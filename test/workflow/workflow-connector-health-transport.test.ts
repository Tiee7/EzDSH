import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
const request = vi.hoisted(() => vi.fn())
vi.mock('node:https', () => ({ request }))
import { isPublicConnectorAddress, resolveConnectorAddresses, requestConnectorHealthStatus } from '../../src/main/workflow/workflow-connector-health-transport.js'

describe('connector health pinned transport', () => {
  it('rejects literal hosts that do not match the pinned DNS decision', async () => {
    await expect(requestConnectorHealthStatus({ url: new URL('https://127.0.0.1/'), addresses: [{ address: '8.8.8.8', family: 4 }], headers: {}, signal: new AbortController().signal })).rejects.toThrow('egress-blocked')
  })
  it.each(['127.0.0.1', '10.0.0.1', '100.64.0.1', '169.254.169.254', '192.0.2.1', '198.51.100.1', '203.0.113.1', '240.0.0.1', '::1', 'fe80::1', 'fc00::1', 'ff02::1', '2001:db8::1', '2002:7f00:1::', '::ffff:7f00:1', '::ffff:a00:1', '0:0:0:0:0:ffff:c0a8:1', 'invalid'])('rejects private/reserved %s', (address) => {
    expect(isPublicConnectorAddress(address)).toBe(false)
  })
  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:808:808'])('allows public %s', (address) => {
    expect(isPublicConnectorAddress(address)).toBe(true)
  })
  it('rejects mixed DNS answers and private names', async () => {
    await expect(resolveConnectorAddresses('example.com', async () => [{ address: '8.8.8.8' }, { address: '::ffff:7f00:1' }])).rejects.toThrow('egress-blocked')
    const dns = vi.fn()
    await expect(resolveConnectorAddresses('localhost.', dns)).rejects.toThrow('egress-blocked')
    expect(dns).not.toHaveBeenCalled()
  })
  it('binds connection lookup to the checked address and destroys body without reading headers', async () => {
    const req = Object.assign(new EventEmitter(), { end: vi.fn(), destroy: vi.fn() })
    const destroy = vi.fn()
    request.mockImplementationOnce((_url, options, response) => {
      expect(options.method).toBe('GET')
      expect(options.agent).toBe(false)
      expect(options.servername).toBe('example.com')
      const callback = vi.fn()
      options.lookup('example.com', { all: true }, callback)
      expect(callback).toHaveBeenCalledWith(null, [{ address: '8.8.8.8', family: 4 }])
      queueMicrotask(() => response({ statusCode: 200, destroy, get headers() { throw new Error('must not inspect headers') } }))
      return req
    })
    await expect(requestConnectorHealthStatus({ url: new URL('https://example.com/health'), addresses: [{ address: '8.8.8.8', family: 4 }], headers: {}, signal: new AbortController().signal })).resolves.toBe(200)
    expect(destroy).toHaveBeenCalledOnce()
  })
  it('never follows redirect or dispatches already aborted preparation', async () => {
    const req = Object.assign(new EventEmitter(), { end: vi.fn(), destroy: vi.fn() })
    request.mockImplementationOnce((_url, _options, response) => { queueMicrotask(() => response({ statusCode: 302, destroy: vi.fn() })); return req })
    const args = { url: new URL('https://example.com/health'), addresses: [{ address: '8.8.8.8', family: 4 as const }], headers: {}, signal: new AbortController().signal }
    await expect(requestConnectorHealthStatus(args)).resolves.toBe(302)
    const controller = new AbortController(); controller.abort()
    request.mockClear()
    await expect(requestConnectorHealthStatus({ ...args, signal: controller.signal })).rejects.toThrow()
    expect(request).not.toHaveBeenCalled()
  })
})
