/**
 * Read-mostly adapter over the host's credential store, for live tests only.
 *
 * The live runner drives the plugin's real tool code against the real Feishu
 * API, so it needs the same `credentials` service the host injects. Reusing the
 * host implementation is not possible outside a cordis Context, and copying the
 * whole store would be a second source of truth, so this module does the
 * smallest thing that is correct for testing:
 *
 *  - read `refs.<KEY>` and `records.<KEY>.payload` out of the YAML document;
 *  - refuse every write, loudly.
 *
 * The refusal is the point. A live run must never rotate the stored grant: the
 * refresh token is single-use, so a write that half-succeeds would leave the
 * real grant unusable. The runner asserts that no rotation happened instead.
 *
 * @module dsh-feishu/test/live/credentials
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Where the host keeps the credential document. */
export const CREDENTIALS_PATH = join(homedir(), '.dsh', '.credentials.yaml');

/**
 * Strip one layer of YAML quoting and decode the escapes a scalar can carry.
 * @param raw - the raw scalar text.
 * @returns the decoded value.
 */
function decodeScalar(raw) {
  const text = raw.trim();
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === '"' || first === "'") && last === first) {
      const body = text.slice(1, -1);
      if (first === "'") return body.replace(/''/gu, "'");
      return body.replace(/\\n/gu, '\n').replace(/\\t/gu, '\t').replace(/\\"/gu, '"').replace(/\\\\/gu, '\\');
    }
  }
  // Strip trailing YAML comments only when they are clearly separated.
  return text.replace(/\s+#.*$/u, '');
}

/**
 * Read one top-level block (`refs:` or a `records:` entry) as raw lines.
 * @param lines - the document lines.
 * @param header - the exact header text, without indent.
 * @returns the lines belonging to the block, dedented by two spaces.
 */
function blockLines(lines, header) {
  const start = lines.findIndex((line) => line === header);
  if (start < 0) return [];
  const body = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim().length === 0) continue;
    if (!line.startsWith('  ')) break;
    body.push(line);
  }
  return body;
}

/**
 * Parse the reference map.
 * @param lines - the document lines.
 * @returns ref name → value.
 */
function parseRefs(lines) {
  const refs = new Map();
  for (const line of blockLines(lines, 'refs:')) {
    const match = /^ {2}([A-Za-z0-9_.:-]+):\s*(.*)$/u.exec(line);
    if (match !== null) refs.set(match[1], decodeScalar(match[2]));
  }
  return refs;
}

/**
 * Parse one record's payload, including a scalar that wraps onto deeper lines.
 * @param lines - the document lines.
 * @param key - the record key.
 * @returns the record, or undefined when the key is absent.
 */
function parseRecord(lines, key) {
  const start = lines.findIndex((line) => line === '  ' + key + ':');
  if (start < 0) return undefined;
  const payload = {};
  let kind = '';
  let inPayload = false;
  let pendingKey;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim().length === 0) continue;
    if (!line.startsWith('  ')) break;
    const kindMatch = /^ {4}kind:\s*(.*)$/u.exec(line);
    if (kindMatch !== null) {
      kind = decodeScalar(kindMatch[1]);
      inPayload = false;
      continue;
    }
    if (/^ {4}payload:\s*$/u.test(line)) {
      inPayload = true;
      continue;
    }
    if (!inPayload) continue;
    const field = /^ {6}([A-Za-z0-9_]+):\s*(.*)$/u.exec(line);
    if (field !== null) {
      pendingKey = field[1];
      payload[pendingKey] = field[2];
      continue;
    }
    // A continuation of the previous scalar (a wrapped quoted string).
    if (pendingKey !== undefined) payload[pendingKey] += ' ' + line.trim();
  }
  for (const field of Object.keys(payload)) {
    const raw = String(payload[field]);
    payload[field] = /^[0-9]+$/u.test(raw.trim()) ? Number(raw.trim()) : decodeScalar(raw);
  }
  return { kind, payload };
}

/**
 * Build the credentials service the plugin expects.
 * @param options - the wiring.
 * @param options.path - credential document path.
 * @param options.logger - sink for the write refusals.
 * @returns the service, plus the parsed snapshot for diagnostics.
 */
export function createReadOnlyCredentials(options = {}) {
  const path = options.path !== undefined ? options.path : CREDENTIALS_PATH;
  const logger = options.logger;
  const text = readFileSync(path, 'utf8');
  const lines = text.split(/\r?\n/u);
  const refs = parseRefs(lines);
  const refused = [];

  /**
   * Record and report a refused write.
   * @param what - the operation that was refused.
   * @returns nothing.
   */
  function refuse(what) {
    refused.push(what);
    if (logger !== undefined) logger.warn('live tests: refusing to ' + what + ' — a write would rotate the single-use grant');
  }

  return {
    path,
    refs,
    refused,
    recordKeys: lines
      .map((line) => /^ {2}([A-Za-z0-9_./:-]+):$/u.exec(line))
      .filter((match) => match !== null)
      .map((match) => match[1]),
    /**
     * Resolve a reference, mirroring the host's `{ value, source }` shape.
     * @param ref - the reference name.
     * @returns the hit, or undefined.
     */
    async resolve(ref) {
      const value = refs.get(ref);
      return value === undefined ? undefined : { value, source: 'credential:' + ref };
    },
    /**
     * Describe a reference without revealing it.
     * @param ref - the reference name.
     * @returns configured/writable.
     */
    async describe(ref) {
      return { configured: refs.has(ref), writable: false };
    },
    /**
     * Read a record.
     * @param key - the record id.
     * @returns the record, or undefined.
     */
    async readRecord(key) {
      return parseRecord(lines, key);
    },
    /**
     * Refuse to write a record.
     * @returns the stored record, unchanged.
     */
    async modifyRecord() {
      refuse('rewrite a credential record');
      return undefined;
    },
    /**
     * Refuse to delete a record.
     * @returns nothing.
     */
    async deleteRecord() {
      refuse('delete a credential record');
    },
    /**
     * Describe a record.
     * @param key - the record id.
     * @returns configured/writable.
     */
    async describeRecord(key) {
      return { configured: parseRecord(lines, key) !== undefined, writable: false };
    },
    /**
     * Refuse to set a reference.
     * @returns nothing.
     */
    async set() {
      refuse('set a credential reference');
    },
    /**
     * Refuse to clear a reference.
     * @returns nothing.
     */
    async unset() {
      refuse('clear a credential reference');
    },
  };
}

/**
 * Read one reference value directly, for runner setup.
 * @param ref - the reference name.
 * @returns the value, or undefined.
 */
export function readRef(ref) {
  const text = readFileSync(CREDENTIALS_PATH, 'utf8');
  return parseRefs(text.split(/\r?\n/u)).get(ref);
}
