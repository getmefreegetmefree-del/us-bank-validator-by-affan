/**
 * Local FedACH Participant Directory (Federal Reserve E-Payments Routing Directory).
 *
 * This is the authoritative source for "is this routing number a FedACH participant
 * (i.e. can it receive ACH entries)". The Federal Reserve no longer publishes the full
 * file publicly. Financial institutions download it through FedLine, and businesses can
 * usually get it from the bank that processes their ACH (see README).
 *
 * Supported formats (drop the file into ./data or point FEDACH_DIRECTORY_PATH at it):
 *   1. Legacy fixed-width text  (FedACHdir.txt, 155-character records)
 *   2. JSON                     (any JSON containing an array of participant objects
 *                                 with a "routingNumber" property)
 *
 * The file is loaded into memory once at startup. Nothing submitted by users is ever
 * written to it.
 */
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_CANDIDATES = ['FedACHdir.txt', 'FedACHdir.json', 'fedach.txt', 'fedach.json'];

let directory = null; // Map<routingNumber, participant>
let meta = { loaded: false, path: null, records: 0, format: null, error: null };

function slice(line, start, len) {
  // start is 1-based, matching the Federal Reserve's published layout.
  return line.substr(start - 1, len).trim();
}

function parseFixedWidth(text) {
  const map = new Map();
  for (const rawLine of text.split(/\r?\n/)) {
    if (rawLine.trim().length < 100) continue;
    const line = rawLine.padEnd(155, ' ');
    const routingNumber = slice(line, 1, 9);
    if (!/^\d{9}$/.test(routingNumber)) continue;
    map.set(routingNumber, {
      routingNumber,
      officeCode: slice(line, 10, 1), // O = main office, B = branch
      servicingFRBNumber: slice(line, 11, 9),
      recordTypeCode: slice(line, 20, 1), // 0 = FRB, 1 = use this RTN, 2 = use newRoutingNumber
      changeDate: slice(line, 21, 6), // MMDDYY
      newRoutingNumber: slice(line, 27, 9),
      name: slice(line, 36, 36),
      address: slice(line, 72, 36),
      city: slice(line, 108, 20),
      state: slice(line, 128, 2),
      zip: slice(line, 130, 5),
      zipExt: slice(line, 135, 4),
      phone: [slice(line, 139, 3), slice(line, 142, 3), slice(line, 145, 4)].filter(Boolean).join('-'),
      institutionStatusCode: slice(line, 149, 1),
      dataViewCode: slice(line, 150, 1),
    });
  }
  return map;
}

function findParticipantArray(node, depth = 0) {
  if (depth > 6 || node == null) return null;
  if (Array.isArray(node)) {
    if (node.length && typeof node[0] === 'object' && node[0] && 'routingNumber' in node[0]) return node;
    for (const item of node) {
      const found = findParticipantArray(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof node === 'object') {
    for (const value of Object.values(node)) {
      const found = findParticipantArray(value, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function parseJson(text) {
  const arr = findParticipantArray(JSON.parse(text)) || [];
  const map = new Map();
  for (const p of arr) {
    const routingNumber = String(p.routingNumber || '').trim();
    if (!/^\d{9}$/.test(routingNumber)) continue;
    map.set(routingNumber, {
      routingNumber,
      officeCode: p.officeCode || '',
      servicingFRBNumber: p.servicingFRBNumber || '',
      recordTypeCode: String(p.recordTypeCode ?? ''),
      changeDate: p.changeDate || '',
      newRoutingNumber: (p.newRoutingNumber || '').trim(),
      name: (p.customerName || p.name || '').trim(),
      address: (p.customerAddress || '').trim(),
      city: (p.customerCity || '').trim(),
      state: (p.customerState || '').trim(),
      zip: (p.customerZipCode || '').trim(),
      zipExt: (p.customerZipCodeExtension || '').trim(),
      phone: [p.customerAreaCode, p.customerPhonePrefix, p.customerPhoneSuffix].filter(Boolean).join('-'),
      institutionStatusCode: String(p.institutionStatusCode ?? ''),
      dataViewCode: String(p.dataViewCode ?? ''),
    });
  }
  return map;
}

export function loadFedAchDirectory({ explicitPath, dataDir }) {
  const candidates = explicitPath
    ? [path.resolve(explicitPath)]
    : DEFAULT_CANDIDATES.map((f) => path.join(dataDir, f));
  const file = candidates.find((p) => fs.existsSync(p));
  if (!file) {
    meta = { loaded: false, path: null, records: 0, format: null, error: explicitPath ? `File not found: ${explicitPath}` : null };
    directory = null;
    return meta;
  }
  try {
    const text = fs.readFileSync(file, 'utf8');
    const isJson = text.trimStart().startsWith('{') || text.trimStart().startsWith('[');
    directory = isJson ? parseJson(text) : parseFixedWidth(text);
    const stat = fs.statSync(file);
    meta = {
      loaded: directory.size > 0,
      path: path.basename(file),
      records: directory.size,
      format: isJson ? 'json' : 'fixed-width',
      fileDate: stat.mtime.toISOString().slice(0, 10),
      error: directory.size === 0 ? 'File parsed but contained no routing records.' : null,
    };
  } catch (err) {
    directory = null;
    meta = { loaded: false, path: path.basename(file), records: 0, format: null, error: `Could not parse directory: ${err.message}` };
  }
  return meta;
}

export function fedAchMeta() {
  return meta;
}

/**
 * @returns {null | { found: boolean, participant?: object }}
 *   null when no directory is loaded (source unavailable).
 */
export function lookupFedAch(routingNumber) {
  if (!directory) return null;
  const participant = directory.get(routingNumber);
  return participant ? { found: true, participant } : { found: false };
}
