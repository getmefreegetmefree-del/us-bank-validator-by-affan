/**
 * Routing-number intelligence: institution profile + ACH eligibility.
 *
 * Sources (any combination can be connected):
 *   1. Lyons Commercial Data RTN 2.1 API: full institution profile (same data as iBankRegistry)
 *   2. Local FedACH Participant Directory file: authoritative ACH participation
 *   3. Increase routing-number API: name + ACH / wire / RTP / FedNow capability
 *
 * Profile: first source that finds the routing number, in the order above.
 * ACH eligibility: FedACH file first (it IS the Fed's participant list), then Lyons, then Increase.
 * If no source is configured, the result says so plainly. Nothing is guessed.
 */
import { lookupFedAch, fedAchMeta } from './fedachDirectory.js';
import { lookupIncrease, increaseConfigured } from './increase.js';
import { lookupLyonsRtn, lyonsConfigured } from '../lyons.js';
import { compareBankNames } from '../../public/js/validation.js';

export const FED_SEARCH_URL =
  'https://www.frbservices.org/resources/e-payments-routing-directory/search-fedach-participant-rdfis/';

const RAIL = { supported: true, not_supported: false };

function titleCase(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase())
    .replace(/\bNa\b/g, 'NA')
    .replace(/\bFsb\b/g, 'FSB')
    .replace(/\bPo Box\b/g, 'PO Box');
}

export function routingSourcesSummary(env = process.env) {
  const fed = fedAchMeta();
  return {
    lyons: { configured: lyonsConfigured(env) },
    fedachDirectory: fed.loaded
      ? { configured: true, records: fed.records, file: fed.path, fileDate: fed.fileDate }
      : { configured: false, error: fed.error || undefined },
    increase: { configured: increaseConfigured(env) },
  };
}

function fedProfile(p) {
  const officeAddress = [titleCase(p.address), `${titleCase(p.city)}, ${p.state} ${p.zip}${p.zipExt && p.zipExt !== '0000' ? `-${p.zipExt}` : ''}`.trim()].filter(
    (s) => s && s !== ','
  );
  return {
    name: titleCase(p.name),
    branchName: null,
    officeType: p.officeCode === 'O' ? 'Main Office' : p.officeCode === 'B' ? 'Branch' : null,
    institutionType: null,
    location: [titleCase(p.city), p.state].filter(Boolean).join(', ') || null,
    phones: p.phone ? [{ label: 'Institution', number: p.phone, extension: null }] : [],
    emails: [],
    officeAddress,
    mailingAddress: [],
    homePage: null,
    swift: null,
    institutionId: null,
    branchCount: null,
    active: true,
    notes: p.recordTypeCode === '2' && p.newRoutingNumber ? `Routing number replaced by ${p.newRoutingNumber}` : null,
    routingNumbers: [],
    rails: { wire: null, rtp: null, fednow: null },
    extra: [
      p.servicingFRBNumber ? { label: 'Servicing FRB', value: p.servicingFRBNumber } : null,
      p.changeDate ? { label: 'Last change (MMDDYY)', value: p.changeDate } : null,
    ].filter(Boolean),
  };
}

/**
 * @param {string} routingNumber  Already checksum-validated, 9 digits.
 * @param {string} enteredBankName  Optional, for comparison only.
 */
export async function analyzeRouting(routingNumber, enteredBankName, env = process.env) {
  const institution = {
    status: 'not_checked', // identified | not_found | not_checked | error
    name: null,
    location: null,
    source: null,
    profile: null,
    details: [],
    bankNameComparison: null,
  };
  const ach = { status: 'unknown', source: null, detail: null, otherRails: null };
  const consulted = [];
  const errors = [];
  let anyNotFound = false;

  const setProfile = (profile, source) => {
    if (institution.profile) return;
    institution.status = 'identified';
    institution.profile = profile;
    institution.name = profile.name;
    institution.location = profile.location;
    institution.source = source;
  };

  // Run the remote lookups in parallel.
  const [lyons, inc] = await Promise.all([
    lyonsConfigured(env) ? lookupLyonsRtn(routingNumber, env) : null,
    increaseConfigured(env) ? lookupIncrease(routingNumber, env) : null,
  ]);
  const fed = lookupFedAch(routingNumber);

  // 1) Lyons
  if (lyons) {
    consulted.push('Lyons Commercial Data');
    if (lyons.error) errors.push(lyons.error);
    else if (lyons.found) setProfile(lyons.profile, 'Lyons Commercial Data (RTN directory)');
    else anyNotFound = true;
  }

  // 2) FedACH directory
  if (fed) {
    consulted.push('FedACH Participant Directory');
    const meta = fedAchMeta();
    const fedSource = `Federal Reserve FedACH Participant Directory (${meta.path}, file dated ${meta.fileDate})`;
    if (fed.found) {
      const p = fed.participant;
      setProfile(fedProfile(p), fedSource);
      ach.source = 'Federal Reserve FedACH Participant Directory';
      if (p.recordTypeCode === '2' && /^\d{9}$/.test(p.newRoutingNumber) && p.newRoutingNumber !== routingNumber) {
        ach.status = 'redirect';
        ach.detail = `Listed as a FedACH participant, but the Fed routes ACH items to a NEW routing number: ${p.newRoutingNumber}. Use the new number.`;
      } else if (p.recordTypeCode === '0') {
        ach.status = 'not_eligible';
        ach.detail = 'This routing number belongs to a Federal Reserve Bank, not a receiving institution.';
      } else {
        ach.status = 'eligible';
        ach.detail = 'Listed in the FedACH Participant Directory as a Receiving Depository Financial Institution (RDFI), so it can receive ACH entries.';
      }
    } else {
      anyNotFound = true;
      ach.status = 'not_eligible';
      ach.source = 'Federal Reserve FedACH Participant Directory';
      ach.detail = 'Not listed in the FedACH Participant Directory, so ACH entries to this routing number would likely be returned.';
    }
  }

  // Lyons ACH info (only if the FedACH file didn't already decide)
  if (lyons?.found && !fed) {
    ach.status = lyons.ach.status;
    ach.detail = lyons.ach.detail;
    ach.source = 'Lyons Commercial Data';
  }

  // 3) Increase
  if (inc) {
    consulted.push('Increase routing-number API');
    if (inc.error) errors.push(inc.error);
    else if (inc.found) {
      setProfile(
        {
          name: inc.participant.name,
          phones: [],
          emails: [],
          officeAddress: [],
          mailingAddress: [],
          routingNumbers: [],
          active: true,
          rails: { wire: RAIL[inc.rails.wire] ?? null, rtp: RAIL[inc.rails.rtp] ?? null, fednow: RAIL[inc.rails.fednow] ?? null },
        },
        'Increase routing-number API'
      );
      ach.otherRails = { wire: inc.rails.wire, rtp: inc.rails.rtp, fednow: inc.rails.fednow, source: 'Increase routing-number API' };
      // Fill missing rail info on a richer profile
      const r = institution.profile.rails || (institution.profile.rails = {});
      if (r.wire == null) r.wire = RAIL[inc.rails.wire] ?? null;
      if (r.rtp == null) r.rtp = RAIL[inc.rails.rtp] ?? null;
      if (r.fednow == null) r.fednow = RAIL[inc.rails.fednow] ?? null;
      if (ach.status === 'unknown') {
        ach.status = inc.rails.ach === 'supported' ? 'eligible' : inc.rails.ach === 'not_supported' ? 'not_eligible' : 'unknown';
        ach.source = 'Increase routing-number API';
        ach.detail =
          ach.status === 'eligible'
            ? 'Increase reports this routing number can receive ACH transfers.'
            : ach.status === 'not_eligible'
              ? 'Increase reports this routing number cannot receive ACH transfers.'
              : 'Increase did not report ACH capability.';
      }
    } else anyNotFound = true;
  }

  if (institution.status !== 'identified') {
    if (consulted.length === 0) {
      institution.status = 'not_checked';
      institution.details.push(
        'No routing directory is connected, so the bank could not be identified. The checksum alone cannot tell you which bank a number belongs to.'
      );
      ach.detail = 'ACH eligibility needs a routing directory (Lyons, the FedACH file or Increase). None is connected.';
    } else if (!anyNotFound && errors.length) {
      institution.status = 'error';
      institution.details.push(...errors);
      ach.detail = ach.detail || 'Routing lookup failed, so ACH eligibility is unknown.';
    } else {
      institution.status = 'not_found';
      institution.details.push(
        `Not found in: ${consulted.join(', ')}. The number passes the checksum but may be unassigned, retired, or not an ACH participant.`
      );
      if (errors.length) institution.details.push(...errors);
      if (ach.status === 'unknown') ach.detail = 'Could not be determined from the connected sources.';
    }
  } else if (errors.length) {
    institution.details.push(...errors.map((e) => `Note: ${e}`));
  }

  if (institution.profile && institution.profile.active === false) {
    institution.details.unshift('This institution / routing number is marked INACTIVE by the directory.');
  }

  if (enteredBankName && institution.name) {
    institution.bankNameComparison = compareBankNames(enteredBankName, institution.name);
  }

  return { institution, ach, consulted, manualLookupUrl: FED_SEARCH_URL };
}
