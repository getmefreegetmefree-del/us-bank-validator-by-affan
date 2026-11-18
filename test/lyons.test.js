/**
 * Lyons integration tests against a LOCAL MOCK of the Lyons REST API.
 * All institution data below is fictional and exists only in this test.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createApp } from '../server/index.js';
import { interpretLyonsAoa, mapLyonsInstitution } from '../server/lyons.js';

let mock, app, base, logons = 0;

const INSTITUTION = {
  institutionId: 9001,
  legacyLyonsId: 555001,
  mainInstitutionId: null,
  institutionType: 'Credit Unions',
  name: 'TEST FIXTURE CREDIT UNION',
  branchName: 'TEST FIXTURE CREDIT UNION',
  addressLine1: '100 EXAMPLE PKWY',
  addressLine2: null,
  city: 'TESTVILLE',
  state: 'TX',
  country: 'US',
  postalCode: '75000-0000',
  mailingAddr: 'PO BOX 1  TESTVILLE, TX 75001',
  fedWire: true,
  swift: '',
  fax: '(555) 010-0002',
  homePage: 'www.example.org',
  notes: null,
  active: true,
  branchCount: 14,
  routingNumbers: [
    { routingNumber: '311990511', purpose: 'ABA', active: true, preferred: true, useForTransactions: true },
    { routingNumber: '311990511', purpose: 'ACH', active: true, preferred: true, useForTransactions: true },
  ],
  contacts: [
    { contactType: 'Institution', phoneNumber: '(555) 010-0001' },
    { contactType: 'Customer Service', phoneNumber: '(555) 010-0000' },
    { contactType: 'Wire', phoneNumber: '(555) 010-0000' },
    { contactType: 'ACH', phoneNumber: '(555) 010-0000', name: 'Pat Example' },
  ],
  tags: [{ name: 'RTP', value: 'true' }, { name: 'FEDNow', value: 'false' }],
};

before(async () => {
  const m = express();
  m.use(express.json());
  const logon = (req, res) => {
    logons++;
    if (req.body.companyId === 'C1' && req.body.userName === 'u' && req.body.password === 'p') res.json({ errorMessage: null, token: 'tok-1' });
    else res.json({ errorMessage: 'Invalid credentials', token: null });
  };
  m.post('/rtn/rest/Logon', logon);
  m.post('/aoa/rest/Logon', logon);
  m.post('/rtn/rest/GetPrimaryInstitutionDetails', (req, res) => {
    assert.equal(req.body.token, 'tok-1');
    if (req.body.rtn === '311990511') return res.json({ errorMessage: null, institution: INSTITUTION });
    res.json({ errorMessage: 'No financial institutions found', institution: null });
  });
  m.post('/aoa/rest/CheckAccountStatusWithDates', (req, res) => {
    assert.equal(req.body.token, 'tok-1');
    const acct = req.body.accountStatusRequest.accountNo;
    assert.ok(Number(req.body.accountStatusRequest.amount) >= 0.01);
    const map = { '1010101010': [101, 'Accept'], '1030303030': [103, 'Deny'], '1980000000': [198, 'No Account Experience Available'] };
    const [statusCode, statusDescription] = map[acct] || [199, 'Insufficient info to make a decision'];
    res.json({ errorMessage: null, statusCode, statusDescription, validRtn: true });
  });
  await new Promise((r) => (mock = m.listen(0, r)));
  const mockBase = `http://127.0.0.1:${mock.address().port}`;

  const a = createApp({
    LYONS_COMPANY_ID: 'C1',
    LYONS_USERNAME: 'u',
    LYONS_PASSWORD: 'p',
    LYONS_RTN_URL: `${mockBase}/rtn`,
    LYONS_AOA_URL: `${mockBase}/aoa`,
    ACCOUNT_VERIFICATION_PROVIDER: 'lyons',
    RATE_LIMIT_PER_MINUTE: '100',
  });
  await new Promise((r) => (app = a.listen(0, r)));
  base = `http://127.0.0.1:${app.address().port}`;
});

after(() => {
  app?.close();
  mock?.close();
});

const verify = async (accountNumber, routingNumber = '311990511') =>
  (await fetch(`${base}/api/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bankName: 'Test Fixture', routingNumber, accountNumber, accountType: 'checking' }),
  })).json();

test('health shows Lyons connected for directory and account status', async () => {
  const h = await (await fetch(`${base}/api/health`)).json();
  assert.equal(h.routingSources.lyons.configured, true);
  assert.equal(h.accountVerification.provider, 'Lyons Commercial Data (AOA)');
  assert.equal(h.accountVerification.ready, true);
  assert.ok(!JSON.stringify(h).includes('"p"'));
});

test('full registry-style profile from Lyons', async () => {
  const r = await verify('1010101010');
  const p = r.institution.profile;
  assert.equal(r.institution.status, 'identified');
  assert.equal(r.institution.bankNameComparison, 'match');
  assert.equal(p.name, 'TEST FIXTURE CREDIT UNION');
  assert.equal(p.officeType, 'Main Office');
  assert.equal(p.location, 'TESTVILLE, TX');
  assert.equal(p.institutionId, 555001);
  assert.equal(p.branchCount, 14);
  assert.equal(p.homePage, 'https://www.example.org/');
  assert.deepEqual(p.officeAddress, ['100 EXAMPLE PKWY', 'TESTVILLE, TX 75000-0000']);
  assert.deepEqual(p.mailingAddress, ['PO BOX 1', 'TESTVILLE, TX 75001']);
  assert.deepEqual(p.phones.map((x) => x.label), ['Customer Service', 'Wire', 'Institution', 'ACH Dept', 'Main Fax']);
  assert.equal(p.achContactName, 'Pat Example');
  assert.deepEqual(p.rails, { wire: true, rtp: true, fednow: false });
  assert.equal(r.ach.status, 'eligible');
  assert.equal(r.ach.source, 'Lyons Commercial Data');
});

test('Lyons AOA statuses map correctly', async () => {
  assert.equal((await verify('1010101010')).accountVerification.status, 'open_verified');
  assert.equal((await verify('1030303030')).accountVerification.status, 'possibly_closed');
  assert.equal((await verify('1980000000')).accountVerification.status, 'not_found');
  assert.equal((await verify('4829173650')).accountVerification.status, 'unable_to_verify');
  const r = await verify('1010101010');
  assert.equal(r.accountVerification.providerCode, 101);
  assert.ok(!JSON.stringify(r).includes('1010101010'), 'full account number must not be echoed');
});

test('token is cached between requests', async () => {
  const before = logons;
  await verify('1010101010');
  await verify('1010101010');
  assert.equal(logons, before, 'no new logons while token is fresh');
});

test('routing number not in Lyons → not found', async () => {
  const r = await verify('1010101010', '021000021');
  assert.equal(r.institution.status, 'not_found');
});

test('interpretLyonsAoa handles errors and input codes', () => {
  assert.equal(interpretLyonsAoa({ statusCode: -31, statusDescription: 'Account Number value must be numeric.' }).status, 'invalid');
  assert.equal(interpretLyonsAoa({ statusCode: -999 }).status, 'unable_to_verify');
  assert.equal(interpretLyonsAoa({ statusCode: 101, validRtn: false }).status, 'invalid');
  assert.equal(interpretLyonsAoa({ statusCode: 104 }).status, 'possibly_closed');
});

test('mapLyonsInstitution rejects unsafe homepage values', () => {
  assert.equal(mapLyonsInstitution({ ...INSTITUTION, homePage: 'javascript:alert(1)' }, '311990511').homePage, null);
  assert.equal(mapLyonsInstitution({ ...INSTITUTION, homePage: '' }, '311990511').homePage, null);
});
