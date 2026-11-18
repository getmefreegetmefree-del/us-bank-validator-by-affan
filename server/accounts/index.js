/**
 * Account-verification provider registry.
 *
 * ACCOUNT_VERIFICATION_PROVIDER selects the provider:
 *   - "socure"  → Socure Account Intelligence (RiskOS)
 *   - "none"    → (default) no real verification; results say so explicitly
 *
 * To add another provider (e.g. GIACT gVerify, Early Warning, a bank's own
 * account-validation API), create a module exporting
 *   configured(env) → boolean
 *   verify({ routingNumber, accountNumber, accountType }, env) → { status, detail, ... }
 * and register it below. `status` must be one of ACCOUNT_STATUSES.
 */
import { socureConfigured, verifyWithSocure } from './socure.js';

export const ACCOUNT_STATUSES = [
  'open_verified',
  'possibly_closed',
  'invalid',
  'not_found',
  'unable_to_verify',
  'not_configured',
  'skipped',
];

const PROVIDERS = {
  socure: {
    label: 'Socure Account Intelligence',
    configured: socureConfigured,
    verify: verifyWithSocure,
  },
};

export function activeProvider(env = process.env) {
  const key = String(env.ACCOUNT_VERIFICATION_PROVIDER || 'none').toLowerCase();
  const provider = PROVIDERS[key];
  if (!provider) return { key: 'none', label: null, ready: false };
  return { key, label: provider.label, ready: provider.configured(env), provider };
}

export async function verifyAccount(input, env = process.env) {
  const active = activeProvider(env);
  if (active.key === 'none') {
    return {
      status: 'not_configured',
      provider: null,
      detail:
        'No account-verification provider is connected. The account was NOT checked against any bank or database. Only its format was checked.',
    };
  }
  if (!active.ready) {
    return {
      status: 'not_configured',
      provider: active.label,
      detail: `${active.label} is selected but its API credentials are missing on the server.`,
    };
  }
  const result = await active.provider.verify(input, env);
  if (!ACCOUNT_STATUSES.includes(result.status)) result.status = 'unable_to_verify';
  return { provider: active.label, ...result };
}
