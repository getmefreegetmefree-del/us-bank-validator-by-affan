/**
 * Socure Account Intelligence via RiskOS (real account-status verification).
 * Docs: https://help.socure.com/riskos/docs/account-intelligence-integration-guide
 *
 *   POST https://riskos.socure.com/api/evaluation          (production)
 *   POST https://riskos.sandbox.socure.com/api/evaluation  (sandbox)
 *   Authorization: Bearer {SOCURE_API_KEY}
 *
 * We send an AVAILABILITY inquiry (routing + account number only). It is a data lookup;
 * no money moves and no ACH entry is created.
 *
 * Socure returns an availabilityScore (0.0–1.0, likelihood the account is open and
 * active) plus reason codes. Socure publishes the score bands and reason-code meanings
 * in each customer's RiskOS dashboard, not publicly. So this adapter only labels an
 * account "open" or "possibly closed" when YOU have configured the thresholds or codes
 * from your dashboard (see .env.example). Otherwise it reports the raw score and says the
 * status could not be determined. It never invents a status.
 */
import crypto from 'node:crypto';

const BASE_URLS = {
  production: 'https://riskos.socure.com',
  sandbox: 'https://riskos.sandbox.socure.com',
};

function numEnv(v) {
  if (v == null || String(v).trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function listEnv(v) {
  return String(v || '')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

export function socureConfigured(env = process.env) {
  return Boolean(env.SOCURE_API_KEY);
}

export function socureSettings(env = process.env) {
  return {
    environment: (env.SOCURE_ENVIRONMENT || 'sandbox').toLowerCase(),
    workflow: env.SOCURE_WORKFLOW || 'bank_account_validation',
    openMinScore: numEnv(env.SOCURE_OPEN_MIN_SCORE),
    closedMaxScore: numEnv(env.SOCURE_CLOSED_MAX_SCORE),
    closedCodes: listEnv(env.SOCURE_CLOSED_REASON_CODES),
    invalidCodes: listEnv(env.SOCURE_INVALID_REASON_CODES),
    notFoundCodes: listEnv(env.SOCURE_NOT_FOUND_REASON_CODES),
  };
}

function extractReasonCodes(rc) {
  if (!rc) return [];
  if (Array.isArray(rc)) {
    return rc
      .map((c) => (typeof c === 'string' ? c : c?.code || c?.reasonCode || ''))
      .filter(Boolean)
      .map((c) => String(c).toUpperCase());
  }
  if (typeof rc === 'object') return Object.keys(rc).map((k) => k.toUpperCase());
  return [];
}

/**
 * Map a Socure RiskOS evaluation response to our status vocabulary.
 * Exported for unit testing.
 */
export function interpretSocureResponse(body, settings) {
  const enrichments = Array.isArray(body?.data_enrichments) ? body.data_enrichments : [];
  const enrichment = enrichments.find(
    (e) => e?.response?.accountIntelligence || e?.response?.accountIntelligencePremier
  );
  const decision = body?.decision || null;

  if (!enrichment) {
    const failed = enrichments.find((e) => e?.error || (e?.status_code && e.status_code !== 200));
    return {
      status: 'unable_to_verify',
      detail: failed
        ? `Socure's Account Intelligence enrichment did not complete (status ${failed.status_code ?? 'error'}).`
        : 'Socure returned no Account Intelligence result. Check that your RiskOS workflow includes the Account Intelligence enrichment.',
      decision,
    };
  }
  if (enrichment.status_code && enrichment.status_code !== 200) {
    return {
      status: 'unable_to_verify',
      detail: `Socure's Account Intelligence enrichment returned status ${enrichment.status_code}.`,
      decision,
    };
  }

  const ai = enrichment.response.accountIntelligence || enrichment.response.accountIntelligencePremier;
  const account = ai.account || {};
  const score = typeof account.availabilityScore === 'number' ? account.availabilityScore : null;
  const reasonCodes = extractReasonCodes(ai.reasonCodes);
  const referenceId = enrichment.response.referenceId || null;
  const base = { score, reasonCodes, decision, referenceId };

  // 1) Explicit status field, if Socure includes one.
  const explicit = String(account.accountStatus || account.status || '').toUpperCase();
  if (explicit === 'OPEN') return { ...base, status: 'open_verified', detail: 'Socure reports the account status as OPEN.' };
  if (explicit === 'CLOSED') return { ...base, status: 'possibly_closed', detail: 'Socure reports the account status as CLOSED.' };
  if (explicit === 'INVALID') return { ...base, status: 'invalid', detail: 'Socure reports the account as INVALID.' };

  // 2) Reason codes the operator has mapped from their RiskOS dashboard.
  const hit = (list) => reasonCodes.find((c) => list.includes(c));
  const invalidHit = hit(settings.invalidCodes);
  if (invalidHit) return { ...base, status: 'invalid', detail: `Socure reason code ${invalidHit} (configured as "invalid account").` };
  const notFoundHit = hit(settings.notFoundCodes);
  if (notFoundHit) return { ...base, status: 'not_found', detail: `Socure reason code ${notFoundHit} (configured as "account not found").` };
  const closedHit = hit(settings.closedCodes);
  if (closedHit) return { ...base, status: 'possibly_closed', detail: `Socure reason code ${closedHit} (configured as "closed account").` };

  // 3) Availability score, against operator-configured thresholds.
  if (score == null) {
    return { ...base, status: 'unable_to_verify', detail: 'Socure did not return an availability score for this account.' };
  }
  if (settings.openMinScore != null && score >= settings.openMinScore) {
    return {
      ...base,
      status: 'open_verified',
      detail: `Availability score ${score.toFixed(2)} meets your configured "open" threshold (≥ ${settings.openMinScore}).`,
    };
  }
  if (settings.closedMaxScore != null && score <= settings.closedMaxScore) {
    return {
      ...base,
      status: 'possibly_closed',
      detail: `Availability score ${score.toFixed(2)} is at or below your configured "possibly closed" threshold (≤ ${settings.closedMaxScore}).`,
    };
  }
  const thresholdsSet = settings.openMinScore != null || settings.closedMaxScore != null;
  return {
    ...base,
    status: 'unable_to_verify',
    detail: thresholdsSet
      ? `Availability score ${score.toFixed(2)} is in the uncertain middle range, so it needs manual review.`
      : `Socure returned an availability score of ${score.toFixed(2)}, but no score thresholds are configured, so the app won't label the account open or closed. Set SOCURE_OPEN_MIN_SCORE / SOCURE_CLOSED_MAX_SCORE from your RiskOS scoring guide.`,
  };
}

export async function verifyWithSocure({ routingNumber, accountNumber }, env = process.env) {
  const settings = socureSettings(env);
  const base = BASE_URLS[settings.environment] || BASE_URLS.sandbox;

  const payload = {
    id: crypto.randomUUID(), // random per request; not linked to any stored record
    timestamp: new Date().toISOString(),
    workflow: settings.workflow,
    data: {
      individual: {
        account: {
          account_number: accountNumber,
          routing_number: routingNumber,
          account_inquiries: ['AVAILABILITY'],
        },
      },
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(env.PROVIDER_TIMEOUT_MS || 15000));
  try {
    const res = await fetch(`${base}/api/evaluation`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.SOCURE_API_KEY}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      return {
        status: 'unable_to_verify',
        detail: `Socure returned HTTP ${res.status}. ${res.status === 401 || res.status === 403 ? 'Check SOCURE_API_KEY and environment.' : ''}`.trim(),
      };
    }
    const body = await res.json();
    return {
      ...interpretSocureResponse(body, settings),
      environment: settings.environment,
    };
  } catch (err) {
    return {
      status: 'unable_to_verify',
      detail: err.name === 'AbortError' ? 'Socure request timed out.' : `Socure request failed: ${err.message}`,
    };
  } finally {
    clearTimeout(timer);
  }
}
