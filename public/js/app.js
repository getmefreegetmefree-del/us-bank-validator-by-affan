import {
  validateRoutingNumber,
  validateAccountNumber,
  normalizeDigits,
  maskAccountNumber,
} from './validation.js';

const FED_SEARCH_URL =
  'https://www.frbservices.org/resources/e-payments-routing-directory/search-fedach-participant-rdfis/';

const cfg = window.APP_CONFIG || {};
const API_BASE = String(cfg.apiBase || '').replace(/\/$/, '');

const $ = (id) => document.getElementById(id);
const form = $('verify-form');
const els = {
  bankName: $('bankName'),
  routing: $('routingNumber'),
  account: $('accountNumber'),
  toggle: $('toggle-account'),
  verifyBtn: $('verify-btn'),
  clearBtn: $('clear-btn'),
  formError: $('form-error'),
  routingLive: $('routing-live'),
  accountLive: $('account-live'),
  mode: $('mode'),
  modeText: $('mode-text'),
  empty: $('empty-state'),
  results: $('results'),
  overall: $('overall'),
  rows: $('result-rows'),
  verifiedList: $('verified-list'),
  notVerifiedList: $('not-verified-list'),
  checkedAt: $('checked-at'),
};

let server = null; // health payload when a backend is reachable

/* ---------------- helpers ---------------- */

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

const COLOR = {
  green: { cls: 'green', icon: '✓' },
  yellow: { cls: 'yellow', icon: '?' },
  red: { cls: 'red', icon: '✕' },
  neutral: { cls: 'neutral', icon: '–' },
};

/* ---------------- server detection ---------------- */

async function detectServer() {
  const onStaticHost = /\.github\.io$/i.test(location.hostname) || location.protocol === 'file:';
  if (onStaticHost && !API_BASE) return setMode(null);
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(`${API_BASE}/api/health`, { signal: ctrl.signal, cache: 'no-store' });
    clearTimeout(t);
    if (!res.ok) throw new Error(String(res.status));
    const body = await res.json();
    if (!body?.ok) throw new Error('bad health');
    setMode(body);
  } catch {
    setMode(null);
  }
}

function setMode(health) {
  server = health;
  els.mode.classList.remove('mode-loading', 'mode-server', 'mode-basic', 'mode-full');
  if (!health) {
    els.mode.classList.add('mode-basic');
    els.modeText.textContent = 'Basic mode: browser-only checks';
    els.mode.title = 'No verification server is connected. Only format and ABA checksum checks run, in your browser.';
    return;
  }
  const rs = health.routingSources || {};
  const hasDirectory = rs.lyons?.configured || rs.fedachDirectory?.configured || rs.increase?.configured;
  const hasProvider = health.accountVerification?.ready;
  if (hasProvider) {
    els.mode.classList.add('mode-full');
    els.modeText.textContent = `Server connected · account verification: ${health.accountVerification.provider}`;
  } else {
    els.mode.classList.add('mode-server');
    els.modeText.textContent = hasDirectory
      ? 'Server connected · no account-verification provider'
      : 'Server connected · no directory or provider configured';
  }
  els.mode.title = '';
}

/* ---------------- live hints ---------------- */

els.routing.addEventListener('input', () => {
  const v = normalizeDigits(els.routing.value);
  els.routing.classList.remove('is-valid', 'is-invalid');
  if (!v) {
    els.routingLive.textContent = '9 digits, printed at the bottom-left of a check.';
    els.routingLive.className = 'hint live';
    return;
  }
  if (!/^\d+$/.test(v)) {
    setLive(els.routingLive, 'Digits only.', 'bad');
    els.routing.classList.add('is-invalid');
  } else if (v.length < 9) {
    setLive(els.routingLive, `${v.length}/9 digits`, '');
  } else if (v.length > 9) {
    setLive(els.routingLive, 'Too many digits. A routing number is exactly 9.', 'bad');
    els.routing.classList.add('is-invalid');
  } else {
    const r = validateRoutingNumber(v);
    if (r.status === 'invalid') {
      setLive(els.routingLive, r.messages[0], 'bad');
      els.routing.classList.add('is-invalid');
    } else {
      setLive(els.routingLive, 'ABA checksum passes.', 'good');
      els.routing.classList.add('is-valid');
    }
  }
});

els.account.addEventListener('input', () => {
  const v = normalizeDigits(els.account.value);
  if (!v) {
    els.accountLive.textContent = 'Hidden while you type. Results only show the last 4 digits.';
    els.accountLive.className = 'hint live';
    return;
  }
  if (!/^\d+$/.test(v)) setLive(els.accountLive, 'Digits only (spaces and hyphens are ignored).', 'bad');
  else setLive(els.accountLive, `${v.length} digit${v.length === 1 ? '' : 's'} · shown as ${maskAccountNumber(v)}`, v.length > 17 ? 'bad' : '');
});

function setLive(node, text, tone) {
  node.textContent = text;
  node.className = `hint live ${tone ? `tone-${tone}` : ''}`;
}

els.toggle.addEventListener('click', () => {
  const show = els.account.type === 'password';
  els.account.type = show ? 'text' : 'password';
  els.toggle.textContent = show ? 'Hide' : 'Show';
  els.toggle.setAttribute('aria-pressed', String(show));
});

els.clearBtn.addEventListener('click', () => {
  form.reset();
  els.account.type = 'password';
  els.toggle.textContent = 'Show';
  els.routing.dispatchEvent(new Event('input'));
  els.account.dispatchEvent(new Event('input'));
  els.results.hidden = true;
  els.empty.hidden = false;
  els.checkedAt.textContent = '';
  els.formError.textContent = '';
  els.rows.replaceChildren();
});

/* ---------------- submit ---------------- */

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  els.formError.textContent = '';

  const input = {
    bankName: els.bankName.value.trim(),
    routingNumber: els.routing.value,
    accountNumber: els.account.value,
    accountType: form.querySelector('input[name="accountType"]:checked')?.value || 'checking',
  };
  if (!normalizeDigits(input.routingNumber) || !normalizeDigits(input.accountNumber)) {
    els.formError.textContent = 'Please enter both a routing number and an account number.';
    return;
  }

  setBusy(true);
  try {
    let result;
    if (server) {
      try {
        result = await verifyOnServer(input);
      } catch (err) {
        els.formError.textContent = `${err.message} Showing browser-only checks instead.`;
        result = verifyInBrowser(input, true);
      }
    } else {
      result = verifyInBrowser(input, false);
    }
    render(result);
  } finally {
    setBusy(false);
  }
});

function setBusy(busy) {
  els.verifyBtn.disabled = busy;
  els.verifyBtn.classList.toggle('busy', busy);
  els.verifyBtn.querySelector('.btn-label').textContent = busy ? 'Verifying…' : 'Verify';
}

async function verifyOnServer(input) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(`${API_BASE}/api/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      signal: ctrl.signal,
      cache: 'no-store',
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Server error (${res.status}).`);
    return body;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('The server took too long to respond.');
    throw err;
  } finally {
    clearTimeout(t);
  }
}

/** Basic mode: the same result shape, built only from offline checks. */
function verifyInBrowser(input, serverFailed) {
  const routing = validateRoutingNumber(input.routingNumber);
  const accountFormat = validateAccountNumber(input.accountNumber, { routing: routing.value });
  const why = serverFailed ? 'The verification server could not be reached.' : 'No verification server is connected (browser-only mode).';

  const verified = [];
  const notVerified = [];
  if (routing.checksumValid) verified.push('Routing number format and ABA checksum (offline math check).');
  else notVerified.push('Routing number. It failed format or checksum validation.');
  notVerified.push('Bank identity. No routing directory is connected in browser-only mode.');
  notVerified.push('ACH eligibility. It needs the Federal Reserve FedACH directory or a routing API.');
  if (accountFormat.status !== 'invalid') verified.push('Account number format only (4–17 digits). This does NOT prove the account exists.');
  else notVerified.push('Account number. It failed basic format validation.');
  notVerified.push('Institution-specific account length. No reliable rule is available.');
  notVerified.push('Whether the account exists, is open, or is closed. That needs a real verification provider, and format checks cannot answer it.');
  notVerified.push("Account ownership (the account holder's name).");

  const invalid = routing.status === 'invalid' || accountFormat.status === 'invalid';
  return {
    checkedAt: new Date().toISOString(),
    mode: 'browser',
    input: {
      bankName: input.bankName || null,
      routingNumber: routing.value,
      accountNumberMasked: accountFormat.masked,
      accountType: input.accountType,
    },
    routing,
    institution: {
      status: routing.status === 'invalid' ? 'skipped' : 'not_checked',
      name: null,
      details: [routing.status === 'invalid' ? 'Skipped because the routing number is invalid.' : `${why} The checksum alone can't tell you which bank a number belongs to.`],
    },
    ach: {
      status: 'unknown',
      detail: routing.status === 'invalid' ? 'Skipped because the routing number is invalid.' : `${why} ACH eligibility can't be determined.`,
    },
    accountFormat,
    accountVerification: invalid
      ? { status: 'skipped', provider: null, detail: 'Not checked because the routing or account number failed basic validation.' }
      : { status: 'not_configured', provider: null, detail: `${why} The account was NOT checked against any bank or database.` },
    manualLookupUrl: FED_SEARCH_URL,
    summary: { verified, notVerified },
  };
}

/* ---------------- rendering ---------------- */

function routingColor(s) {
  return s === 'valid' ? 'green' : s === 'warning' ? 'yellow' : 'red';
}
function institutionColor(i) {
  if (i.status === 'identified') return i.bankNameComparison === 'mismatch' ? 'yellow' : 'green';
  if (i.status === 'not_found') return 'red';
  if (i.status === 'skipped') return 'neutral';
  return 'yellow';
}
function achColor(a) {
  return a.status === 'eligible' ? 'green' : a.status === 'not_eligible' ? 'red' : 'yellow';
}
function formatColor(s) {
  return s === 'valid' ? 'green' : s === 'warning' ? 'yellow' : 'red';
}
const ACCOUNT_STATUS = {
  open_verified: { color: 'green', label: 'Open / verified' },
  possibly_closed: { color: 'red', label: 'Possibly closed' },
  invalid: { color: 'red', label: 'Invalid account' },
  not_found: { color: 'red', label: 'Account not found' },
  unable_to_verify: { color: 'yellow', label: 'Unable to verify' },
  not_configured: { color: 'yellow', label: 'Not verified: no provider connected' },
  skipped: { color: 'neutral', label: 'Not checked' },
};

/** Directory-style institution profile (phones, addresses, IDs), like a bank registry record. */
function profileCard(inst, r, color, statusLabel, notes) {
  const p = inst.profile;
  const c = COLOR[color];
  const subtitle = [p.location, p.officeType].filter(Boolean).join(' · ');

  const phoneList = (p.phones || []).length
    ? el(
        'dl',
        { class: 'kv' },
        p.phones.map((ph) => [
          el('dt', { text: ph.label }),
          el('dd', {}, el('a', { href: `tel:${String(ph.number).replace(/[^\d+]/g, '')}`, text: ph.number }), ph.extension ? ` ext. ${ph.extension}` : null),
        ])
      )
    : el('p', { class: 'muted small', text: 'No phone numbers in this directory record.' });

  const addrBlock = (label, lines) =>
    lines && lines.length ? el('div', { class: 'addr' }, el('div', { class: 'addr-label', text: label }), lines.map((l) => el('div', { text: l }))) : null;
  const addresses = [addrBlock('Office address', p.officeAddress), addrBlock('Mailing address', p.mailingAddress)].filter(Boolean);

  const meta = [];
  const metaItem = (label, valueNode) => meta.push(el('div', { class: 'meta-item' }, el('span', { class: 'meta-label', text: label }), el('span', { class: 'meta-value' }, valueNode)));
  if (p.homePage && /^https?:\/\//i.test(p.homePage)) metaItem('Homepage', el('a', { href: p.homePage, target: '_blank', rel: 'noopener noreferrer', text: p.homePage.replace(/^https?:\/\//, '').replace(/\/$/, '') }));
  if (p.institutionId != null) metaItem(p.idLabel || 'Institution ID', String(p.institutionId));
  if (p.branchCount != null) metaItem('Branches', String(p.branchCount));
  if (p.institutionType) metaItem('Type', p.institutionType);
  if (p.swift) metaItem('SWIFT/BIC', p.swift);
  if (p.achContactName) metaItem('ACH Dept Manager', p.achContactName);
  for (const e of p.emails || []) metaItem(`${e.label} e-mail`, el('a', { href: `mailto:${e.email}`, text: e.email }));
  for (const x of p.extra || []) metaItem(x.label, x.value);
  metaItem('Status', p.active === false ? 'Inactive' : 'Active');

  const railChip = (name, v) => el('span', { class: `chip ${v === true ? 'on' : v === false ? 'off' : 'na'}`, text: `${name}: ${v === true ? 'Yes' : v === false ? 'No' : 'n/a'}` });
  const achV = r.ach.status === 'eligible' ? true : r.ach.status === 'not_eligible' ? false : null;
  const rails = el('div', { class: 'chips' }, railChip('ACH', achV), railChip('Wire', p.rails?.wire), railChip('RTP', p.rails?.rtp), railChip('FedNow', p.rails?.fednow));

  let rtnTable = null;
  if ((p.routingNumbers || []).length) {
    rtnTable = el(
      'table',
      { class: 'rtn-table' },
      el('thead', {}, el('tr', {}, ['Routing number', 'Purpose', 'Active', 'Preferred'].map((h) => el('th', { text: h })))),
      el(
        'tbody',
        {},
        p.routingNumbers.map((x) =>
          el(
            'tr',
            { class: x.routingNumber === r.routing.value ? 'current' : null },
            el('td', { text: x.routingNumber }),
            el('td', { text: x.purpose || '–' }),
            el('td', { text: x.active ? 'Yes' : 'No' }),
            el('td', { text: x.preferred ? 'Yes' : '' })
          )
        )
      )
    );
  }

  return el(
    'article',
    { class: `card row profile ${c.cls}` },
    el('div', { class: 'row-icon', 'aria-hidden': 'true', text: c.icon }),
    el(
      'div',
      { class: 'row-body' },
      el('div', { class: 'row-head' }, el('h3', { text: 'Identified bank' }), el('span', { class: `pill ${c.cls}`, text: statusLabel })),
      el('p', { class: 'inst-name', text: p.name || inst.name }),
      p.branchName ? el('p', { class: 'inst-sub', text: p.branchName }) : null,
      subtitle ? el('p', { class: 'inst-sub', text: subtitle }) : null,
      rails,
      el(
        'div',
        { class: 'profile-grid' },
        el('section', {}, el('h4', { text: 'Phone numbers' }), phoneList),
        el('section', {}, el('h4', { text: 'Addresses' }), addresses.length ? addresses : el('p', { class: 'muted small', text: 'No address in this directory record.' }))
      ),
      meta.length ? el('div', { class: 'meta' }, meta) : null,
      rtnTable ? el('details', { class: 'rtn-details' }, el('summary', { text: `Routing numbers at this institution (${p.routingNumbers.length})` }), rtnTable) : null,
      p.notes ? el('p', { class: 'muted small', text: `Note: ${p.notes}` }) : null,
      notes.length ? el('ul', { class: 'row-lines' }, notes.map((l) => el('li', { text: l }))) : null
    )
  );
}

function row({ title, color, status, value, lines = [], extra }) {
  const c = COLOR[color];
  return el(
    'article',
    { class: `card row ${c.cls}` },
    el('div', { class: 'row-icon', 'aria-hidden': 'true', text: c.icon }),
    el(
      'div',
      { class: 'row-body' },
      el(
        'div',
        { class: 'row-head' },
        el('h3', { text: title }),
        el('span', { class: `pill ${c.cls}`, text: status })
      ),
      value ? el('p', { class: 'row-value', text: value }) : null,
      lines.length ? el('ul', { class: 'row-lines' }, lines.filter(Boolean).map((l) => el('li', { text: l }))) : null,
      extra || null
    )
  );
}

function render(r) {
  els.empty.hidden = true;
  els.results.hidden = false;
  els.checkedAt.textContent = `Checked ${new Date(r.checkedAt).toLocaleString()} · ${r.mode === 'server' ? 'server' : 'browser-only'}`;

  const rows = [];

  // Routing
  rows.push(
    row({
      title: 'Routing number',
      color: routingColor(r.routing.status),
      status: r.routing.status === 'valid' ? 'Valid' : r.routing.status === 'warning' ? 'Valid, see note' : 'Invalid',
      value: r.routing.value || '(empty)',
      lines: [
        ...r.routing.messages,
        r.routing.prefix && r.routing.status !== 'invalid' && r.routing.status !== 'warning' ? r.routing.prefix.description : null,
      ],
    })
  );

  // Institution
  const inst = r.institution;
  const instStatus = {
    identified: 'Identified',
    not_found: 'Not found',
    not_checked: 'Not checked',
    error: 'Lookup failed',
    skipped: 'Not checked',
  }[inst.status] || 'Unknown';
  const instLines = [...(inst.details || [])];
  if (inst.location) instLines.unshift(`Location: ${inst.location}`);
  if (inst.source) instLines.push(`Source: ${inst.source}`);
  if (inst.bankNameComparison) {
    instLines.push(
      {
        match: `The bank name you entered ("${r.input.bankName}") matches.`,
        partial: `The bank name you entered ("${r.input.bankName}") partly matches. Check it.`,
        mismatch: `The bank name you entered ("${r.input.bankName}") does NOT match the directory.`,
      }[inst.bankNameComparison]
    );
  } else if (r.input.bankName && inst.status !== 'identified') {
    instLines.push(`The bank name you entered ("${r.input.bankName}") couldn't be compared because no directory result is available.`);
  }
  let instExtra = null;
  if (inst.status !== 'identified' && r.routing.status !== 'invalid') {
    instExtra = el(
      'p',
      { class: 'row-link' },
      el('a', { href: r.manualLookupUrl || FED_SEARCH_URL, target: '_blank', rel: 'noopener noreferrer', text: 'Look up this routing number on the Federal Reserve directory ↗' })
    );
  }
  if (inst.profile) {
    rows.push(profileCard(inst, r, institutionColor(inst), instStatus, instLines.filter((l) => !String(l).startsWith('Location:'))));
  } else {
    rows.push(row({ title: 'Identified bank', color: institutionColor(inst), status: instStatus, value: inst.name, lines: instLines, extra: instExtra }));
  }

  // ACH
  const ach = r.ach;
  const achLines = [ach.detail];
  if (ach.source) achLines.push(`Source: ${ach.source}`);
  if (ach.otherRails) {
    achLines.push(`Other payment types (${ach.otherRails.source}): wire ${ach.otherRails.wire} · RTP ${ach.otherRails.rtp} · FedNow ${ach.otherRails.fednow}`);
  }
  rows.push(
    row({
      title: 'ACH eligibility',
      color: achColor(ach),
      status: ach.status === 'eligible' ? 'Eligible' : ach.status === 'not_eligible' ? 'Not eligible' : ach.status === 'redirect' ? 'Use another RTN' : 'Unknown',
      lines: achLines,
    })
  );

  // Account format
  const af = r.accountFormat;
  const afLines = [...af.messages];
  if (af.institutionRule?.source) afLines.push(`Rule source: ${af.institutionRule.source}`);
  // Green ONLY when a real provider confirmed the account. A format pass alone stays yellow,
  // because any random number of the right length passes it.
  const confirmed = r.accountVerification.status === 'open_verified';
  const afColor = af.status === 'invalid' || af.suspicious ? 'red' : confirmed && af.status === 'valid' ? 'green' : 'yellow';
  const afLabel =
    af.status === 'invalid'
      ? 'Invalid format'
      : af.suspicious
        ? 'Looks fake'
        : confirmed
          ? 'Confirmed by provider'
          : af.status === 'warning'
            ? 'Check this'
            : 'Format OK · NOT verified';
  rows.push(
    row({
      title: 'Account number',
      color: afColor,
      status: afLabel,
      value: `${r.input.accountNumberMasked || '(empty)'} · ${r.input.accountType === 'savings' ? 'Savings' : 'Checking'}`,
      lines: afLines,
    })
  );

  // Account verification
  const av = r.accountVerification;
  const avMeta = ACCOUNT_STATUS[av.status] || ACCOUNT_STATUS.unable_to_verify;
  const avLines = [av.detail];
  if (av.provider) avLines.push(`Provider: ${av.provider}${av.environment ? ` (${av.environment})` : ''}`);
  if (typeof av.score === 'number') avLines.push(`Availability score: ${av.score.toFixed(2)} (0 = unlikely open, 1 = likely open)`);
  if (av.decision) avLines.push(`Provider workflow decision: ${av.decision}`);
  if (av.reasonCodes?.length) avLines.push(`Reason codes: ${av.reasonCodes.join(', ')}`);
  if (av.referenceId) avLines.push(`Provider reference: ${av.referenceId}`);
  rows.push(row({ title: 'Account verification', color: avMeta.color, status: avMeta.label, lines: avLines }));

  els.rows.replaceChildren(...rows);

  // Overall banner
  const anyRed = [routingColor(r.routing.status), afColor, avMeta.color, achColor(ach)].includes('red') || inst.status === 'not_found';
  const accountVerified = av.status === 'open_verified';
  let tone, title, text;
  if (anyRed) {
    tone = 'red';
    title = 'Problems found';
    text = 'At least one check failed. See the red items below.';
  } else if (accountVerified) {
    tone = 'green';
    title = 'Account verified';
    text = `${av.provider} reports the account as open. The routing and format checks also passed.`;
  } else {
    tone = 'yellow';
    title = 'Account NOT verified. It may or may not be real';
    text =
      'The numbers have a valid format, but a random number of the right length would pass these checks too. Confirming the account exists needs the bank or a connected verification service (e.g. Lyons AOA).';
  }
  els.overall.className = `overall ${tone}`;
  els.overall.replaceChildren(el('strong', { text: title }), el('span', { text }));

  els.verifiedList.replaceChildren(...r.summary.verified.map((t) => el('li', { text: t })));
  els.notVerifiedList.replaceChildren(...r.summary.notVerified.map((t) => el('li', { text: t })));

  if (window.matchMedia('(max-width: 900px)').matches) {
    els.results.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

detectServer();
