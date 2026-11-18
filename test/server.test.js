import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/index.js';
import { interpretSocureResponse } from '../server/accounts/socure.js';

/**
 * Builds a TEST-ONLY FedACH fixed-width record (155 chars).
 * The institution names are fictional and exist only inside this test.
 */
function record({ rtn, type = '1', newRtn = '000000000', name, city, state }) {
  const pad = (s, n) => String(s).padEnd(n, ' ').slice(0, n);
  return (
    pad(rtn, 9) + 'O' + pad('011000015', 9) + type + '010126' + pad(newRtn, 9) +
    pad(name, 36) + pad('1 TEST ST', 36) + pad(city, 20) + pad(state, 2) +
    '00000' + '0000' + '555' + '555' + '0100' + '1' + '1' + '     '
  );
}

let server, base, tmpDir;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'usbv-'));
  const file = path.join(tmpDir, 'FedACHdir.txt');
  fs.writeFileSync(
    file,
    [
      record({ rtn: '021000021', name: 'TEST FIXTURE BANK ONE NA', city: 'TESTVILLE', state: 'NY' }),
      record({ rtn: '121000248', type: '2', newRtn: '021000021', name: 'TEST FIXTURE MERGED BANK', city: 'TESTVILLE', state: 'CA' }),
    ].join('\n')
  );
  const app = createApp({ FEDACH_DIRECTORY_PATH: file, ACCOUNT_VERIFICATION_PROVIDER: 'none', RATE_LIMIT_PER_MINUTE: '100' });
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const verify = (body) =>
  fetch(`${base}/api/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('health reports directory loaded and no provider', async () => {
  const h = await (await fetch(`${base}/api/health`)).json();
  assert.equal(h.routingSources.fedachDirectory.configured, true);
  assert.equal(h.routingSources.fedachDirectory.records, 2);
  assert.equal(h.accountVerification.provider, null);
  assert.ok(!JSON.stringify(h).includes('KEY'));
});

test('identified bank, ACH eligible, account NOT verified without provider', async () => {
  const res = await verify({ bankName: 'Test Fixture Bank One', routingNumber: '021000021', accountNumber: '4829173650', accountType: 'checking' });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const r = await res.json();
  assert.equal(r.routing.status, 'valid');
  assert.equal(r.institution.status, 'identified');
  assert.equal(r.institution.name, 'Test Fixture Bank One NA');
  assert.equal(r.institution.bankNameComparison, 'match');
  assert.equal(r.ach.status, 'eligible');
  assert.equal(r.accountFormat.status, 'valid');
  assert.equal(r.accountVerification.status, 'not_configured');
  // Full account number never echoed back
  assert.ok(!JSON.stringify(r).includes('4829173650'));
  assert.equal(r.input.accountNumberMasked, '••••••3650');
});

test('replaced routing number points to new number', async () => {
  const r = await (await verify({ routingNumber: '121000248', accountNumber: '4829173650', accountType: 'savings' })).json();
  assert.equal(r.ach.status, 'eligible');
  assert.match(r.ach.detail, /021000021/);
});

test('checksum-valid but not in directory → not found / not ACH eligible', async () => {
  const r = await (await verify({ routingNumber: '026009593', accountNumber: '4829173650', accountType: 'checking' })).json();
  assert.equal(r.institution.status, 'not_found');
  assert.equal(r.ach.status, 'not_eligible');
});

test('invalid routing skips lookups and provider', async () => {
  const r = await (await verify({ routingNumber: '021000022', accountNumber: '4829173650', accountType: 'checking' })).json();
  assert.equal(r.routing.status, 'invalid');
  assert.equal(r.accountVerification.status, 'skipped');
});

test('bad input rejected', async () => {
  assert.equal((await verify({ routingNumber: '021000021', accountNumber: '1234', accountType: 'brokerage' })).status, 400);
  const bad = await fetch(`${base}/api/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops' });
  assert.equal(bad.status, 400);
});

/* ---------- Socure response interpretation (no network) ---------- */

const settings = (o = {}) => ({ openMinScore: null, closedMaxScore: null, closedCodes: [], invalidCodes: [], notFoundCodes: [], ...o });
const socureBody = (account, reasonCodes = [], status_code = 200) => ({
  decision: 'REVIEW',
  data_enrichments: [
    { enrichment_provider: 'Socure', status_code, response: { accountIntelligence: { account, reasonCodes }, referenceId: 'ref-1' } },
  ],
});

test('Socure: score without thresholds is NOT labeled open', () => {
  const r = interpretSocureResponse(socureBody({ availabilityScore: 0.97 }), settings());
  assert.equal(r.status, 'unable_to_verify');
  assert.equal(r.score, 0.97);
});

test('Socure: thresholds map score to open / closed / uncertain', () => {
  const s = settings({ openMinScore: 0.8, closedMaxScore: 0.2 });
  assert.equal(interpretSocureResponse(socureBody({ availabilityScore: 0.9 }), s).status, 'open_verified');
  assert.equal(interpretSocureResponse(socureBody({ availabilityScore: 0.1 }), s).status, 'possibly_closed');
  assert.equal(interpretSocureResponse(socureBody({ availabilityScore: 0.5 }), s).status, 'unable_to_verify');
});

test('Socure: configured reason codes and explicit status', () => {
  const s = settings({ notFoundCodes: ['R999'], invalidCodes: ['R100'] });
  assert.equal(interpretSocureResponse(socureBody({ availabilityScore: 0.5 }, ['R999']), s).status, 'not_found');
  assert.equal(interpretSocureResponse(socureBody({ availabilityScore: 0.5 }, ['r100']), s).status, 'invalid');
  assert.equal(interpretSocureResponse(socureBody({ accountStatus: 'CLOSED' }), s).status, 'possibly_closed');
});

test('Socure: failed enrichment → unable to verify', () => {
  assert.equal(interpretSocureResponse(socureBody({}, [], 500), settings()).status, 'unable_to_verify');
  assert.equal(interpretSocureResponse({ data_enrichments: [] }, settings()).status, 'unable_to_verify');
});
