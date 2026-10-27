/**
 * Identity and token custody for the Feishu open platform.
 *
 * Three credentials exist, and they are deliberately kept apart:
 *
 *  - the app id and app secret, which are configuration plus a credential
 *    reference and never leave the host;
 *  - the derived tenant / app access tokens, cached in memory and re-minted on
 *    expiry;
 *  - the user access token from the OAuth flow, which is a durable grant and
 *    therefore lives in the credentials store as a record, with its refresh
 *    token, so a rotated or expired grant survives a restart.
 *
 * Every refresh is single-flight: concurrent tool calls that discover an
 * expired token await one exchange rather than racing several.
 *
 * @module dsh-feishu/identity
 */

import { httpRequest, isAbort } from './http.js';
import { FeishuError } from './errors.js';

/** Credential-store record id owned by this plugin; the store prefixes its own scope. */
export const USER_TOKEN_RECORD_KEY = 'dsh-feishu/user-token';

/** Re-mint a cached token this long before it actually expires. */
const EXPIRY_MARGIN_MS = 120000;

/** Fallback lifetime when a response omits expires_in. */
const DEFAULT_TOKEN_TTL_MS = 3600000;

/**
 * Percent-encode one query value.
 * @param value - the raw value.
 * @returns the encoded form.
 */
function encode(value) {
  return encodeURIComponent(String(value));
}

/**
 * Render a query string from pairs, skipping empty values.
 * @param pairs - alternating key and value entries.
 * @returns the query string, without a leading question mark.
 */
function query(pairs) {
  const parts = [];
  for (let index = 0; index < pairs.length; index += 2) {
    const key = pairs[index];
    const value = pairs[index + 1];
    if (value === undefined || value === null || String(value).length === 0) continue;
    parts.push(encode(key) + '=' + encode(value));
  }
  return parts.join('&');
}

/**
 * Reveal only the head and tail of a secret-ish identifier.
 * @param value - the identifier.
 * @returns the masked form.
 */
export function mask(value) {
  if (typeof value !== 'string' || value.length === 0) return '';
  if (value.length <= 8) return value.slice(0, 2) + '***';
  return value.slice(0, 4) + '***' + value.slice(-4);
}

/** The Feishu business codes that mean "this token is no longer usable". */
export const TOKEN_EXPIRED_CODES = new Set([99991661, 99991663, 99991664, 99991668]);

/**
 * Build the identity manager.
 *
 * @param options - composition facts.
 * @param options.config - normalized configuration.
 * @param options.credentials - the optional credentials service.
 * @param options.logger - optional logger.
 * @param options.fetchImpl - fetch implementation for tests.
 * @param options.now - clock returning epoch milliseconds.
 * @returns the identity manager.
 */
export function createIdentity(options) {
  const config = options.config;
  const credentials = options.credentials;
  const logger = options.logger;
  const fetchImpl = options.fetchImpl;
  const now = options.now !== undefined ? options.now : () => Date.now();

  let tenantCache;
  let appCache;
  let memoryUserToken;
  let tenantInFlight;
  let appInFlight;
  let userInFlight;

  /**
   * Resolve the app secret through the credentials service, then the
   * environment, then the literal configuration value.
   * @returns the secret and where it came from.
   */
  async function appSecret() {
    if (credentials !== undefined && typeof credentials.resolve === 'function') {
      try {
        const hit = await credentials.resolve(config.appSecretRef);
        if (hit !== undefined && hit !== null && typeof hit.value === 'string' && hit.value.length > 0) {
          return { value: hit.value, source: 'credential:' + config.appSecretRef };
        }
      } catch (error) {
        if (logger !== undefined) logger.warn('feishu: credential reference resolution failed: ' + String(error && error.message));
      }
    }
    const fromEnv = typeof process !== 'undefined' && process.env !== undefined ? process.env[config.appSecretRef] : undefined;
    if (typeof fromEnv === 'string' && fromEnv.length > 0) return { value: fromEnv, source: 'env:' + config.appSecretRef };
    if (config.appSecret.length > 0) return { value: config.appSecret, source: 'config' };
    return { value: '', source: 'unset' };
  }

  /**
   * Describe app credentials without revealing the secret.
   * @returns the description.
   */
  async function describeCredentials() {
    const secret = await appSecret();
    return {
      appId: config.appId,
      appIdMasked: mask(config.appId),
      secretConfigured: secret.value.length > 0,
      secretSource: secret.source,
      secretRef: config.appSecretRef,
    };
  }

  /**
   * POST a JSON body to an auth endpoint and unwrap the Feishu envelope.
   * @param path - the auth path, without the accounts base.
   * @param body - the JSON body.
   * @param signal - caller cancellation.
   * @param label - a short name for error messages.
   * @returns the business payload.
   */
  async function authPost(path, body, signal, label, baseUrl) {
    // Two different hosts serve authentication here, and mixing them up is a
    // silent, total failure: the OAuth endpoints live on the accounts host,
    // while the tenant/app token endpoints live on the open-apis host. Asking
    // the accounts host for a tenant token answers 404 with a plain-text body,
    // which surfaces as "returned a non-JSON response".
    const url = (baseUrl !== undefined ? baseUrl : config.accountsBaseUrl) + path;
    const response = await httpRequest({
      url,
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8', accept: 'application/json' },
      body: JSON.stringify(body),
      timeoutMs: config.requestTimeoutMs,
      maxRetries: config.maxRetries,
      signal,
      fetchImpl,
      logger,
    });
    let parsed;
    try {
      parsed = response.text.length > 0 ? JSON.parse(response.text) : {};
    } catch {
      throw new FeishuError(label + ' returned a non-JSON response', {
        httpStatus: response.status,
        path,
        detail: response.text.slice(0, 300),
      });
    }
    if (parsed !== null && typeof parsed === 'object' && typeof parsed.error === 'string') {
      throw new FeishuError(label + ' failed: ' + parsed.error + (parsed.error_description !== undefined ? ' (' + parsed.error_description + ')' : ''), {
        httpStatus: response.status,
        path,
        detail: response.text.slice(0, 300),
      });
    }
    const code = parsed !== null && typeof parsed === 'object' ? parsed.code : undefined;
    if (typeof code === 'number' && code !== 0) {
      const message = typeof parsed.msg === 'string' ? parsed.msg : label + ' failed';
      throw new FeishuError(message, {
        code,
        httpStatus: response.status,
        path,
        detail: response.text.slice(0, 300),
      });
    }
    if (response.status >= 400) {
      throw new FeishuError(label + ' failed with HTTP ' + response.status, {
        httpStatus: response.status,
        path,
        detail: response.text.slice(0, 300),
      });
    }
    return parsed !== null && typeof parsed === 'object' ? parsed : {};
  }

  /**
   * Exchange app credentials for a tenant or app access token, with caching.
   * @param kind - 'tenant' or 'app'.
   * @param signal - caller cancellation.
   * @returns the access token.
   */
  async function internalToken(kind, signal) {
    const cached = kind === 'tenant' ? tenantCache : appCache;
    if (cached !== undefined && cached.expiresAt - EXPIRY_MARGIN_MS > now()) return cached.value;
    const inFlight = kind === 'tenant' ? tenantInFlight : appInFlight;
    if (inFlight !== undefined) return inFlight;

    const path = kind === 'tenant' ? '/auth/v3/tenant_access_token/internal' : '/auth/v3/app_access_token/internal';
    const label = kind === 'tenant' ? 'tenant_access_token' : 'app_access_token';
    const work = (async () => {
      const secret = await appSecret();
      if (config.appId.length === 0 || secret.value.length === 0) {
        throw new FeishuError('Feishu app credentials are not configured', {
          path,
          hint: 'Set config.appId plus a secret through the ' + config.appSecretRef + ' credential (Settings, or the ' + config.appSecretRef + ' environment variable), then restart.',
        });
      }
      const parsed = await authPost(path, { app_id: config.appId, app_secret: secret.value }, signal, label, config.apiBaseUrl);
      const value = parsed.tenant_access_token !== undefined ? parsed.tenant_access_token : parsed.app_access_token;
      if (typeof value !== 'string' || value.length === 0) {
        throw new FeishuError(label + ' response carried no token', { path, detail: JSON.stringify(parsed).slice(0, 300) });
      }
      const expiresIn = Number(parsed.expire) > 0 ? Number(parsed.expire) * 1000 : DEFAULT_TOKEN_TTL_MS;
      const record = { value, expiresAt: now() + expiresIn };
      if (kind === 'tenant') tenantCache = record;
      else appCache = record;
      return value;
    })();

    if (kind === 'tenant') tenantInFlight = work;
    else appInFlight = work;
    try {
      return await work;
    } finally {
      if (kind === 'tenant') tenantInFlight = undefined;
      else appInFlight = undefined;
    }
  }

  /**
   * Read the stored user grant from the credentials service.
   * @returns the stored token record, or undefined.
   */
  async function readStoredUserToken() {
    if (credentials === undefined || typeof credentials.readRecord !== 'function') return undefined;
    try {
      const record = await credentials.readRecord(USER_TOKEN_RECORD_KEY);
      if (record === undefined || record === null) return undefined;
      const payload = record.payload;
      if (payload === null || typeof payload !== 'object' || typeof payload.accessToken !== 'string') return undefined;
      return payload;
    } catch (error) {
      if (logger !== undefined) logger.warn('feishu: reading the stored user token failed: ' + String(error && error.message));
      return undefined;
    }
  }

  /**
   * Persist the user grant, or keep it in memory when no credentials service exists.
   * @param payload - the token record to store.
   * @returns nothing.
   */
  async function storeUserToken(payload) {
    memoryUserToken = payload;
    if (credentials === undefined || typeof credentials.modifyRecord !== 'function') return;
    await credentials.modifyRecord(USER_TOKEN_RECORD_KEY, async () => ({ kind: 'grant', payload }));
  }

  /**
   * Remove the user grant from both the store and memory.
   * @returns nothing.
   */
  async function clearUserToken() {
    memoryUserToken = undefined;
    if (credentials === undefined || typeof credentials.deleteRecord !== 'function') return;
    try {
      await credentials.deleteRecord(USER_TOKEN_RECORD_KEY);
    } catch (error) {
      if (logger !== undefined) logger.warn('feishu: deleting the stored user token failed: ' + String(error && error.message));
    }
  }

  /**
   * Assemble a token record from an OAuth token response.
   * @param parsed - the token endpoint payload.
   * @returns the record to persist.
   */
  function userRecordFrom(parsed) {
    const accessToken = parsed.access_token;
    if (typeof accessToken !== 'string' || accessToken.length === 0) {
      throw new FeishuError('the OAuth token response carried no access_token', { detail: JSON.stringify(parsed).slice(0, 300) });
    }
    const expiresIn = Number(parsed.expires_in) > 0 ? Number(parsed.expires_in) * 1000 : DEFAULT_TOKEN_TTL_MS;
    const refreshExpiresIn = Number(parsed.refresh_token_expires_in) > 0 ? Number(parsed.refresh_token_expires_in) * 1000 : 0;
    return {
      accessToken,
      refreshToken: typeof parsed.refresh_token === 'string' ? parsed.refresh_token : '',
      expiresAt: now() + expiresIn,
      refreshExpiresAt: refreshExpiresIn > 0 ? now() + refreshExpiresIn : 0,
      scope: typeof parsed.scope === 'string' ? parsed.scope : '',
      obtainedAt: now(),
    };
  }

  /**
   * Exchange an authorization code for a user access token.
   * @param parameters - the exchange facts.
   * @returns the stored record, plus the profile when it could be read.
   */
  async function exchangeCode(parameters) {
    const secret = await appSecret();
    const body = {
      grant_type: 'authorization_code',
      client_id: config.appId,
      client_secret: secret.value,
      code: parameters.code,
    };
    if (parameters.redirectUri !== undefined && parameters.redirectUri.length > 0) body.redirect_uri = parameters.redirectUri;
    const parsed = await authPost('/authen/v2/oauth/token', body, parameters.signal, 'OAuth code exchange');
    const record = userRecordFrom(parsed);
    await storeUserToken(record);
    let profile;
    try {
      profile = await fetchUserInfo(record.accessToken, parameters.signal);
    } catch (error) {
      if (logger !== undefined) logger.warn('feishu: user_info after exchange failed: ' + String(error && error.message));
    }
    if (profile !== undefined) {
      record.openId = profile.open_id;
      record.name = profile.name;
      await storeUserToken(record);
    }
    return { record, profile };
  }

  /**
   * Refresh the user grant, single-flight.
   * @param signal - caller cancellation.
   * @param force - refresh even when the cached access token is still valid.
   * @returns the refreshed record.
   */
  async function refreshUserToken(signal, force) {
    if (userInFlight !== undefined && force !== true) return userInFlight;
    const work = (async () => {
      const stored = memoryUserToken !== undefined ? memoryUserToken : await readStoredUserToken();
      if (stored === undefined) throw new FeishuError('no Feishu user authorization is stored', { hint: 'Authorize first with the feishu_auth tool, action "authorize_url".' });
      if (typeof stored.refreshToken !== 'string' || stored.refreshToken.length === 0) {
        throw new FeishuError('the stored Feishu grant has no refresh token', { hint: 'Re-authorize with the feishu_auth tool, action "authorize_url".' });
      }
      if (stored.refreshExpiresAt > 0 && stored.refreshExpiresAt <= now()) {
        throw new FeishuError('the Feishu refresh token has expired', { hint: 'Re-authorize with the feishu_auth tool, action "authorize_url".' });
      }
      const secret = await appSecret();
      const parsed = await authPost('/authen/v2/oauth/token', {
        grant_type: 'refresh_token',
        client_id: config.appId,
        client_secret: secret.value,
        refresh_token: stored.refreshToken,
      }, signal, 'OAuth token refresh');
      const record = userRecordFrom(parsed);
      record.openId = stored.openId;
      record.name = stored.name;
      // Feishu returns a rotated refresh token only sometimes. When the reply
      // omits it, the stored one remains the only usable credential — and where
      // the app secret happens to live (config vs credential store) says nothing
      // about that, so the carry-over must not be gated on config.appSecret.
      if (record.refreshToken.length === 0) {
        record.refreshToken = stored.refreshToken;
        record.refreshExpiresAt = stored.refreshExpiresAt;
      }
      await storeUserToken(record);
      return record;
    })();
    userInFlight = work;
    try {
      return await work;
    } finally {
      userInFlight = undefined;
    }
  }

  /**
   * Resolve the user access token, refreshing when it is near expiry.
   * @param signal - caller cancellation.
   * @returns the usable token record, or undefined when unconfigured.
   */
  async function userToken(signal) {
    if (config.userAccessToken.length > 0) {
      return { accessToken: config.userAccessToken, refreshToken: '', expiresAt: Number.MAX_SAFE_INTEGER, refreshExpiresAt: 0, scope: '', source: 'config' };
    }
    const stored = memoryUserToken !== undefined ? memoryUserToken : await readStoredUserToken();
    if (stored === undefined) return undefined;
    memoryUserToken = stored;
    if (stored.expiresAt - EXPIRY_MARGIN_MS > now()) {
      return { ...stored, source: 'store' };
    }
    const refreshed = await refreshUserToken(signal, false);
    return { ...refreshed, source: 'store' };
  }

  /**
   * Read the authorized user profile.
   * @param accessToken - the user access token.
   * @param signal - caller cancellation.
   * @returns the profile payload.
   */
  async function fetchUserInfo(accessToken, signal) {
    const response = await httpRequest({
      url: config.apiBaseUrl + '/authen/v1/user_info',
      method: 'GET',
      headers: { authorization: 'Bearer ' + accessToken, accept: 'application/json' },
      timeoutMs: config.requestTimeoutMs,
      maxRetries: config.maxRetries,
      signal,
      fetchImpl,
      logger,
    });
    let parsed;
    try {
      parsed = response.text.length > 0 ? JSON.parse(response.text) : {};
    } catch {
      throw new FeishuError('user_info returned a non-JSON response', { httpStatus: response.status, path: '/authen/v1/user_info' });
    }
    if (typeof parsed.code === 'number' && parsed.code !== 0) {
      throw new FeishuError(typeof parsed.msg === 'string' ? parsed.msg : 'user_info failed', {
        code: parsed.code,
        httpStatus: response.status,
        path: '/authen/v1/user_info',
      });
    }
    return parsed.data !== null && typeof parsed.data === 'object' ? parsed.data : {};
  }

  /**
   * Read the authorized user profile through the current token.
   * @param signal - caller cancellation.
   * @returns the profile, or undefined when no user grant exists.
   */
  async function userInfo(signal) {
    const token = await userToken(signal);
    if (token === undefined) return undefined;
    return fetchUserInfo(token.accessToken, signal);
  }

  /**
   * Build the authorization URL the user opens in a browser.
   * @param parameters - optional scopes and redirect override.
   * @returns the URL plus the state it carries.
   */
  function authorizeUrl(parameters = {}) {
    const scopes = Array.isArray(parameters.scopes) && parameters.scopes.length > 0 ? parameters.scopes : config.oauthScopes;
    const redirectUri = typeof parameters.redirectUri === 'string' && parameters.redirectUri.length > 0 ? parameters.redirectUri : config.oauthRedirectUri;
    const state = typeof parameters.state === 'string' && parameters.state.length > 0 ? parameters.state : 'dsh-' + Math.random().toString(36).slice(2, 10);
    const search = query([
      'client_id', config.appId,
      'redirect_uri', redirectUri,
      'scope', scopes.join(' '),
      'state', state,
      'response_type', 'code',
    ]);
    return {
      url: config.accountsBaseUrl + '/authen/v1/authorize' + (search.length > 0 ? '?' + search : ''),
      state,
      redirectUri,
      scopes,
    };
  }

  /**
   * Describe the user grant without performing a refresh.
   * @returns the description.
   */
  async function userState() {
    const stored = memoryUserToken !== undefined ? memoryUserToken : await readStoredUserToken();
    if (stored === undefined) {
      return { authorized: config.userAccessToken.length > 0, source: config.userAccessToken.length > 0 ? 'config' : 'none' };
    }
    memoryUserToken = stored;
    return {
      authorized: true,
      source: 'store',
      expiresAt: stored.expiresAt,
      expired: stored.expiresAt <= now(),
      refreshable: typeof stored.refreshToken === 'string' && stored.refreshToken.length > 0 && (stored.refreshExpiresAt === 0 || stored.refreshExpiresAt > now()),
      scope: typeof stored.scope === 'string' ? stored.scope : '',
      openId: stored.openId,
      name: stored.name,
    };
  }

  /**
   * Choose the identity a call should use.
   *
   * The default is transparent rather than silent: a call that wanted the user
   * but fell back to the app reports the fallback in its warnings, because the
   * resulting document would otherwise land in the wrong drive.
   *
   * @param requested - 'auto', 'user', or 'app'.
   * @param signal - caller cancellation.
   * @returns the resolved token plus any fallback note.
   */
  async function resolveIdentity(requested, signal) {
    const wanted = requested !== undefined && requested !== null ? String(requested) : config.defaultIdentity;
    if (wanted === 'app') {
      return { kind: 'app', token: await internalToken('tenant', signal), warnings: [] };
    }
    if (wanted === 'user') {
      const token = await userToken(signal);
      if (token === undefined) {
        throw new FeishuError('this call needs a Feishu user authorization, which is not configured', {
          hint: 'Run the feishu_auth tool to get an authorization URL, or pass identity:"app" to act as the app instead.',
        });
      }
      return { kind: 'user', token: token.accessToken, warnings: [] };
    }
    const token = await userToken(signal);
    if (token !== undefined) return { kind: 'user', token: token.accessToken, warnings: [] };
    const tenant = await internalToken('tenant', signal);
    return {
      kind: 'app',
      token: tenant,
      warnings: ['no Feishu user authorization is stored, so this call acted as the app; the result is owned by the app, not by you. Run feishu_auth (action "authorize_url") to act in your own drive.'],
    };
  }

  /** Drop every cached token, forcing a re-mint on the next call. */
  function reset() {
    tenantCache = undefined;
    appCache = undefined;
    memoryUserToken = undefined;
  }

  return {
    config,
    now,
    appSecret,
    describeCredentials,
    tenantToken: (signal) => internalToken('tenant', signal),
    appAccessToken: (signal) => internalToken('app', signal),
    userToken,
    userState,
    userInfo,
    authorizeUrl,
    exchangeCode,
    refreshUserToken,
    clearUserToken,
    resolveIdentity,
    describeUserGrant: userState,
    reset,
    isAbort,
  };
}
