/**
 * Authorization and diagnostics: the tool that answers "why did that fail".
 *
 * There are three independent ways a Feishu call can be refused — the app
 * credentials are absent, the app lacks a scope, or no user grant is stored —
 * and they look alike from the outside. This tool separates them, produces the
 * authorization URL for the missing grant, and completes the code exchange when
 * the browser cannot reach the host callback (a headless or remote session).
 *
 * @module dsh-feishu/tools/auth
 */

import { defineTool, ok, stringArrayParam, stringParam } from './kit.js';

/**
 * The scopes this plugin's tools need. `offline_access` is what makes the
 * grant refreshable; without it Feishu returns no refresh token and the user
 * must re-authorize every couple of hours.
 */
export const RECOMMENDED_SCOPES = [
  'offline_access',
  'bitable:app',
  // The Base V3 surface (LiteQuery aggregation and dashboards) is gated by its
  // own scopes; bitable:app does not cover it.
  'base:table:read',
  'base:dashboard:read',
  // Creating a dashboard and its blocks is gated by its own scope: read alone
  // answers 99991679 (verified live 2026-10-28), so the recommended set has to
  // carry the write scope too or the dashboard actions can never work.
  'base:dashboard:create',
  // Each dashboard mutation is gated by its own scope; read+create alone answers
  // 99991679 on update_block / delete_block (verified live 2026-10-28).
  'base:dashboard:update',
  'base:dashboard:delete',
  'docx:document',
  // append_markdown converts Markdown through the server-side block converter.
  'docx:document.block:convert',
  'drive:drive',
  'sheets:spreadsheet',
  'wiki:wiki',
  'im:message',
  'im:resource',
  'contact:user.base:readonly',
];

/**
 * Build the authorization tool.
 * @param deps - composition facts.
 * @param deps.identity - the identity manager.
 * @param deps.config - normalized configuration.
 * @param deps.resolveRedirectUri - returns the redirect URI to advertise.
 * @param deps.registerOAuthState - registers a state as one this host started.
 * @returns the tool definition.
 */
export function createAuthTool(deps) {
  const identity = deps.identity;
  const registerOAuthState = deps.registerOAuthState;
  const config = deps.config;
  const resolveRedirectUri = deps.resolveRedirectUri;

  return defineTool({
    name: 'feishu_auth',
    timeoutMs: 120000,
    description: [
      'Inspect and manage Feishu authorization.',
      'Action "status" reports whether the app credentials resolve, whether a tenant token can be minted, and whether a user grant is stored — use it first whenever a Feishu call fails with a permission error.',
      'Action "authorize_url" returns the URL the user opens to grant access; the grant is what makes documents land in their own drive instead of the app space.',
      'Action "complete" finishes the flow from a pasted authorization code, for sessions where the browser callback cannot reach this host. Action "refresh" re-mints the user token now; "logout" forgets the stored grant.',
    ].join(' '),
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['status', 'authorize_url', 'complete', 'refresh', 'logout'],
        description: 'The authorization operation to perform.',
      },
      code: stringParam('The authorization code for the "complete" action, taken from the code parameter of the redirect URL.'),
      redirectUri: stringParam('Override the redirect URI, which must match the one registered on the Feishu app.'),
      scopes: stringArrayParam('Scopes to request in "authorize_url"; defaults to the recommended set for this plugin.'),
    },
    async execute(args, exec) {
      const signal = exec !== undefined && exec.signal !== undefined ? exec.signal : undefined;
      const action = args.action;

      if (action === 'status') {
        const credentials = await identity.describeCredentials();
        const user = await identity.userState();
        const data = {
          brand: config.brand,
          brandLabel: config.brandLabel,
          apiBaseUrl: config.apiBaseUrl,
          accountsBaseUrl: config.accountsBaseUrl,
          appId: credentials.appIdMasked,
          appSecretConfigured: credentials.secretConfigured,
          appSecretSource: credentials.secretSource,
          appSecretRef: credentials.secretRef,
          defaultFolderToken: config.defaultFolderToken,
          configuredRedirectUri: config.oauthRedirectUri,
          recommendedScopes: config.oauthScopes.length > 0 ? config.oauthScopes : RECOMMENDED_SCOPES,
          user,
        };
        const warnings = [];
        let tenantOk = false;
        let tenantError;
        if (!credentials.secretConfigured || credentials.appId.length === 0) {
          warnings.push('app credentials are incomplete: set config.appId and provide the secret through ' + credentials.secretRef + ', then restart.');
        } else {
          try {
            await identity.tenantToken(signal);
            tenantOk = true;
          } catch (error) {
            tenantError = String(error !== null && error !== undefined && error.message !== undefined ? error.message : error);
            warnings.push('the app credentials are configured but Feishu rejected them: ' + tenantError);
          }
          if (user.authorized === true) {
            try {
              const profile = await identity.userInfo(signal);
              if (profile !== undefined) {
                data.user = { ...user, name: profile.name, openId: profile.open_id, unionId: profile.union_id, email: profile.email, avatarUrl: profile.avatar_url };
              }
            } catch (error) {
              warnings.push('the stored user grant could not be used: ' + String(error !== null && error !== undefined && error.message !== undefined ? error.message : error));
            }
          } else {
            warnings.push('no user grant is stored, so tools default to acting as the app; run this tool with action "authorize_url" and open the returned link to act in your own drive.');
          }
          if (user.authorized === true && user.refreshable === false) {
            // The failure this names is the one that used to appear only two hours
            // later, as every user-identity call failing at once: the grant exists
            // but cannot renew itself.
            warnings.push(
              'the stored grant has no usable refresh token, so it cannot renew itself; it stops working when the access token expires. '
                + 'Re-authorize with action "authorize_url" (the grant keeps refreshing only while it carries offline_access).',
            );
          }
        }
        data.tenantTokenOk = tenantOk;
        if (tenantError !== undefined) data.tenantTokenError = tenantError;
        const ready = tenantOk || user.authorized === true;
        return ok({
          action,
          summary: ready
            ? 'Feishu is reachable as ' + (user.authorized === true ? 'an authorized user' : 'the app') + (user.authorized === true ? '' : ' (no user grant stored)')
            : 'Feishu is not usable yet: ' + (warnings.length > 0 ? warnings[0] : 'no credentials'),
          identity: user.authorized === true ? 'user' : 'app',
          warnings,
          data,
        });
      }

      if (action === 'authorize_url') {
        const scopes = Array.isArray(args.scopes) && args.scopes.length > 0 ? args.scopes : config.oauthScopes.length > 0 ? config.oauthScopes : RECOMMENDED_SCOPES;
        const redirectUri = typeof args.redirectUri === 'string' && args.redirectUri.length > 0
          ? args.redirectUri
          : typeof resolveRedirectUri === 'function'
            ? resolveRedirectUri()
            : config.oauthRedirectUri;
        if (config.appId.length === 0) throw new Error('authorization needs config.appId; set it and restart');
        const built = identity.authorizeUrl({ scopes, redirectUri });
        // The callback only honours a state this host started, and the /start
        // route was the only place registering one. A URL minted here therefore
        // died with "Authorization state mismatch" as soon as the panel had ever
        // been used. Register it, so both entry points agree.
        if (typeof registerOAuthState === 'function') registerOAuthState(built.state);
        return ok({
          action,
          summary: 'open this URL to authorize Feishu access' + (redirectUri.length > 0 ? '' : ' (no redirect URI is configured, so the callback will not return here — use action "complete" with the code from the URL)'),
          url: built.url,
          data: {
            url: built.url,
            redirectUri: built.redirectUri,
            scopes: built.scopes,
            state: built.state,
            nextStep: built.redirectUri.length > 0
              ? 'Open the URL, approve access, and the browser will land back on this host, which stores the grant automatically.'
              : 'Open the URL, approve access, copy the code parameter from the address you land on, then call this tool with action "complete" and that code.',
          },
        });
      }

      if (action === 'complete') {
        if (typeof args.code !== 'string' || args.code.length === 0) throw new Error('complete needs the authorization code');
        const redirectUri = typeof args.redirectUri === 'string' && args.redirectUri.length > 0
          ? args.redirectUri
          : typeof resolveRedirectUri === 'function'
            ? resolveRedirectUri()
            : config.oauthRedirectUri;
        const result = await identity.exchangeCode({ code: args.code.trim(), redirectUri, signal });
        const name = result.profile !== undefined && result.profile.name !== undefined ? result.profile.name : '(unknown user)';
        return ok({
          action,
          summary: 'authorized as ' + name + '; the grant is stored and refreshes automatically',
          identity: 'user',
          data: { profile: result.profile, scope: result.record.scope, expiresAt: result.record.expiresAt, refreshable: result.record.refreshToken.length > 0 },
        });
      }

      if (action === 'refresh') {
        const record = await identity.refreshUserToken(signal, true);
        return ok({
          action,
          summary: 'refreshed the Feishu user token',
          identity: 'user',
          data: { expiresAt: record.expiresAt, refreshable: record.refreshToken.length > 0, scope: record.scope },
        });
      }

      if (action === 'logout') {
        await identity.clearUserToken();
        return ok({ action, summary: 'forgot the stored Feishu user grant', identity: 'app' });
      }

      throw new Error('unsupported authorization action: ' + String(action));
    },
  });
}
