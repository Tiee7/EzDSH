import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { repairInstalledDshPlugin } from '../../src/main/store/dsh-plugin-compatibility'

const workdirs: string[] = []

afterEach(async () => {
  await Promise.all(workdirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const brokenCodexSource = `
await registerSessionEventType();

export const name = "llm-codex";

  async function buildAccountStatusFast() {
    try {
      const pending = pendingLogin ? { ...pendingLogin, done: pendingLogin.done } : null;
      const record = await store.read(PROVIDER).catch(() => undefined);
      const loggedIn = record !== undefined;
      return {
        loggedIn,
        accountId: record?.accountId ?? undefined,
        expiresIn: record?.expires ? describeExpiry(record.expires) : undefined,
        pending: pending
          ? {
              method: pending.method,
              startedAt: pending.startedAt,
              url: pending.url,
              userCode: pending.userCode,
              verificationUri: pending.verificationUri,
              error: pending.error,
              done: !!pending.done,
            }
          : null,
        usage: { status: loggedIn ? "loading" : "not_logged_in" },
        version: pkgVersion,
      };
    } catch (e) {
      return {
        loggedIn: false,
        accountId: undefined,
        expiresIn: undefined,
        pending: null,
        usage: { status: "not_logged_in" },
        version: pkgVersion,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  // Account Remote for the Settings page.
`

async function makePlugin(dshHome: string, source = brokenCodexSource): Promise<string> {
  const file = join(dshHome, 'profiles', 'web', 'node_modules', 'dsh-codex', 'lib', 'index.js')
  await mkdir(join(file, '..'), { recursive: true })
  await writeFile(file, source)
  return file
}

describe('dsh plugin compatibility repairs', () => {
  it('removes undefined Codex account status fields before the Runtime JSON boundary', async () => {
    const dshHome = await mkdtemp(join(tmpdir(), 'ezdsh-codex-'))
    workdirs.push(dshHome)
    const file = await makePlugin(dshHome)

    await expect(repairInstalledDshPlugin(dshHome, 'web', 'dsh-codex')).resolves.toBe(true)

    const repaired = await readFile(file, 'utf8')
    expect(repaired).toContain('function omitUndefinedProperties(value)')
    expect(repaired).toContain('return omitUndefinedProperties({')
    expect(repaired).toContain('...omitUndefinedProperties({')
    expect(repaired).not.toContain('accountId: undefined')
  })

  it('is idempotent and ignores other plugins', async () => {
    const dshHome = await mkdtemp(join(tmpdir(), 'ezdsh-codex-'))
    workdirs.push(dshHome)
    await makePlugin(dshHome)

    await expect(repairInstalledDshPlugin(dshHome, 'web', 'other-plugin')).resolves.toBe(false)
    await expect(repairInstalledDshPlugin(dshHome, 'web', 'dsh-codex')).resolves.toBe(true)
    await expect(repairInstalledDshPlugin(dshHome, 'web', 'dsh-codex')).resolves.toBe(false)
  })
})
