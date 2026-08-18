/**
 * Install paths for store-managed artifacts inside the DSH home. Every
 * installer resolves its target through this module so a vendored DSH layout
 * change is a one-file update.
 *
 * @module install-paths
 */

import { join } from 'node:path'

/** Skill bundles installed for the local user (watched by dsh-skill-filesystem). */
export function skillsDir(dshHome: string): string {
  return join(dshHome, 'skills')
}

/** Channel adapter plugins installed for the local user (loaded by EzDSH main process). */
export function channelAdaptersDir(dshHome: string): string {
  return join(dshHome, 'channel-adapters')
}

/** Locally authored agent presets (discovered by dsh-agent-presets on every roster read). */
export function presetsDir(dshHome: string): string {
  return join(dshHome, '.agent-presets')
}

/** User patch layer of the `web` profile the EzDSH runtime boots (HMR-watched by dsh-app-boot). */
export function webProfilePatchFile(dshHome: string): string {
  return join(dshHome, 'profiles', 'web', 'cordis.patch.yml')
}

/** Parent directory of a file path. */
export function parentDir(path: string): string {
  return join(path, '..')
}
