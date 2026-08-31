import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { MobileRemoteService } from '../../src/main/mobile/mobile-remote-service.js'
import { mobileModelFailures, mobileModelGroups, renderMobileMarkdown, renderMobilePage } from '../../src/main/mobile/mobile-pages.js'
import type { DshSessionHistoryResponse } from '../../src/main/channel-bridge/dsh-session.js'

describe('MobileRemoteService', () => {
  const services: MobileRemoteService[] = []

  afterEach(async () => {
    await Promise.all(services.splice(0).map((service) => service.stop()))
  })

  it('renders GitHub-style tables with alignment and escaped cell content', () => {
    const rendered = renderMobileMarkdown([
      '| 项目 | 状态 | 备注 |',
      '| :--- | :---: | ---: |',
      '| API | **通过** | `a|b` |',
      '| UI | <script>alert(1)</script> | 可滚动 |',
    ].join('\n'))

    expect(rendered).toContain('<div class="markdown-table-wrap"><table class="markdown-table">')
    expect(rendered).toContain('<th scope="col" style="text-align:left">项目</th>')
    expect(rendered).toContain('<th scope="col" style="text-align:center">状态</th>')
    expect(rendered).toContain('<th scope="col" style="text-align:right">备注</th>')
    expect(rendered).toContain('<strong>通过</strong>')
    expect(rendered).toContain('<code>a|b</code>')
    expect(rendered).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(rendered).not.toContain('<p>| 项目')
  })

  it('renders a mobile page with a valid interactive script', () => {
    const page = renderMobilePage({ locale: 'zh' })
    const script = page.match(/<script>([\s\S]*)<\/script>/u)?.[1]

    expect(script).toContain('new EventSource(')
    expect(() => new Function(script ?? '')).not.toThrow()
  })

  it('keeps the complete provider catalog visible and reports partial catalog failures', () => {
    const directory = {
      groups: [{ id: 'deepseek', name: 'DeepSeek', models: [{ id: 'deepseek-v4-flash' }, { id: 'deepseek-v4-pro' }] }],
      failures: [{ id: 'openai', name: 'OpenAI', message: 'credentials are missing' }],
    }
    expect(mobileModelGroups(directory)[0]?.models?.map(model => model.id)).toEqual(['deepseek-v4-flash', 'deepseek-v4-pro'])
    expect(mobileModelFailures(directory)).toEqual(directory.failures)

    const page = renderMobilePage({ locale: 'zh' })

    expect(page).not.toContain('.filter(item=>!defaultModel||item.id!==defaultModel.model||group.id!==defaultModel.provider)')
    expect(page).toContain('mobileModelFailuresInBrowser')
    expect(page).toContain('modelPartialFailure')
  })

  it('pairs a phone, creates a session cookie, and exposes only the mobile session API', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'ezdsh-mobile-'))
    let sessionRunning = false
    const history: DshSessionHistoryResponse = {
      events: [
        { event: { type: 'user/message', seq: 1, time: 1, data: { message: { content: [{ type: 'text', text: '你好' }] } } } },
        { event: { type: 'assistant/message', seq: 2, time: 2, data: { message: { content: [{ type: 'text', text: '你好，我在这里。' }] } } } },
      ],
      hasMore: false,
    }
    const service = new MobileRemoteService({
      statePath: join(stateDir, 'mobile-remote.json'),
      getRuntimeUrl: () => 'http://127.0.0.1:9999',
      getLanAddresses: () => ['192.168.1.20'],
      createClient: () => ({
        listWorkspaces: async () => [{ workspaceId: 'workspace-1', path: '/work', title: '工作区', sessionIds: ['session-1'], createdAt: '2026-01-01', updatedAt: '2026-01-02' }],
        listSessions: async () => [{ sessionId: 'session-1', title: '第一条会话', updatedAt: 1, running: sessionRunning }],
        createSession: async () => ({ sessionId: 'session-2' }),
        getSessionModels: async () => ({
          current: { provider: 'deepseek', model: 'deepseek-v4-flash' },
          routable: true,
          groups: [{ id: 'deepseek', name: 'DeepSeek', models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }, { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }] }],
          failures: [],
        }),
        selectSessionModel: async (_sessionId, selection) => ({ selected: selection }),
        queuePrompt: async () => { sessionRunning = true; return { accepted: true as const } },
        cancelSession: async () => { sessionRunning = false },
        getSessionHistory: async () => history,
      }),
    })
    services.push(service)
    await service.initialize()
    await service.start()

    const initial = await service.startPairing()
    expect(initial.lanUrls).toEqual(['http://192.168.1.20:' + String(initial.port)])
    expect(initial.pairing.active).toBe(true)
    expect(initial.pairing.qrDataUrl).toMatch(/^data:image\/png;base64,/u)

    const baseUrl = `http://127.0.0.1:${String(initial.port)}`
    const pairUrl = new URL(initial.pairing.url!)
    pairUrl.hostname = '127.0.0.1'
    const pairResponse = await fetch(pairUrl)
    const pairPage = await pairResponse.text()
    expect(pairResponse.status).toBe(200)
    const requestId = JSON.parse(pairPage.match(/const id=(.*?),state/u)?.[1] ?? 'null') as string
    expect(service.snapshot().pendingPairings[0]?.requestId).toBe(requestId)

    service.approvePairing(requestId)
    const statusResponse = await fetch(`${baseUrl}/pair/status?id=${encodeURIComponent(requestId)}`)
    const cookie = statusResponse.headers.get('set-cookie')?.split(';')[0]
    expect(statusResponse.status).toBe(200)
    expect(cookie).toMatch(/^ezdsh_mobile=/u)

    const stateResponse = await fetch(`${baseUrl}/api/mobile/state`, { headers: { Cookie: cookie! } })
    expect(stateResponse.status).toBe(200)
    await expect(stateResponse.json()).resolves.toMatchObject({ runtimeReady: true, sessions: [{ sessionId: 'session-1' }] })

    const mobileResponse = await fetch(`${baseUrl}/mobile`, { headers: { Cookie: cookie! } })
    const mobilePage = await mobileResponse.text()
    expect(mobileResponse.status).toBe(200)
    expect(mobilePage).toContain('id="sessionsView"')
    expect(mobilePage).toContain('new EventSource(')
    expect(mobilePage).toContain('visualViewport')
    expect(mobilePage).toContain('id="modelTrigger"')
    expect(mobilePage).toContain('/models')

    const historyResponse = await fetch(`${baseUrl}/api/mobile/sessions/session-1/history`, { headers: { Cookie: cookie! } })
    await expect(historyResponse.json()).resolves.toMatchObject({
      messages: [
        { role: 'user', text: '你好', seq: 1 },
        { role: 'assistant', text: '你好，我在这里。', seq: 2 },
      ],
      events: history.events,
      running: false,
    })

    const modelsResponse = await fetch(`${baseUrl}/api/mobile/sessions/session-1/models`, { headers: { Cookie: cookie! } })
    await expect(modelsResponse.json()).resolves.toMatchObject({
      current: { provider: 'deepseek', model: 'deepseek-v4-flash' },
      groups: [{ models: [{ id: 'deepseek-v4-flash' }, { id: 'deepseek-v4-pro' }] }],
    })

    const selectModelResponse = await fetch(`${baseUrl}/api/mobile/sessions/session-1/model`, {
      method: 'POST',
      headers: { Cookie: cookie!, 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'deepseek', model: 'deepseek-v4-pro' }),
    })
    await expect(selectModelResponse.json()).resolves.toEqual({ selected: { provider: 'deepseek', model: 'deepseek-v4-pro' } })

    const controller = new AbortController()
    const streamResponse = await fetch(`${baseUrl}/api/mobile/sessions/session-1/stream`, {
      headers: { Cookie: cookie! },
      signal: controller.signal,
    })
    expect(streamResponse.headers.get('content-type')).toContain('text/event-stream')
    const reader = streamResponse.body!.getReader()
    const firstEvent = await reader.read()
    expect(new TextDecoder().decode(firstEvent.value)).toContain('event: snapshot')
    await reader.cancel()
    controller.abort()

    const promptResponse = await fetch(`${baseUrl}/api/mobile/sessions/session-1/prompt`, {
      method: 'POST',
      headers: { Cookie: cookie!, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '继续工作' }),
    })
    await expect(promptResponse.json()).resolves.toEqual({ accepted: true, sessionId: 'session-1' })

    const forbiddenResponse = await fetch(`${baseUrl}/api/mobile/state`, {
      headers: { Cookie: cookie!, Origin: 'https://attacker.invalid' },
    })
    expect(forbiddenResponse.status).toBe(403)
  })

  it('publishes the mobile service through the configured tunnel command', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'ezdsh-mobile-'))
    const child = new class extends EventEmitter {
      readonly stdout = new PassThrough()
      readonly stderr = new PassThrough()
      killed = false
      kill(): boolean {
        this.killed = true
        this.emit('exit', 0, null)
        return true
      }
    }()
    let command = ''
    let args: readonly string[] = []
    const service = new MobileRemoteService({
      statePath: join(stateDir, 'mobile-remote.json'),
      getRuntimeUrl: () => undefined,
      spawnProcess: (nextCommand, nextArgs) => {
        command = nextCommand
        args = nextArgs
        queueMicrotask(() => child.stderr.write('https://random-name.trycloudflare.com'))
        return child as never
      },
    })
    services.push(service)
    await service.start()

    await expect(service.startPublicAccess()).resolves.toMatchObject({
      publicUrl: 'https://random-name.trycloudflare.com',
      publicAccess: true,
    })
    expect(command).toBe('cloudflared')
    expect(args[0]).toBe('tunnel')
    expect(args[1]).toBe('--url')
    await service.stopPublicAccess()
    expect(child.killed).toBe(true)
  })
})
