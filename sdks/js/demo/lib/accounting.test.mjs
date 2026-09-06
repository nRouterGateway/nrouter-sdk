// Unit test for the demo probes' spend accounting.
//
// The probes in `sdks/js/demo/` are OPT-IN LIVE scripts: running them spends
// real credit against a real key, so there is no mock and no CI lane that can
// exercise them end to end. What CAN be tested offline is the part that was
// actually wrong — the arithmetic that decided a call's cost was `0` when the
// gateway said it did not know. That logic is extracted into `accounting.js`
// precisely so it can be pinned here.
//
//   node --test sdks/js/demo/lib/
//
// Requires a built SDK (`cd sdks/js && npm run build`), because the pricing
// predicate under test is the SDK's own `isPriced`, imported rather than
// re-implemented. A second copy of "was this priced?" is how the two answers
// drift.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import accounting from './accounting.js';

const { classify, summarize, summaryLines } = accounting;

const PRICED = { costStatus: 'exact', cost: 0.0032, requestId: 'req_priced' };
const UNPRICED = { costStatus: 'unpriced', cost: null, requestId: 'req_unpriced' };
const NO_HEADERS = { costStatus: null, cost: null, requestId: 'req_bare' };

test('an exactly priced call is summable', () => {
  const record = classify(PRICED);
  assert.equal(record.bucket, 'priced');
  assert.equal(record.priced, true);
  assert.equal(record.cost, 0.0032);
});

test('an unpriced call is NOT priced and carries a null cost, never 0', () => {
  const record = classify(UNPRICED);
  assert.equal(record.bucket, 'unpriced');
  assert.equal(record.priced, false);
  // The whole defect in one assertion: `?? 0` / `|| 0` would make this 0, and
  // a 0 added to a total is indistinguishable from a call that was free.
  assert.equal(record.cost, null);
});

test('a cost with an `unpriced` status is a contradiction and is not summed', () => {
  // The two headers disagree about whether the amount means anything. Trusting
  // the number charges a customer for a request the gateway said it could not
  // price.
  const record = classify({ costStatus: 'unpriced', cost: 0.5 });
  assert.equal(record.bucket, 'unpriced');
  assert.equal(record.cost, null);
});

test('a streamed call lands in the streamed bucket, not the unpriced one', () => {
  // A stream is unpriced BY CONSTRUCTION — its headers are written before a
  // token exists. Counting it as "the gateway failed to price this" would send
  // an operator to look for a pricing bug that is not there.
  const record = classify(UNPRICED, { streamed: true });
  assert.equal(record.bucket, 'streamed');
  assert.equal(record.priced, false);
  assert.equal(record.cost, null);
});

test('a documented-free call lands in the free bucket', () => {
  const record = classify(NO_HEADERS, { free: true });
  assert.equal(record.bucket, 'free');
  assert.equal(record.cost, null);
});

test('a failed call is neither priced nor "served without a price"', () => {
  const record = classify(undefined, { ok: false });
  assert.equal(record.bucket, 'failed');
  assert.equal(record.cost, null);
});

test('a missing meta is unpriced, not free', () => {
  const record = classify(undefined);
  assert.equal(record.bucket, 'unpriced');
  assert.equal(record.cost, null);
});

test('summarize sums ONLY the priced bucket', () => {
  const records = [
    classify(PRICED),
    classify({ costStatus: 'exact', cost: 0.01 }),
    classify(UNPRICED),
    classify(UNPRICED, { streamed: true }),
    classify(NO_HEADERS, { free: true }),
    classify(undefined, { ok: false }),
  ];
  const summary = summarize(records);
  assert.equal(summary.calls, 6);
  assert.equal(summary.priced, 2);
  assert.equal(summary.unpriced, 1);
  assert.equal(summary.streamed, 1);
  assert.equal(summary.free, 1);
  assert.equal(summary.failed, 1);
  assert.equal(Number(summary.pricedTotalUsd.toFixed(8)), 0.0132);
});

test('one unpriced call makes the total INCOMPLETE and adds nothing to it', () => {
  const summary = summarize([classify(PRICED), classify(UNPRICED)]);
  assert.equal(summary.pricedTotalUsd, 0.0032);
  assert.equal(summary.complete, false);
  assert.match(summaryLines(summary).join('\n'), /TOTAL INCOMPLETE/);
});

test('an unpriced-only session totals 0 but never claims the session cost 0', () => {
  const summary = summarize([classify(UNPRICED), classify(UNPRICED)]);
  assert.equal(summary.pricedTotalUsd, 0);
  assert.equal(summary.unpriced, 2);
  assert.equal(summary.complete, false);
  assert.match(summaryLines(summary).join('\n'), /TOTAL INCOMPLETE/);
});

test('a failed call alone makes the total INCOMPLETE', () => {
  const summary = summarize([classify(PRICED), classify(undefined, { ok: false })]);
  assert.equal(summary.complete, false);
  assert.match(summaryLines(summary).join('\n'), /TOTAL INCOMPLETE/);
});

test('streamed and free calls do NOT make the total incomplete', () => {
  // They are accounted for, not missing: a stream settles server-side and a
  // free route cost nothing. Only an unpriced BILLED call or a failure is a
  // hole in the total.
  const summary = summarize([
    classify(PRICED),
    classify(UNPRICED, { streamed: true }),
    classify(NO_HEADERS, { free: true }),
  ]);
  assert.equal(summary.complete, true);
  const text = summaryLines(summary).join('\n');
  assert.match(text, /TOTAL COMPLETE/);
  assert.doesNotMatch(text, /TOTAL INCOMPLETE/);
  assert.equal(summary.pricedTotalUsd, 0.0032);
});

test('an `exact` status with an unusable amount falls to unpriced, not priced', () => {
  // `isPriced` asks only that `cost` is not null, so a header that parsed to
  // NaN satisfies it. Trusting that pair would build a priced record with no
  // usable amount and blow up in `summarize` at the END of a live run — after
  // the money was spent, and reported as a crash rather than as an unpriced
  // call. Fall to the honest bucket and say why instead.
  const record = classify({ costStatus: 'exact', cost: Number.NaN });
  assert.equal(record.bucket, 'unpriced');
  assert.equal(record.cost, null);
  assert.match(record.warning, /exact/);
});

test('summarize refuses a hand-built priced record with no amount', () => {
  // Defence in depth: `classify` cannot produce this, but a caller assembling
  // records by hand can, and it is the exact shape that would silently add a
  // zero to a total labelled COMPLETE.
  assert.throws(
    () => summarize([{ bucket: 'priced', priced: true, cost: null, ok: true }]),
    /priced record carries no cost/,
  );
});
