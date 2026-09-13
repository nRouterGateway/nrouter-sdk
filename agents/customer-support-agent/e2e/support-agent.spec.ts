import { test, expect } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

// Stored state shared between tests for leak assertions
const test1Responses: string[] = [];
let test4RawSSE = '';

test.beforeAll(() => {
  if (!process.env.NROUTER_API_KEY || !process.env.NROUTER_API_KEY.trim()) {
    throw new Error('NROUTER_API_KEY environment variable is required to run e2e tests.');
  }
});

test('1. in-KB question: How do I create an API key?', async ({ page }) => {
  // Collect all response bodies on the page during test 1 for test 5
  const responsePromises: Promise<void>[] = [];
  page.on('response', (res) => {
    const p = res.text().then((text) => {
      test1Responses.push(text);
    }).catch(() => {
      // Ignore responses that cannot be read as text
    });
    responsePromises.push(p);
  });

  await page.goto('/');

  await page.locator('textarea[data-testid="question"]').fill('How do I create an API key?');
  await page.locator('button[data-testid="send"]').click();

  const doneEl = page.locator('[data-testid="done"]');
  await expect(doneEl).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('[data-testid="error"]')).toBeEmpty();

  // Answer non-empty
  const answerEl = page.locator('[data-testid="answer"]');
  await expect(answerEl).toBeVisible();
  await expect(answerEl).not.toBeEmpty();
  const answerText = await answerEl.textContent();
  expect(answerText?.trim().length).toBeGreaterThan(0);
  const answerLower = (answerText ?? '').toLowerCase();
  expect(answerLower).toContain('settings');
  expect(answerLower).toContain('api key');
  await expect(answerEl).toContainText(/settings/i);
  await expect(answerEl).toContainText(/api key/i);

  // Done visible
  await expect(doneEl).toBeVisible();

  // Confidence high|medium
  const confidenceEl = page.locator('[data-testid="confidence"]');
  await expect(confidenceEl).toBeVisible();
  await expect(confidenceEl).toHaveText(/^(high|medium)$/);

  // Citation href containing '/getting-started'
  const citationEl = page.locator('a[data-testid="citation"][href*="/getting-started"]');
  await expect(citationEl.first()).toBeVisible();

  // Cost shows exact:<n> or unpriced (never 'exact:0')
  const costEl = page.locator('[data-testid="cost"]');
  await expect(costEl).toBeVisible();
  const costText = (await costEl.textContent())?.trim() ?? '';
  expect(costText).not.toBe('exact:0');
  expect(costText).toMatch(/^(exact:(?!0(\.0+)?$)[0-9.]+|unpriced)$/);
  if (costText.startsWith('exact:')) {
    const costVal = parseFloat(costText.slice('exact:'.length));
    expect(costVal).toBeGreaterThan(0);
  }

  // Ensure all responses from test 1 are collected
  await Promise.all(responsePromises);
});

test('2. off-topic: What is the capital of Mongolia?', async ({ page }) => {
  await page.goto('/');

  await page.locator('textarea[data-testid="question"]').fill('What is the capital of Mongolia?');
  await page.locator('button[data-testid="send"]').click();

  const doneEl = page.locator('[data-testid="done"]');
  await expect(doneEl).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('[data-testid="error"]')).toBeEmpty();

  // Answer does NOT contain "ulaanbaatar"
  const answerEl = page.locator('[data-testid="answer"]');
  const answerText = (await answerEl.textContent()) ?? '';
  expect(answerText.toLowerCase()).not.toContain('ulaanbaatar');
  await expect(answerEl).not.toContainText(/ulaanbaatar/i);

  // Confidence low
  const confidenceEl = page.locator('[data-testid="confidence"]');
  await expect(confidenceEl).toBeVisible();
  await expect(confidenceEl).toHaveText('low');

  // Done visible
  await expect(doneEl).toBeVisible();
});

test('3. gated doc: partner referral rate before and after login', async ({ page }) => {
  // Ensure logged out
  await page.goto('/logout');
  await page.goto('/');

  // Ask without partner login
  await page.locator('textarea[data-testid="question"]').fill('What is the partner referral rate?');
  await page.locator('button[data-testid="send"]').click();

  const doneEl = page.locator('[data-testid="done"]');
  await expect(doneEl).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('[data-testid="error"]')).toBeEmpty();

  // Answer text must NOT contain "7731" before login
  const answerEl = page.locator('[data-testid="answer"]');
  const answerBefore = (await answerEl.textContent()) ?? '';
  expect(answerBefore).not.toContain('7731');
  await expect(answerEl).not.toContainText('7731');

  // NO citation to '/partners'
  const partnerCitationsBefore = page.locator('a[data-testid="citation"][href*="/partners"]');
  await expect(partnerCitationsBefore).toHaveCount(0);

  // Visit /login-as-partner (sets demo_session=partner cookie and redirects to /)
  await page.goto('/login-as-partner');

  // Ask again as partner
  await page.locator('textarea[data-testid="question"]').fill('What is the partner referral rate?');
  await page.locator('button[data-testid="send"]').click();

  await expect(doneEl).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('[data-testid="error"]')).toBeEmpty();

  // Answer text MUST contain "7731" after login
  const answerAfter = (await answerEl.textContent()) ?? '';
  expect(answerAfter).toContain('7731');
  await expect(answerEl).toContainText('7731');

  // A citation to '/partners' appears
  const partnerCitationsAfter = page.locator('a[data-testid="citation"][href*="/partners"]');
  await expect(partnerCitationsAfter.first()).toBeVisible({ timeout: 60_000 });
});

test('4. body cannot grant access: untrusted audiences in body is ignored', async ({ page }) => {
  // Clear all cookies to ensure unauthenticated request
  await page.context().clearCookies();

  const response = await page.request.post('/api/chat', {
    data: {
      messages: [{ role: 'user', content: 'What is the partner referral rate?' }],
      audiences: ['partners'],
      sessionId: 'x',
    },
  });

  expect(response.status()).toBe(200);
  const responseText = await response.text();
  expect(responseText).not.toContain('"nrouter_event":"error"');
  test4RawSSE = responseText;

  // Response text has no '/partners' citation
  expect(responseText).not.toContain('/partners');
});

test('5. key never leaks into response bodies or raw SSE text', async ({ page }) => {
  const keyRegex = /sk-nrouter-[A-Za-z0-9_-]{20,}/;
  const apiKey = process.env.NROUTER_API_KEY;

  // Fallback if test 5 is executed independently
  if (test1Responses.length === 0) {
    const responsePromises: Promise<void>[] = [];
    page.on('response', (res) => {
      const p = res.text().then((t) => { test1Responses.push(t); }).catch(() => {});
      responsePromises.push(p);
    });
    await page.goto('/');
    await page.locator('textarea[data-testid="question"]').fill('How do I create an API key?');
    await page.locator('button[data-testid="send"]').click();
    await expect(page.locator('[data-testid="done"]')).toBeVisible({ timeout: 60_000 });
    await Promise.all(responsePromises);
  }

  if (!test4RawSSE) {
    await page.context().clearCookies();
    const res = await page.request.post('/api/chat', {
      data: {
        messages: [{ role: 'user', content: 'What is the partner referral rate?' }],
        audiences: ['partners'],
        sessionId: 'x',
      },
    });
    test4RawSSE = await res.text();
  }

  // Assert on every response body collected during test 1
  expect(test1Responses.length).toBeGreaterThan(0);
  for (const body of test1Responses) {
    if (apiKey) {
      expect(body).not.toContain(apiKey);
    }
    expect(body).not.toMatch(keyRegex);
  }

  // Assert on raw SSE text from test 4
  expect(test4RawSSE.length).toBeGreaterThan(0);
  if (apiKey) {
    expect(test4RawSSE).not.toContain(apiKey);
  }
  expect(test4RawSSE).not.toMatch(keyRegex);
});

test('6. raw SSE contract via page.request', async ({ page }) => {
  const response = await page.request.post('/api/chat', {
    data: {
      messages: [{ role: 'user', content: 'How do I create an API key?' }],
    },
  });

  expect(response.status()).toBe(200);
  const rawText = await response.text();
  expect(rawText).not.toContain('"nrouter_event":"error"');

  // Frames separated by double newline
  const frames = rawText
    .split(/\n\n+/)
    .map((f) => f.trim())
    .filter(Boolean);

  expect(frames.length).toBeGreaterThan(0);

  // Frames all start with 'data: '
  for (const frame of frames) {
    expect(frame.startsWith('data: ')).toBe(true);
  }

  // Last frame is 'data: [DONE]'
  expect(frames[frames.length - 1]).toBe('data: [DONE]');

  // Exactly one [DONE]
  const doneMatches = rawText.match(/\[DONE\]/g) || [];
  expect(doneMatches.length).toBe(1);
});

test('7. billing answer is grounded: What happens when my organization balance reaches zero?', async ({ page }) => {
  await page.goto('/');

  await page.locator('textarea[data-testid="question"]').fill('What happens when my organization balance reaches zero?');
  await page.locator('button[data-testid="send"]').click();

  const doneEl = page.locator('[data-testid="done"]');
  await expect(doneEl).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('[data-testid="error"]')).toBeEmpty();

  // Answer contains "402"
  const answerEl = page.locator('[data-testid="answer"]');
  await expect(answerEl).toBeVisible();
  const answerText = (await answerEl.textContent()) ?? '';
  expect(answerText).toContain('402');
  await expect(answerEl).toContainText('402');

  // Citation to '/billing' or '/errors'
  const citationEl = page.locator('a[data-testid="citation"][href*="/billing"], a[data-testid="citation"][href*="/errors"]');
  await expect(citationEl.first()).toBeVisible();
  const citations = await page.locator('a[data-testid="citation"]').all();
  expect(citations.length).toBeGreaterThan(0);
  const hrefs = await Promise.all(citations.map((c) => c.getAttribute('href')));
  expect(hrefs.some((h) => h && (h.includes('/billing') || h.includes('/errors')))).toBe(true);
});

test('8. PII in the question still works: My email is jane.doe@example.com. How do I add credits?', async ({ page }) => {
  await page.goto('/');

  await page.locator('textarea[data-testid="question"]').fill('My email is jane.doe@example.com. How do I add credits?');
  await page.locator('button[data-testid="send"]').click();

  const doneEl = page.locator('[data-testid="done"]');
  await expect(doneEl).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('[data-testid="error"]')).toBeEmpty();

  // Done visible
  await expect(doneEl).toBeVisible();

  // Answer mentions "billing" or "add credits"
  const answerEl = page.locator('[data-testid="answer"]');
  await expect(answerEl).toBeVisible();
  const answerText = (await answerEl.textContent()) ?? '';
  const answerLower = answerText.toLowerCase();
  const mentionsBillingOrCredits = answerLower.includes('billing') || answerLower.includes('add credits');
  expect(mentionsBillingOrCredits).toBe(true);

  // Answer does NOT contain "jane.doe@example.com"
  expect(answerLower).not.toContain('jane.doe@example.com');
  await expect(answerEl).not.toContainText(/jane\.doe@example\.com/i);
});

