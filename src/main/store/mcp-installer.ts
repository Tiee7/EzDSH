/**
 * MCP installer: edits the `web` profile's user patch layer
 * (`<dshHome>/profiles/web/cordis.patch.yml`) to append, replace, disable, or
 * remove `@deepseek-ai/dsh-mcp-client` rows. Edits are comment-preserving
 * round-trips through the YAML document model; dsh-app-boot re-applies the
 * layer through HMR, so changes take effect without a runtime restart. Rows
 * this module owns carry the stable id `mcp-<serverName>` and are the only
 * rows it will modify or delete.
 *
 * @module mcp-installer
 */

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Document, parseDocument, type YAMLMap, type YAMLSeq } from 'yaml'
import type { StoreMcpConfig } from '../../shared/store.js'

/** Plugin that bridges one MCP server into the runtime. */
const MCP_CLIENT_PLUGIN = '@deepseek-ai/dsh-mcp-client'

/** Stable loader entry id for the row owned by one MCP server. */
export function mcpRowId(serverName: string): string {
  return `mcp-${serverName}`
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * Read the patch document, creating an empty block-style one when absent.
 * @param patchFile - absolute path of the user patch layer.
 * @returns the parsed YAML document.
 */
async function readPatchDocument(patchFile: string): Promise<Document> {
  if (await fileExists(patchFile)) {
    return parseDocument(await readFile(patchFile, 'utf8')) as unknown as Document
  }
  return new Document<YAMLSeq<YAMLMap>>([])
}

async function writePatchDocument(patchFile: string, document: Document): Promise<void> {
  await mkdir(dirname(patchFile), { recursive: true, mode: 0o700 })
  const text = document.toString()
  await writeFile(patchFile, text.endsWith('\n') ? text : `${text}\n`, { mode: 0o600 })
}

/** The top-level patch rows as a YAML sequence, replacing a non-sequence document body. */
function patchRows(document: Document): YAMLSeq<YAMLMap> {
  const contents = document.contents
  if (contents === null || typeof (contents as YAMLSeq).items === 'undefined') {
    document.contents = document.createNode([])
  }
  return document.contents as unknown as YAMLSeq<YAMLMap>
}

/** Plain value of one map key (scalars unwrap to JS values). */
function mapValue(row: YAMLMap, key: string): unknown {
  return row.get(key) as unknown
}

/** Whether an insert row carries the given managed entry id. */
function insertRowOwns(row: YAMLMap, rowId: string): boolean {
  if (!row.has('insert')) return false
  const insert = row.get('insert', true)
  if (insert === null || typeof insert !== 'object' || !('items' in (insert as object))) return false
  for (const child of (insert as unknown as YAMLSeq<YAMLMap>).items) {
    if (child !== undefined && mapValue(child, 'id') === rowId) return true
  }
  return false
}

/** Build the plain patch row carrying one MCP client entry. */
function mcpInsertRow(config: StoreMcpConfig): { insert: Array<Record<string, unknown>> } {
  const entryConfig: Record<string, unknown> = {
    transport: config.transport,
    serverName: config.serverName
  }
  if (config.transport === 'stdio') {
    entryConfig.command = config.command ?? ''
    entryConfig.args = config.args === undefined ? [] : [...config.args]
    if (config.env !== undefined && Object.keys(config.env).length > 0) entryConfig.env = { ...config.env }
    if (config.cwd !== undefined && config.cwd !== '') entryConfig.cwd = config.cwd
  } else {
    entryConfig.url = config.url ?? ''
    if (config.headers !== undefined && Object.keys(config.headers).length > 0) entryConfig.headers = { ...config.headers }
  }
  return {
    insert: [{
      id: mcpRowId(config.serverName),
      name: MCP_CLIENT_PLUGIN,
      config: entryConfig
    }]
  }
}

/** Remove every existing row owned by `rowId`; returns how many were deleted. */
function deleteOwnedRows(rows: YAMLSeq<YAMLMap>, rowId: string): number {
  let deleted = 0
  for (let index = rows.items.length - 1; index >= 0; index -= 1) {
    const row = rows.items[index]
    if (row === undefined || insertRowOwns(row, rowId)) {
      if (row !== undefined) {
        rows.delete(index)
        deleted += 1
      }
    }
  }
  return deleted
}

/**
 * Insert or replace the managed row for one MCP server.
 * @param patchFile - the user patch layer of the web profile.
 * @param config - audited MCP server wiring.
 */
export async function installMcpEntry(patchFile: string, config: StoreMcpConfig): Promise<void> {
  const document = await readPatchDocument(patchFile)
  const rows = patchRows(document)
  deleteOwnedRows(rows, mcpRowId(config.serverName))
  rows.add(document.createNode(mcpInsertRow(config)) as unknown as YAMLMap)
  await writePatchDocument(patchFile, document)
}

/**
 * Remove the managed row for one MCP server.
 * @param patchFile - the user patch layer of the web profile.
 * @param serverName - the MCP server namespace.
 * @returns whether a row was removed.
 */
export async function uninstallMcpEntry(patchFile: string, serverName: string): Promise<boolean> {
  if (!(await fileExists(patchFile))) return false
  const document = await readPatchDocument(patchFile)
  const rows = patchRows(document)
  const deleted = deleteOwnedRows(rows, mcpRowId(serverName))
  if (deleted > 0) await writePatchDocument(patchFile, document)
  return deleted > 0
}

/**
 * Toggle `disabled` on the managed entry for one MCP server.
 * @param patchFile - the user patch layer of the web profile.
 * @param serverName - the MCP server namespace.
 * @param disabled - whether the server should be disabled.
 */
export async function setMcpDisabled(patchFile: string, serverName: string, disabled: boolean): Promise<void> {
  if (!(await fileExists(patchFile))) throw new Error(`Patch file does not exist: ${patchFile}`)
  const document = await readPatchDocument(patchFile)
  const rows = patchRows(document)
  const rowId = mcpRowId(serverName)
  let touched = false
  for (const row of rows.items) {
    if (row === undefined || !row.has('insert')) continue
    const insertSeq = row.get('insert', true)
    if (insertSeq === null || typeof insertSeq !== 'object' || !('items' in (insertSeq as object))) continue
    for (const child of (insertSeq as unknown as YAMLSeq<YAMLMap>).items) {
      if (child === undefined || mapValue(child, 'id') !== rowId) continue
      if (disabled) child.set('disabled', true)
      else child.delete('disabled')
      touched = true
    }
  }
  if (!touched) throw new Error(`No managed MCP row for server ${JSON.stringify(serverName)}`)
  await writePatchDocument(patchFile, document)
}
