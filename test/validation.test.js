import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  abaChecksumValid,
  validateRoutingNumber,
  validateAccountNumber,
  maskAccountNumber,
  compareBankNames,
} from '../public/js/validation.js';

test('ABA checksum accepts well-known valid routing numbers', () => {
  for (const rtn of ['021000021', '011000015', '121000248', '026009593', '322271627']) {
    assert.equal(abaChecksumValid(rtn), true, rtn);
  }
});

test('ABA checksum rejects single-digit typos', () => {
  assert.equal(abaChecksumValid('021000022'), false);
  assert.equal(abaChecksumValid('121000249'), false);
  assert.equal(abaChecksumValid('123456789'), false);
});

test('routing format errors', () => {
  assert.equal(validateRoutingNumber('').status, 'invalid');
  assert.equal(validateRoutingNumber('12345678').formatValid, false);
  assert.equal(validateRoutingNumber('12345678a').formatValid, false);
  assert.equal(validateRoutingNumber('0210000210').formatValid, false);
});

test('routing number with spaces/hyphens is normalized', () => {
  const r = validateRoutingNumber(' 0210-00021 ');
  assert.equal(r.value, '021000021');
  assert.equal(r.status, 'valid');
});

test('routing prefix rules', () => {
  // Valid checksum but unassigned prefix (e.g. 50xxxxxxx)
  const findValid = (prefix) => {
    for (let i = 0; i < 10_000_000; i++) {
      const n = prefix + String(i).padStart(7, '0');
      if (abaChecksumValid(n)) return n;
    }
  };
  const bad = validateRoutingNumber(findValid('50'));
  assert.equal(bad.checksumValid, true);
  assert.equal(bad.status, 'invalid');

  const thrift = validateRoutingNumber('322271627');
  assert.match(thrift.prefix.description, /thrift/);
  assert.equal(thrift.status, 'valid');

  const travelers = validateRoutingNumber(findValid('80'));
  assert.equal(travelers.status, 'warning');
});

test('account number format', () => {
  assert.equal(validateAccountNumber('').status, 'invalid');
  assert.equal(validateAccountNumber('123').status, 'invalid');
  assert.equal(validateAccountNumber('123456789012345678').status, 'invalid'); // 18
  assert.equal(validateAccountNumber('0000000').status, 'invalid');
  assert.equal(validateAccountNumber('12a456').status, 'invalid');
  assert.equal(validateAccountNumber('1234').status, 'warning');
  assert.equal(validateAccountNumber('58204817392046157').status, 'valid'); // 17
  assert.equal(validateAccountNumber('12345678901234567').suspicious, true);
  assert.equal(validateAccountNumber('4829173650').status, 'valid');
  assert.equal(validateAccountNumber('1111111111').status, 'warning');
  assert.equal(validateAccountNumber('021000021', { routing: '021000021' }).status, 'warning');
});

test('made-up account number patterns are flagged', () => {
  for (const v of ['123456789', '9876543210', '121212121212', '123123123', '4444444444', '10000000']) {
    const r = validateAccountNumber(v);
    assert.equal(r.suspicious, true, v);
    assert.equal(r.status, 'warning', v);
  }
  for (const v of ['4829173650', '000123456789', '58004820']) {
    assert.ok(!validateAccountNumber(v).suspicious, v);
  }
  // A clean format pass always carries the "not proof" message
  assert.ok(validateAccountNumber('4829173650').messages.some((m) => /random/.test(m)));
});

test('institution rule applied only when configured', () => {
  const rule = { minLength: 10, maxLength: 12, institution: 'X', source: 'spec' };
  assert.equal(validateAccountNumber('48291736', { rule }).status, 'invalid');
  const ok = validateAccountNumber('4829173650', { rule });
  assert.equal(ok.status, 'valid');
  assert.equal(ok.institutionRule.passed, true);
  assert.equal(validateAccountNumber('48291736').institutionRule, null);
});

test('masking shows only last 4 digits', () => {
  assert.equal(maskAccountNumber('4829173650'), '••••••3650');
  assert.equal(maskAccountNumber('1234'), '••••');
  assert.ok(!maskAccountNumber('99998888777766').includes('9999'));
});

test('bank name comparison', () => {
  assert.equal(compareBankNames('Bank of America', 'BANK OF AMERICA, N.A.'), 'match');
  assert.equal(compareBankNames('Chase', 'JPMORGAN CHASE BANK, NA'), 'match');
  assert.equal(compareBankNames('Wells Fargo', 'JPMORGAN CHASE BANK, NA'), 'mismatch');
  assert.equal(compareBankNames('', 'X BANK'), null);
});
