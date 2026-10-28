/**
 * dsh-feishu - deep Feishu / Lark integration for DeepSeek Harness.
 *
 * The plugin is a composition root and nothing else: it normalizes
 * configuration, builds the identity manager and the API client, registers the
 * tools, and claims the OAuth routes. Every behavior lives in the module that
 * owns it.
 *
 * Two host facts shape the code. First, third-party plugins load from a profile
 * junction or a copied directory, where a bare `@deepseek-ai/*` specifier may
 * resolve to a different DSH copy than the running host - so this package
 * imports nothing but Node builtins and validates its own configuration.
 * Second, the plugin is expected to run in compositions that lack the browser
 * host, the credentials store, or the system prompt: every optional service is
 * reached lazily through `ctx.get`, so a headless composition still gets the
 * tools and simply reports that OAuth cannot complete in place.
 *
 * @module dsh-feishu
 */

import { normalizeConfig } from './config.js';
import { createIdentity } from './identity.js';
import { createFeishuClient } from './client.js';
import { createActivityLog } from './activity.js';
import { buildTools, registerTools } from './tools/index.js';
import { ROUTES, createRouteHandlers, registerRoutes } from './routes.js';

/** The Cordis service this plugin cannot work without. */
export const inject = ['tools'];

/** Short, stable plugin name; also the credentials-record scope. */
export const name = 'feishu';

/** Guidance appended to the system prompt when a prompt service is present. */
const PROMPT_TEXT = [
  'Feishu (Lark) tools are available and act on the user real cloud drive.',
  'Prefer them over the local filesystem whenever the user asks for something to exist in Feishu: a 多维表格 or database (feishu_bitable), a chart or dashboard inside one (feishu_dashboard), an aggregate question such as a total or a top-N ranking (feishu_query), a document (feishu_doc), a spreadsheet (feishu_sheet), a wiki page (feishu_wiki), a file in the drive (feishu_drive), or a message (feishu_message).',
  'Create the database, document, or sheet first, then report the returned url so the user can open it.',
  'These tools act as the authorized user by default, which is what puts new content in the user own space; when no grant is stored they fall back to the app identity and say so in a warning.',
  'If a call fails with a permission or scope error, run feishu_auth with action "status" before guessing, and read the hint in the error.',
].join(' ');

/**
 * Build a lazily-resolving proxy over the optional credentials service.
 *
 * The store may be mounted after this plugin, and a composition may omit it
 * entirely, so every method looks the service up at call time and degrades to
 * "nothing stored" rather than throwing.
 *
 * @param ctx - the Cordis context.
 * @returns the proxy.
 */
function credentialsProxy(ctx) {
  const service = () => ctx.get('credentials');
  return {
    async resolve(ref) {
      const found = service();
      return found === undefined ? undefined : found.resolve(ref);
    },
    async describe(ref) {
      const found = service();
      return found === undefined ? { configured: false, writable: false } : found.describe(ref);
    },
    async readRecord(key) {
      const found = service();
      return found === undefined ? undefined : found.readRecord(key);
    },
    async modifyRecord(key, mutate) {
      const found = service();
      if (found === undefined) return undefined;
      return found.modifyRecord(key, mutate);
    },
    async deleteRecord(key) {
      const found = service();
      if (found === undefined) return undefined;
      return found.deleteRecord(key);
    },
    async describeRecord(key) {
      const found = service();
      return found === undefined ? { configured: false, writable: false } : found.describeRecord(key);
    },
    async set(ref, value) {
      const found = service();
      if (found === undefined || typeof found.set !== 'function') {
        throw new Error('the credential store is not available in this composition, so the app secret cannot be stored; set ' + String(ref) + ' in the environment instead');
      }
      return found.set(ref, value);
    },
    async unset(ref) {
      const found = service();
      if (found === undefined || typeof found.unset !== 'function') return undefined;
      return found.unset(ref);
    },
  };
}

/**
 * Mount the plugin.
 * @param ctx - the Cordis context.
 * @param rawConfig - the raw patch configuration, validated here rather than by a Cordis schema.
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);
  const logger = ctx.logger;
  const activity = createActivityLog(config.activityLogSize);
  const oauth = { pending: new Set() };

  /**
   * Resolve the OAuth redirect URI: an explicit override wins, otherwise the
   * webserver's own loopback address, otherwise empty (which makes the
   * authorization tool fall back to a manual code exchange).
   * @returns the redirect URI, or an empty string.
   */
  function resolveRedirectUri() {
    if (config.oauthRedirectUri.length > 0) return config.oauthRedirectUri;
    const webServer = ctx.get('webServer');
    if (webServer === undefined) return '';
    const port = webServer.port;
    if (typeof port !== 'number' || port <= 0) return '';
    return 'http://127.0.0.1:' + port + ROUTES.oauthCallback;
  }

  const credentials = credentialsProxy(ctx);

  const identity = createIdentity({
    config,
    credentials,
    logger,
  });

  const client = createFeishuClient({ config, identity, logger });
  const toolNames = [];

  if (config.enableTools) {
    const definitions = buildTools({
      client, identity, config, activity, resolveRedirectUri, logger,
      // The OAuth callback only accepts a state this host started; without this
      // the URL the tool hands out is rejected as soon as the panel has been used.
      registerOAuthState: (state) => {
        if (typeof state === 'string' && state.length > 0) oauth.pending.add(state);
      },
    });
    registerTools(ctx, definitions, logger);
    for (const definition of definitions) toolNames.push(definition.name);
    if (logger !== undefined) {
      logger.info('feishu: registered ' + definitions.length + ' tools as ' + toolNames.join(', '));
    }
  }

  if (config.enableOAuth) {
    ctx.inject(['webServer'], (scope) => {
      const handlers = createRouteHandlers({
        config,
        identity,
        activity,
        oauth,
        resolveRedirectUri,
        credentials,
        toolNames,
        baseUrl: typeof ctx.baseUrl === 'string' ? ctx.baseUrl : undefined,
        logger,
      });
      const disposers = registerRoutes(scope.webServer, handlers);
      scope.effect(() => () => {
        for (const dispose of disposers) dispose();
      }, 'feishu: http routes');
      if (logger !== undefined) logger.info('feishu: OAuth and status routes mounted under /api/feishu');
    });
  }

  if (config.registerSystemPrompt) {
    ctx.inject(['systemPrompt'], (scope) => {
      scope.systemPrompt.section({
        name: 'tool:feishu',
        order: 150,
        text: PROMPT_TEXT,
      });
    });
  }
}
