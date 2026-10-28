/**
 * HTTP endpoints for the browser half and for the OAuth redirect.
 *
 * These are exact routes under /api/feishu, which the webserver matches before
 * the gateway's /api prefix route, so nothing here is proxied or cached. The
 * OAuth callback is the reason the routes exist at all: it is the only place a
 * grant can be captured without the user copying a code by hand.
 *
 * @module dsh-feishu/routes
 */

import { patchFileCandidates, readEntryFile, resolvePatchFile, writeEntry } from './entry-config.js';

/** Cap on a configuration request body. */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * Read a JSON request body with a size ceiling.
 * @param req - the request.
 * @returns the parsed body, or an error description.
 */
function readJsonBody(req) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        resolve({ ok: false, message: 'request body exceeds ' + MAX_BODY_BYTES + ' bytes' });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.trim().length === 0) {
        resolve({ ok: true, value: {} });
        return;
      }
      try {
        const parsed = JSON.parse(text);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          resolve({ ok: false, message: 'the request body must be a JSON object' });
          return;
        }
        resolve({ ok: true, value: parsed });
      } catch (error) {
        resolve({ ok: false, message: 'the request body is not valid JSON: ' + String(error && error.message !== undefined ? error.message : error) });
      }
    });
    req.on('error', (error) => resolve({ ok: false, message: 'reading the request failed: ' + String(error && error.message !== undefined ? error.message : error) }));
  });
}

/** Route paths owned by this plugin. */
export const ROUTES = {
  status: '/api/feishu/status',
  activity: '/api/feishu/activity',
  config: '/api/feishu/config',
  oauthStart: '/api/feishu/oauth/start',
  oauthCallback: '/api/feishu/oauth/callback',
  oauthLogout: '/api/feishu/oauth/logout',
};

/**
 * The configuration fields the settings page may write, with their validation.
 *
 * patchFilePath is deliberately absent: it names the file being edited, so
 * accepting it from the browser would turn a settings form into an arbitrary
 * file writer.
 */
export const EDITABLE_FIELDS = {
  appId: { kind: 'string', maxLength: 200, label: 'App ID' },
  appSecretRef: { kind: 'reference', label: 'App Secret reference' },
  brand: { kind: 'enum', values: ['feishu', 'lark'], label: 'Brand' },
  apiBaseUrl: { kind: 'url', allowEmpty: true, label: 'API base URL' },
  accountsBaseUrl: { kind: 'url', allowEmpty: true, label: 'Accounts base URL' },
  defaultFolderToken: { kind: 'string', maxLength: 200, label: 'Default folder token' },
  defaultIdentity: { kind: 'enum', values: ['auto', 'user', 'app'], label: 'Default identity' },
  toolPrefix: { kind: 'prefix', label: 'Tool name prefix' },
  requestTimeoutMs: { kind: 'integer', min: 1000, max: 120000, label: 'Request timeout' },
  maxRetries: { kind: 'integer', min: 1, max: 6, label: 'Max attempts' },
  enableTools: { kind: 'boolean', label: 'Register tools' },
  enableOAuth: { kind: 'boolean', label: 'Mount HTTP routes' },
  enableUi: { kind: 'boolean', label: 'Show the floating panel' },
  oauthRedirectUri: { kind: 'url', allowEmpty: true, label: 'OAuth redirect URI' },
  oauthScopes: { kind: 'stringList', label: 'OAuth scopes' },
  registerSystemPrompt: { kind: 'boolean', label: 'Add the system-prompt section' },
  maxRecordsPerPage: { kind: 'integer', min: 1, max: 1000, label: 'Rows per page cap' },
  activityLogSize: { kind: 'integer', min: 1, max: 500, label: 'Panel history size' },
};

/**
 * Validate one field value submitted by the settings page.
 * @param key - the configuration key.
 * @param raw - the submitted value.
 * @returns the accepted value, or a rejection message.
 */
export function validateField(key, raw) {
  const field = EDITABLE_FIELDS[key];
  if (field === undefined) return { ok: false, message: 'unknown configuration field ' + JSON.stringify(key) };
  if (field.kind === 'boolean') {
    if (typeof raw !== 'boolean') return { ok: false, message: field.label + ' must be true or false' };
    return { ok: true, value: raw };
  }
  if (field.kind === 'integer') {
    const parsed = typeof raw === 'string' && raw.trim().length > 0 ? Number(raw) : raw;
    if (typeof parsed !== 'number' || !Number.isInteger(parsed)) return { ok: false, message: field.label + ' must be a whole number' };
    if (parsed < field.min || parsed > field.max) return { ok: false, message: field.label + ' must be between ' + field.min + ' and ' + field.max };
    return { ok: true, value: parsed };
  }
  if (field.kind === 'stringList') {
    const list = Array.isArray(raw) ? raw : String(raw !== undefined && raw !== null ? raw : '').split(/[,\s]+/u);
    const out = [];
    for (const entry of list) {
      if (typeof entry !== 'string') continue;
      const trimmed = entry.trim();
      if (trimmed.length > 0) out.push(trimmed);
    }
    return { ok: true, value: out };
  }
  if (typeof raw !== 'string') return { ok: false, message: field.label + ' must be text' };
  const text = raw.trim();
  if (field.kind === 'enum') {
    if (!field.values.includes(text)) return { ok: false, message: field.label + ' must be one of ' + field.values.join(', ') };
    return { ok: true, value: text };
  }
  if (field.kind === 'url') {
    if (text.length === 0) {
      if (field.allowEmpty === true) return { ok: true, value: '' };
      return { ok: false, message: field.label + ' is required' };
    }
    if (!/^https?:\/\//u.test(text)) return { ok: false, message: field.label + ' must start with http:// or https://' };
    return { ok: true, value: text.replace(/\/+$/u, '') };
  }
  if (field.kind === 'reference') {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(text)) return { ok: false, message: field.label + ' must be a shell-style identifier such as FEISHU_APP_SECRET' };
    return { ok: true, value: text };
  }
  if (field.kind === 'prefix') {
    if (text.length === 0) return { ok: true, value: '' };
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/u.test(text)) return { ok: false, message: field.label + ' must start with a letter and use only letters, digits, underscore, or hyphen' };
    return { ok: true, value: text };
  }
  if (text.length > field.maxLength) return { ok: false, message: field.label + ' is longer than ' + field.maxLength + ' characters' };
  return { ok: true, value: text };
}

/**
 * Send a JSON response.
 * @param res - the response.
 * @param status - the HTTP status.
 * @param payload - the JSON value.
 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * Send a small HTML page.
 * @param res - the response.
 * @param status - the HTTP status.
 * @param title - the page title and heading.
 * @param message - the explanatory paragraph.
 * @param tone - 'ok' or 'error', which picks the accent colour.
 */
function sendPage(res, status, title, message, tone) {
  const accent = tone === 'error' ? '#d4380d' : tone === 'warn' ? '#ad6800' : '#237804';
  const body = '<!doctype html><html lang="en"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>' + title + '</title></head>'
    + '<body style="margin:0;font:15px/1.6 system-ui,-apple-system,Segoe UI,sans-serif;background:#141418;color:#e9e9f0">'
    + '<main style="max-width:34rem;margin:12vh auto;padding:2rem;border:1px solid rgba(255,255,255,.14);border-radius:14px;background:rgba(255,255,255,.03)">'
    + '<h1 style="margin:0 0 .75rem;font-size:1.25rem;color:' + accent + '">' + title + '</h1>'
    + '<p style="margin:0;color:#a8a8b8">' + message + '</p>'
    + '</div></main></body></html>';
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * Escape text placed into an HTML page.
 * @param value - the raw text.
 * @returns the escaped text.
 */
export function escapeHtml(value) {
  return String(value)
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;');
}

/**
 * Build the handlers.
 *
 * @param deps - composition facts.
 * @param deps.config - normalized configuration.
 * @param deps.identity - the identity manager.
 * @param deps.activity - the activity ring.
 * @param deps.oauth - the pending-state holder shared with the authorization tool.
 * @param deps.resolveRedirectUri - returns the redirect URI to advertise.
 * @param deps.credentials - the credentials proxy, used to store the app secret.
 * @param deps.toolNames - the model-facing tool names, for the settings page.
 * @param deps.logger - optional logger.
 * @returns the handlers keyed by route path.
 */
export function createRouteHandlers(deps) {
  const config = deps.config;
  const identity = deps.identity;
  const activity = deps.activity;
  const oauth = deps.oauth;
  const credentials = deps.credentials;
  const logger = deps.logger;
  const resolveRedirectUri = deps.resolveRedirectUri;
  const locationOptions = {
    env: typeof process !== 'undefined' && process.env !== undefined ? process.env : {},
    baseUrl: typeof deps.baseUrl === 'string' ? deps.baseUrl : undefined,
  };

  /**
   * Assemble the payload the settings page renders.
   * @returns the state description.
   */
  async function describeConfiguration() {
    const candidates = patchFileCandidates(config, locationOptions);
    const file = resolvePatchFile(config, locationOptions);
    const read = readEntryFile(file, candidates);
    const credentialsInfo = await identity.describeCredentials();
    const user = await identity.userState();
    // A field the file does not mention is shown with the value that is actually
    // in effect, so an untouched form never rewrites a working default into a
    // fresh (and wrong) one. The endpoint overrides and the scope list are the
    // exceptions: their empty state is meaningful ("use the brand default" and
    // "use the recommended set"), so they stay empty rather than echoing back a
    // resolved value the user never chose.
    const effectiveValues = {
      appId: () => config.appId,
      appSecretRef: () => config.appSecretRef,
      brand: () => config.brand,
      defaultFolderToken: () => config.defaultFolderToken,
      defaultIdentity: () => config.defaultIdentity,
      toolPrefix: () => config.toolPrefix,
      requestTimeoutMs: () => config.requestTimeoutMs,
      maxRetries: () => config.maxRetries + 1,
      enableTools: () => config.enableTools,
      enableOAuth: () => config.enableOAuth,
      enableUi: () => config.enableUi,
      registerSystemPrompt: () => config.registerSystemPrompt,
      maxRecordsPerPage: () => config.maxRecordsPerPage,
      activityLogSize: () => config.activityLogSize,
    };
    const values = {};
    const stored = {};
    for (const key of Object.keys(EDITABLE_FIELDS)) {
      const inFile = read.ok === true && read.values[key] !== undefined;
      if (inFile) stored[key] = read.values[key];
      values[key] = inFile ? read.values[key] : effectiveValues[key] !== undefined ? effectiveValues[key]() : null;
    }
    return {
      values,
      stored,
      fields: EDITABLE_FIELDS,
      effective: {
        brandLabel: config.brandLabel,
        apiBaseUrl: config.apiBaseUrl,
        accountsBaseUrl: config.accountsBaseUrl,
        toolPrefix: config.toolPrefix,
        toolNames: Array.isArray(deps.toolNames) ? deps.toolNames : [],
        activityLogSize: config.activityLogSize,
      },
      patch: {
        file: file !== undefined ? file : null,
        entryFound: read.ok === true ? read.found : false,
        readable: read.ok === true,
        unmanagedKeys: read.ok === true ? read.unmanaged : [],
        error: read.ok === true ? null : read.message,
      },
      secret: { ref: credentialsInfo.appSecretRef, configured: credentialsInfo.secretConfigured, source: credentialsInfo.secretSource },
      redirectUri: resolveRedirectUri(),
      user,
      applyMode: 'hot',
    };
  }

  const handlers = {
    /**
     * Report authorization and configuration state to the browser half.
     * @param req - the request.
     * @param res - the response.
     */
    async status(req, res) {
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: 'METHOD' });
        return;
      }
      try {
        const credentials = await identity.describeCredentials();
        const user = await identity.userState();
        const data = {
          brand: config.brand,
          brandLabel: config.brandLabel,
          appId: credentials.appIdMasked,
          appSecretConfigured: credentials.secretConfigured,
          appSecretSource: credentials.secretSource,
          appSecretRef: credentials.appSecretRef,
          defaultFolderToken: config.defaultFolderToken,
          redirectUri: resolveRedirectUri(),
          enableUi: config.enableUi,
          user,
        };
        if (user.authorized === true && config.appId.length > 0 && credentials.secretConfigured) {
          try {
            const profile = await identity.userInfo(undefined);
            if (profile !== undefined) data.user = { ...user, name: profile.name, openId: profile.open_id, email: profile.email };
          } catch (error) {
            data.user = { ...user, error: String(error !== null && error !== undefined && error.message !== undefined ? error.message : error) };
          }
        }
        sendJson(res, 200, { ok: true, data });
      } catch (error) {
        sendJson(res, 200, { ok: false, error: 'STATUS', message: String(error !== null && error !== undefined && error.message !== undefined ? error.message : error) });
      }
    },

    /**
     * Start the OAuth flow: remember the state and redirect to Feishu.
     * @param req - the request.
     * @param res - the response.
     */
    async oauthStart(req, res) {
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: 'METHOD' });
        return;
      }
      const url = new URL(req.url !== undefined ? req.url : ROUTES.oauthStart, 'http://127.0.0.1');
      if (config.appId.length === 0) {
        sendPage(res, 400, 'Feishu app id is not configured', 'Set config.appId for the feishu plugin entry and restart DeepSeek Harness.', 'error');
        return;
      }
      const scopes = config.oauthScopes.length > 0 ? config.oauthScopes : undefined;
      const built = identity.authorizeUrl({ scopes, redirectUri: resolveRedirectUri() });
      oauth.pending.add(built.state);
      if (url.searchParams.get('json') === '1') {
        sendJson(res, 200, { ok: true, url: built.url, state: built.state, redirectUri: built.redirectUri });
        return;
      }
      res.writeHead(302, { location: built.url, 'cache-control': 'no-store' });
      res.end();
    },

    /**
     * Finish the OAuth flow with the code Feishu redirected back.
     * @param req - the request.
     * @param res - the response.
     */
    async oauthCallback(req, res) {
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: 'METHOD' });
        return;
      }
      const url = new URL(req.url !== undefined ? req.url : ROUTES.oauthCallback, 'http://127.0.0.1');
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const failure = url.searchParams.get('error');
      if (failure !== null) {
        sendPage(res, 400, 'Feishu declined the authorization', 'Feishu reported: ' + escapeHtml(url.searchParams.get('error_description') !== null ? url.searchParams.get('error_description') : failure), 'error');
        return;
      }
      if (code === null || code.length === 0) {
        sendPage(res, 400, 'No authorization code', 'Feishu did not return a code. Start the flow again from the Feishu panel.', 'error');
        return;
      }
      if (state !== null && oauth.pending.size > 0 && !oauth.pending.has(state)) {
        sendPage(res, 400, 'Authorization state mismatch', 'This callback did not match an authorization this host started. Start the flow again from the Feishu panel.', 'error');
        return;
      }
      if (state !== null) oauth.pending.delete(state);
      try {
        const result = await identity.exchangeCode({ code, redirectUri: resolveRedirectUri() });
        const name = result.profile !== undefined && result.profile.name !== undefined ? result.profile.name : 'your Feishu account';
        const renewable = result.record.refreshToken.length > 0;
        activity.record({ at: Date.now(), tool: 'oauth', action: 'callback', ok: true, summary: 'authorized as ' + name + (renewable ? '' : ' (no offline_access)'), identity: 'user' });
        // A grant without offline_access is a success that quietly expires in about
        // two hours; the page has to say that, or the next failure looks unrelated.
        sendPage(
          res,
          200,
          renewable ? 'Feishu is connected' : 'Feishu is connected, but it will not renew itself',
          'Authorized as ' + escapeHtml(name) + '. ' + (renewable
            ? 'You can close this tab and return to DeepSeek Harness.'
            : 'The grant came back without offline_access, so it stops working when the access token expires (about two hours). In 权限管理 make sure 持续访问已授权的数据 (offline_access) is granted, publish an app version, then authorize again.'),
          renewable ? 'ok' : 'warn',
        );
      } catch (error) {
        const message = String(error !== null && error !== undefined && error.message !== undefined ? error.message : error);
        if (logger !== undefined) logger.warn('feishu: OAuth callback failed: ' + message);
        activity.record({ at: Date.now(), tool: 'oauth', action: 'callback', ok: false, summary: message, identity: 'user' });
        sendPage(res, 400, 'Authorization failed', escapeHtml(message), 'error');
      }
    },

    /**
     * Forget the stored user grant.
     * @param req - the request.
     * @param res - the response.
     */
    async oauthLogout(req, res) {
      if (req.method !== 'POST' && req.method !== 'DELETE') {
        sendJson(res, 405, { ok: false, error: 'METHOD' });
        return;
      }
      try {
        await identity.clearUserToken();
        sendJson(res, 200, { ok: true });
      } catch (error) {
        sendJson(res, 200, { ok: false, error: 'LOGOUT', message: String(error !== null && error !== undefined && error.message !== undefined ? error.message : error) });
      }
    },

    /**
     * Report the recent tool activity.
     * @param req - the request.
     * @param res - the response.
     */
    async activity(req, res) {
      if (req.method === 'DELETE') {
        activity.clear();
        sendJson(res, 200, { ok: true, data: [] });
        return;
      }
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: 'METHOD' });
        return;
      }
      sendJson(res, 200, { ok: true, data: activity.list() });
    },

    /**
     * Read or write the plugin's loader configuration.
     *
     * A write rewrites only this plugin's entry in the profile patch file,
     * which the harness hot-reloads, and stores the app secret through the
     * credential store rather than in the file.
     *
     * @param req - the request.
     * @param res - the response.
     */
    async config(req, res) {
      if (req.method === 'GET') {
        try {
          sendJson(res, 200, { ok: true, data: await describeConfiguration() });
        } catch (error) {
          sendJson(res, 200, { ok: false, error: 'CONFIG', message: String(error !== null && error !== undefined && error.message !== undefined ? error.message : error) });
        }
        return;
      }
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'METHOD' });
        return;
      }
      const body = await readJsonBody(req);
      if (body.ok !== true) {
        sendJson(res, 400, { ok: false, error: 'BAD_BODY', message: body.message });
        return;
      }
      const submitted = body.value.values !== undefined && body.value.values !== null ? body.value.values : {};
      if (typeof submitted !== 'object' || Array.isArray(submitted)) {
        sendJson(res, 400, { ok: false, error: 'BAD_BODY', message: 'values must be an object of configuration fields' });
        return;
      }
      const accepted = {};
      const problems = [];
      for (const key of Object.keys(submitted)) {
        if (submitted[key] === null) {
          if (EDITABLE_FIELDS[key] === undefined) problems.push('unknown configuration field ' + JSON.stringify(key));
          else accepted[key] = null;
          continue;
        }
        const result = validateField(key, submitted[key]);
        if (result.ok === true) accepted[key] = result.value;
        else problems.push(result.message);
      }
      if (problems.length > 0) {
        sendJson(res, 400, { ok: false, error: 'INVALID', message: problems.join('; ') });
        return;
      }
      if (Object.keys(accepted).length > 0) {
        const file = resolvePatchFile(config, locationOptions);
        if (file === undefined) {
          sendJson(res, 400, {
            ok: false,
            error: 'NO_LOCATION',
            message: 'the profile patch file could not be located, so the configuration cannot be saved. Looked in: ' + patchFileCandidates(config, locationOptions).slice(0, 4).join(', '),
          });
          return;
        }
        const outcome = writeEntry(file, accepted);
        if (outcome.ok !== true) {
          sendJson(res, 400, { ok: false, error: outcome.reason, message: outcome.message });
          return;
        }
        activity.record({ at: Date.now(), tool: 'settings', action: 'write-config', ok: true, summary: 'updated ' + Object.keys(accepted).join(', ') });
      }
      if (typeof body.value.appSecret === 'string') {
        const ref = typeof accepted.appSecretRef === 'string' && accepted.appSecretRef.length > 0 ? accepted.appSecretRef : config.appSecretRef;
        try {
          if (body.value.appSecret.length === 0) {
            await credentials.unset(ref);
            activity.record({ at: Date.now(), tool: 'settings', action: 'clear-secret', ok: true, summary: 'cleared the stored app secret' });
          } else {
            await credentials.set(ref, body.value.appSecret);
            activity.record({ at: Date.now(), tool: 'settings', action: 'set-secret', ok: true, summary: 'stored a new app secret under ' + ref });
          }
        } catch (error) {
          sendJson(res, 400, {
            ok: false,
            error: 'SECRET',
            message: 'the configuration was saved, but storing the app secret failed: ' + String(error !== null && error !== undefined && error.message !== undefined ? error.message : error),
          });
          return;
        }
      }
      try {
        sendJson(res, 200, { ok: true, data: await describeConfiguration() });
      } catch (error) {
        sendJson(res, 200, { ok: false, error: 'CONFIG', message: String(error !== null && error !== undefined && error.message !== undefined ? error.message : error) });
      }
    },
  };

  return {
    [ROUTES.status]: handlers.status,
    [ROUTES.activity]: handlers.activity,
    [ROUTES.config]: handlers.config,
    [ROUTES.oauthStart]: handlers.oauthStart,
    [ROUTES.oauthCallback]: handlers.oauthCallback,
    [ROUTES.oauthLogout]: handlers.oauthLogout,
  };
}

/**
 * Register every route on the host webserver.
 * @param webServer - the webserver service.
 * @param handlers - the handlers keyed by route path.
 * @returns the disposers.
 */
export function registerRoutes(webServer, handlers) {
  const disposers = [];
  for (const path of Object.keys(handlers)) {
    disposers.push(webServer.register({ kind: 'exact', path, handler: handlers[path] }));
  }
  return disposers;
}
