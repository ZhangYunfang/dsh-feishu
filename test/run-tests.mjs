/**
 * Test suite for dsh-feishu.
 *
 * Runs without the harness: the modules under test import only Node builtins,
 * so the suite can load them directly and drive a fake `fetch` as a mock Feishu
 * tenant. Two checks are deliberately made against the real SDK rather than a
 * local reimplementation - every tool parameter and output schema is validated
 * by `assertSupportedJsonSchema`, and every parameter schema is rendered to
 * TypeScript by `jsonSchemaToTs` - because those are the two places a
 * hand-written definition could silently drift from what the registry and the
 * PTC SDK generator accept.
 *
 * Run with: node test/run-tests.mjs
 */

import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const LIB = join(HERE, '..', 'lib');

let passed = 0;
let failed = 0;
const failures = [];

/**
 * Run one test case.
 * @param nameText - the case name.
 * @param body - the async body.
 */
async function test(nameText, body) {
  try {
    await body();
    passed += 1;
    console.log('  ok   ' + nameText);
  } catch (error) {
    failed += 1;
    failures.push({ name: nameText, error });
    console.log('  FAIL ' + nameText);
    console.log('       ' + String(error && error.message !== undefined ? error.message : error).split('\n').join('\n       '));
  }
}

/**
 * Assert a condition.
 * @param condition - the condition.
 * @param message - the failure message.
 */
function assert(condition, message) {
  if (!condition) throw new Error(message !== undefined ? message : 'assertion failed');
}

/**
 * Assert strict equality.
 * @param actual - the actual value.
 * @param expected - the expected value.
 * @param message - the failure message.
 */
function equal(actual, expected, message) {
  if (!Object.is(actual, expected)) {
    throw new Error((message !== undefined ? message + ': ' : '') + 'expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
  }
}

/**
 * Assert that a promise rejects.
 * @param body - the async body.
 * @param matcher - an optional substring or predicate for the error.
 * @returns the caught error.
 */
async function rejects(body, matcher) {
  let caught;
  try {
    await body();
  } catch (error) {
    caught = error;
  }
  assert(caught !== undefined, 'expected a rejection, but the call resolved');
  if (typeof matcher === 'string') {
    assert(String(caught.message).includes(matcher), 'expected the error to mention ' + JSON.stringify(matcher) + ', got ' + JSON.stringify(String(caught.message)));
  }
  return caught;
}

/** Build a fetch-style response. */
function makeResponse(status, body, headers) {
  const isObject = body !== null && typeof body === 'object' && !(body instanceof Uint8Array);
  const text = isObject ? JSON.stringify(body) : body === undefined ? '' : String(body);
  return {
    status,
    headers: new Headers(headers !== undefined ? headers : { 'content-type': 'application/json' }),
    text: async () => text,
  };
}

/**
 * Build a mock Feishu service.
 * @returns the service: routes, the fetch implementation, and the request log.
 */
function mockFeishu() {
  const log = [];
  const routes = new Map();
  const hosts = new Map();
  const state = { expireTenantOnce: false, oauthRefreshes: 0 };

  /**
   * Register a route.
   * @param method - the HTTP method.
   * @param path - the pathname.
   * @param handler - returns a response description or a Response.
   */
  function route(method, path, handler) {
    routes.set(method + ' ' + path, handler);
  }

  /**
   * Serve a route on exactly one host.
   *
   * Feishu answers on two hosts and they are not interchangeable: the tenant,
   * app, and resource endpoints live on open.feishu.cn/open-apis, while the
   * OAuth endpoints live on accounts.feishu.cn/open-apis. Matching by path
   * alone hides a request aimed at the wrong host, so tests that care about the
   * direction pin the origin and let anything else 404.
   *
   * @param method - the HTTP method.
   * @param path - the pathname.
   * @param host - the required origin.
   */
  function routeOn(method, path, host) {
    hosts.set(method + ' ' + path, host);
  }

  /**
   * The fetch implementation.
   * @param url - the request URL.
   * @param init - the request init.
   * @returns the response.
   */
  async function fetchImpl(url, init) {
    const method = (init !== undefined && init.method !== undefined ? init.method : 'GET').toUpperCase();
    const parsed = new URL(url);
    log.push({ method, path: parsed.pathname, url, body: init !== undefined ? init.body : undefined, headers: init !== undefined ? init.headers : undefined });
    const handler = routes.get(method + ' ' + parsed.pathname);
    const expectedHost = hosts.get(method + ' ' + parsed.pathname);
    if (handler !== undefined && expectedHost !== undefined && parsed.origin !== expectedHost) {
      return makeResponse(404, '404 page not found', { 'content-type': 'text/plain' });
    }
    if (handler === undefined) return makeResponse(404, { code: 404, msg: 'no mock route for ' + method + ' ' + parsed.pathname });
    const result = await handler({ url: parsed, init, log, state });
    if (result !== undefined && typeof result.status === 'number' && typeof result.text === 'function') return result;
    return makeResponse(result.status !== undefined ? result.status : 200, result.body);
  }

  return { route, routeOn, fetchImpl, log, state, makeResponse };
}

/** The redirect URI used throughout the tests. */
const REDIRECT = 'http://127.0.0.1:19387/api/feishu/oauth/callback';

/**
 * Build a fake Cordis context that records registrations.
 * @param options - which optional services to provide.
 * @returns the context plus the recorded registrations.
 */
function fakeCtx(options) {
  const settings = options !== undefined ? options : {};
  const recorded = { tools: [], routes: [], sections: [], effects: [], disposers: 0 };
  const services = {
    credentials: settings.credentials,
    webServer: settings.webServer === false ? undefined : {
      port: 19387,
      register(route) {
        recorded.routes.push(route);
        return () => { recorded.disposers += 1; };
      },
    },
    systemPrompt: settings.systemPrompt === false ? undefined : {
      section(section) {
        recorded.sections.push(section);
        return () => { recorded.disposers += 1; };
      },
    },
  };
  const messages = [];
  const ctx = {
    credentials: services.credentials,
    webServer: services.webServer,
    systemPrompt: services.systemPrompt,
    logger: {
      info: (message) => messages.push({ level: 'info', message }),
      warn: (message) => messages.push({ level: 'warn', message }),
      error: (message) => messages.push({ level: 'error', message }),
    },
    messages,
    get(name) {
      return services[name];
    },
    inject(names, callback) {
      const available = names.every((entry) => services[entry] !== undefined);
      if (available) callback(ctx);
      return () => {};
    },
    tools: {
      register(definition) {
        recorded.tools.push(definition);
        return () => { recorded.disposers += 1; };
      },
    },
    effect(callback) {
      recorded.effects.push(callback);
      return () => { recorded.disposers += 1; };
    },
    fiber: { state: 1 },
  };
  return { ctx, recorded };
}

/**
 * Build an in-memory stand-in for the credentials store.
 * @returns the store plus a handle on its records.
 */
function fakeCredentials() {
  const records = new Map();
  const refs = new Map();
  return {
    records,
    refs,
    async resolve(ref) {
      const value = refs.get(ref);
      return value === undefined ? undefined : { value, source: 'store' };
    },
    async describe(ref) {
      return { configured: refs.has(ref), writable: true };
    },
    async readRecord(key) {
      return records.get(key);
    },
    async modifyRecord(key, mutate) {
      const next = await mutate(records.get(key));
      if (next === undefined) return records.get(key);
      records.set(key, next);
      return next;
    },
    async deleteRecord(key) {
      records.delete(key);
    },
    async describeRecord(key) {
      return { configured: records.has(key), writable: true };
    },
    async set(ref, value) {
      if (typeof value !== 'string' || value.length === 0) throw new Error('an empty value cannot be stored');
      refs.set(ref, value);
    },
    async unset(ref) {
      refs.delete(ref);
    },
  };
}

/** Run the suite. */
async function main() {
  console.log('dsh-feishu test suite');
  console.log('');

  const configMod = await import('file:///' + join(LIB, 'config.js').replace(/\\/gu, '/'));
  const kit = await import('file:///' + join(LIB, 'tools', 'kit.js').replace(/\\/gu, '/'));
  const bitable = await import('file:///' + join(LIB, 'tools', 'bitable.js').replace(/\\/gu, '/'));
  const identityMod = await import('file:///' + join(LIB, 'identity.js').replace(/\\/gu, '/'));
  const clientMod = await import('file:///' + join(LIB, 'client.js').replace(/\\/gu, '/'));
  const errorsMod = await import('file:///' + join(LIB, 'errors.js').replace(/\\/gu, '/'));
  const routesMod = await import('file:///' + join(LIB, 'routes.js').replace(/\\/gu, '/'));
  const indexMod = await import('file:///' + join(LIB, 'index.js').replace(/\\/gu, '/'));

  // ------------------------------------------------------------------ config
  console.log('config');
  await test('applies brand endpoints and defaults', () => {
    const config = configMod.normalizeConfig({ appId: 'cli_1', appSecret: 's' });
    equal(config.brand, 'feishu');
    equal(config.apiBaseUrl, 'https://open.feishu.cn/open-apis');
    equal(config.accountsBaseUrl, 'https://accounts.feishu.cn/open-apis');
    equal(config.toolPrefix, 'feishu_');
    equal(config.defaultIdentity, 'auto');
    assert(configMod.hasAppCredentials(config), 'app credentials should be considered present');
  });
  await test('switches endpoints for the lark brand', () => {
    const config = configMod.normalizeConfig({ brand: 'lark' });
    equal(config.apiBaseUrl, 'https://open.larksuite.com/open-apis');
  });
  await test('falls back to environment variables and validates enumerations', () => {
    const config = configMod.normalizeConfig({ defaultIdentity: 'nonsense' }, { FEISHU_APP_ID: 'cli_env', FEISHU_BRAND: 'lark' });
    equal(config.appId, 'cli_env');
    equal(config.brand, 'lark');
    equal(config.defaultIdentity, 'auto');
  });
  await test('normalizes the tool prefix and clamps retries', () => {
    const config = configMod.normalizeConfig({ toolPrefix: 'fs', maxRetries: 99 });
    equal(config.toolPrefix, 'fs_');
    equal(config.maxRetries, 5);
  });

  // -------------------------------------------------------------------- kit
  console.log('');
  console.log('tool kit');
  const objectSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      name: { type: 'string', required: true },
      count: { type: 'integer' },
      tags: { type: 'array', items: { type: 'string' } },
      mode: { type: 'string', enum: ['a', 'b'] },
      anything: {},
    },
    required: ['name'],
  };
  await test('accepts a valid argument object', () => {
    equal(kit.validateArgs(objectSchema, { name: 'x', count: 2, tags: ['a'], mode: 'a' }).length, 0);
  });
  await test('reports missing required keys', () => {
    const violations = kit.validateArgs(objectSchema, {});
    assert(violations.some((entry) => entry.includes('name is required')), 'expected a required violation, got ' + JSON.stringify(violations));
  });
  await test('reports unknown keys when additionalProperties is false', () => {
    const violations = kit.validateArgs(objectSchema, { name: 'x', nope: 1 });
    assert(violations.some((entry) => entry.includes('nope')), 'expected an unknown-key violation, got ' + JSON.stringify(violations));
  });
  await test('reports type and enum violations with paths', () => {
    const violations = kit.validateArgs(objectSchema, { name: 'x', count: 1.5, tags: ['a', 2], mode: 'c' });
    assert(violations.some((entry) => entry.startsWith('count')), 'expected a count violation');
    assert(violations.some((entry) => entry.startsWith('tags[1]')), 'expected an item-path violation');
    assert(violations.some((entry) => entry.startsWith('mode')), 'expected an enum violation');
  });
  await test('treats an annotation-only node as unconstrained', () => {
    equal(kit.validateArgs(objectSchema, { name: 'x', anything: { deep: [1, 2, 3] } }).length, 0);
  });
  await test('compiles a parameter map into a closed object schema and hoists required', () => {
    const normalized = kit.normalizeParameters({
      a: { type: 'string', required: true },
      b: { type: 'number' },
      nested: {
        type: 'object',
        additionalProperties: false,
        properties: { c: { type: 'string', required: true } },
      },
    });
    equal(normalized.type, 'object');
    equal(normalized.additionalProperties, false);
    equal(JSON.stringify(normalized.required), JSON.stringify(['a']));
    equal(normalized.properties.a.required, undefined);
    equal(JSON.stringify(normalized.properties.nested.required), JSON.stringify(['c']));
    equal(normalized.properties.nested.required !== undefined, true);
    equal(normalized.properties.b.required, undefined);
  });
  await test('enforces exact-one oneOf', () => {
    const schema = {
      type: 'object',
      properties: { value: { oneOf: [{ type: 'string' }, { type: 'number' }] } },
    };
    equal(kit.validateArgs(schema, { value: 'x' }).length, 0);
    equal(kit.validateArgs(schema, { value: 1 }).length, 0);
    assert(kit.validateArgs(schema, { value: true }).length > 0, 'a boolean matches neither branch');
  });

  // --------------------------------------------------- real SDK schema checks
  console.log('');
  console.log('schema conformance against the real DSH validator');
  // The conformance checks need the real SDK. It is not a dependency of this
  // package (deliberately: see the README), so it is looked up in the places a
  // DSH installation actually puts it, and the checks skip cleanly when it is
  // absent - which is the case in CI.
  const sdkCandidates = [];
  if (typeof process.env.DSH_TOOLS_PATH === 'string' && process.env.DSH_TOOLS_PATH.length > 0) sdkCandidates.push(process.env.DSH_TOOLS_PATH);
  for (const base of [
    process.env.DSH_PROFILE_DIR,
    typeof process.env.DSH_HOME === 'string' ? join(process.env.DSH_HOME, 'profiles', process.env.DSH_PROFILE || 'desktop') : undefined,
    join(homedir(), '.dsh', 'profiles', process.env.DSH_PROFILE || 'desktop'),
  ]) {
    if (typeof base !== 'string' || base.length === 0) continue;
    sdkCandidates.push(join(base, 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'));
    sdkCandidates.push(join(base, '..', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'));
  }
  let sdk = null;
  try {
    sdk = await import('@deepseek-ai/dsh-tools');
  } catch {
    for (const candidate of sdkCandidates) {
      if (!existsSync(candidate)) continue;
      try {
        sdk = await import('file:///' + candidate.replace(/\\/gu, '/'));
        break;
      } catch {
        /* try the next location */
      }
    }
  }
  if (sdk === null) {
    console.log('  skip the DSH SDK was not found; set DSH_TOOLS_PATH to dsh-tools/lib/index.js to run the conformance checks');
  }
  if (sdk !== null) {
    const mock = mockFeishu();
    const config = configMod.normalizeConfig({ appId: 'cli_1', appSecret: 'secret' });
    const identity = identityMod.createIdentity({ config, fetchImpl: mock.fetchImpl });
    const client = clientMod.createFeishuClient({ config, identity, fetchImpl: mock.fetchImpl });
    const toolsMod = await import('file:///' + join(LIB, 'tools', 'index.js').replace(/\\/gu, '/'));
    const definitions = toolsMod.buildTools({ client, identity, config, resolveRedirectUri: () => REDIRECT });
    await test('every tool parameter and output schema is accepted by assertSupportedJsonSchema', () => {
      for (const definition of definitions) {
        sdk.assertSupportedJsonSchema(definition.parameters);
        sdk.assertSupportedJsonSchema(definition.output.schema);
      }
      equal(definitions.length, 10);
    });
    await test('every parameter schema renders to a TypeScript SDK type', () => {
      for (const definition of definitions) {
        const rendered = sdk.jsonSchemaToTs(definition.parameters, definition.name);
        assert(typeof rendered === 'string' && rendered.length > 0, definition.name + ' rendered nothing');
      }
    });
    await test('tool names are unique and none is the reserved run_code', () => {
      const names = definitions.map((definition) => definition.name);
      equal(new Set(names).size, names.length);
      assert(!names.includes('run_code'), 'run_code is reserved');
    });
    await test('the registry accepts every definition (register contract only)', () => {
      const recorded = [];
      const registry = { register: (definition) => { sdk.assertSupportedJsonSchema(definition.output.schema); recorded.push(definition.name); return () => {}; } };
      for (const definition of definitions) registry.register(definition);
      equal(recorded.length, definitions.length);
    });
    await test('argument validation paths match the registry validator for a sampled call', () => {
      const definition = definitions.find((entry) => entry.name === 'feishu_bitable');
      const args = { action: 'create_app', name: 'X', tables: [{ name: 'T', fields: [{ name: 'f', type: 'text' }] }] };
      equal(kit.validateArgs(definition.parameters, args).length, 0);
      equal(sdk.validateJsonSchemaValue(definition.parameters, args, '').length, 0);
      const bad = { action: 'nope' };
      assert(kit.validateArgs(definition.parameters, bad).length > 0, 'a bad action must be rejected');
      assert(sdk.validateJsonSchemaValue(definition.parameters, bad, '').length > 0, 'the SDK must also reject it');
    });
  }

  // ------------------------------------------------------------- bitable map
  console.log('');
  console.log('bitable mapping');
  await test('builds a named field with select options', () => {
    const field = bitable.buildField({ name: '状态', type: 'single_select', options: ['完成', '进行中'] });
    equal(field.field_name, '状态');
    equal(field.type, 3);
    equal(field.property.options.length, 2);
    equal(field.property.options[0].name, '完成');
  });
  await test('accepts a numeric field type and default properties', () => {
    const field = bitable.buildField({ name: '分数', type: 2 });
    equal(field.type, 2);
    equal(field.property.formatter, '0');
  });
  await test('rejects an unknown field type with the known list', async () => {
    await rejects(() => bitable.buildField({ name: 'x', type: 'wat' }), 'unknown field type');
  });
  await test('builds a flat insert record', () => {
    const record = bitable.buildRecord({ 姓名: 'Ada', 分数: 95 }, false);
    equal(record.fields['姓名'], 'Ada');
    equal(record.fields['分数'], 95);
    equal(record.record_id, undefined);
  });
  await test('builds an update record from the verbose form', () => {
    const record = bitable.buildRecord({ recordId: 'rec1', fields: { 分数: 96 } }, true);
    equal(record.record_id, 'rec1');
    equal(record.fields['分数'], 96);
  });
  await test('requires a record id when updating', async () => {
    await rejects(() => bitable.buildRecord({ 分数: 1 }, true), 'record id');
  });
  await test('rejects a record id when inserting', async () => {
    await rejects(() => bitable.buildRecord({ recordId: 'rec1', 分数: 1 }, false), 'must not carry a record id');
  });
  await test('flattens rich text and people values read back', () => {
    const flat = bitable.flattenRecord({ record_id: 'rec1', fields: { 备注: [{ type: 'text', text: 'hello' }, { type: 'text', text: ' world' }], 负责人: [{ name: 'Ada' }] } }, true);
    equal(flat.fields['备注'], 'hello world');
    equal(flat.fields['负责人'], 'Ada');
  });
  await test('leaves raw values when readable is false', () => {
    const raw = bitable.flattenRecord({ record_id: 'rec1', fields: { 备注: [{ type: 'text', text: 'hi' }] } }, false);
    equal(Array.isArray(raw.fields['备注']), true);
  });

  // ------------------------------------------------------------- http/client
  console.log('');
  console.log('client');
  await test('unwraps the Feishu envelope', async () => {
    const mock = mockFeishu();
    mock.route('POST', '/open-apis/auth/v3/tenant_access_token/internal', () => ({ body: { code: 0, tenant_access_token: 't1', expire: 7200 } }));
    mock.route('GET', '/open-apis/ping', () => ({ body: { code: 0, data: { pong: true } } }));
    const config = configMod.normalizeConfig({ appId: 'cli_1', appSecret: 'secret' });
    const identity = identityMod.createIdentity({ config, fetchImpl: mock.fetchImpl });
    const client = clientMod.createFeishuClient({ config, identity, fetchImpl: mock.fetchImpl });
    const data = await client.call({ method: 'GET', path: '/ping' });
    equal(data.pong, true);
    const pingCall = mock.log.find((entry) => entry.path === '/open-apis/ping');
    equal(pingCall.headers.authorization, 'Bearer t1');
  });
  await test('maps a business code to an actionable error', async () => {
    const mock = mockFeishu();
    mock.route('POST', '/open-apis/auth/v3/tenant_access_token/internal', () => ({ body: { code: 0, tenant_access_token: 't1', expire: 7200 } }));
    mock.route('GET', '/open-apis/blocked', () => ({ status: 403, body: { code: 99991672, msg: 'no scope', permission_violations: [{ type: 'scope', subject: 'bitable:app' }] } }));
    const config = configMod.normalizeConfig({ appId: 'cli_1', appSecret: 'secret' });
    const identity = identityMod.createIdentity({ config, fetchImpl: mock.fetchImpl });
    const client = clientMod.createFeishuClient({ config, identity, fetchImpl: mock.fetchImpl });
    const error = await rejects(() => client.call({ method: 'GET', path: '/blocked' }));
    assert(errorsMod.isFeishuError(error), 'expected a FeishuError');
    equal(error.code, 99991672);
    equal(error.httpStatus, 403);
    const text = error.toText();
    assert(text.includes('bitable:app'), 'the missing scope should be reported: ' + text);
    assert(text.includes('hint:'), 'a hint should be included: ' + text);
  });
  await test('refreshes an expired token once and retries the call', async () => {
    const mock = mockFeishu();
    let minted = 0;
    mock.route('POST', '/open-apis/auth/v3/tenant_access_token/internal', () => {
      minted += 1;
      return { body: { code: 0, tenant_access_token: 't' + minted, expire: 7200 } };
    });
    let calls = 0;
    mock.route('GET', '/open-apis/flaky', () => {
      calls += 1;
      if (calls === 1) return { body: { code: 99991663, msg: 'token expired' } };
      return { body: { code: 0, data: { ok: true } } };
    });
    const config = configMod.normalizeConfig({ appId: 'cli_1', appSecret: 'secret' });
    const identity = identityMod.createIdentity({ config, fetchImpl: mock.fetchImpl });
    const client = clientMod.createFeishuClient({ config, identity, fetchImpl: mock.fetchImpl });
    const data = await client.call({ method: 'GET', path: '/flaky' });
    equal(data.ok, true);
    equal(calls, 2);
    equal(minted, 2);
  });
  await test('retries a 5xx and then succeeds', async () => {
    const mock = mockFeishu();
    mock.route('POST', '/open-apis/auth/v3/tenant_access_token/internal', () => ({ body: { code: 0, tenant_access_token: 't1', expire: 7200 } }));
    let calls = 0;
    mock.route('GET', '/open-apis/transient', () => {
      calls += 1;
      if (calls === 1) return { status: 503, body: { code: 1, msg: 'busy' } };
      return { body: { code: 0, data: { ok: true } } };
    });
    const config = configMod.normalizeConfig({ appId: 'cli_1', appSecret: 'secret', maxRetries: 2 });
    const identity = identityMod.createIdentity({ config, fetchImpl: mock.fetchImpl });
    const client = clientMod.createFeishuClient({ config, identity, fetchImpl: mock.fetchImpl });
    const data = await client.call({ method: 'GET', path: '/transient' });
    equal(data.ok, true);
    equal(calls, 2);
  });
  await test('paginates until has_more is false', async () => {
    const mock = mockFeishu();
    mock.route('POST', '/open-apis/auth/v3/tenant_access_token/internal', () => ({ body: { code: 0, tenant_access_token: 't1', expire: 7200 } }));
    const pages = [
      { items: [{ id: 1 }, { id: 2 }], has_more: true, page_token: 'p2' },
      { items: [{ id: 3 }], has_more: false },
    ];
    let index = 0;
    mock.route('GET', '/open-apis/list', () => {
      const payload = pages[index];
      index += 1;
      return { body: { code: 0, data: payload } };
    });
    const config = configMod.normalizeConfig({ appId: 'cli_1', appSecret: 'secret' });
    const identity = identityMod.createIdentity({ config, fetchImpl: mock.fetchImpl });
    const client = clientMod.createFeishuClient({ config, identity, fetchImpl: mock.fetchImpl });
    const result = await client.paginate({ path: '/list', itemsPath: 'items' });
    equal(result.items.length, 3);
    equal(result.pages, 2);
    equal(result.hasMore, false);
  });
  await test('honours next_page_token as a cursor', async () => {
    const mock = mockFeishu();
    mock.route('POST', '/open-apis/auth/v3/tenant_access_token/internal', () => ({ body: { code: 0, tenant_access_token: 't1', expire: 7200 } }));
    const pages = [{ files: [{ token: 'a' }], has_more: true, next_page_token: 'n2' }, { files: [{ token: 'b' }], has_more: false }];
    let index = 0;
    mock.route('GET', '/open-apis/drive/v1/files', () => {
      const payload = pages[index];
      index += 1;
      return { body: { code: 0, data: payload } };
    });
    const config = configMod.normalizeConfig({ appId: 'cli_1', appSecret: 'secret' });
    const identity = identityMod.createIdentity({ config, fetchImpl: mock.fetchImpl });
    const client = clientMod.createFeishuClient({ config, identity, fetchImpl: mock.fetchImpl });
    const result = await client.paginate({ path: '/drive/v1/files', itemsPath: 'files' });
    equal(result.items.length, 2);
  });
  await test('surfaces a non-JSON response instead of crashing', async () => {
    const mock = mockFeishu();
    mock.route('POST', '/open-apis/auth/v3/tenant_access_token/internal', () => ({ body: { code: 0, tenant_access_token: 't1', expire: 7200 } }));
    mock.route('GET', '/open-apis/html', () => ({ status: 200, body: '<html>nope</html>' }));
    const config = configMod.normalizeConfig({ appId: 'cli_1', appSecret: 'secret' });
    const identity = identityMod.createIdentity({ config, fetchImpl: mock.fetchImpl });
    const client = clientMod.createFeishuClient({ config, identity, fetchImpl: mock.fetchImpl });
    await rejects(() => client.call({ method: 'GET', path: '/html' }), 'non-JSON');
  });

  // --------------------------------------------------------------- identity
  console.log('');
  console.log('identity');
  await test('mints and caches the tenant token on the open-apis host', async () => {
    const mock = mockFeishu();
    let mints = 0;
    mock.routeOn('POST', '/open-apis/auth/v3/tenant_access_token/internal', 'https://open.feishu.cn');
    mock.route('POST', '/open-apis/auth/v3/tenant_access_token/internal', () => {
      mints += 1;
      return { body: { code: 0, tenant_access_token: 'tok', expire: 7200 } };
    });
    const config = configMod.normalizeConfig({ appId: 'cli_1', appSecret: 'secret' });
    const identity = identityMod.createIdentity({ config, fetchImpl: mock.fetchImpl });
    equal(await identity.tenantToken(), 'tok');
    equal(await identity.tenantToken(), 'tok');
    equal(mints, 1);
    const mint = mock.log.find((entry) => entry.path.includes('tenant_access_token'));
    assert(mint.url.startsWith('https://open.feishu.cn/open-apis/'), 'the tenant token must come from the open-apis host, got ' + mint.url);
  });
  await test('uses the accounts host for OAuth and the open-apis host for tokens', async () => {
    const mock = mockFeishu();
    mock.routeOn('POST', '/open-apis/auth/v3/tenant_access_token/internal', 'https://open.feishu.cn');
    mock.route('POST', '/open-apis/auth/v3/tenant_access_token/internal', () => ({ body: { code: 0, tenant_access_token: 't', expire: 7200 } }));
    mock.routeOn('POST', '/open-apis/authen/v2/oauth/token', 'https://accounts.feishu.cn');
    mock.route('POST', '/open-apis/authen/v2/oauth/token', () => ({ body: { code: 0, access_token: 'u', expires_in: 7200, refresh_token: 'r' } }));
    const config = configMod.normalizeConfig({ appId: 'cli_1', appSecret: 'secret' });
    const identity = identityMod.createIdentity({ config, fetchImpl: mock.fetchImpl });
    await identity.tenantToken();
    await identity.exchangeCode({ code: 'c', redirectUri: REDIRECT });
    for (const entry of mock.log) {
      if (entry.path.includes('tenant_access_token')) assert(entry.url.includes('open.feishu.cn'), 'token host: ' + entry.url);
      if (entry.path.includes('oauth/token')) assert(entry.url.includes('accounts.feishu.cn'), 'oauth host: ' + entry.url);
    }
  });
  await test('reads the app secret from the credentials store first', async () => {
    const store = fakeCredentials();
    store.refs.set('FEISHU_APP_SECRET', 'from-store');
    const mock = mockFeishu();
    let seen;
    mock.route('POST', '/open-apis/auth/v3/tenant_access_token/internal', (request) => {
      seen = JSON.parse(String(request.init.body));
      return { body: { code: 0, tenant_access_token: 'tok', expire: 7200 } };
    });
    const config = configMod.normalizeConfig({ appId: 'cli_1', appSecret: 'from-config' });
    const identity = identityMod.createIdentity({ config, credentials: store, fetchImpl: mock.fetchImpl });
    await identity.tenantToken();
    equal(seen.app_secret, 'from-store');
    const described = await identity.describeCredentials();
    equal(described.secretSource, 'credential:FEISHU_APP_SECRET');
    equal(described.secretConfigured, true);
  });
  await test('reports missing app credentials with a hint', async () => {
    const mock = mockFeishu();
    const config = configMod.normalizeConfig({});
    const identity = identityMod.createIdentity({ config, fetchImpl: mock.fetchImpl });
    const error = await rejects(() => identity.tenantToken(), 'not configured');
    assert(error.hint.includes('FEISHU_APP_SECRET'), 'the hint should name the credential reference');
  });
  await test('exchanges a code, stores the grant, and reads the profile', async () => {
    const mock = mockFeishu();
    mock.route('POST', '/open-apis/authen/v2/oauth/token', () => ({ body: { code: 0, access_token: 'u1', expires_in: 7200, refresh_token: 'r1', refresh_token_expires_in: 2592000, scope: 'bitable:app' } }));
    mock.route('GET', '/open-apis/authen/v1/user_info', () => ({ body: { code: 0, data: { name: 'Ada', open_id: 'ou_1' } } }));
    const store = fakeCredentials();
    const config = configMod.normalizeConfig({ appId: 'cli_1', appSecret: 'secret' });
    const identity = identityMod.createIdentity({ config, credentials: store, fetchImpl: mock.fetchImpl });
    const result = await identity.exchangeCode({ code: 'c1', redirectUri: REDIRECT });
    equal(result.profile.name, 'Ada');
    assert(store.records.has(identityMod.USER_TOKEN_RECORD_KEY), 'the grant should be stored');
    const state = await identity.userState();
    equal(state.authorized, true);
    equal(state.name, 'Ada');
  });
  await test('refreshes a near-expiry grant', async () => {
    const mock = mockFeishu();
    let refreshes = 0;
    mock.route('POST', '/open-apis/authen/v2/oauth/token', (request) => {
      const body = JSON.parse(String(request.init.body));
      if (body.grant_type === 'refresh_token') refreshes += 1;
      return { body: { code: 0, access_token: 'u' + (refreshes + 1), expires_in: 7200, refresh_token: 'r2', refresh_token_expires_in: 2592000 } };
    });
    const store = fakeCredentials();
    store.records.set(identityMod.USER_TOKEN_RECORD_KEY, {
      kind: 'grant',
      payload: { accessToken: 'stale', refreshToken: 'r1', expiresAt: Date.now() - 1000, refreshExpiresAt: Date.now() + 1000000, scope: 'x' },
    });
    const config = configMod.normalizeConfig({ appId: 'cli_1', appSecret: 'secret' });
    const identity = identityMod.createIdentity({ config, credentials: store, fetchImpl: mock.fetchImpl });
    const token = await identity.userToken();
    equal(token.accessToken, 'u2');
    equal(refreshes, 1);
    // Feishu refresh tokens are single-use, so a reply that carries a new one has
    // to replace the stored value; keeping the old one would fail the next refresh
    // with 20073 "already been used".
    const rotated = store.records.get(identityMod.USER_TOKEN_RECORD_KEY).payload;
    equal(rotated.refreshToken, 'r2', 'a rotated refresh token must be stored');
    assert(rotated.refreshExpiresAt > Date.now(), 'the rotated expiry must be stored too');
  });
  await test('keeps the stored refresh token when a refresh reply omits a new one', async () => {
    // The secret deliberately lives in the credential store, not in
    // config.appSecret: the old carry-over was gated on config.appSecret being
    // non-empty, so only this shape reproduces the lost-grant failure.
    const mock = mockFeishu();
    let refreshCalls = 0;
    mock.route('POST', '/open-apis/authen/v2/oauth/token', () => {
      refreshCalls += 1;
      // Feishu rotates the refresh token only sometimes. This reply carries
      // none, which used to wipe the only credential able to refresh again.
      return { body: { code: 0, access_token: 'u-next', expires_in: 7200 } };
    });
    const store = fakeCredentials();
    store.refs.set('FEISHU_APP_SECRET', 'secret-from-store');
    store.records.set(identityMod.USER_TOKEN_RECORD_KEY, {
      kind: 'grant',
      payload: {
        accessToken: 'stale',
        refreshToken: 'r1',
        expiresAt: Date.now() - 1000,
        refreshExpiresAt: Date.now() + 1000000,
        scope: 'offline_access drive:drive',
        openId: 'ou_1',
        name: 'Tester',
      },
    });
    const config = configMod.normalizeConfig({ appId: 'cli_1' });
    equal(config.appSecret, '', 'this test only means something with no config-level secret');
    const identity = identityMod.createIdentity({ config, credentials: store, fetchImpl: mock.fetchImpl });
    await identity.userToken();
    const saved = store.records.get(identityMod.USER_TOKEN_RECORD_KEY).payload;
    equal(refreshCalls, 1, 'exactly one refresh should have happened');
    equal(saved.accessToken, 'u-next');
    equal(saved.refreshToken, 'r1', 'the previous refresh token must survive a reply that omits a new one');
    assert(saved.refreshExpiresAt > 0, 'the previous refresh expiry must be carried over too');
    equal(saved.scope, 'offline_access drive:drive', 'an omitted scope is not a revocation and must be carried over');
    const state = await identity.userState();
    equal(state.refreshable, true, 'the grant must remain refreshable after the rotation');
  });
  await test('keeps a rotated grant usable in memory when the credential write fails', async () => {
    // A refresh token is single-use: if writing the rotated record fails and the
    // failure escapes, the caller sees an error while the only live refresh token
    // has nowhere to go. The exchange must survive the failed write, and the
    // in-memory copy must still refresh again.
    const mock = mockFeishu();
    let refreshCalls = 0;
    mock.route('POST', '/open-apis/authen/v2/oauth/token', () => {
      refreshCalls += 1;
      return { body: { code: 0, access_token: 'u-' + refreshCalls, expires_in: 7200, refresh_token: 'r-' + refreshCalls, refresh_token_expires_in: 2592000 } };
    });
    let clock = Date.now();
    const store = fakeCredentials();
    store.refs.set('FEISHU_APP_SECRET', 'secret-from-store');
    // The stored grant is readable but unwritable: a read-only store, which is what
    // a read-only / locked-down credentials file looks like at runtime.
    store.readRecord = async () => ({
      kind: 'grant',
      payload: { accessToken: 'stale', refreshToken: 'r0', expiresAt: clock - 1000, refreshExpiresAt: 0, scope: 'x' },
    });
    store.modifyRecord = async () => {
      throw new Error('the store is read-only');
    };
    const config = configMod.normalizeConfig({ appId: 'cli_1' });
    const warnings = [];
    const identity = identityMod.createIdentity({
      config,
      credentials: store,
      fetchImpl: mock.fetchImpl,
      now: () => clock,
      logger: { warn: (line) => warnings.push(line) },
    });
    const first = await identity.userToken();
    equal(first.accessToken, 'u-1', 'the refresh should succeed even though the record could not be written');
    assert(warnings.some((line) => line.includes('survives only in this process')), 'the degraded persistence must be reported');
    clock += 7300000;
    const second = await identity.userToken();
    equal(second.accessToken, 'u-2', 'the in-memory refresh token must still work after the failed write');
    equal(refreshCalls, 2);
  });
  await test('reports the refresh lifetime without inventing one', async () => {
    const make = (payload) => {
      const store = fakeCredentials();
      store.records.set(identityMod.USER_TOKEN_RECORD_KEY, { kind: 'grant', payload });
      return identityMod.createIdentity({ config: configMod.normalizeConfig({ appId: 'cli_1' }), credentials: store });
    };
    const known = await make({ accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 1000, refreshExpiresAt: Date.now() + 3 * 86400000, scope: 'x' }).userState();
    equal(known.refreshExpiresInDays, 3, 'a known refresh lifetime should be reported in days');
    const unknown = await make({ accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 1000, refreshExpiresAt: 0 }).userState();
    assert(!('refreshExpiresInDays' in unknown), 'an unknown refresh lifetime must stay absent, not become zero');
    // Tool results have to be lossless JSON, which an undefined-valued key is not.
    equal(JSON.stringify(unknown), JSON.stringify(JSON.parse(JSON.stringify(unknown))));
  });
  await test('surfaces the refresh failure code and its remediation hint', async () => {
    // The token endpoint reports failures as {code, error, error_description}. The
    // code selects the hint, so it must survive into the error instead of being
    // dropped with the prose.
    const mock = mockFeishu();
    mock.route('POST', '/open-apis/authen/v2/oauth/token', () => ({
      status: 400,
      body: { code: 20073, error: 'invalid_grant', error_description: 'The refresh token has been used.' },
    }));
    const store = fakeCredentials();
    store.refs.set('FEISHU_APP_SECRET', 'secret-from-store');
    store.records.set(identityMod.USER_TOKEN_RECORD_KEY, {
      kind: 'grant',
      payload: { accessToken: 'stale', refreshToken: 'r1', expiresAt: Date.now() - 1000, refreshExpiresAt: Date.now() + 1000000, scope: 'x' },
    });
    const config = configMod.normalizeConfig({ appId: 'cli_1' });
    const identity = identityMod.createIdentity({ config, credentials: store, fetchImpl: mock.fetchImpl });
    const error = await rejects(() => identity.userToken(), 'has been used');
    equal(error.code, 20073);
    assert(String(error.hint).includes('authorize_url'), 'a used refresh token must point at re-authorization');
    const state = await identity.userState();
    equal(state.refreshable, true, 'a failed refresh must leave the stored grant alone');
  });
  await test('auth authorize_url registers the state its callback will match', async () => {
    // The callback rejects a state this host never started, and only the /start
    // route used to register one — so a URL minted by this tool failed with
    // "Authorization state mismatch" the moment the panel had been used.
    const registered = [];
    const mock = mockFeishu();
    const { config, identity, client } = compose(mock);
    const toolsMod = await import('file:///' + join(LIB, 'tools', 'index.js').replace(/\\/gu, '/'));
    const definitions = toolsMod.buildTools({
      client, identity, config,
      resolveRedirectUri: () => REDIRECT,
      registerOAuthState: (state) => registered.push(state),
    });
    const tool = find(definitions, 'feishu_auth');
    const value = await tool.execute({ action: 'authorize_url' }, {});
    equal(registered.length, 1, 'the advertised state has to be registered with the host');
    equal(registered[0], value.data.state, 'the registered state is the one in the URL');
    assert(String(value.url).includes('state=' + value.data.state), 'the URL should carry that same state');
  });
  await test('reports the app identity and warns when auto has no grant', async () => {
    const mock = mockFeishu();
    mock.route('POST', '/open-apis/auth/v3/tenant_access_token/internal', () => ({ body: { code: 0, tenant_access_token: 't1', expire: 7200 } }));
    const config = configMod.normalizeConfig({ appId: 'cli_1', appSecret: 'secret' });
    const identity = identityMod.createIdentity({ config, fetchImpl: mock.fetchImpl });
    const resolved = await identity.resolveIdentity('auto');
    equal(resolved.kind, 'app');
    assert(resolved.warnings.length === 1 && resolved.warnings[0].includes('app'), 'a fallback warning is expected');
  });
  await test('refuses a user-identity call with no grant and says how to fix it', async () => {
    const config = configMod.normalizeConfig({ appId: 'cli_1', appSecret: 'secret' });
    const identity = identityMod.createIdentity({ config, fetchImpl: mockFeishu().fetchImpl });
    const error = await rejects(() => identity.resolveIdentity('user'), 'user authorization');
    assert(error.hint.includes('feishu_auth'), 'the hint should name the authorization tool');
  });
  await test('builds an authorization URL carrying the state and scopes', () => {
    const config = configMod.normalizeConfig({ appId: 'cli_1', appSecret: 's' });
    const identity = identityMod.createIdentity({ config, fetchImpl: mockFeishu().fetchImpl });
    const built = identity.authorizeUrl({ scopes: ['bitable:app', 'offline_access'], redirectUri: REDIRECT, state: 'st1' });
    assert(built.url.startsWith('https://accounts.feishu.cn/open-apis/authen/v1/authorize?'), 'unexpected authorize endpoint: ' + built.url);
    assert(built.url.includes('client_id=cli_1'), 'the app id should be present');
    assert(built.url.includes('state=st1'), 'the state should be present');
    assert(built.url.includes('scope=bitable%3Aapp%20offline_access'), 'the scopes should be joined: ' + built.url);
  });
  await test('masks identifiers', () => {
    equal(identityMod.mask('cli_a1b2c3d4e5f6'), 'cli_***e5f6');
    equal(identityMod.mask(''), '');
  });

  // ------------------------------------------------------------------ tools
  console.log('');
  console.log('tools end to end');
  /**
   * Build a client wired to a mock, with an app secret configured.
   * @param mock - the mock service.
   * @returns the composition.
   */
  function compose(mock, extra) {
    const config = configMod.normalizeConfig({ appId: 'cli_1', appSecret: 'secret', ...(extra !== undefined ? extra : {}) });
    const identity = identityMod.createIdentity({ config, credentials: extra !== undefined ? extra.credentials : undefined, fetchImpl: mock.fetchImpl });
    const client = clientMod.createFeishuClient({ config, identity, fetchImpl: mock.fetchImpl });
    return { config, identity, client };
  }
  /**
   * Find a tool definition by name.
   * @param definitions - the definitions.
   * @param toolName - the tool name.
   * @returns the definition.
   */
  function find(definitions, toolName) {
    const found = definitions.find((entry) => entry.name === toolName);
    assert(found !== undefined, 'no tool named ' + toolName);
    return found;
  }
  /** Extract the rendered text of a tool result. */
  function textOf(value) {
    const blocks = kit.renderResult(value);
    return blocks.map((block) => block.text).join('\n');
  }

  const toolsMod = await import('file:///' + join(LIB, 'tools', 'index.js').replace(/\\/gu, '/'));

  await test('create_app creates the app plus its tables in one call', async () => {
    const mock = mockFeishu();
    mock.route('POST', '/open-apis/auth/v3/tenant_access_token/internal', () => ({ body: { code: 0, tenant_access_token: 't1', expire: 7200 } }));
    mock.route('POST', '/open-apis/bitable/v1/apps', () => ({ body: { code: 0, data: { app: { app_token: 'bas1', name: '项目', url: 'https://feishu.cn/base/bas1' } } } }));
    mock.route('POST', '/open-apis/bitable/v1/apps/bas1/tables', () => ({ body: { code: 0, data: { table_id: 'tbl1' } } }));
    const { config, identity, client } = compose(mock);
    const definitions = toolsMod.buildTools({ client, identity, config, resolveRedirectUri: () => REDIRECT });
    const tool = find(definitions, 'feishu_bitable');
    const value = await tool.execute({ action: 'create_app', name: '项目', tables: [{ name: '任务', fields: [{ name: '标题', type: 'text' }] }] }, {});
    equal(value.ok, true);
    equal(value.url, 'https://feishu.cn/base/bas1');
    equal(value.data.tables.length, 1);
    equal(value.data.tables[0].table_id, 'tbl1');
    assert(textOf(value).includes('bas1'), 'the rendered text should identify the app');
  });
  await test('insert_records chunks and flattens the response', async () => {
    const mock = mockFeishu();
    mock.route('POST', '/open-apis/auth/v3/tenant_access_token/internal', () => ({ body: { code: 0, tenant_access_token: 't1', expire: 7200 } }));
    mock.route('POST', '/open-apis/bitable/v1/apps/bas1/tables/tbl1/records/batch_create', () => ({ body: { code: 0, data: { records: [{ record_id: 'rec1', fields: { 标题: [{ type: 'text', text: 'first' }] } }] } } }));
    const { config, identity, client } = compose(mock);
    const definitions = toolsMod.buildTools({ client, identity, config, resolveRedirectUri: () => REDIRECT });
    const tool = find(definitions, 'feishu_bitable');
    const value = await tool.execute({ action: 'insert_records', appToken: 'bas1', tableId: 'tbl1', records: [{ 标题: 'first' }] }, {});
    equal(value.data.records.length, 1);
    equal(value.data.records[0].fields['标题'], 'first');
  });
  await test('search_records follows the page token', async () => {
    const mock = mockFeishu();
    mock.route('POST', '/open-apis/auth/v3/tenant_access_token/internal', () => ({ body: { code: 0, tenant_access_token: 't1', expire: 7200 } }));
    const pages = [{ items: [{ record_id: 'a', fields: {} }], has_more: true, page_token: 'p2' }, { items: [{ record_id: 'b', fields: {} }], has_more: false }];
    let index = 0;
    mock.route('POST', '/open-apis/bitable/v1/apps/bas1/tables/tbl1/records/search', () => {
      const payload = pages[index];
      index += 1;
      return { body: { code: 0, data: payload } };
    });
    const { config, identity, client } = compose(mock);
    const definitions = toolsMod.buildTools({ client, identity, config, resolveRedirectUri: () => REDIRECT });
    const tool = find(definitions, 'feishu_bitable');
    const value = await tool.execute({ action: 'search_records', appToken: 'bas1', tableId: 'tbl1' }, {});
    equal(value.data.records.length, 2);
    equal(value.data.pages, 2);
  });
  await test('a Bitable failure becomes an explanatory error result', async () => {
    const mock = mockFeishu();
    mock.route('POST', '/open-apis/auth/v3/tenant_access_token/internal', () => ({ body: { code: 0, tenant_access_token: 't1', expire: 7200 } }));
    mock.route('POST', '/open-apis/bitable/v1/apps', () => ({ status: 403, body: { code: 99991672, msg: 'no scope', permission_violations: [{ subject: 'bitable:app' }] } }));
    const { config, identity, client } = compose(mock);
    const definitions = toolsMod.buildTools({ client, identity, config, resolveRedirectUri: () => REDIRECT });
    const tool = find(definitions, 'feishu_bitable');
    const error = await rejects(() => tool.execute({ action: 'create_app', name: 'X' }, {}));
    assert(errorsMod.isFeishuError(error), 'expected a FeishuError');
    assert(error.toText().includes('bitable:app'), 'the missing scope should be reported');
  });
  await test('rejects an unknown argument before any network call', async () => {
    const mock = mockFeishu();
    const { config, identity, client } = compose(mock);
    const definitions = toolsMod.buildTools({ client, identity, config, resolveRedirectUri: () => REDIRECT });
    const tool = find(definitions, 'feishu_bitable');
    await rejects(() => tool.execute({ action: 'create_app', name: 'X', nonsense: 1 }, {}), 'invalid arguments');
    equal(mock.log.length, 0);
  });
  await test('rejects a domain-level omission before any network call', async () => {
    const mock = mockFeishu();
    const { config, identity, client } = compose(mock);
    const definitions = toolsMod.buildTools({ client, identity, config, resolveRedirectUri: () => REDIRECT });
    const tool = find(definitions, 'feishu_bitable');
    await rejects(() => tool.execute({ action: 'create_app' }, {}), 'create_app needs a name');
    equal(mock.log.length, 0);
  });
  await test('rejects an unknown action', async () => {
    const mock = mockFeishu();
    const { config, identity, client } = compose(mock);
    const definitions = toolsMod.buildTools({ client, identity, config, resolveRedirectUri: () => REDIRECT });
    const tool = find(definitions, 'feishu_bitable');
    await rejects(() => tool.execute({ action: 'nope' }, {}), 'invalid arguments');
  });
  await test('docx append_markdown converts then appends descendants', async () => {
    const mock = mockFeishu();
    mock.route('POST', '/open-apis/auth/v3/tenant_access_token/internal', () => ({ body: { code: 0, tenant_access_token: 't1', expire: 7200 } }));
    mock.route('POST', '/open-apis/docx/v1/documents/blocks/convert', () => ({ body: { code: 0, data: { blocks: [{ block_id: 'b1', block_type: 3 }, { block_id: 'b2', block_type: 2 }], first_level_block_ids: ['b1', 'b2'] } } }));
    mock.route('POST', '/open-apis/docx/v1/documents/dox1/blocks/dox1/descendant', () => ({ body: { code: 0, data: { children: [{ block_id: 'b1' }, { block_id: 'b2' }] } } }));
    const { config, identity, client } = compose(mock);
    const definitions = toolsMod.buildTools({ client, identity, config, resolveRedirectUri: () => REDIRECT });
    const tool = find(definitions, 'feishu_doc');
    const value = await tool.execute({ action: 'append_markdown', documentId: 'dox1', markdown: '# Title' }, {});
    equal(value.data.appended, 2);
    assert(value.url.includes('dox1'), 'the document URL should be reported');
  });
  await test('docx append_markdown asks the converter for markdown, not "md"', async () => {
    const mock = mockFeishu();
    mock.route('POST', '/open-apis/auth/v3/tenant_access_token/internal', () => ({ body: { code: 0, tenant_access_token: 't1', expire: 7200 } }));
    let convertBody;
    mock.route('POST', '/open-apis/docx/v1/documents/blocks/convert', (request) => {
      convertBody = JSON.parse(String(request.init.body));
      return { body: { code: 0, data: { blocks: [{ block_id: 'b1', block_type: 2 }], first_level_block_ids: ['b1'] } } };
    });
    mock.route('POST', '/open-apis/docx/v1/documents/dox1/blocks/dox1/descendant', () => ({ body: { code: 0, data: {} } }));
    const { config, identity, client } = compose(mock);
    const definitions = toolsMod.buildTools({ client, identity, config, resolveRedirectUri: () => REDIRECT });
    const tool = find(definitions, 'feishu_doc');
    await tool.execute({ action: 'append_markdown', documentId: 'dox1', markdown: 'hi' }, {});
    equal(convertBody.content_type, 'markdown', 'Feishu answers content_type "md" with a bare field validation error');
  });
  await test('docx import_file reports the ticket it polled with', async () => {
    // Without the ticket a caller cannot follow up with list_import_tasks, and the
    // polled payload is service-shaped: it may carry no ticket at all (seen live).
    const mock = mockFeishu();
    mock.route('POST', '/open-apis/auth/v3/tenant_access_token/internal', () => ({ body: { code: 0, tenant_access_token: 't1', expire: 7200 } }));
    mock.route('POST', '/open-apis/drive/v1/medias/upload_all', () => ({ body: { code: 0, data: { file_token: 'm1' } } }));
    mock.route('POST', '/open-apis/drive/v1/import_tasks', () => ({ body: { code: 0, data: { ticket: 'tk-1' } } }));
    mock.route('GET', '/open-apis/drive/v1/import_tasks/tk-1', () => ({ body: { code: 0, data: { result: { job_status: 0, job_error_msg: 'success', token: 'doxNew', url: 'https://x/doxNew' } } } }));
    const dir = await mkdtemp(join(tmpdir(), 'dsh-feishu-'));
    const file = join(dir, 'import.md');
    await writeFile(file, '# import', 'utf8');
    try {
      const { config, identity, client } = compose(mock);
      const definitions = toolsMod.buildTools({ client, identity, config, resolveRedirectUri: () => REDIRECT });
      const tool = find(definitions, 'feishu_doc');
      const value = await tool.execute({ action: 'import_file', filePath: file, folderToken: 'fld1' }, {});
      equal(value.data.ticket, 'tk-1', 'the ticket has to survive into the result');
      equal(value.data.token, 'doxNew', 'the imported document token comes from the polled payload');
      assert(String(value.url).includes('doxNew'), 'the document URL should be reported');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  await test('bitable create_app names the app it already made when a table is rejected', async () => {
    // The app and its tables are two calls: a rejected table leaves a real Base
    // behind, and the bare API error hides its token — leaving the caller with an
    // orphan it cannot address. Observed live with an unsupported number formatter.
    const mock = mockFeishu();
    mock.route('POST', '/open-apis/auth/v3/tenant_access_token/internal', () => ({ body: { code: 0, tenant_access_token: 't1', expire: 7200 } }));
    mock.route('POST', '/open-apis/bitable/v1/apps', () => ({ body: { code: 0, data: { app: { app_token: 'basNEW', name: 'dev tasks', url: 'https://x/base/basNEW' } } } }));
    mock.route('POST', '/open-apis/bitable/v1/apps/basNEW/tables', () => ({ body: { code: 1254001, msg: 'WrongRequestBody' } }));
    const { config, identity, client } = compose(mock);
    const definitions = toolsMod.buildTools({ client, identity, config, resolveRedirectUri: () => REDIRECT });
    const tool = find(definitions, 'feishu_bitable');
    const error = await rejects(
      () => tool.execute({ action: 'create_app', name: 'dev tasks', tables: [{ name: 'items', fields: [{ name: 'x', type: 'text' }] }] }, {}),
      'the Bitable app was created',
    );
    assert(String(error.message).includes('basNEW'), 'the message must carry the app token that now exists');
    assert(String(error.message).includes('create_table'), 'it should say how to finish the job');
  });
  await test('bitable create_field takes its name from fields when name is omitted', async () => {
    // create_table and create_app both take a fields array, so a caller reasonably
    // describes the field there; demanding a separate flat name was a trap.
    const mock = mockFeishu();
    mock.route('POST', '/open-apis/auth/v3/tenant_access_token/internal', () => ({ body: { code: 0, tenant_access_token: 't1', expire: 7200 } }));
    let sent;
    mock.route('POST', '/open-apis/bitable/v1/apps/bas1/tables/tbl1/fields', (request) => {
      sent = JSON.parse(String(request.init.body));
      return { body: { code: 0, data: { field: { field_id: 'fld1', field_name: sent.field_name, type: Number(sent.type) } } } };
    });
    const { config, identity, client } = compose(mock);
    const definitions = toolsMod.buildTools({ client, identity, config, resolveRedirectUri: () => REDIRECT });
    const tool = find(definitions, 'feishu_bitable');
    const value = await tool.execute({ action: 'create_field', appToken: 'bas1', tableId: 'tbl1', fields: [{ name: '备注', type: 'text' }] }, {});
    equal(sent.field_name, '备注', 'the name inside fields[0] should be used');
    assert(String(value.summary).includes('备注'), 'the summary should name the created field');
  });
  await test('drive delete_file accepts a folder token', async () => {
    // The tool creates folders, so it has to be able to delete them: without
    // "folder" in the type enum every folder this tool made became permanent.
    const mock = mockFeishu();
    mock.route('POST', '/open-apis/auth/v3/tenant_access_token/internal', () => ({ body: { code: 0, tenant_access_token: 't1', expire: 7200 } }));
    let deletedPath = '';
    mock.route('DELETE', '/open-apis/drive/v1/files/fld9', (request) => {
      deletedPath = request.url.pathname + request.url.search;
      return { body: { code: 0, data: { task_id: 't', type: 'folder' } } };
    });
    const { config, identity, client } = compose(mock);
    const definitions = toolsMod.buildTools({ client, identity, config, resolveRedirectUri: () => REDIRECT });
    const tool = find(definitions, 'feishu_drive');
    const value = await tool.execute({ action: 'delete_file', fileToken: 'fld9', docType: 'folder' }, {});
    assert(String(value.summary).includes('folder'), 'the summary should name the folder type');
    assert(deletedPath.includes('type=folder'), 'the delete call should ask for type=folder, got ' + deletedPath);
  });
  await test('the recommended scopes cover the Base dashboard write path', async () => {
    // Read alone answers 99991679 on create_dashboard/create_block (verified live),
    // so a recommended set without the write scope can never work for those actions.
    const auth = await import('file:///' + join(LIB, 'tools', 'auth.js').replace(/\\/gu, '/'));
    assert(auth.RECOMMENDED_SCOPES.includes('offline_access'), 'offline_access is what makes the grant refreshable');
    assert(auth.RECOMMENDED_SCOPES.includes('base:dashboard:read'), 'dashboard reads need this');
    assert(auth.RECOMMENDED_SCOPES.includes('base:dashboard:create'), 'creating a dashboard or a block needs this');
    assert(auth.RECOMMENDED_SCOPES.includes('base:dashboard:update'), 'updating a block needs this');
    assert(auth.RECOMMENDED_SCOPES.includes('base:dashboard:delete'), 'deleting a block needs this');
  });
  await test('drive create_folder resolves the root folder when no folderToken is given', async () => {
    const mock = mockFeishu();
    mock.route('POST', '/open-apis/auth/v3/tenant_access_token/internal', () => ({ body: { code: 0, tenant_access_token: 't1', expire: 7200 } }));
    mock.route('GET', '/open-apis/drive/explorer/v2/root_folder/meta', () => ({ body: { code: 0, data: { token: 'root1', id: '1' } } }));
    let createBody;
    mock.route('POST', '/open-apis/drive/v1/files/create_folder', (request) => {
      createBody = JSON.parse(String(request.init.body));
      return { body: { code: 0, data: { token: 'new1', url: 'https://example.test/folder/new1' } } };
    });
    const { config, identity, client } = compose(mock);
    const definitions = toolsMod.buildTools({ client, identity, config, resolveRedirectUri: () => REDIRECT });
    const tool = find(definitions, 'feishu_drive');
    await tool.execute({ action: 'create_folder', name: 'demo' }, {});
    equal(createBody.folder_token, 'root1', 'a root-level create must send the resolved root token, not omit the field');
  });
  await test('drive get_meta resolves a call that mixes docx and sheet tokens', async () => {
    const mock = mockFeishu();
    mock.route('POST', '/open-apis/auth/v3/tenant_access_token/internal', () => ({ body: { code: 0, tenant_access_token: 't1', expire: 7200 } }));
    mock.route('POST', '/open-apis/drive/v1/metas/batch_query', (request) => {
      const body = JSON.parse(String(request.init.body));
      const docs = Array.isArray(body.request_docs) ? body.request_docs : [];
      const accepted = docs.filter((doc) => doc.doc_type === 'docx' || doc.doc_type === 'sheet');
      const rejected = docs.filter((doc) => doc.doc_type !== 'docx' && doc.doc_type !== 'sheet');
      return {
        body: {
          code: 0,
          data: {
            metas: accepted.map((doc) => ({ doc_token: doc.doc_token, doc_type: doc.doc_type, title: 't-' + doc.doc_type })),
            failed_list: rejected.map((doc) => ({ token: doc.doc_token, code: 970005 })),
          },
        },
      };
    });
    const { config, identity, client } = compose(mock);
    const definitions = toolsMod.buildTools({ client, identity, config, resolveRedirectUri: () => REDIRECT });
    const tool = find(definitions, 'feishu_drive');
    const value = await tool.execute({ action: 'get_meta', tokens: ['d1', 's1'] }, {});
    equal(value.data.metas.length, 2, 'each token should resolve by trying the remaining doc types');
    equal(value.data.failed, undefined, 'nothing should be left unresolved');
  });
  await test('sheet write qualifies an unqualified range with the first sheet id', async () => {
    const mock = mockFeishu();
    mock.route('POST', '/open-apis/auth/v3/tenant_access_token/internal', () => ({ body: { code: 0, tenant_access_token: 't1', expire: 7200 } }));
    mock.route('GET', '/open-apis/sheets/v3/spreadsheets/sht1/sheets/query', () => ({ body: { code: 0, data: { sheets: [{ sheet_id: 'sh1', title: 'Sheet1' }] } } }));
    let writeBody;
    mock.route('PUT', '/open-apis/sheets/v2/spreadsheets/sht1/values', (request) => {
      writeBody = JSON.parse(String(request.init.body));
      return { body: { code: 0, data: { updates: { updatedRows: 2 } } } };
    });
    const { config, identity, client } = compose(mock);
    const definitions = toolsMod.buildTools({ client, identity, config, resolveRedirectUri: () => REDIRECT });
    const tool = find(definitions, 'feishu_sheet');
    const value = await tool.execute({ action: 'write', spreadsheetToken: 'sht1', range: 'A1:B2', values: [['a', 'b'], ['c', 'd']] }, {});
    equal(writeBody.valueRange.range, 'sh1!A1:B2');
    equal(value.data.updatedRows, 2);
  });
  await test('drive upload sends the file as multipart', async () => {
    const mock = mockFeishu();
    mock.route('POST', '/open-apis/auth/v3/tenant_access_token/internal', () => ({ body: { code: 0, tenant_access_token: 't1', expire: 7200 } }));
    let sawForm = false;
    mock.route('POST', '/open-apis/drive/v1/medias/upload_all', (request) => {
      sawForm = request.init.body instanceof FormData;
      return { body: { code: 0, data: { file_token: 'f1' } } };
    });
    const dir = await mkdtemp(join(tmpdir(), 'dsh-feishu-'));
    const file = join(dir, 'note.md');
    await writeFile(file, '# hello', 'utf8');
    try {
      const { config, identity, client } = compose(mock);
      const definitions = toolsMod.buildTools({ client, identity, config, resolveRedirectUri: () => REDIRECT });
      const tool = find(definitions, 'feishu_drive');
      const value = await tool.execute({ action: 'upload', filePath: file, folderToken: 'fld1' }, {});
      equal(sawForm, true);
      equal(value.data.fileToken, 'f1');
      equal(value.data.size, 7);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  await test('drive download writes the local file', async () => {
    const mock = mockFeishu();
    mock.route('POST', '/open-apis/auth/v3/tenant_access_token/internal', () => ({ body: { code: 0, tenant_access_token: 't1', expire: 7200 } }));
    mock.route('GET', '/open-apis/drive/v1/files/f1/download', () => ({ status: 200, body: 'binary-payload' }));
    const dir = await mkdtemp(join(tmpdir(), 'dsh-feishu-'));
    const target = join(dir, 'out.bin');
    try {
      const { config, identity, client } = compose(mock);
      const definitions = toolsMod.buildTools({ client, identity, config, resolveRedirectUri: () => REDIRECT });
      const tool = find(definitions, 'feishu_drive');
      const value = await tool.execute({ action: 'download', fileToken: 'f1', outputPath: target }, {});
      equal(await readFile(target, 'utf8'), 'binary-payload');
      equal(value.data.bytes, 14);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  await test('the raw escape hatch rejects a path without a leading slash', async () => {
    const mock = mockFeishu();
    const { config, identity, client } = compose(mock);
    const definitions = toolsMod.buildTools({ client, identity, config, resolveRedirectUri: () => REDIRECT });
    const tool = find(definitions, 'feishu_api');
    await rejects(() => tool.execute({ method: 'GET', path: 'contact/v3/users' }, {}), 'leading slash');
  });
  await test('the auth tool reports status and an authorization URL', async () => {
    const mock = mockFeishu();
    mock.route('POST', '/open-apis/auth/v3/tenant_access_token/internal', () => ({ body: { code: 0, tenant_access_token: 't1', expire: 7200 } }));
    const { config, identity, client } = compose(mock);
    const definitions = toolsMod.buildTools({ client, identity, config, resolveRedirectUri: () => REDIRECT });
    const status = await find(definitions, 'feishu_auth').execute({ action: 'status' }, {});
    equal(status.data.tenantTokenOk, true);
    assert(status.warnings.some((entry) => entry.includes('authorize_url')), 'the missing grant should be flagged');
    const authorize = await find(definitions, 'feishu_auth').execute({ action: 'authorize_url' }, {});
    assert(authorize.url.includes('client_id=cli_1'), 'the URL should carry the app id: ' + authorize.url);
    assert(authorize.url.includes('offline_access'), 'offline_access should be requested by default');
  });
  await test('a custom tool prefix renames every tool', async () => {
    const mock = mockFeishu();
    const { config, identity, client } = compose(mock, { toolPrefix: 'fs' });
    const definitions = toolsMod.buildTools({ client, identity, config, resolveRedirectUri: () => REDIRECT });
    assert(definitions.every((entry) => entry.name.startsWith('fs_')), 'every tool should carry the prefix');
    assert(definitions.some((entry) => entry.name === 'fs_bitable'), 'expected fs_bitable');
  });
  await test('the activity ring records calls and stays bounded', async () => {
    const mock = mockFeishu();
    mock.route('POST', '/open-apis/auth/v3/tenant_access_token/internal', () => ({ body: { code: 0, tenant_access_token: 't1', expire: 7200 } }));
    mock.route('POST', '/open-apis/bitable/v1/apps', (request) => {
      const body = JSON.parse(String(request.init.body));
      return { body: { code: 0, data: { app: { app_token: 'bas1', name: body.name, url: 'u' } } } };
    });
    const activityMod = await import('file:///' + join(LIB, 'activity.js').replace(/\\/gu, '/'));
    const activity = activityMod.createActivityLog(2);
    const { config, identity, client } = compose(mock);
    const definitions = toolsMod.buildTools({ client, identity, config, activity, resolveRedirectUri: () => REDIRECT });
    const tool = find(definitions, 'feishu_bitable');
    await tool.execute({ action: 'create_app', name: 'A' }, {});
    await tool.execute({ action: 'create_app', name: 'B' }, {});
    await tool.execute({ action: 'create_app', name: 'C' }, {});
    equal(activity.list().length, 2);
    const latest = activity.list()[activity.list().length - 1];
    assert(latest.summary.includes('"C"'), 'the newest entry should be retained, got ' + latest.summary);
  });

  // ----------------------------------------------------------------- routes
  console.log('');
  console.log('http routes');
  /**
   * Build a fake request/response pair.
   * @param method - the HTTP method.
   * @param url - the request URL.
   * @returns the pair plus the capture.
   */
  function fakeHttp(method, url) {
    const captured = { status: undefined, headers: undefined, body: undefined };
    const request = { method, url };
    const response = {
      writeHead(status, headers) {
        captured.status = status;
        captured.headers = headers;
        return response;
      },
      end(body) {
        captured.body = body;
      },
    };
    return { request, response, captured };
  }
  await test('status reports configuration without leaking the secret', async () => {
    const mock = mockFeishu();
    mock.route('POST', '/open-apis/auth/v3/tenant_access_token/internal', () => ({ body: { code: 0, tenant_access_token: 't1', expire: 7200 } }));
    const { config, identity } = compose(mock);
    const activityMod = await import('file:///' + join(LIB, 'activity.js').replace(/\\/gu, '/'));
    const handlers = routesMod.createRouteHandlers({ config, identity, activity: activityMod.createActivityLog(5), oauth: { pending: new Set() }, resolveRedirectUri: () => REDIRECT });
    const http = fakeHttp('GET', routesMod.ROUTES.status);
    await handlers[routesMod.ROUTES.status](http.request, http.response);
    const payload = JSON.parse(http.captured.body);
    equal(payload.ok, true);
    equal(payload.data.appSecretConfigured, true);
    equal(JSON.stringify(payload).includes('secret"'), false);
    assert(!JSON.stringify(payload).includes('"secret"'), 'the raw secret must never be returned');
  });
  await test('oauth/start redirects and remembers the state', async () => {
    const mock = mockFeishu();
    const { config, identity } = compose(mock);
    const activityMod = await import('file:///' + join(LIB, 'activity.js').replace(/\\/gu, '/'));
    const oauth = { pending: new Set() };
    const handlers = routesMod.createRouteHandlers({ config, identity, activity: activityMod.createActivityLog(5), oauth, resolveRedirectUri: () => REDIRECT });
    const http = fakeHttp('GET', routesMod.ROUTES.oauthStart);
    await handlers[routesMod.ROUTES.oauthStart](http.request, http.response);
    equal(http.captured.status, 302);
    assert(http.captured.headers.location.startsWith('https://accounts.feishu.cn/'), 'should redirect to the accounts host');
    equal(oauth.pending.size, 1);
  });
  await test('oauth/callback stores the grant and answers with a page', async () => {
    const mock = mockFeishu();
    mock.route('POST', '/open-apis/authen/v2/oauth/token', () => ({ body: { code: 0, access_token: 'u1', expires_in: 7200, refresh_token: 'r1', scope: 'x' } }));
    mock.route('GET', '/open-apis/authen/v1/user_info', () => ({ body: { code: 0, data: { name: 'Ada', open_id: 'ou_1' } } }));
    const { config, identity } = compose(mock);
    const activityMod = await import('file:///' + join(LIB, 'activity.js').replace(/\\/gu, '/'));
    const oauth = { pending: new Set(['st1']) };
    const handlers = routesMod.createRouteHandlers({ config, identity, activity: activityMod.createActivityLog(5), oauth, resolveRedirectUri: () => REDIRECT });
    const http = fakeHttp('GET', routesMod.ROUTES.oauthCallback + '?code=c1&state=st1');
    await handlers[routesMod.ROUTES.oauthCallback](http.request, http.response);
    equal(http.captured.status, 200);
    assert(http.captured.body.includes('Ada'), 'the page should name the user');
    equal(oauth.pending.size, 0);
  });
  await test('oauth/callback rejects an unknown state', async () => {
    const mock = mockFeishu();
    const { config, identity } = compose(mock);
    const activityMod = await import('file:///' + join(LIB, 'activity.js').replace(/\\/gu, '/'));
    const handlers = routesMod.createRouteHandlers({ config, identity, activity: activityMod.createActivityLog(5), oauth: { pending: new Set(['other']) }, resolveRedirectUri: () => REDIRECT });
    const http = fakeHttp('GET', routesMod.ROUTES.oauthCallback + '?code=c1&state=st1');
    await handlers[routesMod.ROUTES.oauthCallback](http.request, http.response);
    equal(http.captured.status, 400);
    assert(http.captured.body.includes('state mismatch'), 'the page should explain the mismatch');
  });

  // ------------------------------------------------------------ plugin entry
  console.log('');
  console.log('plugin entry');
  await test('apply registers the tools, the routes, and the prompt section', async () => {
    const mock = mockFeishu();
    const store = fakeCredentials();
    const previous = globalThis.fetch;
    globalThis.fetch = mock.fetchImpl;
    try {
      const { ctx, recorded } = fakeCtx({ credentials: store });
      indexMod.apply(ctx, { appId: 'cli_1', appSecret: 'secret' });
      equal(recorded.tools.length, 10);
      equal(recorded.routes.length, 6);
      assert(recorded.routes.some((route) => route.path === '/api/feishu/config'), 'expected the config route');
      equal(recorded.sections.length, 1);
      equal(recorded.sections[0].name, 'tool:feishu');
      assert(recorded.tools.some((entry) => entry.name === 'feishu_bitable'), 'expected the Bitable tool');
      assert(recorded.tools.some((entry) => entry.name === 'feishu_dashboard'), 'expected the V3 dashboard tool');
      assert(recorded.tools.some((entry) => entry.name === 'feishu_query'), 'expected the V3 query tool');
      assert(recorded.routes.some((route) => route.path === routesMod.ROUTES.oauthCallback), 'expected the OAuth callback route');
    } finally {
      globalThis.fetch = previous;
    }
  });
  await test('apply survives a composition without webServer, credentials, or systemPrompt', async () => {
    const mock = mockFeishu();
    const previous = globalThis.fetch;
    globalThis.fetch = mock.fetchImpl;
    try {
      const { ctx, recorded } = fakeCtx({ webServer: false, systemPrompt: false });
      indexMod.apply(ctx, { appId: 'cli_1', appSecret: 'secret' });
      equal(recorded.tools.length, 10);
      equal(recorded.routes.length, 0);
      equal(recorded.sections.length, 0);
    } finally {
      globalThis.fetch = previous;
    }
  });
  await test('apply can be configured to register no tools', async () => {
    const { ctx, recorded } = fakeCtx({});
    indexMod.apply(ctx, { enableTools: false });
    equal(recorded.tools.length, 0);
  });
  await test('the OAuth redirect URI falls back to the webserver port', async () => {
    const mock = mockFeishu();
    const previous = globalThis.fetch;
    globalThis.fetch = mock.fetchImpl;
    try {
      const { ctx, recorded } = fakeCtx({});
      indexMod.apply(ctx, { appId: 'cli_1', appSecret: 'secret' });
      const authTool = recorded.tools.find((entry) => entry.name === 'feishu_auth');
      const value = await authTool.execute({ action: 'authorize_url' }, {});
      assert(value.url.includes(encodeURIComponent('http://127.0.0.1:19387/api/feishu/oauth/callback')), 'the webserver redirect should be advertised: ' + value.url);
    } finally {
      globalThis.fetch = previous;
    }
  });

  // ------------------------------------------------------ V3 dashboards + query
  console.log('');
  console.log('base v3 (dashboards and aggregation)');
  const dashMod = await import('file:///' + join(LIB, 'tools', 'dashboard.js').replace(/\\/gu, '/'));
  const queryMod = await import('file:///' + join(LIB, 'tools', 'query.js').replace(/\\/gu, '/'));

  await test('rejects a chart with no metric and a text block with no text', () => {
    assert(dashMod.validateDataConfig('column', { table_name: 'T' }).some((p) => p.includes('series')), 'a chart needs a metric');
    assert(dashMod.validateDataConfig('text', {}).some((p) => p.includes('text')), 'a text block needs text');
    assert(dashMod.validateDataConfig('column', { table_name: 'T', count_all: true }).length === 0, 'count_all is a valid metric');
    assert(dashMod.validateDataConfig('column', { series: [{ field_name: 'a', rollup: 'SUM' }] }).some((p) => p.includes('table_name')), 'table_name is required');
    assert(dashMod.validateDataConfig('column', { table_name: 'T', series: [{ field_name: 'a', rollup: 'MEDIAN' }] }).some((p) => p.includes('rollup')), 'rollup must be one of the four');
    assert(dashMod.validateDataConfig('ranking', { table_name: 'T', count_all: true, group_by: [{ field_name: 'a' }, { field_name: 'b' }] }).some((p) => p.includes('exactly one group_by')), 'ranking takes one group');
    assert(dashMod.validateDataConfig('text', { text: '# hi' }).length === 0, 'a text block with markdown is valid');
  });
  await test('requires all four position keys when a position is given', () => {
    assert(dashMod.validatePosition({ x: 0, y: 0, w: 6, h: 4 }).length === 0, 'a complete position is valid');
    assert(dashMod.validatePosition({ x: 0, y: 0, w: 6 }).some((p) => p.includes('h')), 'a partial position is rejected');
    assert(dashMod.validatePosition(undefined).length === 0, 'an absent position is fine (server auto-layout)');
  });
  await test('creates a dashboard and a chart block and reads the computed data', async () => {
    const mock = mockFeishu();
    mock.route('POST', '/open-apis/auth/v3/tenant_access_token/internal', () => ({ body: { code: 0, tenant_access_token: 't1', expire: 7200 } }));
    mock.route('POST', '/open-apis/base/v3/bases/bas1/dashboards', () => ({ body: { code: 0, data: { dashboard_id: 'blk1', name: '销售看板', theme: { theme_style: 'default' } } } }));
    mock.route('POST', '/open-apis/base/v3/bases/bas1/dashboards/blk1/blocks', () => ({ body: { code: 0, data: { block_id: 'cht1', name: '金额', type: 'column', position: { x: 0, y: 0, w: 6, h: 4 } } } }));
    mock.route('GET', '/open-apis/base/v3/bases/bas1/dashboards/blocks/cht1/data', () => ({ body: { code: 0, data: { main_data: [{ 城市: { value: '北京' }, 金额: { value: 120 } }] } } }));
    const { config, identity, client } = compose(mock);
    const definitions = toolsMod.buildTools({ client, identity, config, resolveRedirectUri: () => REDIRECT });
    const tool = find(definitions, 'feishu_dashboard');
    const created = await tool.execute({ action: 'create_dashboard', baseToken: 'bas1', name: '销售看板' }, {});
    equal(created.data.dashboard_id, 'blk1');
    const block = await tool.execute({
      action: 'create_block', baseToken: 'bas1', dashboardId: 'blk1', name: '金额', type: 'column',
      dataConfig: { table_name: '订单表', series: [{ field_name: '金额', rollup: 'SUM' }], group_by: [{ field_name: '城市' }] },
      position: { x: 0, y: 0, w: 6, h: 4 },
    }, {});
    equal(block.data.block_id, 'cht1');
    const data = await tool.execute({ action: 'get_block_data', baseToken: 'bas1', blockId: 'cht1' }, {});
    equal(data.data.main_data.length, 1);
    const dataCall = mock.log.find((entry) => entry.path.endsWith('/dashboards/blocks/cht1/data'));
    assert(dataCall !== undefined && !dataCall.path.includes('blk1'), 'the computed-data path must not carry the dashboard id: ' + (dataCall && dataCall.path));
  });
  await test('a chart create rejects an unusable dataConfig before any network call', async () => {
    const mock = mockFeishu();
    const { config, identity, client } = compose(mock);
    const definitions = toolsMod.buildTools({ client, identity, config, resolveRedirectUri: () => REDIRECT });
    const tool = find(definitions, 'feishu_dashboard');
    await rejects(() => tool.execute({ action: 'create_block', baseToken: 'bas1', dashboardId: 'd1', name: 'x', type: 'pie', dataConfig: { table_name: 'T' } }, {}), 'series');
    await rejects(() => tool.execute({ action: 'create_block', baseToken: 'bas1', dashboardId: 'd1', name: 'x', type: 'text', dataConfig: {} }, {}), 'text');
    equal(mock.log.length, 0);
  });
  await test('lists dashboards and blocks', async () => {
    const mock = mockFeishu();
    mock.route('POST', '/open-apis/auth/v3/tenant_access_token/internal', () => ({ body: { code: 0, tenant_access_token: 't1', expire: 7200 } }));
    mock.route('GET', '/open-apis/base/v3/bases/bas1/dashboards', () => ({ body: { code: 0, data: { items: [{ dashboard_id: 'blk1', name: 'D' }], has_more: false, total: 1 } } }));
    mock.route('GET', '/open-apis/base/v3/bases/bas1/dashboards/blk1/blocks', () => ({ body: { code: 0, data: { items: [{ block_id: 'cht1', name: 'B', type: 'line' }], has_more: false, total: 1 } } }));
    const { config, identity, client } = compose(mock);
    const definitions = toolsMod.buildTools({ client, identity, config, resolveRedirectUri: () => REDIRECT });
    const tool = find(definitions, 'feishu_dashboard');
    const list = await tool.execute({ action: 'list_dashboards', baseToken: 'bas1' }, {});
    equal(list.data.dashboards.length, 1);
    const blocks = await tool.execute({ action: 'list_blocks', baseToken: 'bas1', dashboardId: 'blk1' }, {});
    equal(blocks.data.blocks[0].type, 'line');
  });

  await test('builds a LiteQuery DSL that names the table and fields', () => {
    const dsl = queryMod.buildDsl({
      tableName: '订单表',
      dimensions: [{ fieldName: '城市', alias: 'dim_city' }],
      measures: [{ fieldName: '金额', aggregation: 'SUM', alias: 'total' }],
      filters: { conjunction: 'and', conditions: [{ fieldName: '状态', operator: 'is', value: ['已完成'] }, { fieldName: '备注', operator: 'isEmpty' }] },
      sort: [{ fieldName: 'total', order: 'desc' }],
      limit: 20,
    });
    equal(dsl.datasource.table.tableName, '订单表');
    equal(dsl.measures[0].aggregation, 'sum', 'aggregations are lower-cased');
    equal(JSON.stringify(dsl.dimensions), '[{"field_name":"城市","alias":"dim_city"}]');
    equal(dsl.filters.type, 1);
    equal(dsl.filters.conditions[1].operator, 'isEmpty');
    equal(JSON.stringify(dsl.filters.conditions[1].value), '[]', 'a valueless operator sends an empty array');
    equal(dsl.sort[0].order, 'desc');
    equal(dsl.pagination.limit, 20);
    equal(dsl.shaper.format, 'flat');
    equal(dsl.datasource.table.tableId, undefined);
  });
  await test('prefers tableId and rejects an unusable query', async () => {
    equal(queryMod.buildDsl({ tableId: 'tbl1', tableName: 'T', measures: [{ fieldName: 'a', aggregation: 'count' }] }).datasource.table.tableId, 'tbl1');
    for (const bad of [
      { measures: [{ fieldName: 'a', aggregation: 'count' }] },
      { tableName: 'T' },
      { tableName: 'T', measures: [{ fieldName: 'a', aggregation: 'median' }] },
      { tableName: 'T', measures: [{ fieldName: 'a', aggregation: 'sum' }], filters: { conditions: [{ fieldName: 'f', operator: 'isEmpty', value: ['x'] }] } },
      { tableName: 'T', measures: [{ fieldName: 'a', aggregation: 'sum' }], filters: { conditions: [{ fieldName: 'f', operator: 'is' }] } },
      { tableName: 'T', measures: [{ fieldName: 'a', aggregation: 'sum' }], filters: { conditions: [{ fieldName: 'f', operator: 'wat' }] } },
    ]) {
      await rejects(() => queryMod.buildDsl(bad));
    }
  });
  await test('runs a query and flattens the columnar reply', async () => {
    const mock = mockFeishu();
    mock.route('POST', '/open-apis/auth/v3/tenant_access_token/internal', () => ({ body: { code: 0, tenant_access_token: 't1', expire: 7200 } }));
    mock.route('POST', '/open-apis/base/v3/bases/bas1/data/query', () => ({
      body: { code: 0, data: { main_data: [{ city: { value: '北京' }, n: { value: 12 } }, { city: { value: '上海' }, n: { value: 7 } }] } },
    }));
    const { config, identity, client } = compose(mock);
    const definitions = toolsMod.buildTools({ client, identity, config, resolveRedirectUri: () => REDIRECT });
    const tool = find(definitions, 'feishu_query');
    const value = await tool.execute({
      baseToken: 'bas1', tableName: '订单表',
      dimensions: [{ fieldName: '城市', alias: 'city' }],
      measures: [{ fieldName: '金额', aggregation: 'count', alias: 'n' }],
    }, {});
    equal(value.data.rows[0].city, '北京');
    equal(value.data.rows[0].n, 12, 'the {value} wrapper is unwrapped');
    equal(JSON.stringify(value.data.columns), '["city","n"]');
    const sent = JSON.parse(String(mock.log.find((entry) => entry.path.endsWith('/data/query')).body));
    equal(sent.datasource.table.tableName, '订单表');
    equal(sent.shaper.format, 'flat');
  });
  await test('forwards a raw dsl unchanged', async () => {
    const mock = mockFeishu();
    mock.route('POST', '/open-apis/auth/v3/tenant_access_token/internal', () => ({ body: { code: 0, tenant_access_token: 't1', expire: 7200 } }));
    mock.route('POST', '/open-apis/base/v3/bases/bas1/data/query', () => ({ body: { code: 0, data: { main_data: [] } } }));
    const { config, identity, client } = compose(mock);
    const definitions = toolsMod.buildTools({ client, identity, config, resolveRedirectUri: () => REDIRECT });
    const tool = find(definitions, 'feishu_query');
    const raw = { datasource: { type: 'table', table: { tableName: 'T' } }, measures: [{ field_name: 'a', aggregation: 'max', alias: 'm' }], shaper: { format: 'flat' } };
    await tool.execute({ baseToken: 'bas1', dsl: raw }, {});
    const sent = JSON.parse(String(mock.log.find((entry) => entry.path.endsWith('/data/query')).body));
    equal(JSON.stringify(sent), JSON.stringify(raw));
  });

  // ------------------------------------------------------------ browser half
  console.log('');
  console.log('browser half');
  await test('the client bundle loads, exports the contract, and registers into shell.overlay', async () => {
    const captured = {};
    const fakeReact = {
      createElement: (...args) => ({ args }),
      useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
      useEffect: () => {},
      useRef: () => ({ current: null }),
      useCallback: (fn) => fn,
    };
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    globalThis.window = {
      __ModuleLoader__: { load: (spec) => { captured.spec = spec; } },
      localStorage: { getItem: () => null, setItem: () => {} },
      innerWidth: 1200,
      innerHeight: 800,
      setInterval: () => 0,
      clearInterval: () => {},
      setTimeout: () => 0,
      open: () => {},
    };
    globalThis.document = {
      querySelector: () => null,
      createElement: () => ({ dataset: {}, style: {}, textContent: '' }),
      head: { appendChild: () => {} },
    };
    try {
      await import('file:///' + join(LIB, 'ui', 'client.js').replace(/\\/gu, '/'));
      assert(captured.spec !== undefined, 'the bundle should call __ModuleLoader__.load');
      equal(captured.spec.id, 'dsh-feishu');
      const mod = captured.spec.factory((name) => {
        if (name === 'react') return fakeReact;
        throw new Error('unexpected require: ' + name);
      });
      assert(typeof mod.apply === 'function', 'apply must be exported');
      assert(Array.isArray(mod.inject) && mod.inject.includes('slots'), 'the slots service must be injected');
      const registered = [];
      mod.apply({
        inject: (names, callback) => callback({
          slots: {
            inject: (slotName, register) => register(),
            register: (meta, component) => { registered.push({ meta, component }); return () => {}; },
          },
        }),
      });
      equal(registered.length, 2);
      const overlay = registered.find((entry) => entry.meta.name === 'shell.overlay');
      const section = registered.find((entry) => entry.meta.name === 'settings.section');
      assert(overlay !== undefined, 'the overlay panel must be registered');
      assert(section !== undefined, 'the settings section must be registered');
      equal(section.meta.id, 'feishu');
      equal(typeof section.meta.label, 'function', 'the section label must be a resolver');
      equal(section.meta.label(), '飞书 / Feishu');
      assert(overlay.component({}) !== null && overlay.component({}) !== undefined, 'the panel should render a tree');
      const sectionTree = section.component({});
      assert(sectionTree !== null && sectionTree !== undefined, 'the settings page should render a tree');
      assert(Array.isArray(mod.SETTINGS_GROUPS) && mod.SETTINGS_GROUPS.length >= 4, 'the settings field plan must be exported');
    } finally {
      globalThis.window = previousWindow;
      globalThis.document = previousDocument;
    }
  });
  await test('the settings page renders its full tree once the host answers', async () => {
    // A minimal but stateful hook shim: render once with no data, run the
    // effects, let the fetches settle, then render again with the same hook
    // cells. That exercises every branch of the page's JSX, which a single
    // render cannot reach because it returns early until the config arrives.
    const captured = {};
    const cells = [];
    const effects = [];
    let cursor = 0;
    const fakeReact = {
      createElement: (...args) => ({ args }),
      useState: (initial) => {
        const index = cursor++;
        if (!(index in cells)) cells[index] = typeof initial === 'function' ? initial() : initial;
        return [cells[index], (next) => { cells[index] = typeof next === 'function' ? next(cells[index]) : next; }];
      },
      useEffect: (fn) => { effects.push(fn); },
      useRef: (initial) => {
        const index = cursor++;
        if (!(index in cells)) cells[index] = { current: initial };
        return cells[index];
      },
      useCallback: (fn) => { cursor += 1; return fn; },
    };
    const configPayload = {
      values: { appId: 'cli_x', enableTools: true, brand: 'feishu', oauthScopes: null },
      stored: { appId: 'cli_x' },
      fields: {},
      effective: { toolNames: [] },
      patch: { file: 'C:\\p\\profiles\\desktop\\cordis.patch.yml', entryFound: true, readable: true, unmanagedKeys: [], error: null },
      secret: { ref: 'FEISHU_APP_SECRET', configured: true, source: 'credential:FEISHU_APP_SECRET' },
      redirectUri: 'http://127.0.0.1:19387/api/feishu/oauth/callback',
      user: { authorized: false, source: 'none' },
      applyMode: 'hot',
    };
    const routes = {
      '/api/feishu/config': { ok: true, data: configPayload },
      '/api/feishu/status': { ok: true, data: { appId: 'cli_***_x', appSecretConfigured: true, redirectUri: 'http://127.0.0.1:19387/api/feishu/oauth/callback', enableUi: true, user: { authorized: false } } },
      '/api/feishu/activity': { ok: true, data: [{ seq: 1, at: Date.now(), tool: 'feishu_bitable', action: 'create_app', ok: true, summary: 'created Bitable app "T"', url: 'https://feishu.cn/base/x' }] },
      '/api/feishu/oauth/start?json=1': { ok: true, url: 'https://accounts.feishu.cn/open-apis/authen/v1/authorize?client_id=cli_x', state: 's', redirectUri: REDIRECT },
    };
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    const previousFetch = globalThis.fetch;
    globalThis.window = {
      __ModuleLoader__: { load: (spec) => { captured.spec = spec; } },
      localStorage: { getItem: () => null, setItem: () => {} },
      innerWidth: 1200, innerHeight: 800,
      setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, open: () => {},
    };
    globalThis.document = { querySelector: () => null, createElement: () => ({ dataset: {}, style: {}, textContent: '' }), head: { appendChild: () => {} } };
    globalThis.fetch = async (url) => {
      const key = String(url).replace('http://127.0.0.1:19387', '');
      const payload = routes[key];
      return { ok: true, json: async () => (payload !== undefined ? payload : { ok: false, message: 'no mock for ' + key }) };
    };
    try {
      await import('file:///' + join(LIB, 'ui', 'client.js').replace(/\\/gu, '/') + '?settings=1');
      const mod = captured.spec.factory((name) => { if (name === 'react') return fakeReact; throw new Error('unexpected require: ' + name); });
      const Section = mod.FeishuSettingsSection;
      cursor = 0;
      const first = Section({});
      assert(first !== null, 'the first render should show a loading state');
      for (const effect of effects) effect();
      for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setImmediate(resolve));
      effects.length = 0;
      cursor = 0;
      const tree = Section({});
      const json = JSON.stringify(tree);
      assert(json.includes('用户授权'), 'the authorization group must render: ' + json.slice(0, 200));
      assert(json.includes('复制授权链接'), 'the copyable authorization link must render');
      assert(json.includes('https://accounts.feishu.cn'), 'the authorization URL from the host must be shown');
      assert(json.includes('默认值'), 'fields running on their default must be marked');
      assert(json.includes('最近操作'), 'the activity group must render');
      assert(json.includes('created Bitable app'), 'the activity entries must render');
    } finally {
      globalThis.window = previousWindow;
      globalThis.document = previousDocument;
      globalThis.fetch = previousFetch;
    }
  });
  await test('the package advertises the client half', async () => {
    const manifest = JSON.parse(await readFile(join(HERE, '..', 'package.json'), 'utf8'));
    equal(manifest.dsh.client.platform, 'web');
    assert(manifest.exports['./client'] !== undefined, 'the ./client export must exist');
    equal(manifest.exports['./client'].default, './lib/ui/client.js');
  });

  // ---------------------------------------------------- loader entry editing
  console.log('');
  console.log('loader entry configuration');
  const entryMod = await import('file:///' + join(LIB, 'entry-config.js').replace(/\\/gu, '/'));

  const SAMPLE_PATCH = [
    '# profile patch layer',
    '- id: desktop-shell',
    '  name: dsh-plugin-desktop',
    '  config:',
    '    mode: advanced',
    '',
    '# >>> dsh-feishu (managed by scripts/install.ps1 - do not edit by hand)',
    '- insert:',
    '    - id: feishu',
    '      name: dsh-feishu',
    '      config:',
    "        appId: 'cli_old'",
    '        brand: feishu',
    "        customHandwrittenKey: 'keep me'",
    '# <<< dsh-feishu',
    '',
  ].join('\n');

  /**
   * Write a patch fixture under a profile-shaped directory.
   * @param text - the file contents.
   * @returns the fixture handles.
   */
  async function patchFixture(text) {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-feishu-cfg-'));
    const profileDir = join(dir, 'profiles', 'test');
    await mkdir(profileDir, { recursive: true });
    const file = join(profileDir, 'cordis.patch.yml');
    await writeFile(file, text !== undefined ? text : SAMPLE_PATCH, 'utf8');
    return { dir, file };
  }

  await test('accepts only a profile cordis.patch.yml path', () => {
    equal(entryMod.isProfilePatchPath('C:\\Users\\x\\.dsh\\profiles\\desktop\\cordis.patch.yml'), true);
    equal(entryMod.isProfilePatchPath('/home/x/.dsh/profiles/web/cordis.patch.yml'), true);
    equal(entryMod.isProfilePatchPath('C:\\Users\\x\\.dsh\\profiles\\desktop\\settings.yaml'), false);
    equal(entryMod.isProfilePatchPath('C:\\Users\\x\\important.yml'), false);
    equal(entryMod.isProfilePatchPath(''), false);
  });
  await test('round-trips the scalars the configuration uses', () => {
    for (const value of ['', 'plain', "has 'quote'", 'true', 'false', 'null', '123', '0', '1.5', '-2']) {
      const rendered = entryMod.renderScalar(value);
      const parsed = entryMod.parseScalar(rendered);
      assert(parsed === value || String(parsed) === value, 'string ' + JSON.stringify(value) + ' round-tripped to ' + JSON.stringify(parsed) + ' via ' + rendered);
    }
    equal(entryMod.parseScalar(entryMod.renderScalar(true)), true);
    equal(entryMod.parseScalar(entryMod.renderScalar(false)), false);
    equal(entryMod.parseScalar(entryMod.renderScalar(42)), 42);
    equal(JSON.stringify(entryMod.parseScalar(entryMod.renderScalar([]))), '[]');
    equal(JSON.stringify(entryMod.parseScalar(entryMod.renderScalar(['a', 'b']))), '["a","b"]');
    equal(entryMod.parseScalar("'a'  # a trailing comment"), 'a');
    equal(entryMod.parseScalar('"a # b"'), 'a # b');
  });
  await test('resolves the patch file from the environment or an explicit path', async () => {
    const fixture = await patchFixture();
    try {
      const profileDir = dirname(fixture.file);
      equal(entryMod.resolvePatchFile({}, { env: { DSH_PROFILE_DIR: profileDir } }), fixture.file);
      equal(entryMod.resolvePatchFile({ patchFilePath: fixture.file }, { env: {} }), fixture.file);
      equal(entryMod.resolvePatchFile({}, { env: { DSH_HOME: dirname(dirname(profileDir)), DSH_PROFILE: 'test' } }), fixture.file);
      const deduped = entryMod.patchFileCandidates({ patchFilePath: fixture.file, moduleUrl: fixture.file }, { env: {} });
      equal(new Set(deduped.map((entry) => entry.toLowerCase())).size, deduped.length, 'candidates must be de-duplicated');
    } finally {
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });
  await test('finds the patch file by walking up from the plugin module itself', async () => {
    // The environment is absent inside the host process, so this is the path
    // that has to hold in practice: <profile>/node_modules/dsh-feishu/lib/.
    const dir = await mkdtemp(join(tmpdir(), 'dsh-feishu-loc-'));
    const profileDir = join(dir, 'profiles', 'test');
    const libDir = join(profileDir, 'node_modules', 'dsh-feishu', 'lib');
    await mkdir(libDir, { recursive: true });
    const file = join(profileDir, 'cordis.patch.yml');
    await writeFile(file, SAMPLE_PATCH, 'utf8');
    try {
      equal(entryMod.resolvePatchFile({}, { moduleUrl: join(libDir, 'entry-config.js'), env: {} }), file);
      equal(entryMod.resolvePatchFile({}, { baseUrl: 'file:///' + libDir.split('\\').join('/') + '/entry-config.js', env: {} }), file);
      const candidates = entryMod.patchFileCandidates({}, { moduleUrl: join(libDir, 'entry-config.js'), env: {} });
      assert(candidates.includes(file), 'the profile patch file must be among the candidates');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  await test('reports the locations it tried when it cannot find the file', () => {
    const read = entryMod.readEntryFile(undefined, ['C:\\a\\profiles\\x\\cordis.patch.yml', 'D:\\b\\cordis.patch.yml']);
    equal(read.ok, false);
    equal(read.reason, 'NO_LOCATION');
    assert(read.message.includes('Looked in:'), 'the message must list what was tried: ' + read.message);
    equal(read.candidates.length, 2);
  });
  await test('finds the managed block and parses its values', () => {
    const read = entryMod.readEntry(SAMPLE_PATCH);
    equal(read.found, true);
    equal(read.values.appId, 'cli_old');
    equal(read.values.brand, 'feishu');
    equal(JSON.stringify(read.unmanaged), '["customHandwrittenKey"]');
  });
  await test('finds a hand-written entry without the markers', () => {
    const text = ['- id: feishu', '  name: dsh-feishu', '  config:', "    appId: 'cli_manual'", '- id: other', '  name: other-plugin', ''].join('\n');
    const read = entryMod.readEntry(text);
    equal(read.found, true);
    equal(read.values.appId, 'cli_manual');
    equal(read.block.mode, 'scan');
  });
  await test('rewrites the entry, preserving unmanaged keys and other entries', async () => {
    const fixture = await patchFixture();
    try {
      const outcome = entryMod.writeEntry(fixture.file, { appId: 'cli_new', enableUi: false });
      equal(outcome.ok, true);
      equal(outcome.changed, true);
      const text = await readFile(fixture.file, 'utf8');
      assert(text.includes("appId: 'cli_new'"), 'the new app id should be written');
      assert(text.includes('customHandwrittenKey'), 'an unmanaged key must survive');
      assert(text.includes('desktop-shell'), 'another entry must survive');
      assert(text.includes('enableUi: false'), 'a boolean should be written as a boolean');
      const reread = entryMod.readEntry(text);
      equal(reread.values.appId, 'cli_new');
      equal(reread.values.enableUi, false);
    } finally {
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });
  await test('the rewritten file is still valid YAML with the same number of entries', async () => {
    let yaml;
    try {
      yaml = await import('file:///C:/Users/Admin/.dsh/profiles/desktop/node_modules/js-yaml/dist/js-yaml.mjs');
    } catch (error) {
      return;
    }
    const fixture = await patchFixture();
    try {
      const before = yaml.default.load(await readFile(fixture.file, 'utf8'));
      entryMod.writeEntry(fixture.file, { appId: 'cli_new', oauthScopes: ['a', 'b'], requestTimeoutMs: 45000 });
      const after = yaml.default.load(await readFile(fixture.file, 'utf8'));
      equal(Array.isArray(after), true);
      equal(after.length, before.length);
      const inserted = after[after.length - 1].insert[0];
      equal(inserted.name, 'dsh-feishu');
      equal(inserted.config.appId, 'cli_new');
      equal(inserted.config.requestTimeoutMs, 45000);
      equal(JSON.stringify(inserted.config.oauthScopes), '["a","b"]');
      equal(inserted.config.customHandwrittenKey, 'keep me');
      equal(after[0].id, 'desktop-shell');
    } finally {
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });
  await test('a null change removes a key, resetting it to the plugin default', async () => {
    const fixture = await patchFixture();
    try {
      entryMod.writeEntry(fixture.file, { brand: 'lark' });
      assert((await readFile(fixture.file, 'utf8')).includes("brand: 'lark'"), 'the value should be set first');
      const outcome = entryMod.writeEntry(fixture.file, { brand: null });
      equal(outcome.ok, true);
      const text = await readFile(fixture.file, 'utf8');
      assert(!text.includes('brand:'), 'the key should be gone after a reset');
      assert(!text.includes('brand: null'), 'null must not be written as a value');
      assert(text.includes('customHandwrittenKey'), 'other keys must survive');
    } finally {
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });
  await test('refuses a path outside a profile and an unmanaged key', async () => {
    const fixture = await patchFixture();
    try {
      const outside = entryMod.writeEntry(join(fixture.dir, 'cordis.patch.yml'), { appId: 'x' });
      equal(outside.ok, false);
      equal(outside.reason, 'UNEXPECTED_PATH');
      const unknown = entryMod.writeEntry(fixture.file, { somethingElse: 1 });
      equal(unknown.ok, false);
      equal(unknown.reason, 'UNKNOWN_KEY');
      const text = await readFile(fixture.file, 'utf8');
      equal(text, SAMPLE_PATCH, 'a refused write must not touch the file');
    } finally {
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });
  await test('appends a managed block when the file has none', async () => {
    const fixture = await patchFixture('- id: only\n  name: only-plugin\n');
    try {
      const outcome = entryMod.writeEntry(fixture.file, { appId: 'cli_added' });
      equal(outcome.ok, true);
      const text = await readFile(fixture.file, 'utf8');
      assert(text.includes(entryMod.MARKERS.start), 'the managed block should be added');
      assert(text.includes('only-plugin'), 'the existing entry should survive');
      equal(entryMod.readEntry(text).values.appId, 'cli_added');
    } finally {
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });

  await test('an install through a bundle gets a config override, not a second insert', async () => {
    const fixture = await patchFixture();
    try {
      // A manual install: nothing declares the bundle, so the settings page has
      // to create the loader entry itself.
      equal(entryMod.profileMountsBundle(fixture.file), false, 'no profile manifest means no bundle');
      entryMod.writeEntry(fixture.file, { appId: 'cli_manual' });
      let text = await readFile(fixture.file, 'utf8');
      assert(text.includes('- insert:'), 'a manual install inserts the entry');
      equal(entryMod.readEntry(text).values.appId, 'cli_manual');

      // A bundle install: the bundle patch already inserts the row, so inserting
      // again would define one loader id twice and the loader rejects that.
      await writeFile(join(dirname(fixture.file), 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-feishu'] } } }), 'utf8');
      equal(entryMod.profileMountsBundle(fixture.file), true);
      const outcome = entryMod.writeEntry(fixture.file, { appId: 'cli_bundle' });
      equal(outcome.ok, true);
      text = await readFile(fixture.file, 'utf8');
      assert(!text.includes('- insert:'), 'a bundle mount must not insert a second entry');
      assert(text.includes('- id: feishu'), 'it writes an id-targeted override');
      assert(text.includes("appId: 'cli_bundle'"), 'the override carries the configuration');
      const reread = entryMod.readEntry(text);
      equal(reread.found, true);
      equal(reread.values.appId, 'cli_bundle');
      assert(text.includes('desktop-shell'), 'other entries survive');
    } finally {
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });
  await test('recognizes the bundle through several spellings', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-feishu-mount-'));
    const profileDir = join(dir, 'profiles', 'test');
    await mkdir(profileDir, { recursive: true });
    const file = join(profileDir, 'cordis.patch.yml');
    await writeFile(file, SAMPLE_PATCH, 'utf8');
    const cases = [
      ['dsh-feishu', true],
      ['github:2048lr/dsh-feishu', true],
      ['@scope/dsh-feishu', true],
      ['dsh-feishu-bot', false],
      ['other-plugin', false],
    ];
    try {
      for (const [entry, expected] of cases) {
        await writeFile(join(profileDir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: [entry] } } }), 'utf8');
        equal(entryMod.profileMountsBundle(file), expected, 'bundle list [' + entry + ']');
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  await test('the shipped cordis.patch.yml is a valid bundle patch', async () => {
    let yaml;
    try {
      yaml = await import('file:///C:/Users/Admin/.dsh/profiles/desktop/node_modules/js-yaml/dist/js-yaml.mjs');
    } catch (error) {
      return;
    }
    const manifest = JSON.parse(await readFile(join(HERE, '..', 'package.json'), 'utf8'));
    equal(manifest.dsh.bundle.patch, './cordis.patch.yml', 'the manifest must declare the bundle patch');
    assert(manifest.files.includes('cordis.patch.yml'), 'the patch must ship with the package');
    const loaded = yaml.default.load(await readFile(join(HERE, '..', 'cordis.patch.yml'), 'utf8'));
    equal(Array.isArray(loaded), true);
    equal(loaded.length, 1);
    const row = loaded[0].insert[0];
    equal(row.id, 'feishu');
    equal(row.name, 'dsh-feishu');
    equal(typeof row.config, 'object', 'the row carries a starting config');
  });

  // ------------------------------------------------------- settings endpoints
  console.log('');
  console.log('settings endpoints');
  /**
   * Build a fake request with a JSON body.
   * @param method - the HTTP method.
   * @param url - the request URL.
   * @param body - the JSON body.
   * @returns the request, response, capture, and a dispatch function.
   */
  function fakeBodyHttp(method, url, body) {
    const captured = { status: undefined, body: undefined };
    const listeners = new Map();
    const request = {
      method,
      url,
      on(event, handler) {
        if (!listeners.has(event)) listeners.set(event, []);
        listeners.get(event).push(handler);
        return request;
      },
      destroy() {},
    };
    const response = {
      writeHead(status) {
        captured.status = status;
        return response;
      },
      end(payload) {
        captured.body = payload;
      },
    };
    return {
      request,
      response,
      captured,
      async dispatch() {
        const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')];
        for (const chunk of chunks) for (const handler of listeners.get('data') || []) handler(chunk);
        for (const handler of listeners.get('end') || []) handler();
        await new Promise((resolve) => setImmediate(resolve));
      },
    };
  }

  await test('GET /api/feishu/config reports values, fields, and the patch location', async () => {
    const fixture = await patchFixture();
    try {
      const config = configMod.normalizeConfig({ appId: 'cli_1', appSecret: 'sk-do-not-leak-me', patchFilePath: fixture.file });
      const identity = identityMod.createIdentity({ config, fetchImpl: mockFeishu().fetchImpl });
      const handlers = routesMod.createRouteHandlers({
        config,
        identity,
        activity: (await import('file:///' + join(LIB, 'activity.js').replace(/\\/gu, '/'))).createActivityLog(5),
        oauth: { pending: new Set() },
        resolveRedirectUri: () => REDIRECT,
        credentials: fakeCredentials(),
        toolNames: ['feishu_bitable'],
      });
      const http = fakeHttp('GET', '/api/feishu/config');
      await handlers['/api/feishu/config'](http.request, http.response);
      const payload = JSON.parse(http.captured.body);
      equal(payload.ok, true);
      equal(payload.data.values.appId, 'cli_old');
      equal(payload.data.stored.appId, 'cli_old');
      // A field the file does not mention must report the effective default, not
      // null: otherwise opening the page and saving would switch the tools off.
      equal(payload.data.stored.enableTools, undefined);
      equal(payload.data.values.enableTools, true);
      equal(payload.data.values.registerSystemPrompt, true);
      equal(payload.data.values.brand, 'feishu', 'a stored value wins over the default');
      equal(payload.data.values.appSecretRef, 'FEISHU_APP_SECRET');
      equal(payload.data.values.oauthScopes, null, 'the scope list keeps its empty state');
      assert(payload.data.fields.appId !== undefined, 'the field table must be returned');
      equal(payload.data.patch.file, fixture.file);
      equal(payload.data.patch.readable, true);
      equal(JSON.stringify(payload.data.patch.unmanagedKeys), '["customHandwrittenKey"]');
      equal(payload.data.secret.configured, true);
      assert(!JSON.stringify(payload).includes('sk-do-not-leak-me'), 'the secret value must never be returned');
      equal(payload.data.secret.configured, true, 'the payload should report that a secret is configured');
      equal(payload.data.applyMode, 'hot');
    } finally {
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });
  await test('POST /api/feishu/config validates, writes, and stores the secret', async () => {
    const fixture = await patchFixture();
    try {
      const credentials = fakeCredentials();
      const config = configMod.normalizeConfig({ appId: 'cli_1', patchFilePath: fixture.file });
      const identity = identityMod.createIdentity({ config, credentials, fetchImpl: mockFeishu().fetchImpl });
      const handlers = routesMod.createRouteHandlers({
        config,
        identity,
        activity: (await import('file:///' + join(LIB, 'activity.js').replace(/\\/gu, '/'))).createActivityLog(5),
        oauth: { pending: new Set() },
        resolveRedirectUri: () => REDIRECT,
        credentials,
        toolNames: [],
      });
      const http = fakeBodyHttp('POST', '/api/feishu/config', {
        values: { appId: 'cli_new', brand: 'lark', enableUi: false, requestTimeoutMs: 45000 },
        appSecret: 'super-secret',
      });
      const running = handlers['/api/feishu/config'](http.request, http.response);
      await http.dispatch();
      await running;
      const payload = JSON.parse(http.captured.body);
      equal(payload.ok, true);
      equal(payload.data.values.appId, 'cli_new');
      equal(credentials.refs.get('FEISHU_APP_SECRET'), 'super-secret');
      assert(!JSON.stringify(payload).includes('super-secret'), 'the submitted secret must not be echoed');
      const text = await readFile(fixture.file, 'utf8');
      assert(text.includes("appId: 'cli_new'"), 'the file should carry the new app id');
      assert(!text.includes('super-secret'), 'the secret must never reach the patch file');
      assert(text.includes("brand: 'lark'"), 'the brand should be written');
    } finally {
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });
  await test('POST /api/feishu/config rejects an invalid value without touching the file', async () => {
    const fixture = await patchFixture();
    try {
      const credentials = fakeCredentials();
      const config = configMod.normalizeConfig({ appId: 'cli_1', patchFilePath: fixture.file });
      const identity = identityMod.createIdentity({ config, credentials, fetchImpl: mockFeishu().fetchImpl });
      const handlers = routesMod.createRouteHandlers({
        config,
        identity,
        activity: (await import('file:///' + join(LIB, 'activity.js').replace(/\\/gu, '/'))).createActivityLog(5),
        oauth: { pending: new Set() },
        resolveRedirectUri: () => REDIRECT,
        credentials,
        toolNames: [],
      });
      for (const bad of [{ brand: 'nope' }, { requestTimeoutMs: 5 }, { toolPrefix: '1bad' }, { patchFilePath: '/etc/passwd' }, { nope: 1 }]) {
        const http = fakeBodyHttp('POST', '/api/feishu/config', { values: bad });
        const running = handlers['/api/feishu/config'](http.request, http.response);
        await http.dispatch();
        await running;
        const payload = JSON.parse(http.captured.body);
        equal(payload.ok, false, 'expected ' + JSON.stringify(bad) + ' to be rejected');
        equal(http.captured.status, 400);
      }
      equal(await readFile(fixture.file, 'utf8'), SAMPLE_PATCH, 'no rejected write may change the file');
    } finally {
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });
  await test('the settings field table rejects the path field outright', () => {
    equal(routesMod.validateField('patchFilePath', '/etc/passwd').ok, false);
    equal(routesMod.validateField('brand', 'lark').value, 'lark');
    equal(routesMod.validateField('brand', 'Lark').ok, false);
    equal(routesMod.validateField('maxRetries', 6).ok, true);
    equal(routesMod.validateField('maxRetries', 7).ok, false);
    equal(JSON.stringify(routesMod.validateField('oauthScopes', 'a, b  c').value), '["a","b","c"]');
    equal(routesMod.validateField('apiBaseUrl', '').value, '');
    equal(routesMod.validateField('apiBaseUrl', 'not-a-url').ok, false);
    equal(routesMod.validateField('toolPrefix', 'fs').value, 'fs');
  });

  console.log('');
  console.log(passed + ' passed, ' + failed + ' failed');
  if (failed > 0) {
    console.log('');
    for (const failure of failures) console.log('FAILED: ' + failure.name + '\n  ' + String(failure.error && failure.error.stack !== undefined ? failure.error.stack : failure.error).split('\n').slice(0, 5).join('\n  '));
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
