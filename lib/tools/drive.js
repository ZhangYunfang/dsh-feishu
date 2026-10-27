/**
 * Feishu Drive (云空间) actions: browse, create folders, upload, download, move,
 * delete, and read metadata for cloud files.
 *
 * Uploads go through the media upload endpoint, which is the one path that
 * works for every identity and both brands. Downloads are written to a local
 * path so a follow-up tool can read them.
 *
 * @module dsh-feishu/tools/drive
 */

import { defineTool, ok, IDENTITY_PARAMETER, stringArrayParam, stringParam } from './kit.js';
import { readLocalFile, resolveLocalPath, contentTypeFor, writeLocalFile } from '../local-file.js';

/** Document types the metadata and delete endpoints accept. */
const DOC_TYPES = ['doc', 'docx', 'sheet', 'bitable', 'mindnote', 'file', 'slides', 'wiki'];

/**
 * Build the Drive tool.
 * @param deps - composition facts.
 * @param deps.client - the Feishu client.
 * @returns the tool definition.
 */
export function createDriveTool(deps) {
  const client = deps.client;

  return defineTool({
    name: 'feishu_drive',
    timeoutMs: 240000,
    description: [
      'Work with Feishu Drive (云空间): the cloud file system that holds documents, sheets, Bitable apps, and uploaded files.',
      'Actions: list_files (browse a folder, or the identity root), create_folder, upload (send a local file into a folder), download (write a cloud file to a local path), move, delete_file, get_meta (titles and URLs for up to 50 tokens).',
      'Folder tokens are optional; without one, browse or create at the identity root. Pass the returned folder token to the doc, sheet, and Bitable tools to place new content there.',
    ].join(' '),
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['list_files', 'create_folder', 'upload', 'download', 'move', 'delete_file', 'get_meta'],
        description: 'The Drive operation to perform.',
      },
      folderToken: stringParam('The folder token to list, create in, upload into, or move into. Defaults to the identity root when listing or creating.'),
      name: stringParam('The new folder name (create_folder).'),
      filePath: stringParam('Local path of the file to upload. Relative paths resolve against the session workspace.'),
      outputPath: stringParam('Local path to write a downloaded file to. Relative paths resolve against the session workspace.'),
      fileToken: stringParam('The token of the cloud file to download, move, or delete.'),
      docType: { type: 'string', enum: DOC_TYPES, description: 'The cloud object type, needed by move and delete_file. Defaults to "file".' },
      docTypes: stringArrayParam('Per-token object types for get_meta, parallel to tokens and overriding docType. Only needed to force a type; a mixed call resolves each token automatically.'),
      destFolderToken: stringParam('Destination folder token for move.'),
      shouldRename: { type: 'boolean', description: 'Allow Feishu to rename on conflict when moving (default false).' },
      tokens: stringArrayParam('Cloud tokens for get_meta, at most 50 per call.'),
      pageSize: { type: 'integer', description: 'Files per page, 1-200.' },
      pageToken: stringParam('Pagination cursor returned by a previous page.'),
      autoPaginate: { type: 'boolean', description: 'Keep fetching pages (default true). Set false to fetch one page and read pageToken.' },
      maxFiles: { type: 'integer', description: 'Stop after this many files.' },
      identity: IDENTITY_PARAMETER,
    },
    async execute(args, exec) {
      const signal = exec !== undefined && exec.signal !== undefined ? exec.signal : undefined;
      const identity = args.identity;
      const action = args.action;
      const docType = typeof args.docType === 'string' && args.docType.length > 0 ? args.docType : 'file';

      if (action === 'list_files') {
        const folderToken = typeof args.folderToken === 'string' && args.folderToken.length > 0 ? args.folderToken : client.config.defaultFolderToken;
        const page = await client.paginate({
          path: '/drive/v1/files',
          query: folderToken.length > 0 ? { folder_token: folderToken } : {},
          itemsPath: 'files',
          pageSize: args.pageSize !== undefined && args.pageSize > 0 ? Math.min(args.pageSize, 200) : 50,
          pageToken: args.pageToken,
          maxItems: args.maxFiles,
          autoPaginate: args.autoPaginate !== false,
          identity,
          signal,
        });
        const files = page.items.map((file) => ({ token: file.token, name: file.name, type: file.type, url: file.url, parent_token: file.parent_token, modified_time: file.modified_time }));
        return ok({
          action,
          summary: 'found ' + files.length + ' item(s) in ' + (folderToken.length > 0 ? 'folder ' + folderToken : 'the drive root'),
          identity,
          data: { folderToken, files, pageToken: page.pageToken, hasMore: page.hasMore },
        });
      }

      if (action === 'create_folder') {
        if (typeof args.name !== 'string' || args.name.trim().length === 0) throw new Error('create_folder needs a name');
        let folderToken = typeof args.folderToken === 'string' && args.folderToken.length > 0 ? args.folderToken : client.config.defaultFolderToken;
        if (folderToken.length === 0) {
          // Feishu requires a parent folder token and answers a bare "field
          // validation failed" without one, so "create at the root" has to
          // resolve the root folder first rather than omit the field.
          const root = await client.call({ method: 'GET', path: '/drive/explorer/v2/root_folder/meta', identity, signal });
          folderToken = root !== null && typeof root === 'object' && typeof root.token === 'string' ? root.token : '';
          if (folderToken.length === 0) throw new Error('could not resolve the drive root folder token; pass folderToken explicitly');
        }
        const body = { name: args.name.trim(), folder_token: folderToken };
        const data = await client.call({ method: 'POST', path: '/drive/v1/files/create_folder', body, identity, signal });
        return ok({
          action,
          summary: 'created folder "' + body.name + '" (' + data.token + ')',
          url: data.url,
          identity,
          data,
        });
      }

      if (action === 'upload') {
        const file = await readLocalFile(args.filePath, exec);
        const folderToken = typeof args.folderToken === 'string' && args.folderToken.length > 0 ? args.folderToken : client.config.defaultFolderToken;
        if (folderToken.length === 0) throw new Error('upload needs a destination folderToken');
        const data = await client.upload({
          path: '/drive/v1/medias/upload_all',
          fields: { file_name: file.name, parent_type: 'explorer', parent_node: folderToken, size: file.size },
          file: { name: file.name, bytes: file.bytes, contentType: contentTypeFor(file.name) },
          identity,
          signal,
        });
        return ok({
          action,
          summary: 'uploaded ' + file.name + ' (' + file.size + ' bytes) as ' + data.file_token,
          identity,
          data: { fileToken: data.file_token, name: file.name, size: file.size, folderToken },
        });
      }

      if (action === 'download') {
        if (typeof args.fileToken !== 'string' || args.fileToken.length === 0) throw new Error('download needs a fileToken');
        const target = resolveLocalPath(args.outputPath !== undefined ? args.outputPath : args.fileToken, exec);
        const result = await client.call({ method: 'GET', path: '/drive/v1/files/' + args.fileToken + '/download', binary: true, identity, signal });
        const written = await writeLocalFile(target, result.bytes);
        return ok({
          action,
          summary: 'downloaded ' + written + ' bytes to ' + target,
          identity,
          data: { path: target, bytes: written, contentType: result.contentType },
        });
      }

      if (action === 'move') {
        if (typeof args.fileToken !== 'string' || args.fileToken.length === 0) throw new Error('move needs a fileToken');
        if (typeof args.destFolderToken !== 'string' || args.destFolderToken.length === 0) throw new Error('move needs a destFolderToken');
        const body = { type: docType, folder_token: args.destFolderToken };
        if (args.shouldRename === true) body.should_rename = true;
        const data = await client.call({ method: 'POST', path: '/drive/v1/files/' + args.fileToken + '/move', body, identity, signal });
        return ok({ action, summary: 'moved ' + args.fileToken + ' into folder ' + args.destFolderToken, identity, data });
      }

      if (action === 'delete_file') {
        if (typeof args.fileToken !== 'string' || args.fileToken.length === 0) throw new Error('delete_file needs a fileToken');
        const data = await client.call({ method: 'DELETE', path: '/drive/v1/files/' + args.fileToken, query: { type: docType }, identity, signal });
        return ok({ action, summary: 'deleted ' + docType + ' ' + args.fileToken, identity, data });
      }

      if (action === 'get_meta') {
        if (!Array.isArray(args.tokens) || args.tokens.length === 0) throw new Error('get_meta needs a non-empty tokens array');
        const tokens = args.tokens.slice(0, 50);
        const declared = Array.isArray(args.docTypes) ? args.docTypes : [];
        /**
         * Ask for one batch of token metadata.
         * @param docs - `{ doc_token, doc_type }` entries.
         * @returns the raw reply.
         */
        const query = (docs) => client.call({
          method: 'POST',
          path: '/drive/v1/metas/batch_query',
          body: { request_docs: docs, with_url: true },
          identity,
          signal,
        });
        /** The declared type for one token, else the call-level default. */
        const typeAt = (index) => {
          const value = declared[index];
          return typeof value === 'string' && DOC_TYPES.includes(value) ? value : docType;
        };
        /**
         * The type the caller pinned for one token, or undefined when the type is
         * unknown and must be discovered. Distinct from {@link typeAt}, which
         * falls back to the call-level default and would suppress discovery.
         */
        const declaredAt = (index) => {
          const value = declared[index];
          return typeof value === 'string' && DOC_TYPES.includes(value) ? value : undefined;
        };
        const first = await query(tokens.map((token, index) => ({ doc_token: token, doc_type: typeAt(index) })));
        const metas = Array.isArray(first !== null && typeof first === 'object' ? first.metas : undefined) ? [...first.metas] : [];
        let failed = Array.isArray(first !== null && typeof first === 'object' ? first.failed_list : undefined) ? [...first.failed_list] : [];
        // The batch query rejects a token whose doc_type does not match it, so a
        // call mixing docs, sheets and Bases resolves each unresolved token by
        // trying the remaining types instead of reporting it as missing.
        if (failed.length > 0) {
          const stillFailed = [];
          for (const entry of failed) {
            const token = entry !== null && typeof entry === 'object' ? entry.token : undefined;
            if (typeof token !== 'string' || token.length === 0) {
              stillFailed.push(entry);
              continue;
            }
            const index = tokens.indexOf(token);
            const forced = index >= 0 ? declaredAt(index) : undefined;
            const candidates = forced !== undefined ? [forced] : DOC_TYPES.filter((type) => type !== docType);
            let resolved = false;
            for (const type of candidates) {
              try {
                const one = await query([{ doc_token: token, doc_type: type }]);
                const got = one !== null && typeof one === 'object' && Array.isArray(one.metas) ? one.metas : [];
                if (got.length > 0) {
                  metas.push(...got);
                  resolved = true;
                  break;
                }
              } catch {
                // This type is wrong for this token (or the token is gone); the
                // next candidate is the only way to learn which one fits.
              }
            }
            if (!resolved) stillFailed.push(entry);
          }
          failed = stillFailed;
        }
        return ok({
          action,
          summary: 'read metadata for ' + metas.length + ' object(s)' + (failed.length > 0 ? ', ' + failed.length + ' unresolved' : ''),
          identity,
          data: { metas, failed: failed.length > 0 ? failed : undefined },
        });
      }

      throw new Error('unsupported Drive action: ' + String(action));
    },
  });
}
