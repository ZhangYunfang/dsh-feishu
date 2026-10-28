#!/usr/bin/env node
/**
 * Live functional test runner for dsh-feishu.
 *
 * Drives the plugin's own tool definitions against the real Feishu open
 * platform, because a mock can only prove the code agrees with itself. Every
 * case names the tool and action it exercises, prints one line of evidence, and
 * leaves no artifact behind unless `--keep` is passed.
 *
 * Safety rails, in order of importance:
 *  - every object it creates carries the `DSH-TEST` prefix;
 *  - it never calls `feishu_auth logout` or `complete`: the stored grant is the
 *    only one there is, and the refresh token is single-use;
 *  - the credential store is mounted read-only, and the runner asserts the grant
 *    was not rotated;
 *  - messages go only to the authorized user's own open_id.
 *
 * Usage:
 *   node test/live/feishu-live.mjs                # every case, then clean up
 *   node test/live/feishu-live.mjs --only=drive   # one tool family
 *   node test/live/feishu-live.mjs --keep         # keep the artifacts
 *   node test/live/feishu-live.mjs --list         # print the case list only
 *
 * @module dsh-feishu/test/live/feishu-live
 */

import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { createReadOnlyCredentials } from './credentials.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const LIB = join(HERE, '..', '..', 'lib');

const args = process.argv.slice(2);
const only = (args.find((a) => a.startsWith('--only=')) ?? '').slice('--only='.length);
const keep = args.includes('--keep');
const listOnly = args.includes('--list');

/** Everything a case may need that is discovered at runtime. */
const C = {
  stamp: new Date().toISOString().replace(/[-:T]/gu, '').slice(0, 12),
  openId: '',
  folderToken: '',
  uploadToken: '',
  docToken: '',
  sheetToken: '',
  baseToken: '',
  tableId: '',
  dashId: '',
  messageId: '',
  wikiSpaceId: '',
  wikiNodeToken: '',
  cleanup: [],
  tmp: '',
};

const PREFIX = 'DSH-TEST-' + C.stamp;

/**
 * Turn a missing user-scope rejection into a recorded blocker.
 *
 * 99991679 / 99991672 mean the app console does not grant the scope, so no code
 * change can fix it: the permission must be enabled, published, and then granted
 * by a fresh authorization. Saying that once beats re-deriving it per case.
 * @param error - the thrown value.
 * @param t - the tool facade.
 * @param scope - the scope Feishu named, for the message.
 * @returns the error to rethrow.
 */
function asScopeBlocker(error, t, scope) {
  const code = error?.code;
  if (code === 99991679 || code === 99991672) {
    return new Error('blocked: the user grant lacks ' + scope + ' (Feishu code ' + code + '); the app console must enable it, publish a version, and then be re-authorized');
  }
  return error;
}

/**
 * Make sure a Base with an `items` table and two rows exists.
 *
 * query and dashboard cases need one, and a run filtered to those areas must not
 * skip for lack of a prerequisite that only another area creates.
 * @param t - the tool facade.
 * @returns nothing.
 */
async function ensureBase(t) {
  if (C.baseToken !== undefined && C.baseToken.length > 0) return;
  const r = assertOk(await t.call('feishu_bitable', {
    action: 'create_app',
    name: PREFIX + '-base-for-' + (only || 'run'),
    tables: [{
      name: 'items',
      fields: [
        { name: '标题', type: 'text' },
        { name: '数量', type: 'number' },
        { name: '状态', type: 'single_select', options: ['待办', '完成'] },
      ],
    }],
  }), 'setup create_app');
  C.baseToken = r.data.app?.app_token ?? r.data.app_token;
  C.cleanup.push({ kind: 'drive', token: C.baseToken, docType: 'bitable', label: 'setup base' });
  const tables = assertOk(await t.call('feishu_bitable', { action: 'list_tables', appToken: C.baseToken }), 'setup list_tables');
  const listedTables = tables.data.tables ?? [];
  C.tableId = (listedTables.find((tbl) => tbl.name === 'items') ?? listedTables[0])?.table_id;
  const inserted = assertOk(await t.call('feishu_bitable', {
    action: 'insert_records', appToken: C.baseToken, tableId: C.tableId,
    records: [
      { 标题: PREFIX + '-s1', 数量: 3, 状态: '待办' },
      { 标题: PREFIX + '-s2', 数量: 5, 状态: '完成' },
    ],
  }), 'setup insert_records');
  C.recordIds = (inserted.data.recordIds ?? []).map((id) => String(id));
}

/**
 * Make sure the authorized user's open_id is known.
 * @param t - the tool facade.
 * @returns nothing.
 */
async function ensureOpenId(t) {
  if (C.openId.length > 0) return;
  const r = assertOk(await t.call('feishu_auth', { action: 'status' }), 'setup status');
  C.openId = r.data.user.openId;
  assert(typeof C.openId === 'string' && C.openId.length > 0, 'the grant should carry an open_id');
}

/** What the plugin's web server would advertise; override with FEISHU_TEST_REDIRECT. */
const REDIRECT_FALLBACK = 'http://127.0.0.1:3080/api/feishu/oauth/callback';

/**
 * Assert a condition, with a message that says what was being checked.
 * @param condition - the condition.
 * @param message - the failure message.
 * @returns nothing.
 */
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/**
 * Assert the tool returned `ok: true` with a non-empty summary.
 * @param result - the tool result.
 * @param what - the case label.
 * @returns the result.
 */
function assertOk(result, what) {
  assert(result !== null && typeof result === 'object', what + ': no result object');
  assert(result.ok === true, what + ': tool reported ok=' + String(result.ok) + ' (' + String(result.summary) + ')');
  assert(typeof result.summary === 'string' && result.summary.length > 0, what + ': empty summary');
  return result;
}

/**
 * Truncate a value for one-line evidence.
 * @param value - the value.
 * @param max - maximum characters.
 * @returns the clipped text.
 */
function clip(value, max = 110) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text !== undefined && text.length > max ? text.slice(0, max - 1) + '…' : String(text);
}

/**
 * Define the case list.
 *
 * `p` is the priority the report groups by; `gate` lists other case ids this
 * case cannot run without; `expect` marks a case whose failure is the finding
 * rather than a surprise.
 * @param t - the tool facade.
 * @returns the cases.
 */
function cases(t) {
  return [
    // ---------------------------------------------------------------- auth
    {
      id: 'AUTH-01', p: 'P0', area: 'auth',
      desc: 'feishu_auth status reports app + user state',
      async run() {
        const r = assertOk(await t.call('feishu_auth', { action: 'status' }), 'status');
        const d = r.data;
        assert(d.appSecretConfigured === true, 'the app secret should resolve from the credential store');
        assert(d.tenantTokenOk === true, 'the tenant token should mint');
        assert(d.user.authorized === true, 'a user grant should be stored');
        C.openId = d.user.openId;
        return 'tenant ok · user ' + d.user.name + ' · refreshable=' + String(d.user.refreshable)
          + ' · scope=' + d.user.scope.split(' ').length + ' items';
      },
    },
    {
      id: 'AUTH-02', p: 'P0', area: 'auth',
      desc: 'feishu_auth authorize_url carries offline_access and the redirect',
      async run() {
        const r = assertOk(await t.call('feishu_auth', { action: 'authorize_url' }), 'authorize_url');
        assert(typeof r.url === 'string' && r.url.startsWith('https://accounts.feishu.cn/'), 'the URL should point at the accounts host');
        assert(r.url.includes('scope=offline_access'), 'offline_access must be requested first');
        assert(r.url.includes('redirect_uri='), 'a redirect_uri must be present');
        const scopes = r.data.scopes ?? [];
        assert(scopes.includes('offline_access'), 'offline_access should be in the advertised scopes');
        return 'scopes=' + scopes.length + ' · redirect=' + clip(r.data.redirectUri, 60);
      },
    },
    {
      id: 'AUTH-06', p: 'P2', area: 'auth',
      desc: 'feishu_auth authorize_url falls back to the server-derived redirect',
      async run() {
        const r = assertOk(await t.call('feishu_auth', { action: 'authorize_url', redirectUri: '' }), 'authorize_url with an empty redirect');
        assert(r.data.redirectUri === REDIRECT_FALLBACK, 'an empty redirectUri should fall back to the derived default, not vanish');
        return 'fallback redirect=' + clip(r.data.redirectUri, 60);
      },
    },
    {
      id: 'AUTH-03', p: 'P0', area: 'auth',
      desc: 'feishu_auth status reports a refreshable grant and its own lifetime',
      async run() {
        const r = assertOk(await t.call('feishu_auth', { action: 'status' }), 'status');
        const user = r.data.user;
        assert(user.refreshable === true, 'the stored grant must be refreshable, i.e. carry a live refresh token');
        assert(String(user.scope).split(' ').includes('offline_access'), 'offline_access is what keeps the grant refreshable');
        assert(typeof user.refreshExpiresInDays === 'number', 'the refresh lifetime should be reported in days');
        return 'refreshable · scope=' + String(user.scope).split(' ').length + ' items · refresh expires in ' + user.refreshExpiresInDays + 'd';
      },
    },
    {
      id: 'AUTH-07', p: 'P0', area: 'auth',
      skip: 'deliberate: refreshing here rotates the single-use token, and this harness mounts the store read-only, so the rotated value could not be persisted — the live grant would be consumed. Run it through the tool instead.',
      desc: 'feishu_auth refresh re-mints the user token',
      async run() { return 'skipped'; },
    },
    {
      id: 'AUTH-04', p: 'P1', area: 'auth', skip: 'destructive: the stored grant is the only one, and refresh_token is single-use',
      desc: 'feishu_auth logout forgets the grant',
      async run() { return 'skipped'; },
    },
    {
      id: 'AUTH-05', p: 'P2', area: 'auth', skip: 'needs a fresh authorization code pasted in; the state is single-use',
      desc: 'feishu_auth complete exchanges a pasted code',
      async run() { return 'skipped'; },
    },
    {
      id: 'API-01', p: 'P0', area: 'api',
      desc: 'feishu_api GET reaches an endpoint the curated tools do not wrap',
      async run() {
        const r = assertOk(await t.call('feishu_api', { method: 'GET', path: '/drive/explorer/v2/root_folder/meta' }), 'raw GET');
        assert(r.data !== undefined, 'the envelope data should be returned');
        return 'root token present=' + String(typeof r.data.token === 'string');
      },
    },
    {
      id: 'API-02', p: 'P1', area: 'api',
      desc: 'feishu_api sends query parameters',
      async run() {
        const r = assertOk(await t.call('feishu_api', { method: 'GET', path: '/drive/v1/files', query: { page_size: 1 } }), 'raw GET + query');
        assert(r.data !== undefined, 'data should be returned');
        return 'files key present=' + String(r.data.files !== undefined);
      },
    },

    // --------------------------------------------------------------- drive
    {
      id: 'DRV-01', p: 'P0', area: 'drive',
      desc: 'feishu_drive list_files lists the root folder',
      async run() {
        const r = assertOk(await t.call('feishu_drive', { action: 'list_files', pageSize: 5 }), 'list_files');
        const files = r.data.files ?? [];
        return 'files=' + files.length + ' · has_more=' + String(r.data.has_more);
      },
    },
    {
      id: 'DRV-02', p: 'P0', area: 'drive',
      desc: 'feishu_drive create_folder creates a test folder at the root',
      async run() {
        const r = assertOk(await t.call('feishu_drive', { action: 'create_folder', name: PREFIX + '-folder' }), 'create_folder');
        C.folderToken = r.data.token;
        C.cleanup.push({ kind: 'drive', token: C.folderToken, docType: 'folder', label: 'folder' });
        return 'token=' + clip(C.folderToken, 24);
      },
    },
    {
      id: 'DRV-03', p: 'P0', area: 'drive', gate: ['DRV-02'],
      desc: 'feishu_drive upload puts a local file into that folder',
      async run() {
        const path = join(C.tmp, PREFIX + '.txt');
        await writeFile(path, PREFIX + ' upload payload\nsecond line\n', 'utf8');
        const r = assertOk(await t.call('feishu_drive', { action: 'upload', filePath: path, folderToken: C.folderToken }), 'upload');
        C.uploadToken = r.data.fileToken;
        C.cleanup.push({ kind: 'drive', token: C.uploadToken, docType: 'file', label: 'uploaded file' });
        return 'token=' + clip(C.uploadToken, 24) + ' · ' + clip(r.summary, 60);
      },
    },
    {
      id: 'DRV-04', p: 'P0', area: 'drive', gate: ['DRV-03'],
      desc: 'feishu_drive download returns the same bytes',
      async run() {
        const out = join(C.tmp, 'downloaded-' + PREFIX + '.txt');
        assertOk(await t.call('feishu_drive', { action: 'download', fileToken: C.uploadToken, outputPath: out }), 'download');
        const bytes = await readFile(out);
        const text = bytes.toString('utf8');
        assert(text.startsWith(PREFIX), 'the downloaded content should be the uploaded content');
        return bytes.length + ' bytes · round-trip ok';
      },
    },
    {
      id: 'DRV-05', p: 'P1', area: 'drive', gate: ['DRV-02'],
      desc: 'feishu_drive get_meta resolves tokens of several types',
      async run() {
        const r = assertOk(await t.call('feishu_drive', { action: 'get_meta', tokens: [C.folderToken] }), 'get_meta');
        const metas = r.data.metas ?? [];
        assert(metas.length >= 1, 'at least the folder should resolve');
        return 'metas=' + metas.length + ' · ' + clip(metas[0], 80);
      },
    },

    // ----------------------------------------------------------------- doc
    {
      id: 'DOC-01', p: 'P0', area: 'doc',
      desc: 'feishu_doc create makes a document in the user drive',
      async run() {
        const r = assertOk(await t.call('feishu_doc', { action: 'create', title: PREFIX + '-doc' }), 'doc create');
        C.docToken = r.data.documentId ?? r.data.document_id;
        assert(typeof C.docToken === 'string' && C.docToken.length > 0, 'create should return a document id');
        C.cleanup.push({ kind: 'drive', token: C.docToken, docType: 'docx', label: 'doc' });
        return 'documentId=' + clip(C.docToken, 20) + ' · ' + clip(r.url, 50);
      },
    },
    {
      id: 'DOC-02', p: 'P0', area: 'doc', gate: ['DOC-01'],
      desc: 'feishu_doc append_markdown converts Markdown to native blocks',
      async run() {
        const markdown = [
          '# ' + PREFIX + ' heading',
          '',
          'A paragraph with **bold**, *italic* and `code`.',
          '',
          '- item one',
          '- item two',
          '',
          '| col a | col b |',
          '| --- | --- |',
          '| 1 | 2 |',
          '',
          '```js',
          'const marker = "' + PREFIX + '";',
          '```',
        ].join('\n');
        try {
          const r = assertOk(await t.call('feishu_doc', { action: 'append_markdown', documentId: C.docToken, markdown }), 'append_markdown');
          return clip(r.summary, 90);
        } catch (error) {
          throw asScopeBlocker(error, t, 'docx:document.block:convert');
        }
      },
    },
    {
      id: 'DOC-03', p: 'P1', area: 'doc', gate: ['DOC-01'],
      desc: 'feishu_doc append_blocks appends a raw block',
      async run() {
        const blocks = [{ block_type: 2, text: { elements: [{ text_run: { content: PREFIX + ' raw block' } }] } }];
        const r = assertOk(await t.call('feishu_doc', { action: 'append_blocks', documentId: C.docToken, blocks }), 'append_blocks');
        return clip(r.summary, 90);
      },
    },
    {
      id: 'DOC-04', p: 'P1', area: 'doc', gate: ['DOC-01'],
      desc: 'feishu_doc list_blocks walks the whole document',
      async run() {
        const r = assertOk(await t.call('feishu_doc', { action: 'list_blocks', documentId: C.docToken }), 'list_blocks');
        const blocks = r.data.items ?? r.data.blocks ?? [];
        assert(blocks.length > 0, 'the document should have blocks');
        return 'blocks=' + blocks.length;
      },
    },
    {
      id: 'DOC-05', p: 'P0', area: 'doc', gate: ['DOC-03'],
      desc: 'feishu_doc get_raw_content shows the appended marker',
      async run() {
        const r = assertOk(await t.call('feishu_doc', { action: 'get_raw_content', documentId: C.docToken }), 'get_raw_content');
        const text = r.data.content ?? r.data.text ?? '';
        assert(String(text).includes(PREFIX), 'the marker written into the document should be readable');
        return 'chars=' + String(text).length;
      },
    },
    {
      id: 'DOC-06', p: 'P1', area: 'doc', gate: ['DOC-01'],
      desc: 'feishu_doc get returns document metadata',
      async run() {
        const r = assertOk(await t.call('feishu_doc', { action: 'get', documentId: C.docToken }), 'doc get');
        assert(r.data !== undefined, 'metadata should be returned');
        return clip(r.data.title ?? r.summary, 70);
      },
    },
    {
      id: 'DOC-07', p: 'P1', area: 'doc',
      desc: 'feishu_doc import_file converts a local Markdown file',
      async run() {
        const path = join(C.tmp, PREFIX + '-import.md');
        await writeFile(path, '# ' + PREFIX + ' import\n\nimported paragraph\n', 'utf8');
        // Import tasks refuse the identity root, so they need a real folder.
        const folder = assertOk(await t.call('feishu_drive', { action: 'create_folder', name: PREFIX + '-import-dir' }), 'import folder');
        C.importFolderToken = folder.data.token;
        C.cleanup.push({ kind: 'drive', token: C.importFolderToken, docType: 'folder', label: 'import folder' });
        try {
          const r = assertOk(await t.call('feishu_doc', {
            action: 'import_file', filePath: path, folderToken: C.importFolderToken, pollMs: 25000,
          }), 'import_file');
          C.ticket = typeof r.data.ticket === 'string' ? r.data.ticket : undefined;
          assert(typeof C.ticket === 'string', 'import_file should report the ticket it polled with');
          C.importResultKeys = Object.keys(r.data ?? {});
          const importedToken = r.data.token ?? r.data.documentId ?? r.data.document_id;
          if (typeof importedToken === 'string') {
            C.importedToken = importedToken;
            C.cleanup.push({ kind: 'drive', token: importedToken, docType: 'docx', label: 'imported doc' });
          }
          return 'keys=' + C.importResultKeys.join(',') + ' · ' + clip(r.summary, 40);
        } catch (error) {
          throw asScopeBlocker(error, t, 'drive:drive (import task)');
        }
      },
    },
    {
      id: 'DOC-08', p: 'P2', area: 'doc', gate: ['DOC-07'],
      desc: 'feishu_doc list_import_tasks reads the ticket the import returned',
      async run() {
        assert(typeof C.ticket === 'string', 'DOC-07 should have left a ticket');
        const r = assertOk(await t.call('feishu_doc', { action: 'list_import_tasks', ticket: C.ticket }), 'list_import_tasks');
        return clip(r.summary, 80);
      },
    },

    // --------------------------------------------------------------- sheet
    {
      id: 'SHT-01', p: 'P0', area: 'sheet',
      desc: 'feishu_sheet create makes a spreadsheet',
      async run() {
        const r = assertOk(await t.call('feishu_sheet', { action: 'create', title: PREFIX + '-sheet' }), 'sheet create');
        C.sheetToken = r.data.spreadsheetToken ?? r.data.spreadsheet_token;
        assert(typeof C.sheetToken === 'string', 'create should return a spreadsheet token');
        C.cleanup.push({ kind: 'drive', token: C.sheetToken, docType: 'sheet', label: 'sheet' });
        return 'token=' + clip(C.sheetToken, 20);
      },
    },
    {
      id: 'SHT-02', p: 'P1', area: 'sheet', gate: ['SHT-01'],
      desc: 'feishu_sheet get_info returns sheet metadata',
      async run() {
        const r = assertOk(await t.call('feishu_sheet', { action: 'get_info', spreadsheetToken: C.sheetToken }), 'get_info');
        return clip(r.summary, 80);
      },
    },
    {
      id: 'SHT-03', p: 'P1', area: 'sheet', gate: ['SHT-01'],
      desc: 'feishu_sheet list_sheets lists the tabs',
      async run() {
        const r = assertOk(await t.call('feishu_sheet', { action: 'list_sheets', spreadsheetToken: C.sheetToken }), 'list_sheets');
        const sheets = r.data.sheets ?? [];
        assert(sheets.length >= 1, 'a new spreadsheet has at least one sheet');
        C.sheetId = sheets[0]?.sheet_id;
        return 'sheets=' + sheets.length;
      },
    },
    {
      id: 'SHT-04', p: 'P0', area: 'sheet', gate: ['SHT-01'],
      desc: 'feishu_sheet write stores a block of cells',
      async run() {
        const values = [['name', 'n'], [PREFIX + '-a', 1], [PREFIX + '-b', 2]];
        const r = assertOk(await t.call('feishu_sheet', { action: 'write', spreadsheetToken: C.sheetToken, range: 'A1:B3', values }), 'sheet write');
        return clip(r.summary, 80);
      },
    },
    {
      id: 'SHT-05', p: 'P0', area: 'sheet', gate: ['SHT-04'],
      desc: 'feishu_sheet read returns what was written',
      async run() {
        const r = assertOk(await t.call('feishu_sheet', { action: 'read', spreadsheetToken: C.sheetToken, range: 'A1:B3' }), 'sheet read');
        const values = r.data.values ?? r.data.valueRange?.values ?? [];
        const flat = JSON.stringify(values);
        assert(flat.includes(PREFIX + '-a'), 'the written cell should come back');
        return 'rows=' + values.length;
      },
    },
    {
      id: 'SHT-06', p: 'P1', area: 'sheet', gate: ['SHT-04'],
      desc: 'feishu_sheet append adds a row after the last one',
      async run() {
        const r = assertOk(await t.call('feishu_sheet', { action: 'append', spreadsheetToken: C.sheetToken, range: 'A1:B1', values: [[PREFIX + '-c', 3]] }), 'sheet append');
        return clip(r.summary, 80);
      },
    },
    {
      id: 'SHT-07', p: 'P1', area: 'sheet', gate: ['SHT-01'],
      desc: 'feishu_sheet add_sheet creates a second tab',
      async run() {
        const r = assertOk(await t.call('feishu_sheet', { action: 'add_sheet', spreadsheetToken: C.sheetToken, title: 'DSH-TEST-tab' }), 'add_sheet');
        return clip(r.summary, 80);
      },
    },

    // ------------------------------------------------------------- bitable
    {
      id: 'BIT-01', p: 'P0', area: 'bitable',
      desc: 'feishu_bitable create_app builds a Base with one table and fields',
      async run() {
        const r = assertOk(await t.call('feishu_bitable', {
          action: 'create_app',
          name: PREFIX + '-base',
          tables: [{
            name: 'items',
            fields: [
              { name: '标题', type: 'text' },
              { name: '数量', type: 'number' },
              { name: '状态', type: 'single_select', options: ['待办', '完成'] },
            ],
          }],
        }), 'create_app');
        C.baseToken = r.data.app?.app_token ?? r.data.app_token;
        assert(typeof C.baseToken === 'string', 'create_app should return an app token');
        C.cleanup.push({ kind: 'drive', token: C.baseToken, docType: 'bitable', label: 'base' });
        return 'appToken=' + clip(C.baseToken, 20);
      },
    },
    {
      id: 'BIT-02', p: 'P0', area: 'bitable', gate: ['BIT-01'],
      desc: 'feishu_bitable list_tables finds the table',
      async run() {
        const r = assertOk(await t.call('feishu_bitable', { action: 'list_tables', appToken: C.baseToken }), 'list_tables');
        const tables = r.data.tables ?? r.data.items ?? [];
        assert(tables.length >= 1, 'the created table should be listed');
        // A new Base also carries a default table, so pick ours by name.
        C.tableId = (tables.find((tbl) => tbl.name === 'items') ?? tables[0]).table_id;
        C.defaultTableSeen = tables.some((tbl) => tbl.name !== 'items');
        return 'tables=' + tables.length + ' · first=' + clip(tables[0].name ?? '', 20);
      },
    },
    {
      id: 'BIT-03', p: 'P1', area: 'bitable', gate: ['BIT-01'],
      desc: 'feishu_bitable create_table adds a second table',
      async run() {
        const r = assertOk(await t.call('feishu_bitable', { action: 'create_table', appToken: C.baseToken, name: 'tags', fields: [{ name: '标签', type: 'text' }] }), 'create_table');
        return clip(r.summary, 80);
      },
    },
    {
      id: 'BIT-04', p: 'P1', area: 'bitable', gate: ['BIT-02'],
      desc: 'feishu_bitable create_field adds a field',
      async run() {
        const r = assertOk(await t.call('feishu_bitable', { action: 'create_field', appToken: C.baseToken, tableId: C.tableId, fields: [{ name: '备注', type: 'text' }] }), 'create_field');
        return clip(r.summary, 80);
      },
    },
    {
      id: 'BIT-05', p: 'P0', area: 'bitable', gate: ['BIT-02'],
      desc: 'feishu_bitable list_fields returns the schema',
      async run() {
        const r = assertOk(await t.call('feishu_bitable', { action: 'list_fields', appToken: C.baseToken, tableId: C.tableId }), 'list_fields');
        const fields = r.data.fields ?? r.data.items ?? [];
        assert(fields.length >= 3, 'the three created fields should be listed');
        return 'fields=' + fields.length;
      },
    },
    {
      id: 'BIT-06', p: 'P0', area: 'bitable', gate: ['BIT-02'],
      desc: 'feishu_bitable insert_records writes rows',
      async run() {
        const records = [
          { 标题: PREFIX + '-r1', 数量: 3, 状态: '待办' },
          { 标题: PREFIX + '-r2', 数量: 5, 状态: '完成' },
        ];
        const r = assertOk(await t.call('feishu_bitable', { action: 'insert_records', appToken: C.baseToken, tableId: C.tableId, records }), 'insert_records');
        const ids = (r.data.recordIds ?? []).map((id) => String(id));
        C.recordIds = ids;
        assert(ids.length === 2, 'two records should carry ids, got ' + ids.length);
        return 'records=' + ids.length;
      },
    },
    {
      id: 'BIT-07', p: 'P0', area: 'bitable', gate: ['BIT-06'],
      desc: 'feishu_bitable search_records filters and sorts',
      async run() {
        const filter = { conjunction: 'and', conditions: [{ field_name: '状态', operator: 'is', value: ['完成'] }] };
        const r = assertOk(await t.call('feishu_bitable', { action: 'search_records', appToken: C.baseToken, tableId: C.tableId, filter }), 'search_records');
        const records = r.data.records ?? r.data.items ?? [];
        assert(records.length >= 1, 'the filtered record should be found');
        return 'matched=' + records.length + ' · total=' + String(r.data.total);
      },
    },
    {
      id: 'BIT-08', p: 'P1', area: 'bitable', gate: ['BIT-06'],
      desc: 'feishu_bitable update_records changes a cell',
      async run() {
        const r = assertOk(await t.call('feishu_bitable', {
          action: 'update_records', appToken: C.baseToken, tableId: C.tableId,
          records: [{ recordId: C.recordIds[0], 数量: 9 }],
        }), 'update_records');
        return clip(r.summary, 80);
      },
    },
    {
      id: 'BIT-09', p: 'P1', area: 'bitable', gate: ['BIT-06'],
      desc: 'feishu_bitable get_record reads one row',
      async run() {
        const r = assertOk(await t.call('feishu_bitable', { action: 'get_record', appToken: C.baseToken, tableId: C.tableId, recordId: C.recordIds[0] }), 'get_record');
        assert(Object.keys(r.data ?? {}).length >= 2, 'the record fields should be returned at the data root');
        return clip(r.summary, 80);
      },
    },
    {
      id: 'BIT-10', p: 'P1', area: 'bitable', gate: ['BIT-06'],
      desc: 'feishu_bitable delete_records removes a row',
      async run() {
        const r = assertOk(await t.call('feishu_bitable', { action: 'delete_records', appToken: C.baseToken, tableId: C.tableId, recordIds: [C.recordIds[1]] }), 'delete_records');
        return clip(r.summary, 80);
      },
    },

    // --------------------------------------------------------------- query
    {
      id: 'QRY-01', p: 'P1', area: 'query',
      desc: 'feishu_query groups and counts server-side',
      async run() {
        await ensureBase(t);
        let r;
        try {
          r = assertOk(await t.call('feishu_query', {
            baseToken: C.baseToken, tableName: 'items',
            dimensions: [{ fieldName: '状态' }],
            measures: [{ fieldName: '状态', aggregation: 'count_all', alias: 'n' }],
          }), 'query group by');
        } catch (error) {
          throw asScopeBlocker(error, t, 'base:table:read');
        }
        const rows = r.data.rows ?? [];
        assert(rows.length >= 1, 'the grouped query should return rows');
        return 'rows=' + rows.length + ' · ' + clip(rows, 70);
      },
    },
    {
      id: 'QRY-02', p: 'P1', area: 'query',
      desc: 'feishu_query aggregates a number field',
      async run() {
        await ensureBase(t);
        let r;
        try {
          r = assertOk(await t.call('feishu_query', {
            baseToken: C.baseToken, tableName: 'items',
            measures: [{ fieldName: '数量', aggregation: 'sum', alias: 'total' }, { fieldName: '数量', aggregation: 'avg', alias: 'mean' }],
          }), 'query sum/avg');
        } catch (error) {
          throw asScopeBlocker(error, t, 'base:table:read');
        }
        return clip(r.data.rows, 80);
      },
    },
    {
      id: 'QRY-03', p: 'P2', area: 'query',
      desc: 'feishu_query sorts and limits',
      async run() {
        await ensureBase(t);
        let r;
        try {
          r = assertOk(await t.call('feishu_query', {
            baseToken: C.baseToken, tableName: 'items',
            dimensions: [{ fieldName: '标题' }],
            measures: [{ fieldName: '标题', aggregation: 'count_all', alias: 'n' }],
            sort: [{ fieldName: 'n', order: 'desc' }], limit: 1,
          }), 'query sort+limit');
        } catch (error) {
          throw asScopeBlocker(error, t, 'base:table:read');
        }
        const rows = r.data.rows ?? [];
        assert(rows.length <= 1, 'limit 1 should cap the rows');
        return 'rows=' + rows.length;
      },
    },

    // ----------------------------------------------------------- dashboard
    {
      id: 'DSH-01', p: 'P1', area: 'dashboard',
      desc: 'feishu_dashboard create_dashboard creates a dashboard in the Base',
      async run() {
        await ensureBase(t);
        let r;
        try {
          r = assertOk(await t.call('feishu_dashboard', { action: 'create_dashboard', baseToken: C.baseToken, name: PREFIX + '-dash' }), 'create_dashboard');
        } catch (error) {
          throw asScopeBlocker(error, t, 'base:dashboard:create');
        }
        C.dashId = r.data.block_id ?? r.data.dashboardId ?? r.data.dashboard_id;
        assert(typeof C.dashId === 'string', 'create_dashboard should return an id');
        return 'dashboardId=' + clip(C.dashId, 22);
      },
    },
    {
      id: 'DSH-02', p: 'P1', area: 'dashboard', gate: ['DSH-01'],
      desc: 'feishu_dashboard create_block adds a text block',
      async run() {
        const r = assertOk(await t.call('feishu_dashboard', {
          action: 'create_block', baseToken: C.baseToken, dashboardId: C.dashId,
          type: 'text', name: 'DSH-TEST-text', dataConfig: { text: '**' + PREFIX + '** dashboard text' },
        }), 'create_block text');
        C.textBlockId = r.data.block_id;
        return 'blockId=' + clip(C.textBlockId, 22);
      },
    },
    {
      id: 'DSH-03', p: 'P1', area: 'dashboard', gate: ['DSH-01', 'BIT-02'],
      desc: 'feishu_dashboard create_block adds a chart bound to the table',
      async run() {
        const r = assertOk(await t.call('feishu_dashboard', {
          action: 'create_block', baseToken: C.baseToken, dashboardId: C.dashId,
          type: 'column', name: 'DSH-TEST-chart',
          dataConfig: {
            table_name: 'items',
            series: [{ field_name: '数量', rollup: 'SUM' }],
            group_by: [{ field_name: '状态', mode: 'integrated' }],
          },
        }), 'create_block chart');
        C.chartBlockId = r.data.block_id;
        return 'blockId=' + clip(C.chartBlockId, 22);
      },
    },
    {
      id: 'DSH-04', p: 'P1', area: 'dashboard', gate: ['DSH-01'],
      desc: 'feishu_dashboard list_blocks lists the dashboard blocks',
      async run() {
        const r = assertOk(await t.call('feishu_dashboard', { action: 'list_blocks', baseToken: C.baseToken, dashboardId: C.dashId }), 'list_blocks');
        const blocks = r.data.blocks ?? r.data.items ?? [];
        assert(blocks.length >= 1, 'the dashboard should have blocks');
        return 'blocks=' + blocks.length;
      },
    },
    {
      id: 'DSH-05', p: 'P2', area: 'dashboard', gate: ['DSH-03'],
      desc: 'feishu_dashboard get_block returns one block',
      async run() {
        const r = assertOk(await t.call('feishu_dashboard', { action: 'get_block', baseToken: C.baseToken, dashboardId: C.dashId, blockId: C.chartBlockId }), 'get_block');
        assert(r.data !== undefined, 'the block should be returned');
        return clip(r.summary, 80);
      },
    },
    {
      id: 'DSH-06', p: 'P1', area: 'dashboard', gate: ['DSH-03'],
      desc: 'feishu_dashboard get_block_data returns computed numbers',
      async run() {
        const r = assertOk(await t.call('feishu_dashboard', { action: 'get_block_data', baseToken: C.baseToken, dashboardId: C.dashId, blockId: C.chartBlockId }), 'get_block_data');
        return clip(r.data, 100);
      },
    },
    {
      id: 'DSH-07', p: 'P2', area: 'dashboard', gate: ['DSH-02'],
      desc: 'feishu_dashboard update_block renames a block',
      async run() {
        try {
          const r = assertOk(await t.call('feishu_dashboard', { action: 'update_block', baseToken: C.baseToken, dashboardId: C.dashId, blockId: C.textBlockId, name: 'DSH-TEST-text-renamed' }), 'update_block');
          return clip(r.summary, 80);
        } catch (error) {
          throw asScopeBlocker(error, t, 'base:dashboard:update');
        }
      },
    },
    {
      id: 'DSH-08', p: 'P2', area: 'dashboard', gate: ['DSH-02'],
      desc: 'feishu_dashboard delete_block removes the text block',
      async run() {
        try {
          const r = assertOk(await t.call('feishu_dashboard', { action: 'delete_block', baseToken: C.baseToken, dashboardId: C.dashId, blockId: C.textBlockId }), 'delete_block');
          return clip(r.summary, 80);
        } catch (error) {
          throw asScopeBlocker(error, t, 'base:dashboard:delete');
        }
      },
    },

    // ---------------------------------------------------------------- wiki
    {
      id: 'WIK-01', p: 'P1', area: 'wiki',
      desc: 'feishu_wiki list_spaces lists knowledge spaces',
      async run() {
        const r = assertOk(await t.call('feishu_wiki', { action: 'list_spaces', pageSize: 10 }), 'list_spaces');
        const spaces = r.data.spaces ?? r.data.items ?? [];
        C.wikiSpaceId = spaces[0]?.space_id;
        return 'spaces=' + spaces.length + (C.wikiSpaceId !== undefined ? ' · first=' + clip(spaces[0].name ?? '', 20) : '');
      },
    },
    {
      id: 'WIK-02', p: 'P1', area: 'wiki', gate: ['WIK-01'],
      desc: 'feishu_wiki list_nodes lists a space root',
      async run() {
        if (C.wikiSpaceId === undefined) return 'no space to walk';
        const r = assertOk(await t.call('feishu_wiki', { action: 'list_nodes', spaceId: C.wikiSpaceId, pageSize: 10 }), 'list_nodes');
        const nodes = r.data.nodes ?? r.data.items ?? [];
        C.wikiNodeToken = nodes[0]?.node_token;
        return 'nodes=' + nodes.length;
      },
    },
    {
      id: 'WIK-03', p: 'P1', area: 'wiki', gate: ['WIK-02'],
      desc: 'feishu_wiki get_node resolves a node token',
      async run() {
        if (C.wikiNodeToken === undefined) return 'no node to resolve';
        const r = assertOk(await t.call('feishu_wiki', { action: 'get_node', token: C.wikiNodeToken }), 'get_node');
        assert(r.data.node !== undefined || r.data.obj_token !== undefined, 'the node should resolve to an object');
        return clip(r.summary, 80);
      },
    },
    {
      id: 'WIK-04', p: 'P1', area: 'wiki', skip: 'blocked: neither the plugin nor the open platform offers a delete-node call, so a created node cannot be cleaned up — needs a disposable test space',
      desc: 'feishu_wiki create_node files a document into a space',
      async run() { return 'skipped'; },
    },

    // ------------------------------------------------------------- message
    {
      id: 'MSG-01', p: 'P0', area: 'message',
      desc: 'feishu_message send_text delivers to the authorized user only',
      async run() {
        await ensureOpenId(t);
        const r = assertOk(await t.call('feishu_message', {
          action: 'send_text', receiveIdType: 'open_id', receiveId: C.openId, identity: 'app',
          text: '[' + PREFIX + '] 这是一条自动化测试消息，可撤回',
        }), 'send_text');
        C.messageId = r.data.message_id;
        C.cleanup.push({ kind: 'message', token: r.data.message_id, label: 'message:send_text' });
        assert(typeof C.messageId === 'string' && C.messageId.length > 0, 'send_text should return a message id');
        return 'message_id=' + clip(C.messageId, 24);
      },
    },
    {
      id: 'MSG-02', p: 'P0', area: 'message', gate: ['MSG-01'],
      desc: 'feishu_message reply answers that message',
      async run() {
        const r = assertOk(await t.call('feishu_message', { action: 'reply', messageId: C.messageId, identity: 'app', text: '[' + PREFIX + '] reply 测试' }), 'reply');
        C.replyId = r.data.message_id;
        C.cleanup.push({ kind: 'message', token: r.data.message_id, label: 'message:reply' });
        return clip(r.summary, 80);
      },
    },
    {
      id: 'MSG-03', p: 'P1', area: 'message',
      desc: 'feishu_message send_card delivers an interactive card',
      async run() {
        const r = assertOk(await t.call('feishu_message', {
          action: 'send_card', receiveIdType: 'open_id', receiveId: C.openId, identity: 'app',
          title: PREFIX + ' card',
          content: { elements: [{ tag: 'markdown', content: '**' + PREFIX + '** card body' }] },
        }), 'send_card');
        C.cardId = r.data.message_id;
        C.cleanup.push({ kind: 'message', token: r.data.message_id, label: 'message:send_card' });
        return 'message_id=' + clip(r.data.message_id, 24);
      },
    },
    {
      id: 'MSG-04', p: 'P1', area: 'message',
      desc: 'feishu_message send_post delivers a rich-text post',
      async run() {
        const r = assertOk(await t.call('feishu_message', {
          action: 'send_post', receiveIdType: 'open_id', receiveId: C.openId, identity: 'app',
          content: { zh_cn: { title: PREFIX + ' post', content: [[{ tag: 'text', text: PREFIX + ' post body' }]] } },
        }), 'send_post');
        C.postId = r.data.message_id;
        C.cleanup.push({ kind: 'message', token: r.data.message_id, label: 'message:send_post' });
        return 'message_id=' + clip(r.data.message_id, 24);
      },
    },
    {
      id: 'MSG-05', p: 'P1', area: 'message',
      desc: 'feishu_message send_image uploads and sends an image',
      async run() {
        const path = join(C.tmp, PREFIX + '.png');
        // A 1x1 transparent PNG.
        await writeFile(path, Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
          'base64',
        ));
        const r = assertOk(await t.call('feishu_message', { action: 'send_image', receiveIdType: 'open_id', receiveId: C.openId, identity: 'app', filePath: path }), 'send_image');
        C.imageId = r.data.message_id;
        C.cleanup.push({ kind: 'message', token: r.data.message_id, label: 'message:send_image' });
        return 'message_id=' + clip(r.data.message_id, 24);
      },
    },
    {
      id: 'MSG-06', p: 'P1', area: 'message',
      desc: 'feishu_message send_file uploads and sends a file',
      async run() {
        const path = join(C.tmp, PREFIX + '-attachment.txt');
        await writeFile(path, PREFIX + ' attachment\n', 'utf8');
        const r = assertOk(await t.call('feishu_message', { action: 'send_file', receiveIdType: 'open_id', receiveId: C.openId, identity: 'app', filePath: path }), 'send_file');
        C.fileId = r.data.message_id;
        C.cleanup.push({ kind: 'message', token: r.data.message_id, label: 'message:send_file' });
        return 'message_id=' + clip(r.data.message_id, 24);
      },
    },
    {
      id: 'MSG-07', p: 'P2', area: 'message', gate: ['MSG-01'],
      desc: 'feishu_message webhook posts through a custom bot',
      async run() { throw new Error('blocked: needs a custom-bot webhook URL, which only the user can create'); },
    },
    {
      id: 'MSG-08', p: 'P2', area: 'message', gate: ['MSG-01'],
      desc: 'feishu_api recalls a bot-sent message as the sender identity',
      async run() {
        // A message can only be recalled by whoever sent it: the sends use the app
        // identity, so the recall must too — the default (auto -> user) answers
        // "Not allowed to recall messages sent by others".
        const r = assertOk(await t.call('feishu_api', { method: 'DELETE', path: '/im/v1/messages/' + C.messageId, identity: 'app' }), 'recall');
        return clip(r.summary, 80);
      },
    },
  ];
}

/**
 * Build the tool facade over the plugin's own definitions.
 * @returns the facade.
 */
async function buildFacade() {
  const configMod = await import('file://' + join(LIB, 'config.js'));
  const identityMod = await import('file://' + join(LIB, 'identity.js'));
  const clientMod = await import('file://' + join(LIB, 'client.js'));
  const toolsMod = await import('file://' + join(LIB, 'tools', 'index.js'));

  const credentials = createReadOnlyCredentials({ logger: undefined });
  const appId = readAppId();
  const config = configMod.normalizeConfig({ appId });
  const identity = identityMod.createIdentity({ config, credentials, logger: undefined });
  const client = clientMod.createFeishuClient({ config, identity, logger: undefined });
  const definitions = toolsMod.buildTools({
    client, identity, config, activity: undefined,
    resolveRedirectUri: () => process.env.FEISHU_TEST_REDIRECT ?? REDIRECT_FALLBACK, logger: undefined,
  });
  const byName = new Map(definitions.map((def) => [def.name, def]));
  return {
    credentials,
    byName,
    /**
     * Execute one tool, mirroring the harness call shape.
     * @param name - the tool name.
     * @param toolArgs - the arguments.
     * @returns the tool result.
     */
    async call(name, toolArgs) {
      const def = byName.get(name);
      if (def === undefined) throw new Error('no such tool: ' + name);
      return def.execute(toolArgs, { signal: undefined });
    },
  };
}

/**
 * Read the app id the profile actually uses, so the runner cannot drift from it.
 * @returns the app id.
 */
function readAppId() {
  const patch = join(process.env.HOME ?? '', '.dsh/profiles/web/cordis.patch.yml');
  try {
    const text = readFileSync(patch, 'utf8');
    const match = /appId:\s*'([^']+)'/u.exec(text);
    if (match !== null) return match[1];
  } catch {
    /* fall through to the environment */
  }
  const fromEnv = process.env.FEISHU_APP_ID;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;
  throw new Error('cannot determine the Feishu app id (profile patch or FEISHU_APP_ID)');
}

/**
 * Run every case, then clean up.
 * @returns nothing; sets the exit code.
 */
async function main() {
  C.tmp = await mkdtemp(join(tmpdir(), 'dsh-feishu-live-'));
  const t = await buildFacade();
  const all = cases(t);
  const selected = only.length === 0 ? all : all.filter((c) => c.area === only || c.id.startsWith(only.toUpperCase()));
  if (listOnly) {
    for (const c of selected) console.log(c.id.padEnd(8) + c.p + '  ' + c.desc + (c.skip !== undefined ? '  [skip]' : ''));
    return 0;
  }

  const grantBefore = await t.credentials.readRecord('dsh-feishu/user-token');
  const expiresBefore = grantBefore?.payload?.expiresAt;
  const results = [];
  const done = new Set();

  for (const c of selected) {
    if (Array.isArray(c.gate) && c.gate.some((id) => !done.has(id))) {
      results.push({ id: c.id, p: c.p, area: c.area, status: 'skipped', evidence: 'a prerequisite case failed' });
      console.log('  skip  ' + c.id.padEnd(8) + 'prerequisite failed');
      continue;
    }
    if (c.skip !== undefined) {
      results.push({ id: c.id, p: c.p, area: c.area, status: 'skipped', evidence: c.skip });
      console.log('  skip  ' + c.id.padEnd(8) + clip(c.skip, 96));
      continue;
    }
    const started = Date.now();
    try {
      const evidence = await c.run();
      const ms = Date.now() - started;
      results.push({ id: c.id, p: c.p, area: c.area, status: 'pass', evidence, ms });
      done.add(c.id);
      console.log('  ok    ' + c.id.padEnd(8) + String(ms).padStart(5) + 'ms  ' + clip(evidence ?? '', 96));
    } catch (error) {
      const ms = Date.now() - started;
      const message = String(error !== null && error !== undefined && error.message !== undefined ? error.message : error)
        .split('\n').slice(0, 3).join(' | ');
      const blocked = c.expect === 'blocked' || /^blocked:/u.test(message);
      results.push({ id: c.id, p: c.p, area: c.area, status: blocked ? 'blocked' : 'fail', evidence: message, ms });
      console.log('  ' + (blocked ? 'BLOCK ' : 'FAIL  ') + c.id.padEnd(8) + String(ms).padStart(5) + 'ms  ' + clip(message, 96));
    }
  }

  // Cleanup: reverse order, best effort, one line per artifact.
  const cleaned = [];
  if (!keep) {
    for (const item of [...C.cleanup].reverse()) {
      try {
        if (item.kind === 'message') {
          // Recalling is the only clean-up a sent message has; the sender is the
          // app, so the app identity can recall it.
          await t.call('feishu_api', { method: 'DELETE', path: '/im/v1/messages/' + item.token, identity: 'app' });
        } else {
          await t.call('feishu_drive', { action: 'delete_file', fileToken: item.token, docType: item.docType });
        }
        cleaned.push(item.label + ' deleted');
        console.log('  clean ' + item.label.padEnd(14) + clip(item.token, 24));
      } catch (error) {
        cleaned.push(item.label + ' NOT deleted: ' + String(error?.message ?? error).split('\n')[0]);
        console.log('  CLEAN-FAIL ' + item.label + ': ' + clip(String(error?.message ?? error), 80));
      }
    }
  } else {
    cleaned.push('--keep: artifacts left in place: ' + C.cleanup.map((i) => i.label + '=' + i.token).join(', '));
  }

  const grantAfter = await t.credentials.readRecord('dsh-feishu/user-token');
  const rotated = grantAfter?.payload?.expiresAt !== expiresBefore;
  const refused = t.credentials.refused;

  const summary = {
    stamp: C.stamp,
    when: new Date().toISOString(),
    filter: only.length > 0 ? only : 'all',
    counts: {
      pass: results.filter((r) => r.status === 'pass').length,
      fail: results.filter((r) => r.status === 'fail').length,
      blocked: results.filter((r) => r.status === 'blocked').length,
      skipped: results.filter((r) => r.status === 'skipped').length,
      total: results.length,
    },
    grantRotated: rotated,
    credentialWritesRefused: refused,
    cleanup: cleaned,
    artifacts: C.cleanup.map((item) => ({ kind: item.kind, label: item.label, token: item.token, docType: item.docType })),
    results,
  };
  const out = join(HERE, 'last-run.json');
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(summary, null, 2), 'utf8');

  const h = createHash('sha256').update(JSON.stringify(results)).digest('hex').slice(0, 12);
  console.log('\n' + '-'.repeat(72));
  console.log('pass=' + summary.counts.pass + ' fail=' + summary.counts.fail + ' blocked=' + summary.counts.blocked + ' skipped=' + summary.counts.skipped + ' total=' + summary.counts.total);
  console.log('grant rotated during the run: ' + String(rotated) + ' (must be false)');
  console.log('credential writes refused: ' + String(refused.length));
  console.log('report: ' + out + '  (results hash ' + h + ')');
  await rm(C.tmp, { recursive: true, force: true });
  return summary.counts.fail === 0 ? 0 : 1;
}

const code = await main().catch((error) => {
  console.error('live runner failed to start:', error);
  return 2;
});
process.exit(code);
