import type { EzDSHBridge } from '../shared/contracts.js'

declare global {
  interface Window {
    EzDSH: EzDSHBridge
  }
}

export {}
