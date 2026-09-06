import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'

const CODEX_PACKAGE_NAME = 'dsh-codex'
const ACCOUNT_STATUS_MARKER = '  async function buildAccountStatusFast() {'
const ACCOUNT_STATUS_END_MARKER = '\n  // Account Remote'
const UNDEFINED_HELPER_MARKER = 'function omitUndefinedProperties(value)'
const UNDEFINED_HELPER = `/** Return a JSON-safe object without optional properties whose value is undefined. */
function omitUndefinedProperties(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

`
const MODE_MENU_PLUS_PACKAGE_NAME = 'mode-menu-plus'
const LEGACY_MODE_MENU_PLUS_IMPORT = '@deepseek-ai/dsh-client-runtime/client'
const CURRENT_MODE_MENU_PLUS_IMPORT = '@deepseek-ai/dsh-client-store'

interface JsonRecord {
  [key: string]: unknown
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function readJson(path: string): Promise<JsonRecord | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'))
    return isJsonRecord(value) ? value : undefined
  } catch {
    return undefined
  }
}

async function legacyModeMenuPlusDirectory(directory: string): Promise<boolean> {
  const packageJson = await readJson(join(directory, 'package.json'))
  if (packageJson?.name !== MODE_MENU_PLUS_PACKAGE_NAME) return false
  try {
    const client = await readFile(join(directory, 'src', 'client.js'), 'utf8')
    return client.includes(LEGACY_MODE_MENU_PLUS_IMPORT)
  } catch {
    return false
  }
}

async function modeMenuPlusCandidates(dshHome: string): Promise<string[]> {
  const profilesRoot = join(dshHome, 'profiles')
  const candidates = [join(profilesRoot, 'node_modules', MODE_MENU_PLUS_PACKAGE_NAME)]
  try {
    const entries = await readdir(profilesRoot, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory()) candidates.push(join(profilesRoot, entry.name, 'node_modules', MODE_MENU_PLUS_PACKAGE_NAME))
    }
  } catch {
    // A missing profiles directory simply means there is nothing to migrate.
  }
  return [...new Set(candidates)]
}

/**
 * Migrate the built-in mode-menu-plus artifact produced for the removed rc
 * Runtime package. Only an installed package whose client really contains
 * that legacy import is touched; current or unrelated user packages remain
 * unchanged. The old directory is moved to a recoverable migration backup
 * before the bundled artifact is installed.
 */
export async function repairLegacyModeMenuPlus(dshHome: string, appPath: string): Promise<boolean> {
  const bundledDirectory = join(appPath, 'plugins', MODE_MENU_PLUS_PACKAGE_NAME)
  const bundledPackage = await readJson(join(bundledDirectory, 'package.json'))
  if (bundledPackage?.name !== MODE_MENU_PLUS_PACKAGE_NAME) return false
  try {
    const bundledClient = await readFile(join(bundledDirectory, 'src', 'client.js'), 'utf8')
    if (!bundledClient.includes(CURRENT_MODE_MENU_PLUS_IMPORT) || bundledClient.includes(LEGACY_MODE_MENU_PLUS_IMPORT)) return false
  } catch {
    return false
  }

  let migrated = false
  for (const destination of await modeMenuPlusCandidates(dshHome)) {
    if (!(await legacyModeMenuPlusDirectory(destination))) continue

    const parent = dirname(destination)
    const temporary = join(parent, `.mode-menu-plus-ezdsh-${randomUUID()}`)
    const backupDirectory = join(dirname(dshHome), 'backups', 'plugin-migrations', `mode-menu-plus-${Date.now()}-${randomUUID().slice(0, 8)}`)
    await mkdir(parent, { recursive: true })
    try {
      await cp(bundledDirectory, temporary, { recursive: true })
      await mkdir(dirname(backupDirectory), { recursive: true })
      await rename(destination, backupDirectory)
      await rename(temporary, destination)
    } catch (error) {
      await rm(temporary, { recursive: true, force: true }).catch(() => {})
      // Restore the old package when the replacement could not be completed.
      try {
        await rename(backupDirectory, destination)
      } catch {
        // Preserve the original failure; the migration backup remains available.
      }
      throw error
    }
    migrated = true
  }
  return migrated
}

/**
 * Repair the dsh-codex 0.1.0 account Remote before DSH starts it.
 *
 * That release puts undefined optional fields into a passthrough schema. The
 * Typert gateway rejects those fields as non-JSON values, so the Settings page
 * receives no account status and cannot render its login controls. The repair
 * is deliberately source-shaped and idempotent: a changed upstream package is
 * left untouched and can be handled by its own implementation.
 */
export async function repairInstalledDshPlugin(
  dshHome: string,
  profile: string,
  packageName: string,
): Promise<boolean> {
  if (packageName !== CODEX_PACKAGE_NAME) return false

  const sourcePath = join(dshHome, 'profiles', profile, 'node_modules', packageName, 'lib', 'index.js')
  let source: string
  try {
    source = await readFile(sourcePath, 'utf8')
  } catch {
    return false
  }
  if (source.includes(UNDEFINED_HELPER_MARKER)) return false

  const withHelper = source.replace(
    'await registerSessionEventType();\n\n',
    `await registerSessionEventType();\n\n${UNDEFINED_HELPER}`,
  )
  if (withHelper === source) return false

  const start = withHelper.indexOf(ACCOUNT_STATUS_MARKER)
  const end = withHelper.indexOf(ACCOUNT_STATUS_END_MARKER, start)
  if (start === -1 || end === -1) return false

  const repairedStatus = `  async function buildAccountStatusFast() {
    try {
      const pending = pendingLogin
        ? omitUndefinedProperties({ ...pendingLogin, done: pendingLogin.done })
        : null;
      // 直接读取本地凭据，避免设置页经过 Models 鉴权包装。
      const record = await store.read(PROVIDER).catch(() => undefined);
      const loggedIn = record !== undefined;
      return omitUndefinedProperties({
        loggedIn,
        accountId: record?.accountId,
        expiresIn: record?.expires ? describeExpiry(record.expires) : undefined,
        pending: pending
          ? {
              method: pending.method,
              startedAt: pending.startedAt,
              ...omitUndefinedProperties({
                url: pending.url,
                userCode: pending.userCode,
                verificationUri: pending.verificationUri,
                error: pending.error,
              }),
              done: !!pending.done,
            }
          : null,
        usage: { status: loggedIn ? "loading" : "not_logged_in" },
        version: pkgVersion,
      });
    } catch (e) {
      return omitUndefinedProperties({
        loggedIn: false,
        pending: null,
        usage: { status: "not_logged_in" },
        version: pkgVersion,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }`

  const repaired = `${withHelper.slice(0, start)}${repairedStatus}${withHelper.slice(end)}`
  await writeFile(sourcePath, repaired, 'utf8')
  return true
}
