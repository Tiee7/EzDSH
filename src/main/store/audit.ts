/**
 * Static audit engine for store payloads. Pure functions over downloaded
 * bundles and MCP configs: no network, no filesystem, no interpretation of
 * skill semantics. Every rule maps to one stable identifier surfaced verbatim
 * in the install confirmation view; `block` verdicts are final and abort the
 * install pipeline before anything is written to the DSH home.
 *
 * @module audit
 */

import type { DownloadedBundle, DownloadedFile } from './downloader.js'
import type { AuditFinding, AuditReport, AuditVerdict, StoreEntry, StoreMcpConfig } from '../../shared/store.js'

export interface AuditOptions {
  /** Additional preset plugin names declared trusted by the server catalog. */
  extraPresetPlugins?: readonly string[]
}

/** Compose file composition name of a preset entry. */
const PRESET_COMPOSITION_FILE = 'agent.cordis.yml'

const MAX_BLOCK = { block: 3, warn: 2, pass: 1 } as const satisfies Record<AuditVerdict, number>

function worst(verdicts: Iterable<AuditVerdict>): AuditVerdict {
  let worst: AuditVerdict = 'pass'
  for (const verdict of verdicts) {
    if (MAX_BLOCK[verdict] > MAX_BLOCK[worst]) worst = verdict
  }
  return worst
}

// ---- Binary sniffing ----

const EXECUTABLE_MAGICS: ReadonlyArray<readonly number[]> = [
  [0x7f, 0x45, 0x4c, 0x46], // ELF
  [0xfe, 0xed, 0xfa, 0xcf], // Mach-O 64
  [0xfe, 0xed, 0xfa, 0xce], // Mach-O 32
  [0xca, 0xfe, 0xba, 0xbe], // Mach-O fat / Java class
  [0x4d, 0x5a] // PE
]

const IMAGE_MAGICS: ReadonlyArray<readonly number[]> = [
  [0x89, 0x50, 0x4e, 0x47], // PNG
  [0xff, 0xd8, 0xff], // JPEG
  [0x47, 0x49, 0x46, 0x38], // GIF
  [0x42, 0x4d] // BMP
]

function hasMagic(bytes: Buffer, magic: readonly number[]): boolean {
  return magic.every((byte, index) => bytes[index] === byte)
}

function classifyBinary(bytes: Buffer): 'image' | 'executable' | 'unknown' {
  if (IMAGE_MAGICS.some((magic) => hasMagic(bytes, magic))) return 'image'
  if (EXECUTABLE_MAGICS.some((magic) => hasMagic(bytes, magic))) return 'executable'
  return 'unknown'
}

// ---- Text rules ----

interface TextRule {
  readonly rule: string
  readonly pattern: RegExp
  readonly detail: string
}

const BLOCKING_TEXT_RULES: readonly TextRule[] = [
  {
    rule: 'pipe-to-shell',
    pattern: /\b(?:curl|wget)\b[^\n|]{0,400}\|\s*(?:sudo\s+)?(?:ba|z|da|k|a)?sh\b/i,
    detail: 'Downloads piped directly into a shell.'
  },
  {
    rule: 'reverse-shell',
    pattern: /(?:\bnc\b[^\n]{0,80}\s-e\b)|(?:\/dev\/tcp\/)|(?:\bbash\b[^\n]{0,20}-i\s*>&)/i,
    detail: 'Reverse-shell pattern detected.'
  },
  {
    rule: 'destructive-command',
    pattern: /\brm\s+-[^\n]{0,20}r[^\n]{0,20}f[^\n]{0,40}\s\/(?:\s|$)|\bmkfs\b|\bdd\b[^\n]{0,80}\bof=\/dev\//i,
    detail: 'Destructive filesystem command detected.'
  },
  {
    rule: 'sensitive-path',
    pattern: /~\/\.ssh|\/\.ssh\/|id_rsa|id_ed25519|\.aws\/credentials|(?:\A|\s|["'`(])(?:~\/)?\.env\b|\.git-credentials|credentials\.json/i,
    detail: 'References private credentials or key material.'
  }
]

const PROMPT_INJECTION_PATTERN =
  /ignore\s+(?:all\s+|any\s+|previous\s+|prior\s+|above\s+)*(?:previous\s+|prior\s+|above\s+)*instructions|disregard\s+(?:all\s+|any\s+)?(?:previous\s+|prior\s+|above\s+)?instructions|忽略[^\n]{0,8}?(?:指令|指示|规则)/i

const URL_PATTERN = /https?:\/\/[^\s)"'<>]+/g
const BASE64_RUN_PATTERN = /[A-Za-z0-9+/]{1024,}={0,2}/g

/** Shannon entropy in bits per character. */
function shannonEntropy(text: string): number {
  const counts = new Map<string, number>()
  for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1)
  let entropy = 0
  for (const count of counts.values()) {
    const p = count / text.length
    entropy -= p * Math.log2(p)
  }
  return entropy
}

function auditTextFile(file: DownloadedFile, findings: AuditFinding[], urls: Set<string>): void {
  const text = file.bytes.toString('utf8')
  for (const rule of BLOCKING_TEXT_RULES) {
    if (rule.pattern.test(text)) {
      findings.push({ severity: 'block', rule: rule.rule, file: file.path, detail: rule.detail })
    }
  }
  if (PROMPT_INJECTION_PATTERN.test(text)) {
    findings.push({ severity: 'warn', rule: 'prompt-injection', file: file.path, detail: 'Contains instruction-override phrasing that may target the host model.' })
  }
  for (const match of text.matchAll(URL_PATTERN)) {
    urls.add(match[0])
  }
  for (const match of text.matchAll(BASE64_RUN_PATTERN)) {
    if (shannonEntropy(match[0]) > 4.5) {
      findings.push({
        severity: 'block',
        rule: 'high-entropy-blob',
        file: file.path,
        detail: `Large high-entropy base64 block (${String(match[0].length)} chars).`
      })
    }
  }
}

// ---- Preset composition rules ----

const PRESET_PLUGIN_WHITELIST = /^(@deepseek-ai\/dsh-[a-z0-9-]+|cordis:[a-z0-9-]+|\.{1,2}\/[^\s]+)$/

function auditPresetComposition(file: DownloadedFile, findings: AuditFinding[], options: AuditOptions): void {
  const text = file.bytes.toString('utf8')
  if (/!!js\b/.test(text)) {
    findings.push({ severity: 'block', rule: 'preset-js-expression', file: file.path, detail: 'Preset composition declares a !!js expression; local presets must stay declarative.' })
  }
  const extra = new Set(options.extraPresetPlugins ?? [])
  for (const match of text.matchAll(/^\s*-?\s*(?:id:\s*\S+\s*\n\s*)?name:\s*(['"]?)([^'"\n]+)\1/gm)) {
    const pluginName = match[2]?.trim() ?? ''
    if (pluginName === '') continue
    if (extra.has(pluginName)) continue
    if (!PRESET_PLUGIN_WHITELIST.test(pluginName)) {
      findings.push({
        severity: 'block',
        rule: 'preset-plugin-unknown',
        file: file.path,
        detail: `Plugin "${pluginName}" is not in the trusted preset plugin list.`
      })
    }
  }
}

// ---- Public API ----

/**
 * Audit a downloaded skill or preset bundle.
 * @param entry - the catalog entry the bundle belongs to.
 * @param files - the verified download (bundle object or bare file list).
 * @param options - rule configuration (server-declared plugin extras).
 * @returns the aggregated report with per-rule findings and external URLs.
 */
export function auditBundle(
  entry: StoreEntry,
  files: DownloadedBundle | readonly DownloadedFile[],
  options: AuditOptions = {}
): AuditReport {
  const findings: AuditFinding[] = []
  const urls = new Set<string>()
  const isPreset = entry.kind === 'preset'

  const fileList: readonly DownloadedFile[] = 'files' in files ? files.files : files
  for (const file of fileList) {
    if (file.kind === 'binary') {
      const binaryKind = classifyBinary(file.bytes)
      if (binaryKind === 'executable') {
        findings.push({ severity: 'block', rule: 'executable-binary', file: file.path, detail: 'File is an executable binary.' })
      }
      continue
    }
    auditTextFile(file, findings, urls)
    if (file.kind === 'script') {
      findings.push({ severity: 'warn', rule: 'script-present', file: file.path, detail: 'Bundle contains a script file; review it before installing.' })
    }
    if (isPreset && file.path.endsWith(PRESET_COMPOSITION_FILE)) {
      auditPresetComposition(file, findings, options)
    }
  }

  const verdict = worst(findings.map((finding) => (finding.severity === 'block' ? 'block' : 'warn')))
  const externalUrls = [...urls].slice(0, 20)
  return { verdict, findings, externalUrls }
}

const MCP_COMMAND_WHITELIST = new Set(['npx', 'node', 'uvx', 'uv'])

/**
 * Audit one MCP server wiring entry.
 * @param config - the server-declared MCP configuration.
 * @returns the aggregated report.
 */
export function auditMcpConfig(config: StoreMcpConfig): AuditReport {
  const findings: AuditFinding[] = []
  if (config.transport === 'stdio') {
    const command = config.command ?? ''
    if (!MCP_COMMAND_WHITELIST.has(command)) {
      findings.push({
        severity: 'block',
        rule: 'mcp-command-not-allowed',
        detail: `Command "${command}" is not in the allowed MCP launcher list (npx, node, uvx, uv).`
      })
    } else {
      findings.push({
        severity: 'warn',
        rule: 'mcp-stdio-subprocess',
        detail: `Runs a local subprocess via ${command}; it executes code on this machine.`
      })
    }
  } else {
    const url = config.url ?? ''
    if (!/^https:\/\//i.test(url)) {
      findings.push({ severity: 'block', rule: 'mcp-url-not-https', detail: 'Streamable HTTP endpoint must use https.' })
    }
    for (const key of Object.keys(config.headers ?? {})) {
      if (/^authorization$|^auth$|token|secret|key/i.test(key)) {
        findings.push({
          severity: 'warn',
          rule: 'mcp-inline-credential',
          detail: `Header "${key}" carries inline credential material; it will be stored in the local runtime config.`
        })
      }
    }
  }
  const verdict = worst(findings.map((finding) => (finding.severity === 'block' ? 'block' : 'warn')))
  return { verdict, findings, externalUrls: config.transport === 'streamable-http' ? [config.url ?? ''].filter(Boolean) : [] }
}
