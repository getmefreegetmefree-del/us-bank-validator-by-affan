/**
 * Optional institution-specific account-number length rules.
 *
 * There is no authoritative public registry of account-number lengths per bank, so this
 * app ships with NO rules enabled. Add rules to data/institution-rules.json only when you
 * have a reliable source (e.g. the bank's own documentation or your processor's spec).
 * See data/institution-rules.example.json for the format.
 */
import fs from 'node:fs';
import path from 'node:path';

let byRouting = new Map();
let meta = { loaded: false, rules: 0, error: null };

export function loadInstitutionRules(dataDir) {
  const file = path.join(dataDir, 'institution-rules.json');
  byRouting = new Map();
  if (!fs.existsSync(file)) {
    meta = { loaded: false, rules: 0, error: null };
    return meta;
  }
  try {
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    const rules = Array.isArray(json.rules) ? json.rules : [];
    for (const rule of rules) {
      if (!rule.source) continue; // rules without a cited source are ignored on purpose
      for (const rtn of rule.routingNumbers || []) {
        if (/^\d{9}$/.test(rtn)) byRouting.set(rtn, rule);
      }
    }
    meta = { loaded: true, rules: rules.filter((r) => r.source).length, error: null };
  } catch (err) {
    meta = { loaded: false, rules: 0, error: `institution-rules.json is invalid: ${err.message}` };
  }
  return meta;
}

export function ruleForRouting(routingNumber) {
  return byRouting.get(routingNumber) || null;
}

export function institutionRulesMeta() {
  return meta;
}
