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
