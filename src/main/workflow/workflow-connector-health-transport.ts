import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { request } from 'node:https'
import type { LookupFunction } from 'node:net'

export interface ConnectorAddress { address: string; family: 4 | 6 }
export type ConnectorResolver = (hostname: string) => Promise<Array<{ address: string }>>

/** Conservative global-unicast allowlist, including hexadecimal IPv4 mappings. */
export function isPublicConnectorAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number) as [number, number, number, number]
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || a === 100 && b >= 64 && b <= 127 || a === 169 && b === 254
      || a === 172 && b >= 16 && b <= 31
      || a === 192 && (b === 168 || b === 0 || b === 88 && c === 99)
      || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)
      || a === 203 && b === 0 && c === 113)
  }
  if (isIP(address) !== 6 || address.includes('%')) return false
  // WHATWG canonicalization converts dotted IPv4 tails to hex groups.
  const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1)
  const [left = '', right = ''] = canonical.split('::')
  const first = left ? left.split(':') : []
  const last = right ? right.split(':') : []
  const words = (canonical.includes('::') ? [...first, ...Array<string>(8 - first.length - last.length).fill('0'), ...last] : first).map((part) => parseInt(part, 16))
  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
    return isPublicConnectorAddress(`${words[6]! >> 8}.${words[6]! & 255}.${words[7]! >> 8}.${words[7]! & 255}`)
  }
  // Deny special-purpose 2001::/23, documentation, 6to4 and non-unicast space.
  return words[0]! >= 0x2000 && words[0]! <= 0x3fff
    && !(words[0] === 0x2001 && (words[1]! < 0x200 || words[1] === 0xdb8))
    && words[0] !== 0x2002 && !(words[0] === 0x3fff && words[1]! < 0x1000)
}

export async function resolveConnectorAddresses(hostname: string, resolver: ConnectorResolver = (host) => lookup(host, { all: true })): Promise<ConnectorAddress[]> {
  const host = hostname.toLowerCase().replace(/^\[|\]$/gu, '').replace(/\.$/u, '')
  if (host === 'localhost' || /\.(localhost|local|internal)$/u.test(host)) throw new Error('egress-blocked')
  let addresses: Array<{ address: string }>
  if (isIP(host)) addresses = [{ address: host }]
  else {
    try { addresses = await resolver(host) } catch { throw new Error('dns-failed') }
  }
  if (!addresses.length) throw new Error('dns-failed')
  if (addresses.some(({ address }) => !isPublicConnectorAddress(address))) throw new Error('egress-blocked')
  return addresses.map(({ address }) => ({ address, family: isIP(address) as 4 | 6 }))
}

export interface ConnectorHealthTransportInput {
  url: URL
  addresses: ConnectorAddress[]
  headers: Record<string, string>
  signal: AbortSignal
}

/** No redirects, pooling, proxy environment, body reads, or response-header reads. */
export async function requestConnectorHealthStatus(input: ConnectorHealthTransportInput): Promise<number> {
  if (input.signal.aborted) throw new Error('timeout')
  const hostname = input.url.hostname.replace(/^\[|\]$/gu, '')
  if (input.url.protocol !== 'https:' || input.url.search || input.url.hash || input.url.username || input.url.password
    || isIP(hostname) && (!isPublicConnectorAddress(hostname) || !input.addresses.some(({ address }) => address === hostname))
    || !input.addresses.length || input.addresses.some(({ address, family }) => !isPublicConnectorAddress(address) || isIP(address) !== family)) throw new Error('egress-blocked')
  // A fresh direct TLS connection keeps hostname verification/SNI on the URL's
  // hostname, while its actual socket resolution cannot consult DNS again.
  const pinned = input.addresses[0]!
  const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
    if ((options as { all?: boolean }).all) (callback as (error: null, result: ConnectorAddress[]) => void)(null, [{ ...pinned }])
    else callback(null, pinned.address, pinned.family)
  }
  return new Promise<number>((resolve, reject) => {
    const req = request(input.url, {
      method: 'GET', headers: input.headers, agent: false, lookup: pinnedLookup,
      servername: isIP(hostname) ? '' : hostname,
      signal: input.signal, maxHeaderSize: 16 * 1024,
    }, (response) => {
      const status = response.statusCode
      response.destroy()
      if (typeof status !== 'number') reject(new Error('request-failed'))
      else resolve(status)
    })
    req.once('error', () => reject(new Error(input.signal.aborted ? 'timeout' : 'request-failed')))
    req.end()
  })
}
