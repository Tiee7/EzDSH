import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_DOUYIN_WRITER_EMPLOYEE,
  DEFAULT_POSTER_EMPLOYEE,
  DEFAULT_RESEARCH_EMPLOYEE,
  EmployeeService,
  type EmployeeGenerationClient,
  type EmployeeRunClient,
} from '../../src/main/employees/employee-service.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function fakeClient(outputs = ['分析完成', '文案完成', '设计提示词完成']): EmployeeRunClient {
  let index = 0
  return {
    createSession: vi.fn().mockResolvedValue({ sessionId: 'employee-session' }),
    sendPrompt: vi.fn().mockImplementation(async () => ({ text: outputs[index++] ?? '完成' })),
  }
}

async function createService(client = fakeClient(), options: { lightweightClient?: EmployeeGenerationClient; getLocale?: () => 'zh' | 'en' } = {}): Promise<{ service: EmployeeService; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'ezdsh-employees-'))
  roots.push(root)
  return {
    root,
    service: new EmployeeService({
      configPath: join(root, 'employees.json'),
      cwd: root,
      createClient: () => client,
      ...options,
    }),
  }
}

describe('EmployeeService', () => {
  it('migrates legacy workflow steps into non-executable profile guidelines', async () => {
    const { service, root } = await createService()
    await writeFile(join(root, 'employees.json'), JSON.stringify([{
      id: 'legacy-writer',
      name: '旧版文案员',
      role: '文案',
      description: '处理短视频文案',
      systemPrompt: '保持真实。',
      capabilities: ['copywriting'],
      workflow: [
        { id: 'draft', name: '写初稿', instruction: '先写初稿。', enabled: true },
        { id: 'check', name: '检查', instruction: '检查事实。', enabled: true },
      ],
      enabled: true,
      builtIn: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }]))

    await service.initialize()

    expect(service.get('legacy-writer')).toMatchObject({
      schemaVersion: 2,
      version: 1,
      businessBoundary: '处理短视频文案',
      operatingGuidelines: ['写初稿：先写初稿。', '检查：检查事实。'],
      qualityStandards: [],
      skillIds: [],
    })
    expect(service.get('legacy-writer')).not.toHaveProperty('workflow')
  })

  it('increments the employee version when its professional profile changes', async () => {
    const { service } = await createService()
    await service.initialize()
    const before = service.get(DEFAULT_RESEARCH_EMPLOYEE.id)
    expect(before).toBeDefined()

    const after = await service.update(DEFAULT_RESEARCH_EMPLOYEE.id, {
      businessBoundary: '只处理可验证的研究任务。',
    })

    expect(after.version).toBe((before?.version ?? 0) + 1)
    expect(after.businessBoundary).toBe('只处理可验证的研究任务。')
  })

  it('seeds the built-in employees on first initialization', async () => {
    const { service, root } = await createService()

    await service.initialize()

    expect(service.list().map((employee) => employee.id)).toEqual(expect.arrayContaining([
      DEFAULT_POSTER_EMPLOYEE.id,
      DEFAULT_RESEARCH_EMPLOYEE.id,
      DEFAULT_DOUYIN_WRITER_EMPLOYEE.id,
      'content-topic-planner',
      'content-reviewer',
    ]))
    expect(service.list()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: DEFAULT_POSTER_EMPLOYEE.id,
        name: '宣传海报生成员',
        builtIn: true,
        enabled: true,
        capabilities: expect.arrayContaining(['copywriting', 'image-generation']),
      }),
      expect.objectContaining({
        id: DEFAULT_RESEARCH_EMPLOYEE.id,
        name: '调研员',
        builtIn: true,
        capabilities: expect.arrayContaining(['research', 'file-read', 'workflow']),
      }),
      expect.objectContaining({
        id: DEFAULT_DOUYIN_WRITER_EMPLOYEE.id,
        name: '抖音文案写手',
        builtIn: true,
        capabilities: expect.arrayContaining(['copywriting', 'research', 'workflow']),
      }),
    ]))
    expect(service.list().every((employee) => !('workflow' in employee))).toBe(true)
    await expect(readFile(join(root, 'employees.json'), 'utf8')).resolves.toContain('researcher')
  })

  it('ships source-informed professional profiles for research and Douyin copywriting', async () => {
    const { service } = await createService()
    await service.initialize()

    const researcher = service.list().find((employee) => employee.id === DEFAULT_RESEARCH_EMPLOYEE.id)
    expect(researcher?.operatingGuidelines).toEqual(expect.arrayContaining([
      expect.stringMatching(/界定研究问题/),
      expect.stringMatching(/规划检索路径/),
      expect.stringMatching(/交叉核验证据/),
      expect.stringMatching(/撰写调研报告/),
    ]))
    expect(researcher?.systemPrompt).toMatch(/来源|证据/)
    expect(researcher?.systemPrompt).toMatch(/无法支持|不确定|未知/)
    expect(researcher?.systemPrompt).toMatch(/不要|绝不|避免.*重复/)

    const copywriter = service.list().find((employee) => employee.id === DEFAULT_DOUYIN_WRITER_EMPLOYEE.id)
    expect(copywriter?.operatingGuidelines).toEqual(expect.arrayContaining([
      expect.stringMatching(/提炼选题角度/),
      expect.stringMatching(/生成多组钩子/),
      expect.stringMatching(/完成口播脚本/),
      expect.stringMatching(/留存与合规质检/),
    ]))
    expect(copywriter?.systemPrompt).toMatch(/前 ?1[–-]3 ?秒|前1-3秒/)
    expect(copywriter?.systemPrompt).toMatch(/钩子.*递进|递进.*钩子/)
    expect(copywriter?.systemPrompt).toMatch(/行动号召|CTA/)
    expect(copywriter?.systemPrompt).toMatch(/画面.*字幕|字幕.*画面/)
  })

  it('adds new built-in employees to an existing employee configuration without replacing it', async () => {
    const { service, root } = await createService()
    await writeFile(join(root, 'employees.json'), JSON.stringify([{
      ...DEFAULT_POSTER_EMPLOYEE,
      name: '自定义海报员',
      enabled: false,
    }]))

    await service.initialize()

    expect(service.list().map((employee) => employee.id)).toEqual(expect.arrayContaining([
      DEFAULT_POSTER_EMPLOYEE.id,
      DEFAULT_RESEARCH_EMPLOYEE.id,
      DEFAULT_DOUYIN_WRITER_EMPLOYEE.id,
    ]))
    expect(service.list().find((employee) => employee.id === DEFAULT_POSTER_EMPLOYEE.id)).toMatchObject({
      name: '自定义海报员',
      enabled: false,
    })
    await expect(readFile(join(root, 'employees.json'), 'utf8')).resolves.toContain('douyin-copywriter')
  })

  it('does not restore a built-in employee deleted after the one-time migration', async () => {
    const { service, root } = await createService()
    await service.initialize()
    await service.remove(DEFAULT_RESEARCH_EMPLOYEE.id)

    const reloaded = new EmployeeService({
      configPath: join(root, 'employees.json'),
      cwd: root,
      createClient: () => fakeClient(),
    })
    await reloaded.initialize()

    expect(reloaded.list().some((employee) => employee.id === DEFAULT_RESEARCH_EMPLOYEE.id)).toBe(false)
  })

  it('lists projects and sessions and creates a session inside the selected project', async () => {
    const client = {
      ...fakeClient(),
      listWorkspaces: vi.fn().mockResolvedValue([{
        workspaceId: 'project-1',
        path: '/work/content',
        title: '内容项目',
        sessionIds: ['session-1'],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
      }]),
      listSessions: vi.fn().mockResolvedValue([
        { sessionId: 'session-1', updatedAt: 2, running: false, title: '已有会话' },
        { sessionId: 'session-2', updatedAt: 1, running: false, title: '其他会话' },
      ]),
      createSession: vi.fn().mockResolvedValue({ sessionId: 'session-new' }),
      renameSession: vi.fn().mockResolvedValue(undefined),
    }
    const { service, root } = await createService(client)
    await service.initialize()

    await expect(service.listProjects()).resolves.toEqual([{
      projectId: 'project-1',
      path: '/work/content',
      title: '内容项目',
      sessionIds: ['session-1'],
    }])
    await expect(service.listSessions('project-1')).resolves.toEqual([
      { sessionId: 'session-1', updatedAt: 2, running: false, title: '已有会话' },
    ])
    await expect(service.createSession('project-1')).resolves.toMatchObject({ sessionId: 'session-new' })
    expect(client.createSession).toHaveBeenCalledWith({ cwd: root, workspaceId: 'project-1' })

    await expect(service.createSession('project-1', ' 新建会话 ')).resolves.toMatchObject({
      sessionId: 'session-new',
      title: '新建会话',
    })
    expect(client.renameSession).toHaveBeenCalledWith('session-new', '新建会话')
  })

  it('generates an editable employee profile in the configured language', async () => {
    const complete = vi.fn().mockResolvedValue(JSON.stringify({
      name: '内容策划员',
      role: '短视频内容策划专员',
      description: '负责把用户需求整理成可执行的短视频内容方案。',
      businessBoundary: '负责选题和脚本，不负责直接发布。',
      systemPrompt: '先理解受众，再输出有依据、可执行的内容方案。',
      operatingGuidelines: ['先分析受众和目标', '再给出内容结构'],
      qualityStandards: ['信息准确', '方案可以直接执行'],
      capabilities: ['research', 'copywriting'],
      skillIds: [],
      enabled: true,
    }))
    const { service } = await createService(fakeClient(), {
      lightweightClient: { complete },
      getLocale: () => 'zh',
    })

    await expect(service.generate({ prompt: '需要一名负责短视频内容策划的员工' })).resolves.toEqual({
      name: '内容策划员',
      role: '短视频内容策划专员',
      description: '负责把用户需求整理成可执行的短视频内容方案。',
      businessBoundary: '负责选题和脚本，不负责直接发布。',
      systemPrompt: '先理解受众，再输出有依据、可执行的内容方案。',
      operatingGuidelines: ['先分析受众和目标', '再给出内容结构'],
      qualityStandards: ['信息准确', '方案可以直接执行'],
      capabilities: ['research', 'copywriting'],
      skillIds: [],
      enabled: true,
      builtIn: false,
    })
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({
      outputMode: 'json',
      prompt: '用户需求：需要一名负责短视频内容策划的员工',
      systemPrompt: expect.stringContaining('简体中文'),
    }))
  })

  it('reuses the selected session instead of creating another session for an employee run', async () => {
    const client = fakeClient(['完成'])
    const { service } = await createService(client)
    await service.initialize()

    await expect(service.run(DEFAULT_RESEARCH_EMPLOYEE.id, {
      task: '比较两个市场方案',
      projectId: 'project-1',
      sessionId: 'session-1',
    })).resolves.toMatchObject({ status: 'completed', output: '完成' })
    expect(client.createSession).not.toHaveBeenCalled()
    expect(client.sendPrompt).toHaveBeenCalledWith('session-1', expect.any(String))
  })

  it('allows the same employee to run concurrently in different sessions', async () => {
    const releases = new Map<string, (result: { text: string }) => void>()
    const client: EmployeeRunClient = {
      createSession: vi.fn().mockResolvedValue({ sessionId: 'unused-session' }),
      sendPrompt: vi.fn((sessionId: string) => new Promise<{ text: string }>((resolve) => {
        releases.set(sessionId, resolve)
      })),
    }
    const { service } = await createService(client)
    await service.initialize()
    const employee = await service.create({
      id: 'parallel-worker',
      name: '并发员工',
      role: '执行专员',
      description: '',
      businessBoundary: '只执行明确任务。',
      systemPrompt: '你负责执行任务。',
      operatingGuidelines: ['完成任务。'],
      qualityStandards: [],
      capabilities: ['workflow'],
      skillIds: [],
      enabled: true,
      builtIn: false,
    })

    const first = service.run(employee.id, { task: '任务一', projectId: 'project-1', sessionId: 'session-a' })
    const second = service.run(employee.id, { task: '任务二', projectId: 'project-1', sessionId: 'session-b' })
    await vi.waitFor(() => expect(client.sendPrompt).toHaveBeenCalledTimes(2))

    expect(service.listSessionLocks()).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionId: 'session-a', employeeId: employee.id }),
      expect.objectContaining({ sessionId: 'session-b', employeeId: employee.id }),
    ]))

    releases.get('session-a')?.({ text: '完成一' })
    releases.get('session-b')?.({ text: '完成二' })
    await expect(first).resolves.toMatchObject({ status: 'completed', output: '完成一' })
    await expect(second).resolves.toMatchObject({ status: 'completed', output: '完成二' })
    expect(service.listSessionLocks()).toEqual([])
  })

  it('rejects a second run on a locked session and releases the lock after completion', async () => {
    let release!: (result: { text: string }) => void
    const client: EmployeeRunClient = {
      createSession: vi.fn().mockResolvedValue({ sessionId: 'unused-session' }),
      sendPrompt: vi.fn(() => new Promise<{ text: string }>((resolve) => {
        release = resolve
      })),
    }
    const { service } = await createService(client)
    await service.initialize()
    const employee = await service.create({
      id: 'locked-worker',
      name: '锁定员工',
      role: '执行专员',
      description: '',
      businessBoundary: '只执行明确任务。',
      systemPrompt: '你负责执行任务。',
      operatingGuidelines: ['完成任务。'],
      qualityStandards: [],
      capabilities: ['workflow'],
      skillIds: [],
      enabled: true,
      builtIn: false,
    })

    const first = service.run(employee.id, { task: '任务一', projectId: 'project-1', sessionId: 'session-a' })
    await vi.waitFor(() => expect(service.listSessionLocks()).toEqual([expect.objectContaining({ sessionId: 'session-a' })]))
    await expect(service.run(employee.id, { task: '任务二', projectId: 'project-1', sessionId: 'session-a' })).rejects.toThrow(/locked/i)

    release({ text: '完成' })
    await expect(first).resolves.toMatchObject({ status: 'completed' })
    expect(service.listSessionLocks()).toEqual([])
  })

  it('force unlocks an in-flight run, cancels the session, and prevents another workflow step', async () => {
    let release!: (result: { text: string }) => void
    const client: EmployeeRunClient = {
      createSession: vi.fn().mockResolvedValue({ sessionId: 'unused-session' }),
      sendPrompt: vi.fn(() => new Promise<{ text: string }>((resolve) => {
        release = resolve
      })),
      cancelSession: vi.fn().mockResolvedValue(undefined),
    }
    const { service } = await createService(client)
    await service.initialize()
    const employee = await service.create({
      id: 'force-unlock-worker',
      name: '可解锁员工',
      role: '执行专员',
      description: '',
      businessBoundary: '只执行明确任务。',
      systemPrompt: '你负责执行任务。',
      operatingGuidelines: ['先完成任务。'],
      qualityStandards: [],
      capabilities: ['workflow'],
      skillIds: [],
      enabled: true,
      builtIn: false,
    })

    const run = service.run(employee.id, { task: '任务', projectId: 'project-1', sessionId: 'session-a' })
    await vi.waitFor(() => expect(service.listSessionLocks()).toEqual([expect.objectContaining({ sessionId: 'session-a' })]))
    await service.forceUnlockSession('session-a')

    expect(client.cancelSession).toHaveBeenCalledWith('session-a')
    expect(service.listSessionLocks()).toEqual([])
    release({ text: '已取消的输出' })
    await expect(run).resolves.toMatchObject({ status: 'failed', error: expect.stringMatching(/unlock/i) })
    expect(client.sendPrompt).toHaveBeenCalledTimes(1)
  })

  it('persists employee creation, updates, enablement, and removal', async () => {
    const { service } = await createService()
    await service.initialize()

    const created = await service.create({
      id: 'campaign-editor',
      name: '活动编辑员',
      role: '内容编辑',
      description: '把活动信息整理成可发布文案。',
      businessBoundary: '只负责活动文案。',
      systemPrompt: '你是内容编辑。',
      operatingGuidelines: ['写一版初稿。'],
      qualityStandards: ['不虚构活动信息。'],
      capabilities: ['copywriting'],
      skillIds: [],
      enabled: true,
      builtIn: false,
    })

    expect(created.id).toBe('campaign-editor')
    await expect(service.update(created.id, { role: '资深内容编辑', enabled: false })).resolves.toMatchObject({
      role: '资深内容编辑',
      enabled: false,
    })
    await expect(service.setEnabled(created.id, true)).resolves.toMatchObject({ enabled: true })

    await service.remove(created.id)
    expect(service.list().some((employee) => employee.id === created.id)).toBe(false)
  })

  it('runs a professional employee once with its complete profile', async () => {
    const client = fakeClient()
    const { service, root } = await createService(client)
    await service.initialize()

    const result = await service.run(DEFAULT_POSTER_EMPLOYEE.id, {
      task: '为春季发布会制作一张宣传海报',
    })

    expect(result.status).toBe('completed')
    expect(result.steps.map((step) => step.name)).toEqual(['执行专业任务'])
    expect(result.output).toBe('分析完成')
    expect(client.createSession).toHaveBeenCalledWith({ cwd: root })
    const prompts = vi.mocked(client.sendPrompt).mock.calls.map(([sessionId, prompt]) => ({ sessionId, prompt }))
    expect(prompts).toHaveLength(1)
    expect(prompts[0]?.prompt).toContain('为春季发布会制作一张宣传海报')
    expect(prompts[0]?.prompt).toContain('业务边界')
    expect(prompts[0]?.prompt).toContain('执行规范')
    expect(prompts[0]?.prompt).toContain('质量标准')
  })

  it('rejects runs for disabled employees', async () => {
    const { service } = await createService()
    await service.initialize()
    await service.setEnabled(DEFAULT_POSTER_EMPLOYEE.id, false)

    await expect(service.run(DEFAULT_POSTER_EMPLOYEE.id, { task: '测试' })).rejects.toThrow(/disabled/i)
  })

  it('notifies subscribers after employee mutations', async () => {
    const { service } = await createService()
    await service.initialize()
    const listener = vi.fn()
    const unsubscribe = service.watch(listener)

    await service.setEnabled(DEFAULT_POSTER_EMPLOYEE.id, false)

    expect(listener).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({
      id: DEFAULT_POSTER_EMPLOYEE.id,
      enabled: false,
    })]))
    unsubscribe()
  })
})
