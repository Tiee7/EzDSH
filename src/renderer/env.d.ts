import type { EzDSHBridge } from '../shared/contracts.js'

declare module '*.png' {
  const source: string
  export default source
}

declare global {
  interface Window {
    EzDSH: EzDSHBridge
  }
}

export {}
