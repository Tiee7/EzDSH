/**
 * Facade over the store subsystem for the IPC layer. Read-only catalog calls
 * delegate to the remote client; install and uninstall run the
 * download → audit → confirm → install pipeline owned by later phases.
 *
 * @module store-service
 */

import type {
  InstalledListResult,
  InstallState,
  StoreCategory,
  StoreEntry,
  StoreKind,
  StoreListResult
} from '../../shared/store.js'
import { StoreClient, type StoreListQuery } from './store-client.js'

export interface StoreServiceOptions {
  client?: StoreClient
  /** Sink for install progress events forwarded to renderer windows. */
  onStateChange?: (state: InstallState) => void
}

/** Store facade owned by the main process. */
export class StoreService {
  private readonly client: StoreClient
  private readonly emit: (state: InstallState) => void

  constructor(options: StoreServiceOptions = {}) {
    this.client = options.client ?? new StoreClient()
    this.emit = options.onStateChange ?? (() => undefined)
  }

  /** List catalog entries of one kind. */
  list(kind: StoreKind, query: StoreListQuery = {}): Promise<StoreListResult> {
    return this.client.list(kind, query)
  }

  /** Fetch one entry detail. */
  entry(kind: StoreKind, id: string): Promise<StoreEntry> {
    return this.client.entry(kind, id)
  }

  /** List categories. */
  categories(): Promise<StoreCategory[]> {
    return this.client.categories()
  }

  /** Install pipeline entry point; delivered by the install-state phase. */
  install(_kind: StoreKind, _id: string): Promise<InstallState> {
    return Promise.reject(new Error('Store install is not available in this build'))
  }

  /** Confirm an audited install; delivered by the install-state phase. */
  confirmInstall(_kind: StoreKind, _id: string, _accepted: boolean): Promise<InstallState> {
    return Promise.reject(new Error('Store install is not available in this build'))
  }

  /** Uninstall an installed entry; delivered by the install-state phase. */
  uninstall(_kind: StoreKind, _id: string): Promise<InstallState> {
    return Promise.reject(new Error('Store uninstall is not available in this build'))
  }

  /** Installed entries; delivered by the install-registry phase. */
  listInstalled(): Promise<InstalledListResult> {
    return Promise.reject(new Error('Installed list is not available in this build'))
  }

  /** Emit an install state event to renderer windows. */
  publish(state: InstallState): void {
    this.emit(state)
  }
}
