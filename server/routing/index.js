/**
 * Routing-number intelligence: institution name + ACH eligibility.
 *
 * Sources, in priority order:
 *   1. Local FedACH Participant Directory file (authoritative, Federal Reserve data)
 *   2. Increase routing-number API (if INCREASE_API_KEY is set)
 *
 * If no source is configured, the result says so plainly. Nothing is guessed.
 */
import { lookupFedAch, fedAchMeta } from './fedachDirectory.js';
import { lookupIncrease, increaseConfigured } from './increase.js';
import { compareBankNames } from '../../public/js/validation.js';

export const FED_SEARCH_URL =
  'https://www.frbservices.org/resources/e-payments-routing-directory/search-fedach-participant-rdfis/';

const RAIL_LABEL = { supported: 'supported', not_supported: 'not supported' };

function titleCase(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase())
    .replace(/\bNa\b/g, 'NA')
    .replace(/\bFsb\b/g, 'FSB');
}

export function routingSourcesSummary(env = process.env) {
  const fed = fedAchMeta();
  return {
    fedachDirectory: fed.loaded
      ? { configured: true, records: fed.records, file: fed.path, fileDate: fed.fileDate }
      : { configured: false, error: fed.error || undefined },
    increase: { configured: increaseConfigured(env) },
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
    details: [],
    bankNameComparison: null,
  };
  const ach = {
    status: 'unknown', // eligible | not_eligible | unknown
    source: null,
    detail: null,
    otherRails: null,
  };

  const consulted = [];
  const errors = [];

  // 1) FedACH directory file
  const fed = lookupFedAch(routingNumber);
  if (fed) {
    consulted.push('FedACH Participant Directory');
    if (fed.found) {
      const p = fed.participant;
      institution.status = 'identified';
      institution.name = titleCase(p.name);
      institution.location = [titleCase(p.city), p.state].filter(Boolean).join(', ') || null;
      institution.source = `Federal Reserve FedACH Participant Directory (${fedAchMeta().path}, file dated ${fedAchMeta().fileDate})`;
      if (p.officeCode) institution.details.push(p.officeCode === 'O' ? 'Main office record' : 'Branch record');
      if (p.phone) institution.details.push(`Phone on file: ${p.phone}`);

      if (p.recordTypeCode === '2' && /^\d{9}$/.test(p.newRoutingNumber) && p.newRoutingNumber !== routingNumber) {
        ach.status = 'eligible';
        ach.detail = `Listed as a FedACH participant, but the Fed directs ACH items to a NEW routing number: ${p.newRoutingNumber}. Use the new number for ACH.`;
        institution.details.push(`Routing number has been replaced by ${p.newRoutingNumber}.`);
      } else if (p.recordTypeCode === '0') {
        ach.status = 'not_eligible';
        ach.detail = 'This routing number belongs to a Federal Reserve Bank, not a receiving depository institution.';
      } else {
        ach.status = 'eligible';
        ach.detail = 'Listed in the FedACH Participant Directory as a Receiving Depository Financial Institution (RDFI), so it can receive ACH entries.';
      }
      ach.source = 'Federal Reserve FedACH Participant Directory';
    }
  }

  // 2) Increase (used if FedACH didn't identify the bank, or to add other-rail info)
  if (increaseConfigured(env)) {
    const inc = await lookupIncrease(routingNumber, env);
    consulted.push('Increase routing-number API');
    if (inc?.error) {
      errors.push(inc.error);
    } else if (inc?.found) {
      if (institution.status !== 'identified') {
        institution.status = 'identified';
        institution.name = inc.participant.name;
        institution.source = 'Increase routing-number API';
      }
      ach.otherRails = {
        wire: RAIL_LABEL[inc.rails.wire] || inc.rails.wire || 'unknown',
        rtp: RAIL_LABEL[inc.rails.rtp] || inc.rails.rtp || 'unknown',
        fednow: RAIL_LABEL[inc.rails.fednow] || inc.rails.fednow || 'unknown',
        source: 'Increase routing-number API',
      };
      if (ach.status === 'unknown') {
        ach.status = inc.rails.ach === 'supported' ? 'eligible' : inc.rails.ach === 'not_supported' ? 'not_eligible' : 'unknown';
        ach.source = 'Increase routing-number API';
        ach.detail =
          ach.status === 'eligible'
            ? 'Increase reports this routing number can receive ACH transfers.'
            : ach.status === 'not_eligible'
              ? 'Increase reports this routing number cannot receive ACH transfers.'
              : 'Increase did not report ACH capability for this routing number.';
      }
    }
  }

  if (institution.status !== 'identified') {
    if (consulted.length === 0) {
      institution.status = 'not_checked';
      institution.details.push(
        'No routing directory is connected, so the bank could not be identified. The checksum alone cannot tell you which bank a number belongs to.'
      );
      ach.detail = 'ACH eligibility needs the FedACH directory or a routing API. Neither is connected.';
    } else if (!fed && errors.length > 0) {
      // The only source consulted (the API) failed: we genuinely don't know.
      institution.status = 'error';
      institution.details.push(...errors);
      ach.detail = 'Routing lookup failed, so ACH eligibility is unknown.';
    } else {
      institution.status = 'not_found';
      institution.details.push(
        `Not found in: ${consulted.join(', ')}. The number passes the checksum but may be unassigned, retired, or not an ACH participant.`
      );
      if (errors.length) institution.details.push(...errors);
      if (fed && !fed.found) {
        ach.status = 'not_eligible';
        ach.source = 'Federal Reserve FedACH Participant Directory';
        ach.detail = 'Not listed in the FedACH Participant Directory, so ACH entries to this routing number would likely be returned.';
      } else {
        ach.detail = 'Could not be determined from the connected sources.';
      }
    }
  }

  if (enteredBankName && institution.name) {
    institution.bankNameComparison = compareBankNames(enteredBankName, institution.name);
  }

  return { institution, ach, consulted, manualLookupUrl: FED_SEARCH_URL };
}
