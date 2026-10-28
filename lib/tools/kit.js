/**
 * The small amount of machinery every Feishu tool shares: an argument
 * validator for the enforced JSON Schema subset, a definition helper that
 * produces a registry-ready tool, and one uniform result envelope.
 *
 * The plugin deliberately does not import `@deepseek-ai/dsh-tools`. A Cordis
 * profile loads third-party packages from a junction or a copied directory, and
 * in that position a bare `@deepseek-ai/*` specifier resolves to whichever DSH
 * copy happens to be reachable rather than to the running host. Hand-writing the
 * definitions keeps this package loadable anywhere; the test suite checks every
 * schema against the real {@link https://github.com/deepseek-ai/deepseek-harness}
 * validator so the hand-written form cannot drift from what the registry accepts.
 *
 * @module dsh-feishu/tools/kit
 */

import { isFeishuError } from '../errors.js';

/** The largest JSON payload rendered into a tool result before truncation. */
const RENDER_LIMIT = 12000;

/**
 * Validate a value against one node of the enforced schema subset.
 *
 * The subset is: one scalar type, object properties with required and boolean
 * additionalProperties, array items, scalar enum and const, and exact-one
 * oneOf. A node with no constraints accepts any JSON.
 *
 * @param schema - the schema node.
 * @param value - the candidate value.
 * @param path - the path used in violation messages.
 * @param violations - the accumulator.
 * @returns nothing; violations are pushed onto the accumulator.
 */
function check(schema, value, path, violations) {
  if (schema === null || typeof schema !== 'object') return;

  if (Array.isArray(schema.oneOf)) {
    let matched = 0;
    for (const branch of schema.oneOf) {
      const nested = [];
      check(branch, value, path, nested);
      if (nested.length === 0) matched += 1;
    }
    if (matched !== 1) violations.push(path + ' must match exactly one of the declared shapes (matched ' + matched + ')');
    return;
  }

  const type = schema.type;
  if (type === undefined) return;

  switch (type) {
    case 'object': {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        violations.push(path + ' must be an object');
        return;
      }
      const properties = schema.properties !== undefined && schema.properties !== null ? schema.properties : {};
      for (const key of Object.keys(properties)) {
        if (Object.prototype.hasOwnProperty.call(value, key) && value[key] !== undefined) {
          check(properties[key], value[key], path.length > 0 ? path + '.' + key : key, violations);
        }
      }
      if (Array.isArray(schema.required)) {
        for (const key of schema.required) {
          if (!Object.prototype.hasOwnProperty.call(value, key) || value[key] === undefined) {
            violations.push((path.length > 0 ? path + '.' : '') + key + ' is required');
          }
        }
      }
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(value)) {
          if (!Object.prototype.hasOwnProperty.call(properties, key)) {
            violations.push(path + '.' + key + ' is not a recognized parameter');
          }
        }
      }
      return;
    }
    case 'array': {
      if (!Array.isArray(value)) {
        violations.push(path + ' must be an array');
        return;
      }
      if (schema.items !== undefined) {
        for (let index = 0; index < value.length; index += 1) check(schema.items, value[index], path + '[' + index + ']', violations);
      }
      return;
    }
    case 'string':
      if (typeof value !== 'string') violations.push(path + ' must be a string');
      break;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) violations.push(path + ' must be a finite number');
      break;
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) violations.push(path + ' must be an integer');
      break;
    case 'boolean':
      if (typeof value !== 'boolean') violations.push(path + ' must be a boolean');
      break;
    case 'null':
      if (value !== null) violations.push(path + ' must be null');
      break;
    default:
      return;
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => Object.is(entry, value))) {
    violations.push(path + ' must be one of ' + schema.enum.map((entry) => JSON.stringify(entry)).join(', '));
  }
  if (Object.prototype.hasOwnProperty.call(schema, 'const') && !Object.is(schema.const, value)) {
    violations.push(path + ' must equal ' + JSON.stringify(schema.const));
  }
}

/**
 * Rewrite one authoring-shaped schema node into the enforced raw subset.
 *
 * The one translation is the required marker: authoring writes
 * `{ required: true }` on a property, while the raw subset states required-ness
 * once per object as an array of names. Hoisting it here is exactly what the
 * SDK's own definition helper does, which is why the test suite can compare the
 * result against the real validator.
 *
 * @param node - a schema node in authoring shape.
 * @returns the equivalent raw node.
 */
export function normalizeSpec(node) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return node;
  const out = {};
  const required = [];
  for (const key of Object.keys(node)) {
    if (key === 'required') {
      if (node.required === true) continue;
      if (Array.isArray(node.required)) {
        for (const name of node.required) if (!required.includes(name)) required.push(name);
      }
      continue;
    }
    if (key === 'properties') {
      const properties = {};
      for (const name of Object.keys(node.properties)) {
        const child = node.properties[name];
        if (child !== null && typeof child === 'object' && !Array.isArray(child) && child.required === true && !required.includes(name)) {
          required.push(name);
        }
        properties[name] = normalizeSpec(child);
      }
      out.properties = properties;
      continue;
    }
    if (key === 'items') {
      out.items = normalizeSpec(node.items);
      continue;
    }
    if (key === 'oneOf') {
      out.oneOf = Array.isArray(node.oneOf) ? node.oneOf.map((branch) => normalizeSpec(branch)) : node.oneOf;
      continue;
    }
    out[key] = node[key];
  }
  if (required.length > 0) out.required = required;
  return out;
}

/**
 * Compile the authoring parameter map into an object-rooted raw schema.
 *
 * This mirrors the SDK's `parameterSchemaSpecToJsonSchema`: the author writes a
 * map of property name to schema, and the wire form is one object node with that
 * map plus the hoisted required list. The root is closed
 * (`additionalProperties: false`) so a misspelled argument is reported instead
 * of silently ignored.
 *
 * @param spec - the parameter map in authoring shape.
 * @returns the object-rooted raw schema.
 */
export function normalizeParameters(spec) {
  const properties = {};
  const required = [];
  for (const name of Object.keys(spec)) {
    const child = spec[name];
    if (child !== null && typeof child === 'object' && !Array.isArray(child) && child.required === true) required.push(name);
    properties[name] = normalizeSpec(child);
  }
  const schema = { type: 'object', additionalProperties: false, properties };
  if (required.length > 0) schema.required = required;
  return schema;
}

/**
 * Collect every argument violation for a parameter schema.
 * @param parameters - the object-rooted parameter schema, already normalized.
 * @param args - the model-supplied arguments.
 * @returns the violations, empty when the arguments are valid.
 */
export function validateArgs(parameters, args) {
  const violations = [];
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return ['arguments must be an object'];
  }
  check(parameters, args, '', violations);
  return violations;
}

/** The uniform result schema every Feishu tool declares. */
export const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', description: 'Whether the call succeeded.' },
    action: { type: 'string', description: 'The action that ran.' },
    summary: { type: 'string', description: 'One-line, human-readable outcome.' },
    url: { type: 'string', description: 'A Feishu URL for the affected resource, when one exists.' },
    identity: { type: 'string', description: 'The identity that acted: user or app.' },
    warnings: { type: 'array', items: { type: 'string' }, description: 'Non-fatal notes, such as an identity fallback.' },
    data: { description: 'Action-specific payload from the Feishu API.' },
  },
  required: ['ok', 'action', 'summary'],
};

/**
 * Render the uniform result envelope into the single text block a tool returns.
 * @param value - the canonical tool value.
 * @returns the content blocks.
 */
export function renderResult(value) {
  const lines = [value.summary];
  if (typeof value.url === 'string' && value.url.length > 0) lines.push('url: ' + value.url);
  if (typeof value.identity === 'string' && value.identity.length > 0) lines.push('identity: ' + value.identity);
  if (Array.isArray(value.warnings)) {
    for (const warning of value.warnings) lines.push('warning: ' + warning);
  }
  if (value.data !== undefined) {
    let text;
    try {
      text = JSON.stringify(value.data, null, 2);
    } catch {
      text = String(value.data);
    }
    if (typeof text === 'string' && text.length > 0) {
      lines.push('');
      lines.push(text.length > RENDER_LIMIT ? text.slice(0, RENDER_LIMIT) + '\n... [truncated, ' + text.length + ' characters total]' : text);
    }
  }
  return [{ type: 'text', text: lines.join('\n') }];
}

/** The deepest object graph this sanitizer walks before giving up. */
const SANITIZE_DEPTH = 64;

/**
 * Rewrite a result value into strict lossless JSON.
 *
 * The tool registry rejects any value that does not survive a lossless round
 * trip, and `undefined` is the one that bites here: a payload that
 * conditionally includes a field (`{ name: stored.name }` where nothing was
 * stored) produces an enumerable property whose value is `undefined`, which
 * `JSON.stringify` silently drops and the registry refuses. Feishu also returns
 * sparse objects, so this cannot be fixed field by field at every call site.
 *
 * Rules applied, matching the registry's own walk: an object property whose
 * value sanitizes to `undefined` is omitted; an array slot becomes `null`; `-0`
 * becomes `0`; a non-finite number, a cycle, or anything that is not a JSON
 * scalar/object/array is dropped.
 *
 * @param value - the candidate result value.
 * @param seen - the objects on the current path, for cycle detection.
 * @param depth - the remaining depth budget.
 * @returns the lossless equivalent, or `undefined` when the value must be omitted.
 */
export function sanitizeToJson(value, seen = new Set(), depth = SANITIZE_DEPTH) {
  if (value === null) return null;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return value;
  if (type === 'number') {
    if (!Number.isFinite(value)) return undefined;
    return Object.is(value, -0) ? 0 : value;
  }
  if (type !== 'object') return undefined;
  if (depth <= 0 || seen.has(value)) return undefined;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const out = [];
      for (let index = 0; index < value.length; index += 1) {
        const item = sanitizeToJson(value[index], seen, depth - 1);
        out.push(item === undefined ? null : item);
      }
      return out;
    }
    const out = {};
    for (const key of Object.keys(value)) {
      const item = sanitizeToJson(value[key], seen, depth - 1);
      if (item !== undefined) out[key] = item;
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

/**
 * Build one registry-ready tool definition.
 *
 * The returned object matches what the tool registry accepts: a name,
 * description, object-rooted parameter schema, an output pair of schema and
 * render, and an execute body. Arguments are validated here, before the body
 * runs, so a malformed call fails with the offending path rather than a
 * confusing upstream error.
 *
 * @param options - the tool.
 * @param options.name - the model-facing name.
 * @param options.description - the model-facing description.
 * @param options.parameters - the object-rooted parameter schema.
 * @param options.execute - the async body, returning the uniform result value.
 * @param options.timeoutMs - optional cooperative timeout.
 * @returns the definition.
 */
export function defineTool(options) {
  if (typeof options.execute !== 'function') throw new TypeError('tool ' + options.name + ' needs an execute function');
  const parameters = normalizeParameters(options.parameters);
  return {
    name: options.name,
    description: options.description,
    parameters,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    output: {
      schema: RESULT_SCHEMA,
      render: (_args, value) => renderResult(value),
    },
    async execute(args, exec) {
      const violations = validateArgs(parameters, args);
      if (violations.length > 0) throw new Error('invalid arguments for ' + options.name + ': ' + violations.join('; '));
      try {
        const value = await options.execute(args, exec);
        // The registry materializes the result as strict lossless JSON; a sparse
        // payload would otherwise reject the whole call (see sanitizeToJson).
        const clean = sanitizeToJson(value);
        return clean === undefined ? null : clean;
      } catch (error) {
        // A failed tool reaches the model as its message alone, so the structured
        // remediation block (http status, Feishu code, path, hint, detail) would
        // never be read — which is exactly how "the refresh token was revoked"
        // arrived with no mention of re-authorizing. Fold that block into the
        // message while keeping the error object, so listeners still see `code`.
        if (isFeishuError(error) && typeof error.message === 'string' && !error.message.startsWith('Feishu API error:')) {
          error.message = error.toText();
        }
        throw error;
      }
    },
  };
}

/**
 * Assemble a successful result value.
 * @param parameters - the result fields.
 * @returns the uniform result value.
 */
export function ok(parameters) {
  const value = { ok: true, action: parameters.action, summary: parameters.summary };
  if (parameters.url !== undefined && parameters.url !== null && parameters.url.length > 0) value.url = parameters.url;
  if (parameters.identity !== undefined && parameters.identity !== null) value.identity = parameters.identity;
  if (Array.isArray(parameters.warnings) && parameters.warnings.length > 0) value.warnings = parameters.warnings;
  if (parameters.data !== undefined) value.data = parameters.data;
  return value;
}

/** The shared identity selector parameter. */
export const IDENTITY_PARAMETER = {
  type: 'string',
  enum: ['auto', 'user', 'app'],
  description: 'Which identity to call as. "user" acts as the authorized person (documents land in their drive); "app" acts as the app (its own drive space); "auto" uses the user when authorized and otherwise the app, and says so in the result. Defaults to the plugin configuration.',
};

/**
 * Build a plain string parameter.
 * @param description - the model-facing description.
 * @returns the schema node.
 */
export function stringParam(description) {
  return { type: 'string', description };
}

/**
 * Build an optional string parameter.
 * @param description - the model-facing description.
 * @returns the schema node.
 */
export function optionalString(description) {
  return { type: 'string', description };
}

/**
 * Build an array-of-strings parameter.
 * @param description - the model-facing description.
 * @returns the schema node.
 */
export function stringArrayParam(description) {
  return { type: 'array', items: { type: 'string' }, description };
}

/** A JSON-valued parameter: any JSON, validated only by the domain layer. */
export function jsonParam(description) {
  return { description };
}
