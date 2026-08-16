/**
 * Manifest-driven downloader for store bundles. Downloads each declared file
 * into memory, enforcing the URL policy (https only, allowlisted hosts),
 * per-file size caps, path-traversal protection, and SHA-256 checksum
 * verification against the manifest before anything reaches disk.
 *
 * @module downloader
 */

import { createHash } from 'node:crypto'
import { isAbsolute, normalize, sep, win32 } from 'node:path'
import { STORE_API_BASE_URL, type StoreFile } from '../../shared/store.js'

/** Raised for any download-policy violation: URL, path, size, or checksum. */
export class DownloadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DownloadError'
  }
}

/** One verified downloaded file. */
export interface DownloadedFile {
  /** Manifest-declared path, already validated to stay inside the install root. */
  readonly path: string
  /** Verified file bytes. */
  readonly bytes: Buffer
  /** Declared content kind. */
  readonly kind: StoreFile['kind']
}

/** A fully verified bundle ready for audit and installation. */
export interface DownloadedBundle {
  readonly files: readonly DownloadedFile[]
}

export interface DownloadBundleOptions {
  fetchImpl?: typeof fetch
  /** Hosts allowed for file downloads; defaults to the store API host. */
  allowedHosts?: readonly string[]
  /** Hard per-file size cap. */
  maxFileBytes?: number
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number
  /** Test hook rewriting request URLs before fetch. */
  urlRewrite?: (url: string) => string
}

const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 30_000
const STORE_API_HOST = new URL(STORE_API_BASE_URL).host

const SHA256_PATTERN = /^[0-9a-f]{64}$/

function defaultAllowedHosts(): string[] {
  return [STORE_API_HOST]
}

/**
 * Validate one manifest path: relative, normalized, and free of escape
 * segments after normalization on both posix and windows separators.
 * @param path - the manifest-declared file path.
 * @returns the normalized posix-style relative path.
 * @throws DownloadError when the path could escape the install root.
 */
export function validateBundlePath(path: string): string {
  if (path === '' || path === '.') throw new DownloadError(`Bundle path is empty: ${JSON.stringify(path)}`)
  const unixified = path.replaceAll('\\', '/')
  if (isAbsolute(unixified) || win32.isAbsolute(path)) {
    throw new DownloadError(`Bundle path must be relative: ${JSON.stringify(path)}`)
  }
  const normalized = normalize(unixified)
  if (normalized === '..' || normalized.startsWith(`..${sep}`) || normalized.startsWith('../')) {
    throw new DownloadError(`Bundle path escapes the install root: ${JSON.stringify(path)}`)
  }
  if (normalized.includes('\0')) throw new DownloadError(`Bundle path contains NUL: ${JSON.stringify(path)}`)
  return normalized
}

/**
 * Download and verify every manifest file of a bundle.
 * @param files - the manifest's file list.
 * @param options - fetch/host/size/timeout policy.
 * @returns the verified bundle; rejects with {@link DownloadError} on any violation.
 */
export async function downloadBundle(files: readonly StoreFile[], options: DownloadBundleOptions = {}): Promise<DownloadedBundle> {
  const fetchImpl = options.fetchImpl ?? fetch
  const allowedHosts = new Set((options.allowedHosts ?? defaultAllowedHosts()).map((host) => host.toLowerCase()))
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const downloaded: DownloadedFile[] = []
  for (const file of files) {
    const path = validateBundlePath(file.path)
    if (!SHA256_PATTERN.test(file.sha256)) {
      throw new DownloadError(`Manifest sha256 for ${file.path} is not a lowercase 64-hex digest`)
    }
    let url: URL
    try {
      url = new URL(file.url)
    } catch {
      throw new DownloadError(`File URL is not absolute: ${file.url}`)
    }
    if (url.protocol !== 'https:') {
      throw new DownloadError(`File URL must use https: ${file.url}`)
    }
    if (!allowedHosts.has(url.hostname.toLowerCase())) {
      throw new DownloadError(`File URL host is not in the download allowlist: ${url.hostname}`)
    }
    const requestUrl = options.urlRewrite === undefined ? url.toString() : options.urlRewrite(url.toString())
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let response: Response
    try {
      response = await fetchImpl(requestUrl, { signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
    if (!response.ok) {
      throw new DownloadError(`Download failed: ${String(response.status)} ${file.path}`)
    }
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.byteLength > maxFileBytes) {
      throw new DownloadError(`File exceeds the size cap (${String(bytes.byteLength)} > ${String(maxFileBytes)} bytes): ${file.path}`)
    }
    const digest = createHash('sha256').update(bytes).digest('hex')
    if (digest !== file.sha256) {
      throw new DownloadError(`Checksum mismatch for ${file.path}: expected ${file.sha256}, got ${digest}`)
    }
    downloaded.push({ path, bytes, kind: file.kind })
  }
  return { files: downloaded }
}
