// Pure TypeScript PII masking module. No node: imports.

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

// Matches candidate sequences of digits and phone punctuation bounded by non-word/currency chars or string edges.
const PHONE_CANDIDATE_RE = /(^|[^\w$€£¥])(\+?(?:(?:\(\d+[\s.-]*\))|\d+)[\d\s().-]*\d)(?=[^\w]|$)/g;

/**
 * Mask PII (email addresses and phone numbers) in text before sending to the gateway.
 * Email addresses -> `[email]`
 * Phone numbers (7+ digits with optional +, spaces, dots, dashes, parentheses) -> `[phone]`
 * Does NOT touch ISO dates, versions like 1.2.3, prices, or short numbers such as "402" or "7731".
 */
export function maskPii(text: string): string {
  if (!text) {
    return text;
  }

  // 1. Mask email addresses first so internal digits aren't mistaken for phone numbers
  let masked = text.replace(EMAIL_RE, '[email]');

  // 2. Mask phone numbers
  masked = masked.replace(PHONE_CANDIDATE_RE, (match, prefix, candidate, offset, fullStr) => {
    // If preceded by URL scheme or slash, skip
    const beforeMatch = fullStr.slice(0, offset + prefix.length);
    if (/https?:\/\/[^\s]*$/.test(beforeMatch) || /\/[^\s]*$/.test(beforeMatch)) {
      return match;
    }

    const digitsOnly = candidate.replace(/\D/g, '');
    // Phone numbers must have at least 7 digits and at most 15 digits (E.164 max length)
    if (digitsOnly.length < 7 || digitsOnly.length > 15) {
      return match;
    }

    // Do NOT touch ISO dates (YYYY-MM-DD, YYYY/MM/DD, DD-MM-YYYY)
    if (/^\d{4}[-/]\d{2}[-/]\d{2}/.test(candidate) || /^\d{2}[-/]\d{2}[-/]\d{4}/.test(candidate)) {
      return match;
    }

    // Do NOT touch IP addresses or multi-part dot-separated numbers (192.168.1.1, 1.2.3.4)
    if (/^\d+(\.\d+){3,}$/.test(candidate)) {
      return match;
    }

    // Do NOT touch prices with currency suffixes (e.g. 1000000 USD)
    const afterMatch = fullStr.slice(offset + match.length);
    if (/^\s*(?:USD|EUR|GBP|JPY|AUD|CAD|CHF|dollars|cents)\b/i.test(afterMatch)) {
      return match;
    }

    return prefix + '[phone]';
  });

  return masked;
}
