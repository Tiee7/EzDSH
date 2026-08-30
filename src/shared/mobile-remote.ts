export type MobileRemoteStatus = 'stopped' | 'starting' | 'ready' | 'error'

export interface MobilePairingSnapshot {
  active: boolean
  url?: string
  qrDataUrl?: string
  expiresAt?: string
}

export interface MobilePendingPairing {
  requestId: string
  createdAt: string
  expiresAt: string
  userAgent?: string
  address?: string
  status: 'pending' | 'approved' | 'rejected'
}

export interface MobileDeviceSnapshot {
  id: string
  label: string
  createdAt: string
  lastSeenAt: string
}

export interface MobileRemoteSnapshot {
  status: MobileRemoteStatus
  port?: number
  lanUrls: string[]
  publicUrl?: string
  publicAccess: boolean
  pairing: MobilePairingSnapshot
  pendingPairings: MobilePendingPairing[]
  devices: MobileDeviceSnapshot[]
  message?: string
}
