/**
 * US Bank Validator by Affan — shared validation logic.
 *
 * This module runs in BOTH the browser (basic mode / instant feedback) and the
 * Node.js backend, so the two can never disagree about format or checksum rules.
 *
 * Everything here is deterministic, offline validation. Nothing in this file can
 * tell you whether a bank account exists, is open, or is closed.
 */

/** Federal Reserve districts by number (1–12). */
const FED_DISTRICTS = {
  1: 'Boston',
  2: 'New York',
  3: 'Philadelphia',
  4: 'Cleveland',
  5: 'Richmond',
  6: 'Atlanta',
  7: 'Chicago',
  8: 'St. Louis',
  9: 'Minneapolis',
  10: 'Kansas City',
  11: 'Dallas',
  12: 'San Francisco',
};

/** NACHA's DFI Account Number field is 17 characters wide. */
export const ACCOUNT_MAX_LENGTH = 17;
/** Below this, a US deposit account number is not realistic. */
export const ACCOUNT_MIN_LENGTH = 4;
/** Lengths at or below this are accepted but flagged as unusually short. */
export const ACCOUNT_SHORT_WARNING_AT = 5;

/** Remove spaces and hyphens people commonly type. */
export function normalizeDigits(value) {
  return String(value ?? '').replace(/[\s-]/g, '');
}

/**
 * Official ABA routing number checksum:
 *   3·(d1 + d4 + d7) + 7·(d2 + d5 + d8) + 1·(d3 + d6 + d9) ≡ 0 (mod 10)
 */
export function abaChecksumValid(routing) {
  if (!/^\d{9}$/.test(routing)) return false;
  const d = routing.split('').map(Number);
  const sum =
    3 * (d[0] + d[3] + d[6]) +
    7 * (d[1] + d[4] + d[7]) +
    1 * (d[2] + d[5] + d[8]);
  return sum % 10 === 0;
}

/**
 * Interpret the first two digits (the "prefix") of a routing number.
 * Valid ABA prefixes: 00, 01–12, 21–32, 61–72, 80.
 */
export function describeRoutingPrefix(routing) {
  const p = Number(routing.slice(0, 2));
  if (p === 0) {
    return { valid: true, achTypical: false, description: 'Prefix 00: reserved for the U.S. Government.' };
  }
  if (p >= 1 && p <= 12) {
    return {
      valid: true,
      achTypical: true,
      description: `Prefix ${routing.slice(0, 2)}: primary institution, Federal Reserve district ${p} (${FED_DISTRICTS[p]}).`,
    };
  }
  if (p >= 21 && p <= 32) {
    const district = p - 20;
    return {
      valid: true,
      achTypical: true,
      description: `Prefix ${routing.slice(0, 2)}: thrift institution (e.g. credit union or savings bank), Federal Reserve district ${district} (${FED_DISTRICTS[district]}).`,
    };
  }
  if (p >= 61 && p <= 72) {
    const district = p - 60;
    return {
      valid: true,
      achTypical: true,
      description: `Prefix ${routing.slice(0, 2)}: electronic transaction identifier, Federal Reserve district ${district} (${FED_DISTRICTS[district]}).`,
    };
  }
  if (p === 80) {
    return { valid: true, achTypical: false, description: "Prefix 80: traveler's checks. Not used for ACH deposits." };
  }
  return {
    valid: false,
    achTypical: false,
    description: `Prefix ${routing.slice(0, 2)} is not an assigned ABA routing prefix (valid ranges: 00–12, 21–32, 61–72, 80).`,
  };
}

/**
 * Validate a routing number's format, prefix and checksum.
 * Does NOT confirm the number is assigned to an active institution — that needs a directory.
 */
export function validateRoutingNumber(raw) {
  const value = normalizeDigits(raw);
  const messages = [];
  const result = {
    value,
    formatValid: false,
    checksumValid: false,
    prefix: null,
    status: 'invalid', // 'valid' | 'invalid' | 'warning'
    messages,
  };

  if (!value) {
    messages.push('Routing number is required.');
    return result;
  }
  if (!/^\d+$/.test(value)) {
    messages.push('Routing number must contain digits only.');
    return result;
  }
  if (value.length !== 9) {
    messages.push(`Routing number must be exactly 9 digits (you entered ${value.length}).`);
    return result;
  }
  result.formatValid = true;

  result.prefix = describeRoutingPrefix(value);
  result.checksumValid = abaChecksumValid(value);

  if (!result.checksumValid) {
    messages.push('Fails the ABA checksum. This is not a valid routing number, most likely a typo.');
    return result;
  }
  if (!result.prefix.valid) {
    messages.push(result.prefix.description);
    return result;
  }

  messages.push('9-digit format is correct and the ABA checksum passes.');
  if (!result.prefix.achTypical) {
    result.status = 'warning';
    messages.push(result.prefix.description);
  } else {
    result.status = 'valid';
  }
  return result;
}

/**
 * Mask an account number for display: only the last 4 digits are shown.
 */
export function maskAccountNumber(raw) {
  const value = normalizeDigits(raw);
  if (!value) return '';
  if (value.length <= 4) return '•'.repeat(value.length);
  return '•'.repeat(Math.min(value.length - 4, 8)) + value.slice(-4);
}

/**
 * Validate the format of an account number.
 *
 * @param {string} raw            Account number as typed.
 * @param {object} [opts]
 * @param {string} [opts.routing] Normalized routing number (to catch "same as routing" mistakes).
 * @param {object} [opts.rule]    Optional institution-specific rule { minLength, maxLength, institution, source }.
 *
 * Format checks can only say whether a number COULD be an account number.
 * They never establish whether the account exists, is open, or is closed.
 */
export function validateAccountNumber(raw, opts = {}) {
  const value = normalizeDigits(raw);
  const messages = [];
  const result = {
    length: value.length,
    masked: maskAccountNumber(value),
    status: 'invalid', // 'valid' | 'warning' | 'invalid'
    institutionRule: null,
    messages,
  };

  if (!value) {
    messages.push('Account number is required.');
    return result;
  }
  if (!/^\d+$/.test(value)) {
    messages.push('Account number should contain digits only (spaces and hyphens are ignored).');
    return result;
  }
  if (value.length < ACCOUNT_MIN_LENGTH) {
    messages.push(`Too short. US account numbers are at least ${ACCOUNT_MIN_LENGTH} digits in practice.`);
    return result;
  }
  if (value.length > ACCOUNT_MAX_LENGTH) {
    messages.push(`Too long. ACH (NACHA) allows at most ${ACCOUNT_MAX_LENGTH} characters for an account number.`);
    return result;
  }
  if (/^0+$/.test(value)) {
    messages.push('An account number cannot be all zeros.');
    return result;
  }

  let warn = false;
  if (opts.routing && value === opts.routing) {
    warn = true;
    messages.push('The account number is identical to the routing number. This is usually a data-entry mistake.');
  }
  if (/^(\d)\1+$/.test(value)) {
    warn = true;
    messages.push('Every digit is the same, which is very unlikely for a real account number.');
  }
  if (value.length <= ACCOUNT_SHORT_WARNING_AT) {
    warn = true;
    messages.push(`Only ${value.length} digits. Valid but unusually short, so double-check it.`);
  }

  // Institution-specific rule (only when a reliable rule has been configured).
  if (opts.rule) {
    const { minLength, maxLength, institution, source } = opts.rule;
    const fits =
      (minLength == null || value.length >= minLength) &&
      (maxLength == null || value.length <= maxLength);
    result.institutionRule = {
      institution: institution || null,
      minLength: minLength ?? null,
      maxLength: maxLength ?? null,
      source: source || null,
      passed: fits,
    };
    if (!fits) {
      const range =
        minLength != null && maxLength != null
          ? `${minLength}–${maxLength}`
          : minLength != null
            ? `at least ${minLength}`
            : `at most ${maxLength}`;
      messages.push(
        `${institution || 'This institution'} uses account numbers of ${range} digits (per configured rule); this one has ${value.length}.`
      );
      result.status = 'invalid';
      return result;
    }
    messages.push(`Length matches the configured rule for ${institution || 'this institution'}.`);
  }

  if (!warn) {
    messages.push(
      `${value.length} digits, within the accepted 4–17 digit range. The format is plausible, but that doesn't mean the account exists.`
    );
  }
  result.status = warn ? 'warning' : 'valid';
  return result;
}

/**
 * Loose comparison of a user-entered bank name to a directory name.
 * Returns 'match' | 'partial' | 'mismatch' | null (when nothing to compare).
 */
export function compareBankNames(entered, official) {
  const norm = (s) =>
    String(s || '')
      .toUpperCase()
      .replace(/&/g, ' AND ')
      .replace(/[^A-Z0-9 ]/g, ' ')
      .split(/\s+/)
      .filter(
        (w) =>
          w &&
          !['THE', 'BANK', 'NA', 'N', 'A', 'OF', 'AND', 'NATIONAL', 'ASSOCIATION', 'CO', 'COMPANY', 'INC', 'FSB', 'CU', 'CREDIT', 'UNION', 'TRUST'].includes(w)
      );
  const a = norm(entered);
  const b = norm(official);
  if (!a.length || !String(official || '').trim()) return null;
  if (!b.length) return null;
  const setB = new Set(b);
  const hits = a.filter((w) => setB.has(w) || b.some((x) => x.startsWith(w) || w.startsWith(x)));
  if (hits.length === a.length) return 'match';
  if (hits.length > 0) return 'partial';
  return 'mismatch';
}
