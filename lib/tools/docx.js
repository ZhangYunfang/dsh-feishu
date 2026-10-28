/**
 * Feishu Docs (云文档) actions.
 *
 * Three ways to put content into a document, in increasing order of fidelity:
 *
 *  - create an empty document and append raw block JSON (exact control);
 *  - convert Markdown to native blocks and append them (the common case);
 *  - import a local Markdown file as a brand new document (the highest
 *    fidelity, because Feishu does the conversion server-side).
 *
 * @module dsh-feishu/tools/docx
 */

import { defineTool, ok, IDENTITY_PARAMETER, jsonParam, stringParam } from './kit.js';
import { readLocalFile, extensionOf } from '../local-file.js';

/** Maximum number of blocks accepted in one append call. */
const MAX_BLOCKS_PER_APPEND = 200;

/** How long an import task is polled before the tool answers with its ticket. */
const IMPORT_POLL_MS = 25000;

/** Documents that Feishu can produce from a local file. */
const IMPORT_TYPES = { md: 'docx', docx: 'docx', doc: 'docx', txt: 'docx', html: 'docx', xlsx: 'sheet', xls: 'sheet', csv: 'sheet', pptx: 'slides', pdf: 'pdf' };

/**
 * Build the browser URL for a document when the API did not return one.
 * @param config - normalized configuration.
 * @param documentId - the document id.
 * @returns the URL.
 */
function docUrl(config, documentId) {
  const host = config.brand === 'lark' ? 'https://larksuite.com' : 'https://feishu.cn';
  return host + '/docx/' + documentId;
}

/**
 * Convert Markdown into Feishu document blocks.
 * @param client - the Feishu client.
 * @param markdown - the Markdown source.
 * @param identity - the requested identity.
 * @param signal - caller cancellation.
 * @returns the blocks, their first-level ids, and any image URL map.
 */
/** Table property fields the create-descendant API accepts. */
const CREATABLE_TABLE_PROPERTY_KEYS = ['row_size', 'column_size', 'header_row'];

/**
 * Reduce a converted table block to what the create API accepts.
 *
 * The converter answers a rich `table.property` (including `column_width` and
 * `merge_info`) which is fine for a document that already exists but is rejected
 * with 1770001 "invalid param" when the same block is created: the geometry is
 * final there, not advisory. Dropping the whole property instead fails with
 * 99992402, so exactly the creatable keys are kept.
 *
 * @param block - one converted block.
 * @returns the block, with a create-safe table property.
 */
function withCreatableTable(block) {
  if (block === null || typeof block !== 'object' || block.block_type !== 31) return block;
  const table = block.table;
  if (table === null || typeof table !== 'object') return block;
  const property = table.property;
  if (property === null || typeof property !== 'object') return block;
  const safe = {};
  for (const key of CREATABLE_TABLE_PROPERTY_KEYS) {
    if (property[key] !== undefined) safe[key] = property[key];
  }
  return { ...block, table: { ...table, property: safe } };
}

async function convertMarkdown(client, markdown, identity, signal) {
  const data = await client.call({
    method: 'POST',
    path: '/docx/v1/documents/blocks/convert',
    body: { content_type: 'markdown', content: markdown },
    identity,
    signal,
  });
  const raw = data !== null && typeof data === 'object' && Array.isArray(data.blocks) ? data.blocks : [];
  const blocks = raw.map((block) => withCreatableTable(block));
  const children = data !== null && typeof data === 'object' && Array.isArray(data.first_level_block_ids) ? data.first_level_block_ids : blocks.map((block) => block.block_id);
  return { blocks, children, images: data !== null && typeof data === 'object' ? data.block_id_to_image_urls : undefined };
}

/**
 * Build the Docs tool.
 * @param deps - composition facts.
 * @param deps.client - the Feishu client.
 * @returns the tool definition.
 */
export function createDocTool(deps) {
  const client = deps.client;

  return defineTool({
    name: 'feishu_doc',
    timeoutMs: 240000,
    description: [
      'Create and edit Feishu documents (云文档).',
      'Actions: create (a new document, optionally inside a folder), get (metadata), get_raw_content (the whole document as plain text), list_blocks, append_blocks (raw block JSON), append_markdown (convert Markdown and append it), import_file (upload a local Markdown, Word, Excel, PowerPoint or PDF file and let Feishu convert it into a new cloud document), list_import_tasks (inspect a pending import).',
      'Prefer append_markdown for prose and tables: it converts headings, lists, tables, and code blocks into native Feishu blocks. Use import_file when the content already exists as a local file.',
      'The returned url opens the document in the browser.',
    ].join(' '),
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['create', 'get', 'get_raw_content', 'list_blocks', 'append_blocks', 'append_markdown', 'import_file', 'list_import_tasks'],
        description: 'The Docs operation to perform.',
      },
      documentId: stringParam('The document id (doxcn...) for every action except create, import_file and list_import_tasks.'),
      title: stringParam('The document title for create.'),
      folderToken: stringParam('Destination folder token for create or import_file. Defaults to the plugin configured folder.'),
      markdown: stringParam('The Markdown source for append_markdown.'),
      blocks: {
        type: 'array',
        description: 'Raw Feishu block objects for append_blocks, in the shape the docx blocks API expects (for example {block_type: 2, text: {elements: [{text_run: {content: "hi"}}]}}).',
        items: { type: 'object', additionalProperties: true, properties: {} },
      },
      blockId: stringParam('The parent block id for append actions. Defaults to the document root, which appends at the end of the document.'),
      index: { type: 'integer', description: 'Position among the parent children to insert at. Defaults to appending at the end (-1).' },
      filePath: stringParam('Local path of the file to import (import_file). Relative paths resolve against the session workspace.'),
      pollMs: { type: 'integer', description: 'How long import_file waits for Feishu to finish converting before returning the ticket (default 25000).' },
      ticket: stringParam('Import ticket for list_import_tasks.'),
      identity: IDENTITY_PARAMETER,
    },
    async execute(args, exec) {
      const signal = exec !== undefined && exec.signal !== undefined ? exec.signal : undefined;
      const identity = args.identity;
      const action = args.action;

      if (action === 'create') {
        const body = {};
        if (typeof args.title === 'string' && args.title.length > 0) body.title = args.title;
        const folderToken = typeof args.folderToken === 'string' && args.folderToken.length > 0 ? args.folderToken : client.config.defaultFolderToken;
        if (folderToken.length > 0) body.folder_token = folderToken;
        const data = await client.call({ method: 'POST', path: '/docx/v1/documents', body, identity, signal });
        const document = data !== null && typeof data === 'object' && data.document !== undefined ? data.document : data;
        return ok({
          action,
          summary: 'created document "' + (document.title !== undefined ? document.title : '') + '" (' + document.document_id + ')',
          url: document.url !== undefined ? document.url : docUrl(client.config, document.document_id),
          identity,
          data: document,
        });
      }

      if (action === 'get') {
        const data = await client.call({ method: 'GET', path: '/docx/v1/documents/' + args.documentId, identity, signal });
        const document = data !== null && typeof data === 'object' && data.document !== undefined ? data.document : data;
        return ok({ action, summary: 'document ' + args.documentId + ' is at revision ' + document.revision_id, url: docUrl(client.config, args.documentId), identity, data: document });
      }

      if (action === 'get_raw_content') {
        const data = await client.call({ method: 'GET', path: '/docx/v1/documents/' + args.documentId + '/raw_content', identity, signal });
        const content = data !== null && typeof data === 'object' && typeof data.content === 'string' ? data.content : '';
        return ok({
          action,
          summary: 'read ' + content.length + ' characters of plain text',
          url: docUrl(client.config, args.documentId),
          identity,
          data: { content },
        });
      }

      if (action === 'list_blocks') {
        const page = await client.paginate({
          path: '/docx/v1/documents/' + args.documentId + '/blocks',
          itemsPath: 'items',
          pageSize: args.pageSize,
          pageToken: args.pageToken,
          autoPaginate: true,
          identity,
          signal,
        });
        return ok({
          action,
          summary: 'document has ' + page.items.length + ' block(s)',
          url: docUrl(client.config, args.documentId),
          identity,
          data: { blocks: page.items, total: page.total },
        });
      }

      if (action === 'append_blocks' || action === 'append_markdown') {
        const parent = typeof args.blockId === 'string' && args.blockId.length > 0 ? args.blockId : args.documentId;
        const index = args.index !== undefined ? args.index : -1;
        if (action === 'append_blocks') {
          if (!Array.isArray(args.blocks) || args.blocks.length === 0) throw new Error('append_blocks needs a non-empty blocks array');
          if (args.blocks.length > MAX_BLOCKS_PER_APPEND) throw new Error('append_blocks accepts at most ' + MAX_BLOCKS_PER_APPEND + ' blocks per call');
          const data = await client.call({
            method: 'POST',
            path: '/docx/v1/documents/' + args.documentId + '/blocks/' + parent + '/children',
            body: { children: args.blocks, index },
            identity,
            signal,
          });
          return ok({
            action,
            summary: 'appended ' + args.blocks.length + ' block(s)',
            url: docUrl(client.config, args.documentId),
            identity,
            data,
          });
        }
        if (typeof args.markdown !== 'string' || args.markdown.length === 0) throw new Error('append_markdown needs markdown');
        const converted = await convertMarkdown(client, args.markdown, identity, signal);
        if (converted.blocks.length === 0) throw new Error('the Markdown produced no blocks; check that the content is not empty');
        const data = await client.call({
          method: 'POST',
          path: '/docx/v1/documents/' + args.documentId + '/blocks/' + parent + '/descendant',
          body: { children_id: converted.children, index, descendants: converted.blocks },
          identity,
          signal,
        });
        return ok({
          action,
          summary: 'converted and appended ' + converted.blocks.length + ' block(s) of Markdown',
          url: docUrl(client.config, args.documentId),
          identity,
          data: { appended: converted.blocks.length, imageUrls: converted.images, result: data },
        });
      }

      if (action === 'import_file') {
        const file = await readLocalFile(args.filePath, exec);
        const extension = extensionOf(file.name);
        const targetType = IMPORT_TYPES[extension];
        if (targetType === undefined) {
          throw new Error('cannot import a .' + extension + ' file; supported extensions: ' + Object.keys(IMPORT_TYPES).join(', '));
        }
        const folderToken = typeof args.folderToken === 'string' && args.folderToken.length > 0 ? args.folderToken : client.config.defaultFolderToken;
        if (folderToken.length === 0) {
          throw new Error('import_file needs a destination folderToken; the identity root is not writable by import tasks');
        }
        const uploaded = await client.upload({
          path: '/drive/v1/medias/upload_all',
          fields: {
            file_name: file.name,
            parent_type: 'ccm_import_open',
            parent_node: folderToken,
            size: file.size,
            // The import branch of the media upload rejects the request with a
            // bare "forbidden." unless `extra` describes what to import.
            extra: JSON.stringify({ obj_type: targetType, file_extension: extension }),
          },
          file: { name: file.name, bytes: file.bytes, contentType: 'application/octet-stream' },
          identity,
          signal,
        });
        const fileToken = uploaded !== null && typeof uploaded === 'object' ? uploaded.file_token : undefined;
        if (typeof fileToken !== 'string' || fileToken.length === 0) throw new Error('the media upload returned no file_token');
        const task = await client.call({
          method: 'POST',
          path: '/drive/v1/import_tasks',
          body: {
            file_extension: extension,
            file_token: fileToken,
            type: targetType,
            file_name: file.name,
            point: { mount_type: 1, mount_key: folderToken },
          },
          identity,
          signal,
        });
        const ticket = task !== null && typeof task === 'object' ? task.ticket : undefined;
        if (typeof ticket !== 'string' || ticket.length === 0) {
          return ok({ action, summary: 'import task accepted but no ticket was returned', identity, data: task });
        }
        const deadline = Date.now() + (args.pollMs !== undefined && args.pollMs > 0 ? args.pollMs : IMPORT_POLL_MS);
        // The ticket is known here, but the polled payload is service-shaped and
        // may or may not echo it. Without it a caller cannot follow up with
        // list_import_tasks, and without the token it cannot address the document
        // it just imported — so the local ticket is always attached.
        const withTicket = (value) => (value !== null && typeof value === 'object' ? { ticket, ...value } : { ticket });
        for (;;) {
          const status = await client.call({ method: 'GET', path: '/drive/v1/import_tasks/' + ticket, identity, signal });
          const result = status !== null && typeof status === 'object' && status.result !== undefined ? status.result : status;
          const job = result !== null && typeof result === 'object' ? result.job_status : undefined;
          if (job === 0 || job === 2 || job === '0' || job === '2') {
            const payload = withTicket(result);
            return ok({
              action,
              summary: 'imported ' + file.name + ' as a ' + targetType
                + (typeof payload.token === 'string' ? ' (' + payload.token + ')' : ''),
              url: typeof payload.url === 'string' ? payload.url : undefined,
              identity,
              data: payload,
            });
          }
          if (job === -1 || job === '-1') {
            throw new Error('Feishu failed to convert ' + file.name + (result !== null && typeof result === 'object' && result.job_error_msg !== undefined ? ': ' + result.job_error_msg : ''));
          }
          if (Date.now() >= deadline) {
            return ok({
              action,
              summary: 'import of ' + file.name + ' is still converting; ticket ' + ticket,
              identity,
              warnings: ['the import had not finished within the poll window; check it later with action "list_import_tasks" and ticket ' + ticket],
              data: withTicket(result),
            });
          }
          await new Promise((resolve) => setTimeout(resolve, 1500));
        }
      }

      if (action === 'list_import_tasks') {
        if (typeof args.ticket !== 'string' || args.ticket.length === 0) throw new Error('list_import_tasks needs a ticket');
        const data = await client.call({ method: 'GET', path: '/drive/v1/import_tasks/' + args.ticket, identity, signal });
        return ok({ action, summary: 'import ticket ' + args.ticket + ' status read', identity, data });
      }

      throw new Error('unsupported Docs action: ' + String(action));
    },
  });
}
