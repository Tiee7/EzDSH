export const PROXY_PROTOCOLS = ['http', 'https'] as const

export type ProxyProtocol = (typeof PROXY_PROTOCOLS)[number]

/** Proxy profile exposed to the renderer. The password is intentionally never included. */
export interface ProxyProfile {
  id: string
  name: string
  protocol: ProxyProtocol
  host: string
  port: number
  username?: string
  passwordConfigured: boolean
  bypass: string[]
}

/** Proxy profile input accepted over the settings IPC boundary. */
export interface ProxyProfileInput {
  id?: string
  name: string
  protocol: ProxyProtocol
  host: string
  port: number
  username?: string
  password?: string
  bypass: string[]
}

export interface ProxySettingsSnapshot {
  activeProxyId?: string
  enabled: boolean
  profiles: ProxyProfile[]
}

export interface ProxyTestResult {
  reachable: boolean
  statusCode?: number
  error?: string
}
