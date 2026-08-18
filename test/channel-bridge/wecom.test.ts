import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { wecomAdapterFactory, WeComAdapter } from '../../plugins/channel-wecom/src/index.js'
import { createDecipheriv, createCipheriv, randomBytes } from 'node:crypto'
import { request as httpRequest } from 'node:http'

function encryptWeComMessage(message: string, corpId: string, aesKey: Buffer): string {
  const msgBuffer = Buffer.from(message, 'utf8')
  const random = randomBytes(16)
  const lengthBuffer = Buffer.alloc(4)
  lengthBuffer.writeUInt32BE(msgBuffer.length, 0)
  const corpIdBuffer = Buffer.from(corpId, 'utf8')
  const combined = Buffer.concat([random, lengthBuffer, msgBuffer, corpIdBuffer])

  const blockSize = 32
  const padLength = blockSize - (combined.length % blockSize)
  const padding = Buffer.alloc(padLength, padLength)
  const padded = Buffer.concat([combined, padding])

  const iv = aesKey.slice(0, 16)
  const cipher = createCipheriv('aes-256-cbc', aesKey, iv)
  cipher.setAutoPadding(false)
  const encrypted = Buffer.concat([cipher.update(padded), cipher.final()])
  return encrypted.toString('base64')
}

function computeSignature(token: string, timestamp: string, nonce: string, encrypted: string): string {
  const sorted = [token, timestamp, nonce, encrypted].sort().join('')
  return require('node:crypto').createHash('sha1').update(sorted).digest('hex')
}

function httpFetch(url: string, options: { method?: string; body?: string; headers?: Record<string, string> } = {}): Promise<{ status: number; text: () => Promise<string> }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      url,
      { method: options.method ?? 'GET', headers: options.headers },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            text: async () => Buffer.concat(chunks).toString('utf8')
          })
        })
      }
    )
    req.on('error', reject)
    if (options.body !== undefined) {
      req.write(options.body)
    }
    req.end()
  })
}

function buildMessageXml(fromUser: string, toUser: string, content: string, msgId: string): string {
  return `<xml>
<ToUserName><![CDATA[${toUser}]]></ToUserName>
<FromUserName><![CDATA[${fromUser}]]></FromUserName>
<CreateTime>${Math.floor(Date.now() / 1000)}</CreateTime>
<MsgType><![CDATA[text]]></MsgType>
<Content><![CDATA[${content}]]></Content>
<MsgId>${msgId}</MsgId>
<AgentID>1000002</AgentID>
</xml>`
}

const TEST_CONFIG = {
  corpId: 'ww_test',
  corpSecret: 'secret',
  agentId: 1000002,
  token: 'test_token',
  encodingAESKey: 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
  callbackPort: 0, // let OS assign port
  baseUrl: 'https://qyapi.weixin.qq.com/cgi-bin'
}

describe('WeComAdapter', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    global.fetch = fetchMock
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('factory validates config', () => {
    expect(() =>
      wecomAdapterFactory.create({
        config: { corpId: 'x' },
        allowList: [],
        logger: { info() {}, error() {}, warn() {} },
      })
    ).toThrow('Invalid WeCom adapter config')
  })

  it('starts and stops callback server', async () => {
    const adapter = new WeComAdapter({
      config: TEST_CONFIG,
      allowList: [],
      logger: { info() {}, error() {}, warn() {} },
    })

    await adapter.start()
    expect(adapter.server.server).toBeDefined()
    await adapter.stop()
  })

  it('verifies callback URL (GET echostr)', async () => {
    const adapter = new WeComAdapter({
      config: TEST_CONFIG,
      allowList: [],
      logger: { info() {}, error() {}, warn() {} },
    })

    await adapter.start()
    const address = adapter.server.server?.address()
    const port = typeof address === 'object' && address !== null ? address.port : TEST_CONFIG.callbackPort

    const echostr = 'hello_wecom'
    const timestamp = String(Date.now())
    const nonce = '123456'
    const signature = computeSignature(TEST_CONFIG.token, timestamp, nonce, echostr)

    const response = await httpFetch(`http://127.0.0.1:${port}/?msg_signature=${signature}&timestamp=${timestamp}&nonce=${nonce}&echostr=${echostr}`)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe(echostr)

    await adapter.stop()
  })

  it('rejects callback with bad signature', async () => {
    const adapter = new WeComAdapter({
      config: TEST_CONFIG,
      allowList: [],
      logger: { info() {}, error() {}, warn() {} },
    })

    await adapter.start()
    const address = adapter.server.server?.address()
    const port = typeof address === 'object' && address !== null ? address.port : TEST_CONFIG.callbackPort

    const response = await httpFetch(`http://127.0.0.1:${port}/?msg_signature=bad&timestamp=1&nonce=1&echostr=x`)
    expect(response.status).toBe(403)

    await adapter.stop()
  })

  it('receives text message callback and sends reply', async () => {
    const adapter = new WeComAdapter({
      config: TEST_CONFIG,
      allowList: ['user_1'],
      logger: { info() {}, error() {}, warn() {} },
    })

    adapter.onMessage(async (message) => {
      expect(message.from.id).toBe('user_1')
      expect(message.content.text).toBe('hello')
      return { to: { userId: 'user_1' }, content: 'got it' }
    })

    await adapter.start()
    const address = adapter.server.server?.address()
    const port = typeof address === 'object' && address !== null ? address.port : TEST_CONFIG.callbackPort

    // Mock token fetch
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ errcode: 0, access_token: 'TOKEN', expires_in: 7200 })
    })
    // Mock send message
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ errcode: 0, errmsg: 'ok' })
    })

    const aesKey = Buffer.from(TEST_CONFIG.encodingAESKey + '=', 'base64')
    const messageXml = buildMessageXml('user_1', 'corp_id', 'hello', '12345')
    const encrypted = encryptWeComMessage(messageXml, TEST_CONFIG.corpId, aesKey)
    const timestamp = String(Date.now())
    const nonce = 'nonce'
    const signature = computeSignature(TEST_CONFIG.token, timestamp, nonce, encrypted)

    const callbackBody = `<xml>
<ToUserName><![CDATA[${TEST_CONFIG.corpId}]]></ToUserName>
<Encrypt><![CDATA[${encrypted}]]></Encrypt>
<AgentID><![CDATA[${TEST_CONFIG.agentId}]]></AgentID>
</xml>`

    const response = await httpFetch(`http://127.0.0.1:${port}/?msg_signature=${signature}&timestamp=${timestamp}&nonce=${nonce}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/xml' },
      body: callbackBody
    })

    expect(response.status).toBe(200)
    const replyXml = await response.text()
    expect(replyXml).toContain('got it')

    await adapter.stop()
  })

  it('rejects users not in allowlist via unauthorized callback', async () => {
    const adapter = new WeComAdapter({
      config: TEST_CONFIG,
      allowList: ['user_1'],
      logger: { info() {}, error() {}, warn() {} },
    })

    await adapter.start()
    const address = adapter.server.server?.address()
    const port = typeof address === 'object' && address !== null ? address.port : TEST_CONFIG.callbackPort

    const aesKey = Buffer.from(TEST_CONFIG.encodingAESKey + '=', 'base64')
    const messageXml = buildMessageXml('user_2', 'corp_id', 'hello', '12346')
    const encrypted = encryptWeComMessage(messageXml, TEST_CONFIG.corpId, aesKey)
    const timestamp = String(Date.now())
    const nonce = 'nonce'
    const signature = computeSignature(TEST_CONFIG.token, timestamp, nonce, encrypted)

    const callbackBody = `<xml>
<ToUserName><![CDATA[${TEST_CONFIG.corpId}]]></ToUserName>
<Encrypt><![CDATA[${encrypted}]]></Encrypt>
<AgentID><![CDATA[${TEST_CONFIG.agentId}]]></AgentID>
</xml>`

    const response = await httpFetch(`http://127.0.0.1:${port}/?msg_signature=${signature}&timestamp=${timestamp}&nonce=${nonce}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/xml' },
      body: callbackBody
    })

    expect(response.status).toBe(200)
    const replyXml = await response.text()
    expect(replyXml).toContain('白名单')

    await adapter.stop()
  })

  it('updateAllowList changes the runtime allowlist', async () => {
    const adapter = new WeComAdapter({
      config: TEST_CONFIG,
      allowList: ['user_1'],
      logger: { info() {}, error() {}, warn() {} },
    })

    const handler = vi.fn(async () => ({ to: { userId: 'user_2' }, content: 'ok' }))
    adapter.onMessage(handler)
    adapter.updateAllowList(['user_1', 'user_2'])

    await adapter.start()
    const address = adapter.server.server?.address()
    const port = typeof address === 'object' && address !== null ? address.port : TEST_CONFIG.callbackPort

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ errcode: 0, access_token: 'TOKEN', expires_in: 7200 })
    })
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ errcode: 0, errmsg: 'ok' })
    })

    const aesKey = Buffer.from(TEST_CONFIG.encodingAESKey + '=', 'base64')
    const messageXml = buildMessageXml('user_2', 'corp_id', 'hello', '12347')
    const encrypted = encryptWeComMessage(messageXml, TEST_CONFIG.corpId, aesKey)
    const timestamp = String(Date.now())
    const nonce = 'nonce'
    const signature = computeSignature(TEST_CONFIG.token, timestamp, nonce, encrypted)

    const callbackBody = `<xml>
<ToUserName><![CDATA[${TEST_CONFIG.corpId}]]></ToUserName>
<Encrypt><![CDATA[${encrypted}]]></Encrypt>
<AgentID><![CDATA[${TEST_CONFIG.agentId}]]></AgentID>
</xml>`

    await httpFetch(`http://127.0.0.1:${port}/?msg_signature=${signature}&timestamp=${timestamp}&nonce=${nonce}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/xml' },
      body: callbackBody
    })

    expect(handler).toHaveBeenCalled()
    await adapter.stop()
  })
})
