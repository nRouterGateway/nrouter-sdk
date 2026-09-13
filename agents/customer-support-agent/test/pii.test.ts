import { describe, it, expect } from 'vitest';
import { maskPii } from '../src/pii.js';

describe('maskPii', () => {
  const table: Array<{ name: string; input: string; expected: string }> = [
    // Emails
    {
      name: 'plain email',
      input: 'Contact support@example.com for help',
      expected: 'Contact [email] for help'
    },
    {
      name: 'complex email with tag and subdomain',
      input: 'Send to user.name+tag@sub.domain.co.uk please',
      expected: 'Send to [email] please'
    },
    {
      name: 'email in brackets',
      input: 'Email: <support@nrouter.ai>',
      expected: 'Email: <[email]>'
    },
    {
      name: 'user prompt with email',
      input: 'my email is x@y.com',
      expected: 'my email is [email]'
    },

    // Phone numbers (7+ digits with +, spaces, dots, dashes, parentheses)
    {
      name: 'us phone with parens and dash',
      input: 'Call +1 (555) 123-4567 now',
      expected: 'Call [phone] now'
    },
    {
      name: 'us phone with dashes',
      input: 'Reach us at 555-123-4567.',
      expected: 'Reach us at [phone].'
    },
    {
      name: 'us phone with dots',
      input: 'Direct line: 555.123.4567',
      expected: 'Direct line: [phone]'
    },
    {
      name: 'international phone with spaces',
      input: 'UK office: +44 20 7946 0958',
      expected: 'UK office: [phone]'
    },
    {
      name: 'international phone with paren 0',
      input: 'Berlin: +49 (0) 30 1234567',
      expected: 'Berlin: [phone]'
    },
    {
      name: '7-digit phone number',
      input: 'Call 123-4567 today',
      expected: 'Call [phone] today'
    },
    {
      name: 'continuous 10 digits',
      input: 'Phone: 5551234567',
      expected: 'Phone: [phone]'
    },
    {
      name: 'continuous 11 digits with plus',
      input: 'Mobile: +15551234567',
      expected: 'Mobile: [phone]'
    },

    // Mixed email and phone
    {
      name: 'both email and phone in text',
      input: 'Contact support@example.com or call (555) 123-4567',
      expected: 'Contact [email] or call [phone]'
    },

    // Negatives: ISO dates
    {
      name: 'negative: iso date YYYY-MM-DD',
      input: 'Released on 2026-09-12',
      expected: 'Released on 2026-09-12'
    },
    {
      name: 'negative: iso timestamp with T and Z',
      input: 'Event at 2026-09-12T17:31:20Z recorded',
      expected: 'Event at 2026-09-12T17:31:20Z recorded'
    },
    {
      name: 'negative: date with slashes',
      input: 'Date: 2026/09/12',
      expected: 'Date: 2026/09/12'
    },

    // Negatives: Versions
    {
      name: 'negative: semver 1.2.3',
      input: 'Upgrade to version 1.2.3 immediately',
      expected: 'Upgrade to version 1.2.3 immediately'
    },
    {
      name: 'negative: semver with v prefix',
      input: 'Tag v1.2.3.4 released',
      expected: 'Tag v1.2.3.4 released'
    },

    // Negatives: Prices
    {
      name: 'negative: price with dollar sign and cents',
      input: 'Price is $100.00 each',
      expected: 'Price is $100.00 each'
    },
    {
      name: 'negative: price with euro sign',
      input: 'Cost: €49.99 per seat',
      expected: 'Cost: €49.99 per seat'
    },
    {
      name: 'negative: price with pound sign',
      input: 'Fee: £12.50',
      expected: 'Fee: £12.50'
    },
    {
      name: 'negative: large price with commas',
      input: 'Valuation: $1,000,000',
      expected: 'Valuation: $1,000,000'
    },
    {
      name: 'negative: large price without commas',
      input: 'Total: $10000000',
      expected: 'Total: $10000000'
    },
    {
      name: 'negative: price with currency suffix',
      input: 'Balance: 1000000 USD',
      expected: 'Balance: 1000000 USD'
    },

    // Negatives: Short numbers
    {
      name: 'negative: 3-digit short number 402',
      input: 'HTTP status 402 Payment Required',
      expected: 'HTTP status 402 Payment Required'
    },
    {
      name: 'negative: 4-digit short number 7731',
      input: 'Port 7731 is active',
      expected: 'Port 7731 is active'
    },
    {
      name: 'negative: 6-digit number',
      input: 'Code 123456 is valid',
      expected: 'Code 123456 is valid'
    },

    // Negatives: IP addresses
    {
      name: 'negative: ipv4 address',
      input: 'Server IP: 192.168.1.1',
      expected: 'Server IP: 192.168.1.1'
    }
  ];

  for (const testCase of table) {
    it(testCase.name, () => {
      expect(maskPii(testCase.input)).toBe(testCase.expected);
    });
  }
});
