import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const CODEX_PACKAGE_NAME = 'dsh-codex'
const ACCOUNT_STATUS_MARKER = '  async function buildAccountStatusFast() {'
const ACCOUNT_STATUS_END_MARKER = '\n  // Account Remote'
const UNDEFINED_HELPER_MARKER = 'function omitUndefinedProperties(value)'
const UNDEFINED_HELPER = `/** Return a JSON-safe object without optional properties whose value is undefined. */
function omitUndefinedProperties(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

`

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
