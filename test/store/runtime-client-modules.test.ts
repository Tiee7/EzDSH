import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveRuntimeClientModuleVersion } from '../../src/main/store/runtime-client-modules'
import { DshPluginInstaller } from '../../src/main/store/dsh-plugin-installer'
import type { InstalledRecord } from '../../src/shared/store'

const roots: string[] = []
const peer = '@deepseek-ai/dsh-client-ui-primitives'
const seed = `function seed(){return{react:R,"react/jsx-runtime":J,"react-dom":D,"react-dom/client":C,"@deepseek-ai/cordis":H,"@deepseek-ai/dsh-client-store":S,"@deepseek-ai/dsh-client-ui-slots":L,"${peer}":P,"@deepseek-ai/dsh-client-ui-dockkit":K}}`
const boot = 'loader.create({boot:win.__DSH_BOOT__,staticModules:seed()})'

async function fixture(version = '0.1.6-alpha.2', dependency = `^${version}`) {
  const root = await mkdtemp(join(tmpdir(), 'ezdsh-client-modules-'))
  roots.push(root)
  const frontend = join(root, 'node_modules', '@deepseek-ai', 'dsh-web-frontend')
  const dist = join(frontend, 'dist')
  await mkdir(join(dist, 'assets'), { recursive: true })
  const manifestPath = join(frontend, 'package.json')
  await writeFile(manifestPath, JSON.stringify({
    name: '@deepseek-ai/dsh-web-frontend', version,
    devDependencies: { [peer]: dependency },
  }))
  await writeFile(join(dist, 'index.html'), '<script type="module" crossorigin src="./assets/index.js"></script>')
  const script = join(dist, 'assets', 'index.js')
  await writeFile(script, `${seed};${boot}`)
  return { root, dist, script, manifestPath, require: createRequire(join(root, 'lib', 'bin.js')) }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('Runtime browser platform module versions', () => {
  it.each(['^0.1.6-alpha.2', 'workspace:^'])('accepts an embedded seed under the official same-version release contract (%s)', async dependency => {
    const setup = await fixture('0.1.6-alpha.2', dependency)
    expect(() => setup.require.resolve(`${peer}/package.json`)).toThrow()
    await expect(resolveRuntimeClientModuleVersion(setup.require, peer)).resolves.toBe('0.1.6-alpha.2')
  })

  it('does not infer an older frontend provides a newer browser peer version', async () => {
    const setup = await fixture('0.1.5-rc.1', 'workspace:^')
    await expect(resolveRuntimeClientModuleVersion(setup.require, peer)).resolves.toBe('0.1.5-rc.1')
  })

  it.each([
    seed,
    `${seed};loader.create({boot:win.__DSH_BOOT__,staticModules:another()})`,
    `${seed.replace(`,"${peer}":P`, '')};${boot}`,
    `const diagnostic = ${JSON.stringify(`${seed};${boot}`)};`,
    `/* ${seed};${boot} */`,
    `const diagnostic = \`${seed};${boot}\`;`,
    'const diagnostic = `x${`' + seed + ';' + boot + '`}`;',
    `${seed};seed=unrelated;${boot}`,
  ])('rejects an unused, incomplete or quoted module table', async source => {
    const setup = await fixture()
    await writeFile(setup.script, source)
    await expect(resolveRuntimeClientModuleVersion(setup.require, peer)).resolves.toBeUndefined()
  })

  it('only inspects the current HTML module entry, not abandoned assets', async () => {
    const setup = await fixture()
    await writeFile(join(setup.dist, 'assets', 'old.js'), await readFile(setup.script))
    await writeFile(setup.script, 'console.log("current shell")')
    await expect(resolveRuntimeClientModuleVersion(setup.require, peer)).resolves.toBeUndefined()
  })

  it.each(['0.1.4', '^0.1.4', '*', 'file:../unrelated'])('rejects a browser dependency outside the same-version contract (%s)', async dependency => {
    const setup = await fixture('0.1.6-alpha.2', dependency)
    await expect(resolveRuntimeClientModuleVersion(setup.require, peer)).resolves.toBeUndefined()
  })

  it('rejects missing frontend metadata and unknown platform modules', async () => {
    const setup = await fixture()
    await expect(resolveRuntimeClientModuleVersion(setup.require, '@deepseek-ai/dsh-client-web')).resolves.toBeUndefined()
    await rm(setup.manifestPath)
    await expect(resolveRuntimeClientModuleVersion(setup.require, peer)).resolves.toBeUndefined()
  })

  it.each(['../outside.js', './assets/linked.js', 'https://example.test/index.js'])('rejects a module entry outside the selected frontend dist (%s)', async src => {
    const setup = await fixture()
    const outside = join(dirname(setup.dist), 'outside.js')
    await writeFile(outside, `${seed};${boot}`)
    await symlink(outside, join(setup.dist, 'assets', 'linked.js'))
    await writeFile(join(setup.dist, 'index.html'), `<script type="module" src="${src}"></script>`)
    await expect(resolveRuntimeClientModuleVersion(setup.require, peer)).resolves.toBeUndefined()
  })

  it.each(['direct', 'bundle'])('keeps a compatible %s plugin enabled when its DSH peer is embedded in the frontend', async kind => {
    const setup = await fixture()
    const profile = join(setup.root, 'profiles', 'web')
    const packageDirectory = join(profile, 'node_modules', 'example-plugin')
    await mkdir(packageDirectory, { recursive: true })
    await writeFile(join(packageDirectory, 'package.json'), JSON.stringify({
      name: 'example-plugin', peerDependencies: { [peer]: '^0.1.6-alpha.2' },
      dsh: kind === 'bundle' ? { bundle: { patch: './cordis.patch.yml' } } : { client: { platform: 'web' } },
    }))
    const manifest = JSON.stringify({ dependencies: { 'example-plugin': '1.0.0' }, dsh: { profile: { bundles: kind === 'bundle' ? ['example-plugin'] : [] } } })
    await writeFile(join(profile, 'package.json'), manifest)
    const patch = kind === 'direct' ? '- insert:\n    - name: example-plugin\n      id: example\n' : '[]\n'
    await writeFile(join(profile, 'cordis.patch.yml'), patch)
    const runtimeEntryPath = join(setup.root, 'lib', 'bin.js')
    const installer = new DshPluginInstaller({ dshHome: setup.root, runtimeEntryPath, runCommand: async () => undefined })
    const record: InstalledRecord = {
      kind: 'skill', id: 'example', name: 'Example', version: '1.0.0', sha256: '0'.repeat(64),
      installedAt: '2026-09-14T00:00:00Z', pluginPackageName: 'example-plugin', pluginProfile: 'web',
    }

    await expect(installer.assertCanEnable(record, undefined)).resolves.toBeUndefined()
    await expect(installer.repairIncompatiblePlugins('web', runtimeEntryPath)).resolves.toEqual([])
    expect(await readFile(join(profile, 'package.json'), 'utf8')).toBe(manifest)
    expect(await readFile(join(profile, 'cordis.patch.yml'), 'utf8')).toBe(patch)

    const pluginManifest = JSON.parse(await readFile(join(packageDirectory, 'package.json'), 'utf8'))
    pluginManifest.peerDependencies[peer] = '^0.1.5-rc.3'
    await writeFile(join(packageDirectory, 'package.json'), JSON.stringify(pluginManifest))
    await expect(installer.assertCanEnable(record, undefined)).rejects.toThrow('selected Runtime provides 0.1.6-alpha.2')
    expect(await readFile(join(profile, 'package.json'), 'utf8')).toBe(manifest)
    await expect(installer.repairIncompatiblePlugins('web', runtimeEntryPath)).resolves.toEqual([
      { packageName: 'example-plugin', reason: expect.stringContaining('selected Runtime provides 0.1.6-alpha.2') },
    ])
    expect((await installer.listInstalledPlugins()).find(plugin => plugin.packageName === 'example-plugin')?.enabled).toBe(false)
  })
})
