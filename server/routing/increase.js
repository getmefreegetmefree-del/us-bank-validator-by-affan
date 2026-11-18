/**
 * Increase routing-number lookup (read-only).
 * Docs: https://increase.com/documentation/api/routing-numbers
 *
 *   GET {INCREASE_URL}/routing_numbers?routing_number=XXXXXXXXX
 *   Authorization: Bearer {INCREASE_API_KEY}
 *
 * Returns the institution name and whether the routing number can receive
 * ACH, wire, RTP and FedNow transfers. It does not move money.
 */
const BASE_URLS = {
  production: 'https://api.increase.com',
  sandbox: 'https://sandbox.increase.com',
};

export function increaseConfigured(env = process.env) {
  return Boolean(env.INCREASE_API_KEY);
}

export async function lookupIncrease(routingNumber, env = process.env) {
  if (!increaseConfigured(env)) return null;
  const base = BASE_URLS[(env.INCREASE_ENVIRONMENT || 'production').toLowerCase()] || BASE_URLS.production;
  const url = `${base}/routing_numbers?routing_number=${encodeURIComponent(routingNumber)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(env.PROVIDER_TIMEOUT_MS || 10000));
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${env.INCREASE_API_KEY}`, Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) {
      return { error: `Increase returned HTTP ${res.status}` };
    }
    const body = await res.json();
    const entry = Array.isArray(body?.data) ? body.data[0] : null;
    if (!entry) return { found: false };
    return {
      found: true,
      participant: {
        routingNumber: entry.routing_number,
        name: entry.name,
      },
      rails: {
        ach: entry.ach_transfers,
        wire: entry.wire_transfers,
        rtp: entry.real_time_payments_transfers,
        fednow: entry.fednow_transfers,
      },
    };
  } catch (err) {
    return { error: err.name === 'AbortError' ? 'Increase lookup timed out' : `Increase lookup failed: ${err.message}` };
  } finally {
    clearTimeout(timer);
  }
}
