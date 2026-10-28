/**
 * Error shaping for the Feishu open platform.
 *
 * Feishu reports business failures two ways: an HTTP error carrying a JSON body,
 * or HTTP 200 with a non-zero `code` in the envelope. Both collapse into
 * {@link FeishuError} so every tool can render one actionable sentence instead of
 * a raw transport object. Known codes carry a remediation hint, because the
 * difference between "the app lacks a scope" and "the user never authorized" is
 * the difference between a configuration fix and one click.
 *
 * @module dsh-feishu/errors
 */

/** Remediation hints for the failure codes an operator or agent can actually act on. */
const HINTS = new Map([
  [99991661, 'The access token is missing from the request; check the configured identity.'],
  [99991663, 'The tenant access token is invalid or expired; it will be refreshed automatically — retry once.'],
  [99991664, 'The app access token is invalid or expired; it will be refreshed automatically — retry once.'],
  [99991668, 'The user access token is invalid or expired. Re-authorize with the feishu_auth tool (action "authorize_url").'],
  [99991672, 'The app is missing an API scope. Add the scope in the Feishu developer console (权限管理), then publish a new app version.'],
  [99991679, 'The app lacks a required data scope for this resource. Grant it, then publish a new app version.'],
  [99991400, 'Permission denied. Check that the app has the scope AND that the target document is shared with the app or the authorized user.'],
  [1061002, 'The Bitable app token does not exist or the app is not accessible to this identity.'],
  [1061003, 'The Bitable table does not exist; list tables first with the feishu_bitable tool (action "list_tables").'],
  [1061004, 'A Bitable field name or type was rejected. List fields first with the feishu_bitable tool (action "list_fields").'],
  [1061045, 'The record payload was rejected: check that every field name exists and its value type matches the field type.'],
  // OAuth token endpoint (open.feishu.cn/open-apis/authen/v2/oauth/token). Each of
  // these means the stored grant is unusable and only a fresh authorization brings
  // it back, so saying that beats relaying "invalid_grant".
  [20010, 'The authorizing user no longer has permission to use this app. Restore the app availability range (应用可用范围), then re-authorize.'],
  [20026, 'The refresh token does not match this app id, or was not issued by a v2/v3 token endpoint. Re-authorize with the feishu_auth tool (action "authorize_url").'],
  [20037, 'The refresh token has expired. Re-authorize with the feishu_auth tool (action "authorize_url").'],
  [20064, 'The refresh token was revoked; each one can be used only once. Re-authorize with the feishu_auth tool (action "authorize_url").'],
  [20073, 'The refresh token has already been used; each one can be used only once. Re-authorize with the feishu_auth tool (action "authorize_url").'],
  [20074, 'Refreshing is disabled for this app: enable 刷新 user_access_token under 安全设置 in the Feishu console, then publish a new app version.'],
  [1770001, 'The document is not found or not shared with this identity.'],
  [1770002, 'The document request was rejected: check the document id and that the identity can edit it.'],
  [131006, 'The folder token is invalid or not writable by this identity.'],
  [230001, 'The message payload was rejected: check the receive_id and that it matches the receive_id_type.'],
  [230002, 'The bot is not a member of that chat; add the bot to the chat first.'],
]);

/** Redeemable-ish suffixes that most often mean "the id is wrong". */
const NOT_FOUND_CODES = new Set([1254005, 1254006, 1254007]);

/**
 * Describe a Feishu business code in one actionable sentence.
 * @param code - the numeric code from the response envelope.
 * @returns the hint, or undefined when nothing specific is known.
 */
export function hintForCode(code) {
  if (HINTS.has(code)) return HINTS.get(code);
  if (NOT_FOUND_CODES.has(code)) return 'The requested resource was not found for this identity.';
  return undefined;
}

/** A failed Feishu open-platform call, with the remediation context needed to act on it. */
export class FeishuError extends Error {
  /**
   * @param message - one-line description of what failed.
   * @param options - structured failure facts.
   * @param options.code - Feishu business code, when the envelope carried one.
   * @param options.httpStatus - HTTP status, when a response was received.
   * @param options.path - the API path that failed, relative to the open-apis base.
   * @param options.hint - remediation hint.
   * @param options.permissionViolations - the `permission_violations` entries Feishu returned.
   * @param options.detail - the raw response body, truncated.
   * @param options.cause - the underlying error, when this wraps a transport failure.
   */
  constructor(message, options = {}) {
    super(message);
    this.name = 'FeishuError';
    this.code = options.code;
    this.httpStatus = options.httpStatus;
    this.path = options.path;
    const base = options.hint !== undefined ? options.hint : hintForCode(options.code);
    this.hint = base;
    this.permissionViolations = options.permissionViolations;
    this.detail = options.detail;
    if (options.cause !== undefined) this.cause = options.cause;
  }

  /**
   * Render the failure as the single text block a tool returns to the model.
   * @returns a multi-line, actionable description.
   */
  toText() {
    const lines = ['Feishu API error: ' + this.message];
    if (this.httpStatus !== undefined) lines.push('http_status: ' + this.httpStatus);
    if (this.code !== undefined) lines.push('code: ' + this.code);
    if (this.path !== undefined) lines.push('path: ' + this.path);
    if (Array.isArray(this.permissionViolations) && this.permissionViolations.length > 0) {
      const subjects = this.permissionViolations.map((entry) => {
        if (entry !== null && typeof entry === 'object') return String(entry.subject !== undefined ? entry.subject : entry.type);
        return String(entry);
      });
      lines.push('missing scopes: ' + subjects.join(', '));
    }
    if (this.hint !== undefined) lines.push('hint: ' + this.hint);
    if (typeof this.detail === 'string' && this.detail.length > 0) lines.push('detail: ' + this.detail.slice(0, 600));
    return lines.join('\n');
  }
}

/**
 * Report whether a value is a Feishu error, including one produced by another
 * copy of this module (the class name is checked as a fallback).
 * @param value - candidate error.
 * @returns whether it should be rendered as a Feishu failure.
 */
export function isFeishuError(value) {
  if (value instanceof FeishuError) return true;
  return value !== null && typeof value === 'object' && value.name === 'FeishuError' && typeof value.toText === 'function';
}

/**
 * Render any thrown value as model-facing text.
 * @param error - the thrown value.
 * @returns the text block content.
 */
export function renderThrown(error) {
  if (isFeishuError(error)) return error.toText();
  if (error instanceof Error) return 'Error: ' + error.message;
  return 'Error: ' + String(error);
}
