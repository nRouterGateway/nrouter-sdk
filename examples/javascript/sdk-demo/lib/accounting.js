'use strict';

/**
 * Spend accounting for the JS SDK example probes.
 *
 * These probes are opt-in LIVE scripts — they spend real credit — so what they
 * print is the only report anyone gets of what a run cost. Both of them used to
 * coerce a missing cost to zero (`meta.cost || 0`) and add it to a total, which
 * is the one arithmetic mistake `sdks/js/docs/cost.md` opens by forbidding:
 * `x-nr-request-cost` is OMITTED when the gateway could not price a request and
 * is never sent as `0`, so a zero there does not mean "this was free", it means
 * "nobody knows". Every stream reports `unpriced` permanently, so on a probe
 * that streams, the printed total was structurally too low and said so nowhere.
 *
 * The fix is a classification, not a bigger number. Five buckets, and the
 * separations are the point — collapsing any pair tells the reader something
 * false about where to look:
 *
 *   priced    exactly priced; the ONLY bucket that is summed.
 *   streamed  unpriced by CONSTRUCTION — headers precede the first token. The
 *             settled figure lands on the spend row; join on requestId.
 *   free      a route documented as costing nothing (`count_tokens`, video
 *             polling and content fetch, model listing). Absence means zero
 *             here, and only here.
 *   unpriced  SERVED and billed, but the gateway could not price it. This is
 *             the hole in the total.
 *   failed    refused. Not "served without a price", and it may still have been
 *             billed upstream if the provider had already run.
 *
 * The predicate is the SDK's own `isPriced`, imported rather than copied: a
 * second implementation of "was this priced?" drifts the day the first changes,
 * and it drifts in the direction that either sums an unpriced call or hides a
 * priced one.
 */

const { isPriced } = require('../../../../sdks/js/dist/index.js');

const BUCKETS = Object.freeze(['priced', 'streamed', 'free', 'unpriced', 'failed']);

/**
 * Decide one call's bucket, ONCE, and carry the answer on the record.
 *
 * The summary must never re-derive it. Two copies of the decision are two
 * chances to disagree.
 *
 * @param {{cost?: number|null, costStatus?: string|null}|null|undefined} meta
 *   `result.meta`, or undefined when the call threw before one existed.
 * @param {{ok?: boolean, streamed?: boolean, free?: boolean}} [options]
 *   `streamed` and `free` are CLAIMS about the route, made by the caller that
 *   knows which wire it used. They are not observations, so each one is checked
 *   against what actually arrived and warns on a contradiction rather than
 *   silently trusting the label.
 * @returns {{bucket: string, priced: boolean, streamed: boolean, free: boolean,
 *            ok: boolean, cost: number|null, costStatus: string|null,
 *            warning: string|null}}
 */
function classify(meta, options = {}) {
  const { ok = true, streamed = false, free = false } = options;
  const costStatus = meta && meta.costStatus !== undefined ? meta.costStatus : null;
  const observed = meta && typeof meta.cost === 'number' && Number.isFinite(meta.cost) ? meta.cost : null;

  const base = { priced: false, streamed, free, ok, costStatus, cost: null, warning: null };

  if (!ok) {
    // A refused call is not a priced one and not an unpriced SERVED one either.
    // It gets counted separately because "may still have been billed upstream"
    // is a different thing to go and check.
    return { ...base, bucket: 'failed', streamed: false, free: false };
  }

  if (free) {
    return {
      ...base,
      bucket: 'free',
      warning:
        observed === null
          ? null
          : `a route documented as free reported ${observed}; it was NOT summed — check sdks/js/docs/cost.md`,
    };
  }

  if (streamed) {
    // `false` by construction, not by measurement. If a stream ever DID carry
    // an exact cost that is a contract change, and it must be loud: quietly
    // dropping the amount under-reports, quietly summing it breaks the rule
    // that one decision decides the bucket.
    return {
      ...base,
      bucket: 'streamed',
      warning: isPriced(meta || {})
        ? `a STREAMED call reported ${costStatus} ${observed}; it was NOT summed — check sdks/js/docs/cost.md`
        : null,
    };
  }

  // Deliberately not `observed !== null`. A cost paired with `unpriced` is two
  // headers disagreeing about whether the amount means anything; requiring both
  // makes the ambiguous case fall to unpriced, which under-reports at worst
  // instead of billing against a number the gateway disowned.
  if (isPriced(meta || {})) {
    if (observed === null) {
      // `isPriced` asks only that `cost` is not null, so a header that parsed
      // to NaN satisfies it. A priced record with no usable amount would throw
      // in `summarize` at the END of a live run — after the money was spent,
      // and reported as a crash rather than as a call nobody could price.
      return {
        ...base,
        bucket: 'unpriced',
        warning: `costStatus was exact but the amount was ${String(meta && meta.cost)}, which is not a usable number`,
      };
    }
    return { ...base, bucket: 'priced', priced: true, cost: observed };
  }

  return { ...base, bucket: 'unpriced' };
}

/**
 * Roll classified records into the numbers a run report may print.
 *
 * `pricedTotalUsd` is the priced SUBSET, never the session total, and
 * `complete` is what says which of the two it is.
 */
function summarize(records) {
  const counts = { priced: 0, streamed: 0, free: 0, unpriced: 0, failed: 0 };
  let pricedTotalUsd = 0;

  for (const record of records) {
    const bucket = record && record.bucket;
    if (!BUCKETS.includes(bucket)) {
      throw new Error(`unclassified record: bucket ${JSON.stringify(bucket)} is not one of ${BUCKETS.join(', ')}`);
    }
    counts[bucket] += 1;
    if (bucket !== 'priced') continue;
    if (typeof record.cost !== 'number' || !Number.isFinite(record.cost)) {
      // `classify` cannot produce this, but a hand-assembled record can — and
      // it is the exact shape that adds a silent zero to a total labelled
      // COMPLETE. Refuse loudly rather than under-report quietly.
      throw new Error(`priced record carries no cost: ${JSON.stringify(record)}`);
    }
    pricedTotalUsd += record.cost;
  }

  return {
    calls: records.length,
    ...counts,
    pricedTotalUsd,
    // Streamed and free calls are ACCOUNTED FOR, not missing: one settles
    // server-side, the other cost nothing. Only a billed call the gateway could
    // not price, or a call that failed after the provider may have run, is a
    // hole in this figure.
    complete: counts.unpriced === 0 && counts.failed === 0,
  };
}

/** The lines a probe prints. Returned rather than logged so they are testable. */
function summaryLines(summary) {
  const lines = [
    'SESSION SUMMARY',
    `  calls            ${summary.calls}`,
    `  pricedCalls      ${summary.priced}`,
    `  streamedCalls    ${summary.streamed}`,
    `  freeCalls        ${summary.free}`,
    `  unpricedCalls    ${summary.unpriced}`,
    `  failedCalls      ${summary.failed}`,
    `  pricedTotalUsd   ${summary.pricedTotalUsd.toFixed(8)}`,
  ];

  if (summary.complete) {
    lines.push(
      '  TOTAL COMPLETE — every BILLED call in this run was priced exactly. ' +
        `${summary.streamed} streamed call(s) settle server-side and ${summary.free} free call(s) ` +
        'cost nothing; neither is missing from the total.',
    );
    return lines;
  }

  const reasons = [];
  if (summary.unpriced > 0) {
    reasons.push(`${summary.unpriced} call(s) were SERVED without a price`);
  }
  if (summary.failed > 0) {
    // "may": the gateway releases what it reserved on a routing or upstream
    // failure, but a call refused after the provider ran was still billed
    // upstream. The per-call request ids say where to check.
    reasons.push(`${summary.failed} call(s) FAILED and may still have been billed`);
  }
  lines.push(
    `  TOTAL INCOMPLETE — ${reasons.join('; ')}. ` +
      'The figure above is the priced subset, NOT the run total. Join each requestId ' +
      'to its spend row on the dashboard Logs page for the settled figure.',
  );
  return lines;
}

module.exports = { BUCKETS, classify, summarize, summaryLines };
