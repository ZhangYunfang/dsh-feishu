/**
 * Bitable (多维表格) actions.
 *
 * Bitable is the richest surface in the Feishu API and the one most likely to
 * be driven end to end by an agent, so the coverage is complete: create an app
 * (optionally with its tables in one call), inspect tables and fields, and
 * insert, search, update, and delete records in batches.
 *
 * Two conveniences sit above the raw API:
 *
 *  - records are written as ordinary JSON objects keyed by field name, which is
 *    what a model naturally produces, instead of the `{fields: {...}}` wrapper;
 *  - records read back are flattened, because Feishu returns a rich-text field
 *    as an array of text segments and a person field as an array of identities,
 *    neither of which is worth spending context on.
 *
 * @module dsh-feishu/tools/bitable
 */

import { defineTool, ok, IDENTITY_PARAMETER, jsonParam, stringArrayParam, stringParam } from './kit.js';

/** Field type names accepted in a field descriptor, mapped to Feishu type codes. */
export const FIELD_TYPES = {
  text: 1,
  number: 2,
  single_select: 3,
  multi_select: 4,
  date: 5,
  checkbox: 7,
  user: 11,
  phone: 13,
  url: 15,
  attachment: 17,
  single_link: 18,
  lookup: 19,
  formula: 20,
  duplex_link: 21,
  location: 22,
  group_chat: 23,
  created_time: 1001,
  modified_time: 1002,
  created_user: 1003,
  modified_user: 1004,
  auto_number: 1005,
};

/** Feishu batch endpoints cap a single request at this many records. */
const BATCH_LIMIT = 500;

/**
 * Build the property object for one field type from the descriptor shorthand.
 * @param type - the numeric Feishu field type.
 * @param field - the caller's field descriptor.
 * @returns the property object, or undefined when the type needs none.
 */
function fieldProperty(type, field) {
  const property = field.property !== undefined && field.property !== null ? { ...field.property } : {};
  if ((type === 3 || type === 4) && Array.isArray(field.options)) {
    property.options = field.options.map((option) => (typeof option === 'string' ? { name: option } : option));
  }
  if (type === 5 && property.date_formatter === undefined) property.date_formatter = field.dateFormatter !== undefined ? field.dateFormatter : 'yyyy/MM/dd';
  if (type === 2 && property.formatter === undefined) property.formatter = field.formatter !== undefined ? field.formatter : '0';
  if (type === 11 && property.multiple === undefined) property.multiple = false;
  return Object.keys(property).length > 0 ? property : undefined;
}

/**
 * Convert one field descriptor into the API shape.
 * @param field - the descriptor: a name, a type name or code, and optional property shorthand.
 * @returns the API field object.
 */
export function buildField(field) {
  if (field === null || typeof field !== 'object') throw new Error('each field must be an object with at least a name and a type');
  const name = typeof field.name === 'string' ? field.name.trim() : '';
  if (name.length === 0) throw new Error('each field needs a non-empty name');
  const rawType = field.type;
  const type = typeof rawType === 'number' ? rawType : FIELD_TYPES[String(rawType).toLowerCase()];
  if (typeof type !== 'number') {
    throw new Error('unknown field type ' + JSON.stringify(rawType) + '; known types: ' + Object.keys(FIELD_TYPES).join(', '));
  }
  const out = { field_name: name, type };
  if (typeof field.uiType === 'string' && field.uiType.length > 0) out.ui_type = field.uiType;
  const property = fieldProperty(type, field);
  if (property !== undefined) out.property = property;
  return out;
}

/**
 * Turn one caller record into the API record shape.
 *
 * A record may be written flat, keyed by field name, or in the verbose
 * `{record_id, fields}` form. Update and delete actions need the id; insert
 * actions reject it.
 *
 * @param entry - the caller record.
 * @param needsId - whether the action requires a record id.
 * @returns the API record.
 */
export function buildRecord(entry, needsId) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('each record must be an object');
  const hasId = typeof entry.recordId === 'string' || typeof entry.record_id === 'string';
  const id = typeof entry.recordId === 'string' ? entry.recordId : entry.record_id;
  let fields;
  if (entry.fields !== undefined && entry.fields !== null && typeof entry.fields === 'object' && !Array.isArray(entry.fields)) {
    fields = entry.fields;
  } else {
    fields = {};
    for (const key of Object.keys(entry)) {
      if (key === 'recordId' || key === 'record_id') continue;
      fields[key] = entry[key];
    }
  }
  if (needsId) {
    if (!hasId || typeof id !== 'string' || id.length === 0) throw new Error('each updated or deleted record needs a record id');
    return { record_id: id, fields };
  }
  if (hasId) throw new Error('insert records must not carry a record id');
  return { fields };
}

/**
 * Flatten a rich value Feishu returned into something readable.
 * @param value - the raw field value.
 * @returns the flattened value.
 */
function flattenValue(value) {
  if (Array.isArray(value)) {
    const allText = value.length > 0 && value.every((entry) => entry !== null && typeof entry === 'object' && typeof entry.text === 'string');
    if (allText) return value.map((entry) => entry.text).join('');
    const allNamed = value.length > 0 && value.every((entry) => entry !== null && typeof entry === 'object' && typeof entry.name === 'string');
    if (allNamed) return value.map((entry) => entry.name).join(', ');
    return value.map(flattenValue);
  }
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) out[key] = flattenValue(value[key]);
    return out;
  }
  return value;
}

/**
 * Flatten every field of one record read back from Feishu.
 * @param record - the API record.
 * @param readable - whether to flatten rich values.
 * @returns the record with its fields flattened.
 */
export function flattenRecord(record, readable) {
  if (record === null || typeof record !== 'object') return record;
  const fields = record.fields !== null && typeof record.fields === 'object' ? record.fields : {};
  const out = {};
  for (const key of Object.keys(fields)) out[key] = readable === false ? fields[key] : flattenValue(fields[key]);
  const result = { record_id: record.record_id, fields: out };
  if (typeof record.created_time === 'number') result.created_time = record.created_time;
  if (typeof record.last_modified_time === 'number') result.last_modified_time = record.last_modified_time;
  return result;
}

/**
 * Split a list into request-sized chunks.
 * @param items - the items.
 * @param size - the chunk size.
 * @returns the chunks.
 */
function chunk(items, size) {
  const out = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}

/**
 * Build the Bitable tool.
 *
 * @param deps - composition facts.
 * @param deps.client - the Feishu client.
 * @returns the tool definition.
 */
export function createBitableTool(deps) {
  const client = deps.client;

  /**
   * Create the tables that accompany a new app.
   * @param appToken - the new app token.
   * @param tables - the table descriptors.
   * @returns the created tables.
   */
  async function createTables(appToken, tables) {
    const created = [];
    for (const table of tables) {
      const body = { table: { name: table.name } };
      if (typeof table.defaultViewName === 'string') body.table.default_view_name = table.defaultViewName;
      if (Array.isArray(table.fields) && table.fields.length > 0) body.table.fields = table.fields.map(buildField);
      created.push(await client.call({ method: 'POST', path: '/bitable/v1/apps/' + appToken + '/tables', body }));
    }
    return created;
  }

  return defineTool({
    name: 'feishu_bitable',
    timeoutMs: 180000,
    description: [
      'Create and operate on Feishu Bitable (多维表格) databases.',
      'Use it to stand up a structured table in the user cloud drive and fill it with rows: create_app (optionally with tables and fields in the same call), list_tables, create_table, list_fields, create_field, insert_records, search_records, update_records, delete_records, get_record.',
      'Records are plain objects keyed by field name. Field types are named (text, number, single_select, multi_select, date, checkbox, user, phone, url, attachment, ...) and selected options take an options array.',
      'The returned url opens the database in the browser; data.app_token and data.table_id are what later calls need.',
    ].join(' '),
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['create_app', 'list_tables', 'create_table', 'list_fields', 'create_field', 'insert_records', 'search_records', 'update_records', 'delete_records', 'get_record'],
        description: 'The Bitable operation to perform.',
      },
      appToken: stringParam('The Bitable app token (bascn...) from create_app or copied from the database URL. Required for every action except create_app.'),
      name: stringParam('A name: the new database name for create_app, the new table name for create_table, or the new field name for create_field.'),
      folderToken: stringParam('Destination folder token for create_app. Defaults to the plugin configured folder, otherwise the identity own space root.'),
      tableId: stringParam('The table id (tbl...) for table-scoped actions. When omitted, list_fields, insert_records, search_records and the record actions use the first table returned by list_tables.'),
      tables: {
        type: 'array',
        description: 'Tables to create together with a new app (create_app only). Each entry is {name, defaultViewName?, fields?}.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', required: true, description: 'Table name.' },
            defaultViewName: stringParam('Name of the default grid view.'),
            fields: {
              type: 'array',
              description: 'Field descriptors: {name, type, options?, property?}.',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  name: { type: 'string', required: true, description: 'Field name.' },
                  type: { type: 'string', required: true, description: 'Field type: ' + Object.keys(FIELD_TYPES).join(', ') + '.' },
                  options: stringArrayParam('Select options for single_select and multi_select.'),
                  property: jsonParam('Raw Feishu field property, merged over the shorthand.'),
                },
              },
            },
          },
        },
      },
      fields: {
        type: 'array',
        description: 'Field descriptors for create_table or create_field: {name, type, options?, property?}.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', required: true, description: 'Field name.' },
            type: { type: 'string', required: true, description: 'Field type: ' + Object.keys(FIELD_TYPES).join(', ') + '.' },
            options: stringArrayParam('Select options for single_select and multi_select.'),
            property: jsonParam('Raw Feishu field property, merged over the shorthand.'),
          },
        },
      },
      records: {
        type: 'array',
        description: 'Rows for insert_records, update_records and search_records input. Write them flat, keyed by field name; update_records entries also need recordId.',
        items: {
          type: 'object',
          additionalProperties: true,
          properties: {
            recordId: stringParam('The record id (rec...), required when updating.'),
          },
        },
      },
      recordIds: stringArrayParam('Record ids to delete (delete_records).'),
      recordId: stringParam('The record id for get_record.'),
      filter: jsonParam('Feishu search filter object for search_records, e.g. {conjunction: "and", conditions: [{field_name: "状态", operator: "is", value: ["完成"]}]}.'),
      sort: jsonParam('Feishu sort array for search_records, e.g. [{field_name: "日期", desc: true}].'),
      fieldNames: stringArrayParam('Restrict search_records output to these field names.'),
      viewId: stringParam('View id to search within.'),
      pageSize: { type: 'integer', description: 'Rows per page, 1-500.' },
      pageToken: stringParam('Pagination cursor returned by a previous page.'),
      autoPaginate: { type: 'boolean', description: 'For search_records and list_fields, keep fetching pages (default true). Set false to fetch one page and read pageToken.' },
      maxRecords: { type: 'integer', description: 'Stop after this many records or fields, even when autoPaginate would fetch more.' },
      readable: { type: 'boolean', description: 'Flatten rich values (rich text, people, attachments) into readable strings (default true).' },
      identity: IDENTITY_PARAMETER,
    },
    async execute(args, exec) {
      const signal = exec !== undefined && exec.signal !== undefined ? exec.signal : undefined;
      const identity = args.identity;
      const readable = args.readable !== false;
      const maxItems = args.maxRecords;
      const action = args.action;

      /**
       * Resolve the table id, defaulting to the app first table.
       * @returns the table id.
       */
      async function resolveTableId() {
        if (typeof args.tableId === 'string' && args.tableId.length > 0) return args.tableId;
        const page = await client.paginate({
          path: '/bitable/v1/apps/' + args.appToken + '/tables',
          itemsPath: 'items',
          pageSize: 1,
          autoPaginate: false,
          identity,
          signal,
        });
        const first = page.items[0];
        if (first === undefined) throw new Error('this Bitable app has no tables yet; create one with action "create_table"');
        return first.table_id;
      }

      if (action === 'create_app') {
        if (typeof args.name !== 'string' || args.name.trim().length === 0) throw new Error('create_app needs a name');
        const folderToken = typeof args.folderToken === 'string' && args.folderToken.length > 0 ? args.folderToken : client.config.defaultFolderToken;
        const body = { name: args.name.trim() };
        if (folderToken.length > 0) body.folder_token = folderToken;
        const data = await client.call({ method: 'POST', path: '/bitable/v1/apps', body, identity, signal });
        const app = data !== null && typeof data === 'object' && data.app !== undefined ? data.app : data;
        const created = Array.isArray(args.tables) && args.tables.length > 0 ? await createTables(app.app_token, args.tables) : [];
        const warnings = created.length === 0 ? [] : [];
        return ok({
          action,
          summary: 'created Bitable app "' + app.name + '" (' + app.app_token + ')' + (created.length > 0 ? ' with ' + created.length + ' table(s)' : ''),
          url: app.url,
          identity,
          warnings,
          data: { app, tables: created },
        });
      }

      if (action === 'list_tables') {
        const page = await client.paginate({
          path: '/bitable/v1/apps/' + args.appToken + '/tables',
          itemsPath: 'items',
          pageSize: args.pageSize,
          pageToken: args.pageToken,
          maxItems,
          autoPaginate: args.autoPaginate !== false,
          identity,
          signal,
        });
        return ok({
          action,
          summary: 'found ' + page.items.length + ' table(s)',
          identity,
          data: { tables: page.items, total: page.total, pageToken: page.pageToken },
        });
      }

      if (action === 'create_table') {
        if (typeof args.name !== 'string' || args.name.trim().length === 0) throw new Error('create_table needs a name');
        const body = { table: { name: args.name.trim() } };
        if (Array.isArray(args.fields) && args.fields.length > 0) body.table.fields = args.fields.map(buildField);
        const data = await client.call({ method: 'POST', path: '/bitable/v1/apps/' + args.appToken + '/tables', body, identity, signal });
        return ok({
          action,
          summary: 'created table "' + args.name + '" (' + data.table_id + ')',
          identity,
          data,
        });
      }

      if (action === 'list_fields') {
        const tableId = await resolveTableId();
        const page = await client.paginate({
          path: '/bitable/v1/apps/' + args.appToken + '/tables/' + tableId + '/fields',
          itemsPath: 'items',
          pageSize: args.pageSize,
          pageToken: args.pageToken,
          maxItems,
          autoPaginate: args.autoPaginate !== false,
          identity,
          signal,
        });
        const fields = page.items.map((field) => ({ field_id: field.field_id, field_name: field.field_name, type: field.type, ui_type: field.ui_type, property: field.property }));
        return ok({
          action,
          summary: 'table ' + tableId + ' has ' + fields.length + ' field(s)',
          identity,
          data: { tableId, fields, total: page.total, pageToken: page.pageToken },
        });
      }

      if (action === 'create_field') {
        const tableId = await resolveTableId();
        // `fields` is the same descriptor array create_table takes, so a caller may
        // legitimately describe the field there and omit the flat `name`. Demanding
        // both was a trap: the error said "needs a name" while the name was right
        // there inside fields[0].
        const described = Array.isArray(args.fields) && args.fields.length > 0 ? args.fields[0] : undefined;
        const flatName = typeof args.name === 'string' && args.name.trim().length > 0 ? args.name : undefined;
        const name = flatName !== undefined ? flatName : described !== undefined && typeof described.name === 'string' ? described.name : undefined;
        if (typeof name !== 'string' || name.trim().length === 0) throw new Error('create_field needs a name (pass name, or a fields array whose first entry has one)');
        const single = described !== undefined ? { ...described, name } : { name };
        const body = buildField(single);
        const data = await client.call({ method: 'POST', path: '/bitable/v1/apps/' + args.appToken + '/tables/' + tableId + '/fields', body, identity, signal });
        return ok({ action, summary: 'created field "' + body.field_name + '" in table ' + tableId, identity, data });
      }

      if (action === 'insert_records') {
        if (!Array.isArray(args.records) || args.records.length === 0) throw new Error('insert_records needs a non-empty records array');
        const tableId = await resolveTableId();
        const records = args.records.map((entry) => buildRecord(entry, false));
        const created = [];
        for (const batch of chunk(records, BATCH_LIMIT)) {
          const data = await client.call({
            method: 'POST',
            path: '/bitable/v1/apps/' + args.appToken + '/tables/' + tableId + '/records/batch_create',
            body: { records: batch },
            identity,
            signal,
          });
          const list = data !== null && typeof data === 'object' && Array.isArray(data.records) ? data.records : [];
          for (const record of list) created.push(flattenRecord(record, readable));
        }
        return ok({
          action,
          summary: 'inserted ' + created.length + ' record(s) into table ' + tableId,
          identity,
          data: { tableId, recordIds: created.map((record) => record.record_id), records: created },
        });
      }

      if (action === 'search_records') {
        const tableId = await resolveTableId();
        const items = [];
        const maxSearch = maxItems !== undefined && maxItems > 0 ? maxItems : Number.MAX_SAFE_INTEGER;
        const pageSize = args.pageSize !== undefined && args.pageSize > 0 ? Math.min(args.pageSize, 500) : 100;
        let pageToken = args.pageToken;
        let pages = 0;
        let total;
        let hasMore = false;
        const base = {};
        if (args.filter !== undefined) base.filter = args.filter;
        if (Array.isArray(args.sort)) base.sort = args.sort;
        if (Array.isArray(args.fieldNames) && args.fieldNames.length > 0) base.field_names = args.fieldNames;
        if (typeof args.viewId === 'string' && args.viewId.length > 0) base.view_id = args.viewId;
        for (;;) {
          const data = await client.call({
            method: 'POST',
            path: '/bitable/v1/apps/' + args.appToken + '/tables/' + tableId + '/records/search',
            query: { page_size: pageSize, ...(pageToken !== undefined && pageToken.length > 0 ? { page_token: pageToken } : {}) },
            body: base,
            identity,
            signal,
          });
          pages += 1;
          const list = data !== null && typeof data === 'object' && Array.isArray(data.items) ? data.items : [];
          for (const record of list) {
            if (items.length >= maxSearch) break;
            items.push(flattenRecord(record, readable));
          }
          if (typeof data.total === 'number') total = data.total;
          hasMore = data.has_more === true;
          pageToken = typeof data.page_token === 'string' ? data.page_token : undefined;
          if (args.autoPaginate === false) break;
          if (!hasMore || pageToken === undefined || items.length >= maxSearch) break;
        }
        return ok({
          action,
          summary: 'matched ' + items.length + ' record(s) in table ' + tableId + (hasMore ? ' (more pages remain)' : ''),
          identity,
          data: { tableId, records: items, total: total !== undefined ? total : items.length, pages, hasMore, pageToken },
        });
      }

      if (action === 'update_records') {
        if (!Array.isArray(args.records) || args.records.length === 0) throw new Error('update_records needs a non-empty records array');
        const tableId = await resolveTableId();
        const records = args.records.map((entry) => buildRecord(entry, true));
        const updated = [];
        for (const batch of chunk(records, BATCH_LIMIT)) {
          const data = await client.call({
            method: 'POST',
            path: '/bitable/v1/apps/' + args.appToken + '/tables/' + tableId + '/records/batch_update',
            body: { records: batch },
            identity,
            signal,
          });
          const list = data !== null && typeof data === 'object' && Array.isArray(data.records) ? data.records : [];
          for (const record of list) updated.push(flattenRecord(record, readable));
        }
        return ok({
          action,
          summary: 'updated ' + updated.length + ' record(s) in table ' + tableId,
          identity,
          data: { tableId, records: updated },
        });
      }

      if (action === 'delete_records') {
        if (!Array.isArray(args.recordIds) || args.recordIds.length === 0) throw new Error('delete_records needs a non-empty recordIds array');
        const tableId = await resolveTableId();
        const deleted = [];
        for (const batch of chunk(args.recordIds, BATCH_LIMIT)) {
          const data = await client.call({
            method: 'POST',
            path: '/bitable/v1/apps/' + args.appToken + '/tables/' + tableId + '/records/batch_delete',
            body: { records: batch },
            identity,
            signal,
          });
          const list = data !== null && typeof data === 'object' && Array.isArray(data.records) ? data.records : batch;
          for (const entry of list) deleted.push(typeof entry === 'string' ? entry : entry.record_id);
        }
        return ok({
          action,
          summary: 'deleted ' + deleted.length + ' record(s) from table ' + tableId,
          identity,
          data: { tableId, deleted },
        });
      }

      if (action === 'get_record') {
        if (typeof args.recordId !== 'string' || args.recordId.length === 0) throw new Error('get_record needs a recordId');
        const tableId = await resolveTableId();
        const data = await client.call({
          method: 'GET',
          path: '/bitable/v1/apps/' + args.appToken + '/tables/' + tableId + '/records/' + args.recordId,
          identity,
          signal,
        });
        const record = data !== null && typeof data === 'object' && data.record !== undefined ? data.record : data;
        return ok({ action, summary: 'read record ' + args.recordId, identity, data: flattenRecord(record, readable) });
      }

      throw new Error('unsupported Bitable action: ' + String(action));
    },
  });
}
