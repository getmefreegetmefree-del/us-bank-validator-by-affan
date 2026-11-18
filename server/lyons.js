/**
 * Lyons Commercial Data web services (REST).
 * Docs: https://apihelp.lyonsreg.com/
 *
 * Auth:   POST {service}/rest/Logon  { companyId, userName, password } → { token }
 *         Tokens expire after 20 minutes of inactivity; we re-logon after 15.
 *
 * RTN 2.1 (routing directory, same data as iBankRegistry):
 *         POST https://lyonsreg.com/webservices/rtn2.1/RTNServiceWCF.svc/rest/GetPrimaryInstitutionDetails
 *         { token, rtn, country, includeInactive, includeWireSearch, includeHistory }
 *
 * AOA (account status):
 *         POST https://lyonsreg.com/webservices/aoa/AOAServiceWCF.svc/rest/CheckAccountStatusWithDates
 *         { token, returnDetails, accountStatusRequest: { rtn, accountNo, amount, customerPresent, denyNsf, country } }
 *
 * Both are inquiries. No money moves.
 */

const DEFAULT_RTN_URL = 'https://lyonsreg.com/webservices/rtn2.1/RTNServiceWCF.svc';
const DEFAULT_AOA_URL = 'https://lyonsreg.com/webservices/aoa/AOAServiceWCF.svc';
const TOKEN_TTL_MS = 15 * 60 * 1000;

const tokens = new Map(); // baseUrl → { token, lastUsed }

export function lyonsConfigured(env = process.env) {
  return Boolean(env.LYONS_COMPANY_ID && env.LYONS_USERNAME && env.LYONS_PASSWORD);
}

export function lyonsUrls(env = process.env) {
  return {
    rtn: (env.LYONS_RTN_URL || DEFAULT_RTN_URL).replace(/\/$/, ''),
    aoa: (env.LYONS_AOA_URL || DEFAULT_AOA_URL).replace(/\/$/, ''),
  };
}

async function post(url, body, env) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(env.PROVIDER_TIMEOUT_MS || 15000));
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('request timed out');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function getToken(baseUrl, env, { force = false } = {}) {
  const cached = tokens.get(baseUrl);
  if (!force && cached && Date.now() - cached.lastUsed < TOKEN_TTL_MS) {
    cached.lastUsed = Date.now();
    return cached.token;
  }
  const body = await post(
    `${baseUrl}/rest/Logon`,
    { companyId: env.LYONS_COMPANY_ID, userName: env.LYONS_USERNAME, password: env.LYONS_PASSWORD },
    env
  );
  if (!body?.token) throw new Error(body?.errorMessage ? `Lyons logon failed: ${body.errorMessage}` : 'Lyons logon failed');
  tokens.set(baseUrl, { token: body.token, lastUsed: Date.now() });
  return body.token;
}

/** Call a Lyons method, re-logging on once if the session token was rejected. */
async function callWithToken(baseUrl, method, payload, env) {
  let token = await getToken(baseUrl, env);
  let body = await post(`${baseUrl}/rest/${method}`, { token, ...payload }, env);
  if (body?.errorMessage && /token|session|logon|expired/i.test(body.errorMessage)) {
    token = await getToken(baseUrl, env, { force: true });
    body = await post(`${baseUrl}/rest/${method}`, { token, ...payload }, env);
  }
  return body;
}

export function _resetLyonsTokens() {
  tokens.clear();
}

/* ───────────────────────── RTN directory ───────────────────────── */

const CONTACT_ORDER = ['Customer Service', 'Wire', 'Adjust', 'Return', 'Institution', 'ACH', 'OFCR'];

function cleanHomePage(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  const withScheme = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  try {
    const u = new URL(withScheme);
    if (!/^https?:$/.test(u.protocol) || !u.hostname.includes('.')) return null;
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Turn a Lyons institution object into our profile shape.
 * Exported for unit tests.
 */
export function mapLyonsInstitution(inst, routingNumber) {
  const contacts = Array.isArray(inst.contacts) ? inst.contacts : [];
  const phones = contacts
    .filter((c) => c && c.phoneNumber)
    .map((c) => ({
      label: c.contactType === 'ACH' ? 'ACH Dept' : c.contactType === 'OFCR' ? 'Officer' : c.contactType || 'Phone',
      number: c.phoneNumber,
      extension: c.extension || null,
      name: c.name || null,
      title: c.title || null,
      order: CONTACT_ORDER.indexOf(c.contactType) === -1 ? 99 : CONTACT_ORDER.indexOf(c.contactType),
    }))
    .sort((a, b) => a.order - b.order)
    .map(({ order, ...rest }) => rest);
  if (inst.fax) phones.push({ label: 'Main Fax', number: inst.fax, extension: null, name: null, title: null });

  const emails = contacts
    .filter((c) => c && c.email)
    .map((c) => ({ label: c.contactType || 'Email', email: c.email }));
  const achContact = contacts.find((c) => c?.contactType === 'ACH');

  const rtns = (Array.isArray(inst.routingNumbers) ? inst.routingNumbers : []).map((r) => ({
    routingNumber: r.routingNumber,
    purpose: r.purpose || null,
    active: r.active !== false,
    preferred: Boolean(r.preferred),
    useForTransactions: r.useForTransactions !== false,
    notes: r.notes || null,
  }));

  const tags = {};
  for (const t of Array.isArray(inst.tags) ? inst.tags : []) {
    if (t?.name) tags[t.name] = t.value;
  }
  const truthy = (v) => (v == null ? null : String(v).toLowerCase() === 'true');

  const officeLines = [inst.addressLine1, inst.addressLine2].filter(Boolean);
  const cityLine = [inst.city, [inst.state, inst.postalCode].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  if (cityLine) officeLines.push(cityLine);

  return {
    name: inst.name || null,
    branchName: inst.branchName && inst.branchName !== inst.name ? inst.branchName : null,
    officeType: inst.mainInstitutionId == null ? 'Main Office' : 'Branch',
    institutionType: inst.institutionType || null,
    location: [inst.city, inst.state].filter(Boolean).join(', ') || null,
    phones,
    emails,
    achContactName: achContact?.name || null,
    officeAddress: officeLines,
    mailingAddress: inst.mailingAddr ? String(inst.mailingAddr).replace(/\s{2,}/g, '\n').split('\n').map((s) => s.trim()).filter(Boolean) : [],
    homePage: cleanHomePage(inst.homePage),
    swift: inst.swift || null,
    institutionId: inst.legacyLyonsId ?? inst.institutionId ?? null,
    idLabel: 'Lyons ID',
    branchCount: typeof inst.branchCount === 'number' ? inst.branchCount : null,
    active: inst.active !== false,
    notes: inst.notes || null,
    routingNumbers: rtns,
    thisRoutingNumber: rtns.filter((r) => r.routingNumber === routingNumber),
    rails: {
      wire: typeof inst.fedWire === 'boolean' ? inst.fedWire : null,
      rtp: truthy(tags.RTP),
      fednow: truthy(tags.FEDNow ?? tags.FedNow ?? tags.FEDNOW),
    },
  };
}

/**
 * @returns {null | { found:boolean, profile?:object, ach?:{status,detail}, error?:string }}
 */
export async function lookupLyonsRtn(routingNumber, env = process.env) {
  if (!lyonsConfigured(env)) return null;
  const { rtn: base } = lyonsUrls(env);
  try {
    const body = await callWithToken(
      base,
      'GetPrimaryInstitutionDetails',
      { rtn: routingNumber, country: 'US', includeInactive: true, includeWireSearch: false, includeHistory: false },
      env
    );
    const inst = body?.institution;
    if (!inst) {
      if (!body?.errorMessage || /no financial institutions found/i.test(body.errorMessage)) return { found: false };
      return { error: `Lyons: ${body.errorMessage}` };
    }
    const profile = mapLyonsInstitution(inst, routingNumber);

    // ACH eligibility from the routing-number records Lyons returns.
    const mine = profile.thisRoutingNumber;
    const achRecords = profile.routingNumbers.filter((r) => /ach/i.test(r.purpose || ''));
    const myAch = mine.find((r) => /ach/i.test(r.purpose || ''));
    let ach;
    if (!profile.active || (mine.length && mine.every((r) => !r.active))) {
      ach = { status: 'not_eligible', detail: 'Lyons lists this routing number / institution as INACTIVE.' };
    } else if (myAch && myAch.active && myAch.useForTransactions) {
      ach = { status: 'eligible', detail: 'Lyons lists this routing number as an active ACH routing number.' };
    } else if (achRecords.some((r) => r.active && r.useForTransactions)) {
      const preferred = achRecords.find((r) => r.active && r.useForTransactions && r.preferred) || achRecords.find((r) => r.active && r.useForTransactions);
      ach = {
        status: 'redirect',
        detail: `Lyons lists a different routing number for ACH at this institution: ${preferred.routingNumber}. Use that number for ACH entries.`,
        redirectTo: preferred.routingNumber,
      };
    } else {
      ach = { status: 'unknown', detail: 'Lyons returned no ACH routing record for this institution.' };
    }
    return { found: true, profile, ach };
  } catch (err) {
    return { error: `Lyons lookup failed: ${err.message}` };
  }
}

/* ───────────────────────── AOA account status ───────────────────────── */

/** Map a Lyons AOA response to our vocabulary. Exported for unit tests. */
export function interpretLyonsAoa(body) {
  const code = Number(body?.statusCode);
  const description = body?.statusDescription || null;
  const base = { providerCode: Number.isFinite(code) ? code : null, providerDescription: description };

  if (body?.validRtn === false) {
    return { ...base, status: 'invalid', detail: 'Lyons reports the routing number is not valid.' };
  }
  switch (code) {
    case 101:
      return { ...base, status: 'open_verified', detail: 'Lyons AOA returned 101 Accept: the account has positive status data.' };
    case 103:
    case 104:
      return {
        ...base,
        status: 'possibly_closed',
        detail: `Lyons AOA returned ${code} Deny: negative account data (for example closed, NSF or fraud history). Don't accept this account without review.`,
      };
    case 198:
      return { ...base, status: 'not_found', detail: 'Lyons AOA returned 198: no account experience available. Lyons has no data on this account.' };
    case 199:
      return { ...base, status: 'unable_to_verify', detail: 'Lyons AOA returned 199: insufficient information to make a decision.' };
    default:
      break;
  }
  if ([-30, -31, -33].includes(code)) {
    return { ...base, status: 'invalid', detail: `Lyons rejected the account number (${code}${description ? `: ${description}` : ''}).` };
  }
  if ([-20, -21, -22].includes(code)) {
    return { ...base, status: 'invalid', detail: `Lyons rejected the routing number (${code}${description ? `: ${description}` : ''}).` };
  }
  return {
    ...base,
    status: 'unable_to_verify',
    detail: body?.errorMessage
      ? `Lyons returned an error: ${body.errorMessage}`
      : `Lyons returned status ${Number.isFinite(code) ? code : 'unknown'}${description ? ` (${description})` : ''}.`,
  };
}

export async function verifyWithLyons({ routingNumber, accountNumber }, env = process.env) {
  const { aoa: base } = lyonsUrls(env);
  try {
    const body = await callWithToken(
      base,
      'CheckAccountStatusWithDates',
      {
        returnDetails: 'false',
        accountStatusRequest: {
          rtn: routingNumber,
          accountNo: accountNumber,
          amount: String(env.LYONS_AOA_AMOUNT || '1.00'),
          customerPresent: '0',
          denyNsf: '0',
          country: 'US',
        },
      },
      env
    );
    return interpretLyonsAoa(body);
  } catch (err) {
    return { status: 'unable_to_verify', detail: `Lyons account check failed: ${err.message}` };
  }
}
