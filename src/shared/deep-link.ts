/**
 * Parsing utilities for the EzDSH custom protocol.
 *
 * Supported links:
 *   ezdsh://install/{kind}/{id}          - exact install path
 *   ezdsh://install/plugin/{id}          - kind-agnostic install path
 *   ezdsh://session/{sessionId}          - navigate to an existing DSH session
 *
 * The "plugin" alias is a distribution-friendly shorthand. Because entry ids
 * are currently unique only within a kind, resolving it requires scanning all
 * kinds; ambiguity is treated as an error.
 *
 * @module deep-link
 */

import { isStoreKind, type StoreKind } from './store.js'

export type DeepLinkAction = 'install' | 'session'

export interface DeepLinkInstall {
  action: 'install'
  /** The requested kind, or `undefined` when the shorthand `plugin` path is used. */
  kind: StoreKind | undefined
  id: string
}

/** A deep link whose kind has been resolved against the catalog. */
export interface ResolvedDeepLinkInstall {
  action: 'install'
  kind: StoreKind
  id: string
}

export interface DeepLinkSession {
  action: 'session'
  sessionId: string
}

export type DeepLink = DeepLinkInstall | DeepLinkSession

/** Parse an `ezdsh://` URL into a structured deep link, or `undefined` if the URL is not ours / malformed. */
export function parseDeepLink(url: string): DeepLink | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'ezdsh:') return undefined
  if (parsed.hostname === 'session') {
    if (parsed.search !== '' || parsed.hash !== '') return undefined
    const rawSegments = parsed.pathname.split('/').filter((segment) => segment !== '')
    if (rawSegments.length !== 1) return undefined
    let sessionId: string
    try {
      sessionId = decodeURIComponent(rawSegments[0] ?? '')
    } catch {
      return undefined
    }
    if (sessionId === '' || /[\u0000-\u001f\u007f]/u.test(sessionId)) return undefined
    return { action: 'session', sessionId }
  }
  if (parsed.hostname !== 'install') return undefined

  const segments = parsed.pathname
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment !== '')

  if (segments.length === 2) {
    const [kindOrAlias, id] = segments
    if (kindOrAlias === 'plugin') {
      if (id === '') return undefined
      return { action: 'install', kind: undefined, id }
    }
    if (isStoreKind(kindOrAlias)) {
      if (id === '') return undefined
      return { action: 'install', kind: kindOrAlias, id }
    }
  }

  return undefined
}

/** Extract the deepest `ezdsh://install/...` URL from a list of raw strings (command-line args). */
export function findDeepLinkInArgs(args: readonly string[]): string | undefined {
  for (let i = args.length - 1; i >= 0; i--) {
    const arg = args[i]
    if (arg?.startsWith('ezdsh://') ?? false) {
      return arg
    }
  }
  return undefined
}
