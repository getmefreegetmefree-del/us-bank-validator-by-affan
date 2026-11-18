/**
 * Orchestrates a single verification request.
 * Input is used in memory only and discarded when the response is sent.
 */
import { validateRoutingNumber, validateAccountNumber, normalizeDigits } from '../public/js/validation.js';
import { analyzeRouting, FED_SEARCH_URL } from './routing/index.js';
import { verifyAccount } from './accounts/index.js';
import { ruleForRouting } from './institutionRules.js';

const ACCOUNT_TYPES = ['checking', 'savings'];

export function validateInput(body) {
  const errors = [];
  const bankName = typeof body?.bankName === 'string' ? body.bankName.trim().slice(0, 100) : '';
  const routingNumber = typeof body?.routingNumber === 'string' ? body.routingNumber : '';
  const accountNumber = typeof body?.accountNumber === 'string' ? body.accountNumber : '';
  const accountType = typeof body?.accountType === 'string' ? body.accountType.toLowerCase() : '';
  if (!routingNumber) errors.push('routingNumber is required');
  if (!accountNumber) errors.push('accountNumber is required');
  if (routingNumber.length > 40 || accountNumber.length > 40) errors.push('input too long');
  if (!ACCOUNT_TYPES.includes(accountType)) errors.push('accountType must be "checking" or "savings"');
  return { errors, input: { bankName, routingNumber, accountNumber, accountType } };
}

export async function runVerification({ bankName, routingNumber, accountNumber, accountType }, env = process.env) {
  const routing = validateRoutingNumber(routingNumber);
  const rule = routing.formatValid ? ruleForRouting(routing.value) : null;
  const accountFormat = validateAccountNumber(accountNumber, { routing: routing.value, rule });

  let institution = { status: 'not_checked', name: null, details: [] };
  let ach = { status: 'unknown', detail: null };
  let consulted = [];

  if (routing.status !== 'invalid') {
    const r = await analyzeRouting(routing.value, bankName, env);
    institution = r.institution;
    ach = r.ach;
    consulted = r.consulted;
  } else {
    institution.details.push('Skipped because the routing number is invalid.');
    ach.detail = 'Skipped because the routing number is invalid.';
  }

  let accountVerification;
  if (routing.status === 'invalid' || accountFormat.status === 'invalid') {
    accountVerification = {
      status: 'skipped',
      provider: null,
      detail: 'Not sent to a verification provider because the routing or account number failed basic validation.',
    };
  } else {
    accountVerification = await verifyAccount(
      { routingNumber: routing.value, accountNumber: normalizeDigits(accountNumber), accountType },
      env
    );
  }

  // Plain-language summary of what was / wasn't verified.
  const verified = [];
  const notVerified = [];

  if (routing.checksumValid) verified.push('Routing number format and ABA checksum (offline math check).');
  else notVerified.push('Routing number. It failed format or checksum validation.');

  if (institution.status === 'identified') {
    verified.push(`Bank identified as ${institution.name} via ${institution.source}.`);
    if (institution.profile?.phones?.length) verified.push('Institution contact numbers and addresses (from the directory).');
  }
  else if (institution.status === 'not_found') notVerified.push('Bank identity. The routing number was not found in the connected directories.');
  else notVerified.push('Bank identity. No routing directory or API was available for this check.');

  if (ach.status === 'eligible') verified.push(`ACH eligibility (${ach.source}).`);
  else if (ach.status === 'not_eligible') verified.push(`ACH eligibility: NOT eligible (${ach.source}).`);
  else if (ach.status === 'redirect') verified.push(`ACH routing: use a different routing number (${ach.source}).`);
  else notVerified.push('ACH eligibility. No authoritative data was available.');

  if (accountFormat.status !== 'invalid') verified.push('Account number format (digits only, 4–17 characters).');
  else notVerified.push('Account number. It failed basic format validation.');
  if (!accountFormat.institutionRule && accountFormat.status !== 'invalid') {
    notVerified.push('Institution-specific account length. No reliable rule is configured for this bank.');
  }

  if (['open_verified', 'possibly_closed', 'invalid', 'not_found'].includes(accountVerification.status)) {
    verified.push(`Account status checked with ${accountVerification.provider}.`);
  } else {
    notVerified.push(
      'Whether the account exists, is open, or is closed. That needs a real verification provider, and format checks cannot answer it.'
    );
  }
  notVerified.push('Account ownership (the account holder\'s name). This app does not check it.');

  return {
    checkedAt: new Date().toISOString(),
    mode: 'server',
    input: {
      bankName: bankName || null,
      routingNumber: routing.value,
      accountNumberMasked: accountFormat.masked,
      accountType,
    },
    routing,
    institution,
    ach,
    accountFormat,
    accountVerification,
    sourcesConsulted: consulted,
    manualLookupUrl: FED_SEARCH_URL,
    summary: { verified, notVerified },
  };
}
