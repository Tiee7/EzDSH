import { readFile, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'

const FRONTEND = '@deepseek-ai/dsh-web-frontend'
// Official packages/client/web/src/{platform,seed}.ts define this exact frozen table.
const PLATFORM_KEYS = new Set([
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-dockkit',
])
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/u

/**
 * Resolve only browser platform peers actually seeded by the selected frontend.
 * The official checkDshFamilyVersion workspace constraint and release pipeline
 * version every dsh-family package together. A same-version dependency declaration
 * plus the built boot seed is therefore evidence for the frontend's version.
 * This does not search another source checkout or infer arbitrary peers from it.
 */
export async function resolveRuntimeClientModuleVersion(runtimeRequire: NodeRequire, packageName: string): Promise<string | undefined> {
  if (!packageName.startsWith('@deepseek-ai/dsh-') || !PLATFORM_KEYS.has(packageName)) return undefined
  try {
    const manifestPath = runtimeRequire.resolve(`${FRONTEND}/package.json`)
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
    const version = manifest.version
    if (manifest.name !== FRONTEND || typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/u.test(version)) return undefined
    const dependencies = manifest.devDependencies as Record<string, unknown> | undefined
    const dependency = dependencies?.[packageName]
    if (typeof dependency !== 'string' || ![
      'workspace:^', 'workspace:~', 'workspace:*', version, `^${version}`, `~${version}`,
    ].includes(dependency)) return undefined

    const dist = await realpath(join(dirname(manifestPath), 'dist'))
    const index = await realpath(join(dist, 'index.html'))
    if (!inside(dist, index)) return undefined
    const html = (await readFile(index, 'utf8')).replace(/<!--[\s\S]*?-->/gu, '')
    const scripts = [...html.matchAll(/<script\b([^>]*)>/giu)]
      .map(match => attributes(match[1] ?? ''))
      .filter(attributes => attributes.get('type') === 'module')
    if (scripts.length !== 1) return undefined
    const source = scripts[0]?.get('src')
    if (source === undefined || source.startsWith('/') || /[\\:&]/u.test(source)) return undefined
    const pathname = decodeURIComponent(source.split(/[?#]/u)[0] ?? '')
    if (!pathname.endsWith('.js') || pathname.split('/').includes('..')) return undefined
    const entry = await realpath(join(dist, pathname))
    if (!inside(dist, entry)) return undefined
    return hasBootSeed(await readFile(entry, 'utf8')) ? version : undefined
  } catch {
    // Missing, changed or unfamiliar evidence cannot establish compatibility.
    return undefined
  }
}

function inside(root: string, path: string): boolean {
  const segment = relative(root, path)
  return segment !== '' && segment !== '..' && !segment.startsWith(`..${sep}`) && !isAbsolute(segment)
}

function attributes(text: string): Map<string, string> {
  return new Map([...text.matchAll(/([\w-]+)\s*=\s*(["'])(.*?)\2/gu)]
    .map(match => [(match[1] ?? '').toLowerCase(), match[3] ?? '']))
}

/**
 * Match the authored getStaticModules shape after minification, then require it
 * at the real boot create call. Tokenizing prevents comments, diagnostic strings
 * and regex literals from masquerading as code. Unrecognized shapes stay unknown.
 */
function hasBootSeed(script: string): boolean {
  const tokens = javascriptTokens(script).tokens
  const seedNames = new Set<string>()
  const declaredNames = new Set<string>()
  const duplicateNames = new Set<string>()
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index] !== 'function' || !IDENTIFIER.test(tokens[index + 1] ?? '')) continue
    const name = tokens[index + 1] ?? ''
    if (declaredNames.has(name)) duplicateNames.add(name)
    declaredNames.add(name)
    if (tokens.slice(index + 2, index + 7).join(' ') !== '( ) { return {') continue
    let cursor = index + 7
    const keys = new Set<string>()
    while (cursor < tokens.length) {
      const key = propertyName(tokens[cursor] ?? '')
      if (key === undefined || keys.has(key) || tokens[cursor + 1] !== ':' || !IDENTIFIER.test(tokens[cursor + 2] ?? '')) break
      keys.add(key)
      cursor += 3
      if (tokens[cursor] !== ',') break
      cursor += 1
    }
    if (tokens[cursor] !== '}') continue
    cursor += 1
    if (tokens[cursor] === ';') cursor += 1
    if (tokens[cursor] !== '}' || keys.size !== PLATFORM_KEYS.size || [...keys].some(key => !PLATFORM_KEYS.has(key))) continue
    seedNames.add(name)
  }
  for (let index = 0; index < tokens.length; index += 1) {
    const name = tokens[index] ?? ''
    if (seedNames.has(name) && tokens[index + 1] === '=') duplicateNames.add(name)
  }
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens.slice(index, index + 6).join(' ') !== '. create ( { boot :') continue
    if (!IDENTIFIER.test(tokens[index + 6] ?? '') || tokens[index + 7] !== '.' || tokens[index + 8] !== '__DSH_BOOT__') continue
    if (tokens.slice(index + 9, index + 12).join(' ') !== ', staticModules :') continue
    const seedName = tokens[index + 12] ?? ''
    if (seedNames.has(seedName) && !duplicateNames.has(seedName)
      && tokens[index + 13] === '(' && tokens[index + 14] === ')') return true
  }
  return false
}

function propertyName(token: string): string | undefined {
  if (IDENTIFIER.test(token)) return token
  if ((token.startsWith('"') || token.startsWith("'")) && !token.includes('\\')) return token.slice(1, -1)
  return undefined
}

/** A conservative lexer for the small syntax shape inspected above; no code executes. */
function javascriptTokens(source: string, start = 0, stopAtBrace = false): { tokens: string[]; end: number } {
  const tokens: string[] = []
  let index = start
  let braceDepth = 0
  while (index < source.length) {
    const char = source[index] ?? ''
    if (/\s/u.test(char)) { index += 1; continue }
    if (source.startsWith('//', index)) {
      const end = source.indexOf('\n', index + 2)
      index = end < 0 ? source.length : end + 1
      continue
    }
    if (source.startsWith('/*', index)) {
      const end = source.indexOf('*/', index + 2)
      if (end < 0) return { tokens: [], end: source.length }
      index = end + 2
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      const start = index++
      while (index < source.length && source[index] !== char) {
        if (source[index] === '\\') { index += 2; continue }
        if (char === '`' && source.startsWith('${', index)) {
          index = javascriptTokens(source, index + 2, true).end
        } else index += 1
      }
      if (index >= source.length) return { tokens: [], end: source.length }
      index += 1
      tokens.push(char === '`' ? '<template>' : source.slice(start, index))
      continue
    }
    if (char === '/' && regexMayStartAfter(tokens.at(-1))) {
      index += 1
      let inClass = false
      while (index < source.length) {
        const current = source[index++]
        if (current === '\\') { index += 1; continue }
        if (current === '[') inClass = true
        if (current === ']') inClass = false
        if (current === '/' && !inClass) break
      }
      while (/[a-z]/iu.test(source[index] ?? '')) index += 1
      tokens.push('<regex>')
      continue
    }
    if (/[A-Za-z_$]/u.test(char)) {
      const start = index++
      while (/[\w$]/u.test(source[index] ?? '')) index += 1
      tokens.push(source.slice(start, index))
      continue
    }
    if (char === '}' && stopAtBrace && braceDepth === 0) return { tokens, end: index + 1 }
    if (char === '{') braceDepth += 1
    if (char === '}') braceDepth -= 1
    tokens.push(char)
    index += 1
  }
  return { tokens, end: index }
}

function regexMayStartAfter(token: string | undefined): boolean {
  return token === undefined || ['=', '(', '[', '{', ':', ',', ';', '!', '?', '&', '|', '>', 'return', 'case', 'throw'].includes(token)
}
