export const APP_LOCALES = ['zh', 'en'] as const
export type AppLocale = (typeof APP_LOCALES)[number]

export const DEFAULT_APP_LOCALE: AppLocale = 'en'

export interface AppCopy {
  loadingConfig: string
  runtimeStartFailed: string
  runtimeRestartFailed: string
  configReadFailed: string
  setupEyebrow: string
  setupTitle: string
  setupLede: string
  provider: string
  apiKeyPlaceholder: string
  baseUrl: string
  optional: string
  baseUrlPlaceholder: string
  saving: string
  saveAndEnter: string
  testing: string
  testConnection: string
  skip: string
  connectionTestFailed: string
  saveFailed: string
  ready: string
  runtimeFailed: string
  starting: string
  preparing: string
  retryStart: string
  appTitle: string
  appSubtitle: string
  menuAbout: string
  menuCheckForUpdates: string
  menuQuit: string
  later: string
  updateDownloadFailed: string
  updateDownloaded: string
  updateDownloadedDetail: string
  restartAndInstall: string
  latestVersionDetail: (version: string) => string
  latestVersionLastChecked: (time: string) => string
  updateCheckFailed: string
  updateDisabledInDevelopment: string
  updateSafetyTitle: string
  updateSafetySessions: string
  updateSafetySettings: string
  updateSafetyPlugins: string
  updateSafetyPresets: string
  updateSafetyRuntime: string
  recoveryTitle: string
  recoveryDetail: string
  recoveryLastError: string
  recoveryRestorePrevious: string
  recoveryRetryRuntime: string
  recoveryOpenBackups: string
  recoveryRestoring: string
  recoveryRestoreFailed: string
  recoveryDoctor: string
  recoveryDoctorRunning: string
  recoveryDoctorDone: (issues: number, repaired: number) => string
  recoveryRepairSessionTail: string
  settingsRecovery: string
  settingsRecoveryHint: string
  settingsRecoveryCreate: string
  settingsRecoveryCreating: string
  settingsRecoveryCheckLogs: string
  settingsRecoveryOpen: string
  settingsRecoveryEmpty: string
  settingsRecoveryCreated: string
  settingsRecoveryVerified: (ok: boolean) => string
  settingsRecoveryIssues: (count: number) => string
  tabHarness: string
  tabStore: string
  tabPresets: string
  tabDocs: string
  tabSettings: string
  menuNavigate: string
  menuOpenLog: string
  menuOpenHarnessDir: string
  storeSearchPlaceholder: string
  storeAllCategories: string
  storeInstalledSection: string
  storeAvailableSection: string
  storeInstall: string
  storeInstalled: string
  storeUninstall: string
  storeUpdate: string
  storeLoadFailed: string
  storeRetry: string
  storeDemoBadge: string
  storeRefresh: string
  storeRefreshing: string
  storeRefreshFailed: string
  storeLastUpdated: (time: string) => string
  storeNeverRefreshed: string
  storeEmpty: string
  storeLoading: string
  storeTotalCount: (count: number) => string
  storePagination: string
  storePreviousPage: string
  storeNextPage: string
  storePage: (page: number, pageCount: number) => string
  storeDetailFiles: string
  storeDetailMcp: string
  storeDetailPlugin: string
  storeConfirmTitle: string
  storeConfirmInstall: string
  storeInstallAnyway: string
  storeCancel: string
  storeRuntimeRestartRequired: string
  storeRuntimeRestartNow: string
  storeRuntimeRestartLater: string
  storeRuntimeRestarting: string
  storeRuntimeRestartDeferred: string
  storeRuntimeRestartFailed: string
  storeAuditReport: string
  storeAuditFindingsNone: string
  storeAuditExternalUrls: string
  storeAuditBlocked: string
  auditVerified: string
  auditBasic: string
  auditUnaudited: string
  phaseDownloading: string
  phaseAuditing: string
  phaseInstalling: string
  phaseDone: string
  phaseFailed: string
  storeSurfaceSkills: string
  storeSurfacePlugins: string
  storeSurfaceMcp: string
  languageTagLabel: string
  languageTagChinese: string
  languageTagEnglish: string
  settingsLanguage: string
  settingsLanguageHint: string
  settingsLanguageTag: string
  settingsLanguageTagHint: string
  settingsLanguageTagToggle: string
  settingsLanguageTagError: string
  settingsWorkspace: string
  settingsWorkspaceHint: string
  settingsWorkspaceMigrate: string
  settingsWorkspaceSwitch: string
  settingsWorkspaceSelect: string
  settingsWorkspaceMoving: string
  settingsWorkspaceSwitching: string
  settingsWorkspaceRestarting: string
  settingsWorkspaceMigrateConfirm: string
  settingsWorkspaceMigrateConfirmDetail: string
  settingsWorkspaceError: string
  settingsOpenLog: string
  settingsOpenHarnessDir: string
  settingsDeveloperMode: string
  settingsDeveloperModeHint: string
  settingsDeveloperModeExit: string
  settingsDeveloperModeError: string
  settingsAbout: string
  settingsStoreSource: string
  settingsProviders: string
  settingsProvidersHint: string
  settingsNotifications: string
  settingsNotificationsHint: string
  settingsNotificationsEnable: string
  settingsNotificationsEnableHint: string
  settingsNotificationsDesktop: string
  settingsNotificationsDesktopHint: string
  settingsNotificationsVolume: string
  settingsNotificationsPreview: string
  settingsNotificationsSound: string
  settingsNotificationsSaveFailed: string
  settingsNotificationsOn: string
  settingsNotificationsOff: string
  settingsNotificationQuestion: string
  settingsNotificationQuestionHint: string
  settingsNotificationApproval: string
  settingsNotificationApprovalHint: string
  settingsNotificationTask: string
  settingsNotificationTaskHint: string
  settingsNotificationJob: string
  settingsNotificationJobHint: string
  settingsNotificationSubagent: string
  settingsNotificationSubagentHint: string
  settingsNotificationError: string
  settingsNotificationErrorHint: string
  settingsProviderAdd: string
  settingsProviderCustomProvider: string
  settingsProviderUsable: string
  settingsProviderConfigured: string
  settingsProviderSave: string
  settingsProviderEdit: string
  settingsProviderDelete: string
  settingsProviderListModels: string
  settingsProviderModelList: string
  settingsProviderSelectAll: string
  settingsProviderDeselectAll: string
  settingsProviderModelsEmpty: string
  settingsProviderModelsEmptyHint: string
  settingsProviderFetchFailed: string
  settingsProviderModelsRequired: string
  settingsProviderAddModel: string
  settingsProviderModelId: string
  settingsProviderModelIdRequired: string
  settingsProviderModelName: string
  settingsProviderModelNamePlaceholder: string
  settingsProviderModelContextWindow: string
  settingsProviderModelContextWindowPlaceholder: string
  settingsProviderModelMaxTokens: string
  settingsProviderModelMaxTokensPlaceholder: string
  settingsProviderModelLimitsInvalid: string
  settingsProviderApiKey: string
  settingsProviderCustomOptions: string
  settingsProviderCustomOptionsOpen: string
  settingsProviderId: string
  settingsProviderIdHint: string
  settingsProviderDisplayName: string
  settingsProviderApiProtocol: string
  settingsProviderIdRequired: string
  settingsProviderBaseUrlRequired: string
  loading: string
  save: string
  settingsUpdateSection: string
  settingsUpdateCurrent: string
  settingsCheckUpdate: string
  settingsDownloadUpdate: string
  settingsRuntimeSection: string
  settingsRuntimePort: string
  settingsRestartRuntime: string
  settingsRuntimeInstances: string
  settingsRuntimeInstancesHint: string
  settingsRuntimeRefresh: string
  settingsRuntimeCurrent: string
  settingsRuntimeOwned: string
  settingsRuntimeExternal: string
  settingsRuntimePid: string
  settingsRuntimeStartedAt: string
  settingsRuntimeStop: string
  settingsRuntimeStopping: string
  settingsRuntimeEmpty: string
  settingsRuntimeLoading: string
  settingsRuntimeLoadFailed: string
  settingsRuntimePortUnavailable: string
  settingsExternalServices: string
  settingsExternalServicesHint: string
  externalServicesAdd: string
  externalServicesEdit: string
  externalServicesDelete: string
  externalServicesStart: string
  externalServicesStop: string
  externalServicesRestart: string
  externalServicesSave: string
  externalServicesCancel: string
  externalServicesName: string
  externalServicesCommand: string
  externalServicesCommandHint: string
  externalServicesArgs: string
  externalServicesArgsHint: string
  externalServicesCwd: string
  externalServicesEnv: string
  externalServicesEnvHint: string
  externalServicesAutoStart: string
  externalServicesEmpty: string
  externalServicesLoading: string
  externalServicesFailed: string
  externalServicesStateStopped: string
  externalServicesStateStarting: string
  externalServicesStateRunning: string
  externalServicesStateStopping: string
  externalServicesStateFailed: string
  externalServicesStateExited: string
  externalServicesNameRequired: string
  externalServicesCommandRequired: string
  externalServicesEnvInvalid: string
  externalServicesSecurityHint: string
  settingsTabGeneral: string
  settingsTabRemoteControl: string
  settingsTabNavigation: string
  navSectionHint: string
  navShortcutHint: string
  navSystemBadge: string
  navAddLink: string
  navEdit: string
  navDelete: string
  navSave: string
  navCancel: string
  navName: string
  navUrlPlaceholder: string
  navShow: string
  navHide: string
  navNameRequired: string
  navInvalidUrl: string
  navSaveFailed: string
  channelBridgeTitle: string
  channelBridgeHint: string
  channelBridgeAllowList: string
  remoteControlFeishuEnabled: string
  channelBridgeSessionId: string
  remoteControlFeishuTitle: string
  remoteControlFeishuHint: string
  remoteControlFeishuAppId: string
  remoteControlFeishuAppIdPlaceholder: string
  remoteControlFeishuAppSecret: string
  remoteControlFeishuAppSecretPlaceholder: string
  remoteControlFeishuEncryptKey: string
  remoteControlFeishuIncomplete: string
  remoteControlFeishuNav: string
  remoteControlGeneral: string
  remoteControlGeneralHint: string
  remoteControlIMPlatforms: string
  remoteControlQQ: string
  remoteControlWeChat: string
  remoteControlComingSoon: string
  channelBridgeSessionIdPlaceholder: string
  channelBridgeSessionTimeout: string
  channelBridgeStatusInterval: string
  channelBridgeListSessions: string
  channelBridgeListingSessions: string
  channelBridgeSessionRunning: string
  channelBridgeSessionIdle: string
  channelBridgeUntitledSession: string
  channelBridgeUseSession: string
  channelBridgeSaved: string
  channelBridgePairTitle: string
  channelBridgePairHint: string
  channelBridgeStartPairing: string
  channelBridgeCancelPairing: string
  channelBridgePairing: string
  channelBridgePairingCode: string
  channelBridgePairingCodeHint: (code: string, secondsLeft: number) => string
  channelBridgePairingExpired: string
  channelBridgePairingSuccess: string
  channelBridgePairingFailed: string
}

const APP_COPY: Record<AppLocale, AppCopy> = {
  zh: {
    loadingConfig: '正在读取 EzDSH 配置…',
    runtimeStartFailed: 'DSH Runtime 暂时未能启动，请点击重试',
    runtimeRestartFailed: '配置已保存，但 DSH Runtime 暂时未能重启，请点击重试',
    configReadFailed: '读取配置失败',
    setupEyebrow: 'EzDSH 初始设置',
    setupTitle: '配置模型供应商',
    setupLede: '模型供应商用于启用对话能力。你可以先跳过配置查看 EzDSH，密钥只会由主进程保存到本机受保护的凭据文件。',
    provider: '供应商',
    apiKeyPlaceholder: '输入 API Key',
    baseUrl: 'Base URL',
    optional: '（可选）',
    baseUrlPlaceholder: 'https://api.example.com/v1',
    saving: '正在保存…',
    saveAndEnter: '保存并进入 EzDSH',
    testing: '正在测试…',
    testConnection: '测试连接',
    skip: '暂时跳过，直接查看 EzDSH',
    connectionTestFailed: '连接测试失败',
    saveFailed: '保存失败，请重试',
    ready: 'Runtime 已就绪',
    runtimeFailed: 'DSH Runtime 暂时未能启动，请点击重试',
    starting: '正在启动 DSH Runtime，首次启动可能需要更多时间…',
    preparing: 'Runtime 准备中，请稍候…',
    retryStart: '重试启动',
    appTitle: '你的本地 AI 工作台',
    appSubtitle: 'Easy Way to the DeepSeek‑Harness',
    menuAbout: '关于 EzDSH',
    menuCheckForUpdates: '检查更新…',
    menuQuit: '退出 EzDSH',
    later: '稍后',
    updateDownloadFailed: '更新下载失败',
    updateDownloaded: '更新已下载',
    updateDownloadedDetail: '现在重启并安装更新吗？',
    restartAndInstall: '重启并安装',
    latestVersionDetail: (version) => '已是最新版本',
    latestVersionLastChecked: (time) => `最后检查 ${time}`,
    updateCheckFailed: '检查更新失败',
    updateDisabledInDevelopment: '开发模式不检查更新',
    updateSafetyTitle: '更新前会自动创建恢复快照',
    updateSafetySessions: 'Sessions 快照',
    updateSafetySettings: 'Settings 备份',
    updateSafetyPlugins: 'Plugin 列表快照',
    updateSafetyPresets: 'Presets 备份',
    updateSafetyRuntime: '记录当前 Runtime 版本',
    recoveryTitle: '需要恢复 EzDSH 环境',
    recoveryDetail: '上次升级后 DSH Runtime 未能正常启动。你的升级前快照仍然保留，可以恢复上一份用户环境后重试。',
    recoveryLastError: '失败原因',
    recoveryRestorePrevious: '恢复上一份环境',
    recoveryRetryRuntime: '重试 Runtime',
    recoveryOpenBackups: '打开备份目录',
    recoveryRestoring: '正在恢复上一份环境…',
    recoveryRestoreFailed: '恢复失败，请查看备份目录或重试。',
    recoveryDoctor: '检查 Session Log',
    recoveryDoctorRunning: '正在检查 Session Log…',
    recoveryDoctorDone: (issues, repaired) => `检查完成：${issues} 个问题，修复 ${repaired} 个尾记录`,
    recoveryRepairSessionTail: '修复未完成的尾记录',
    settingsRecovery: '备份与恢复',
    settingsRecoveryHint: '备份 sessions、settings、skills、plugins、profiles 和 state。Credential 明文保存在本机受限 vault，不进入 Archive；换机恢复时需要重新输入。',
    settingsRecoveryCreate: '立即备份',
    settingsRecoveryCreating: '正在备份…',
    settingsRecoveryCheckLogs: '检查 Session Log',
    settingsRecoveryOpen: '打开备份目录',
    settingsRecoveryEmpty: '还没有可用的恢复快照',
    settingsRecoveryCreated: '备份已创建',
    settingsRecoveryVerified: (ok) => ok ? '校验通过' : '校验失败',
    settingsRecoveryIssues: (count) => String(count) + ' 个 Session Log 问题',
    tabHarness: 'DeepSeek Harness',
    tabStore: 'Skills',
    tabPresets: 'Preset',
    tabDocs: '使用手册',
    tabSettings: '设置',
    menuNavigate: '前往',
    menuOpenLog: '打开运行日志…',
    menuOpenHarnessDir: '打开 Harness 数据目录…',
    storeSearchPlaceholder: '搜索…',
    storeAllCategories: '全部分类',
    storeInstalledSection: '已安装',
    storeAvailableSection: '可安装',
    storeInstall: '安装',
    storeInstalled: '已安装',
    storeUninstall: '卸载',
    storeUpdate: '更新',
    storeLoadFailed: '加载商店失败',
    storeRetry: '重试',
    storeDemoBadge: '演示目录',
    storeRefresh: '更新目录',
    storeRefreshing: '更新中…',
    storeRefreshFailed: '更新失败',
    storeLastUpdated: (time) => `更新于 ${time}`,
    storeNeverRefreshed: '内置目录，未更新',
    storeEmpty: '这里还没有内容',
    storeLoading: '加载中…',
    storeTotalCount: (count) => `共 ${count} 个`,
    storePagination: '目录分页',
    storePreviousPage: '上一页',
    storeNextPage: '下一页',
    storePage: (page, pageCount) => `第 ${page} / ${pageCount} 页`,
    storeDetailFiles: '包含文件',
    storeDetailMcp: 'MCP 服务器配置',
    storeDetailPlugin: 'DSH 插件来源',
    storeConfirmTitle: '安全检测报告',
    storeConfirmInstall: '确认安装',
    storeInstallAnyway: '仍要安装',
    storeCancel: '取消',
    storeRuntimeRestartRequired: '插件已安装，需要重启 Runtime 后才能生效。',
    storeRuntimeRestartNow: '立即重启',
    storeRuntimeRestartLater: '稍后重启',
    storeRuntimeRestarting: '正在重启 Runtime…',
    storeRuntimeRestartDeferred: '插件已安装，稍后重启 Runtime 后生效。',
    storeRuntimeRestartFailed: 'Runtime 重启失败，请稍后重试。',
    storeAuditReport: '检测结果',
    storeAuditFindingsNone: '未发现问题',
    storeAuditExternalUrls: '外链地址',
    storeAuditBlocked: '该内容未通过安全检测，已阻止安装',
    auditVerified: '已验证',
    auditBasic: '基础检测',
    auditUnaudited: '未审计',
    phaseDownloading: '下载中…',
    phaseAuditing: '检测中…',
    phaseInstalling: '安装中…',
    phaseDone: '安装完成',
    phaseFailed: '操作失败',
    storeSurfaceSkills: '技能',
    storeSurfacePlugins: '插件',
    storeSurfaceMcp: '工具扩展（MCP）',
    languageTagLabel: '切换界面语言',
    languageTagChinese: '简体中文',
    languageTagEnglish: 'English',
    settingsLanguage: '界面语言',
    settingsLanguageHint: '跟随 DeepSeek Harness 的语言设置，切换后各界面同步更新',
    settingsLanguageTag: '右上角语言标签',
    settingsLanguageTagHint: '在窗口右上角显示快捷语言选择入口',
    settingsLanguageTagToggle: '显示右上角语言标签',
    settingsLanguageTagError: '语言标签设置失败，请重试',
    settingsWorkspace: '默认工作文件夹',
    settingsWorkspaceHint: 'EzDSH 的配置、会话、插件和日志都保存在这里。迁移会完整移动当前文件夹内容；切换空文件夹会按新安装流程初始化。',
    settingsWorkspaceMigrate: '迁移到此处',
    settingsWorkspaceSwitch: '切换到此处',
    settingsWorkspaceSelect: '选择文件夹',
    settingsWorkspaceMoving: '正在移动文件，请不要退出 EzDSH…',
    settingsWorkspaceSwitching: '正在切换工作文件夹，请不要退出 EzDSH…',
    settingsWorkspaceRestarting: '工作文件夹已更新，正在重新初始化 EzDSH…',
    settingsWorkspaceMigrateConfirm: '开始迁移',
    settingsWorkspaceMigrateConfirmDetail: '当前工作文件夹中的所有内容都会移动到所选文件夹，原位置将不再保留。迁移期间请不要退出 EzDSH。',
    settingsWorkspaceError: '工作文件夹操作失败',
    settingsOpenLog: '打开运行日志',
    settingsOpenHarnessDir: '打开 Harness 数据目录',
    settingsDeveloperMode: '开发者模式',
    settingsDeveloperModeHint: '已启用预览更新源，可能会收到尚未完成的版本。',
    settingsDeveloperModeExit: '退出开发者模式',
    settingsDeveloperModeError: '开发者模式设置失败，请重试',
    settingsAbout: '关于',
    settingsStoreSource: '商店数据源',
    settingsProviders: '模型供应商',
    settingsProvidersHint: '管理预设供应商的 API Key，与首次运行的配置流程一致',
    settingsNotifications: '通知',
    settingsNotificationsHint: '在 EzDSH 窗口最小化或后台运行时，及时知道 Agent 的重要状态变化。声音通过 WebAudio 在本地生成，不需要音频文件或网络。',
    settingsNotificationsEnable: '启用通知声音',
    settingsNotificationsEnableHint: '总开关，关闭后不会播放任何通知声音。',
    settingsNotificationsDesktop: '桌面通知',
    settingsNotificationsDesktopHint: '使用系统原生通知，即使 EzDSH 窗口被最小化也能收到。',
    settingsNotificationsVolume: '声音音量',
    settingsNotificationsPreview: '试听',
    settingsNotificationsSound: '声音',
    settingsNotificationsSaveFailed: '通知设置保存失败，请重试',
    settingsNotificationsOn: '开启',
    settingsNotificationsOff: '关闭',
    settingsNotificationQuestion: 'Questions',
    settingsNotificationQuestionHint: 'Agent 需要你回答问题时提醒。',
    settingsNotificationApproval: 'Approval',
    settingsNotificationApprovalHint: '工具调用等待批准时提醒。',
    settingsNotificationTask: 'Turn complete',
    settingsNotificationTaskHint: '当前对话回合完成时提醒。',
    settingsNotificationJob: 'Background jobs',
    settingsNotificationJobHint: '后台任务完成或被终止时提醒。',
    settingsNotificationSubagent: 'Subagents',
    settingsNotificationSubagentHint: '子 Agent 完成工作时提醒。默认关闭。',
    settingsNotificationError: 'Errors',
    settingsNotificationErrorHint: '回合、后台任务或 Agent 出错时提醒。',
    settingsProviderAdd: '添加供应商',
    settingsProviderCustomProvider: '自定义供应商',
    settingsProviderUsable: '可用',
    settingsProviderConfigured: '已配置',
    settingsProviderSave: '保存',
    settingsProviderEdit: '修改',
    settingsProviderDelete: '删除',
    settingsProviderListModels: '获取可用模型',
    settingsProviderModelList: '模型目录',
    settingsProviderSelectAll: '全选',
    settingsProviderDeselectAll: '取消全选',
    settingsProviderModelsEmpty: '该供应商没有返回可用模型',
    settingsProviderModelsEmptyHint: '模型选择器中将不显示任何模型；目录外 ID 仍可直接发送。',
    settingsProviderFetchFailed: '获取模型失败',
    settingsProviderModelsRequired: '请至少添加或选择一个模型',
    settingsProviderAddModel: '添加模型',
    settingsProviderModelId: '模型 ID',
    settingsProviderModelIdRequired: '请输入模型 ID',
    settingsProviderModelName: '显示名称（可选）',
    settingsProviderModelNamePlaceholder: '留空则使用模型 ID',
    settingsProviderModelContextWindow: '上下文窗口',
    settingsProviderModelContextWindowPlaceholder: '例如 256K',
    settingsProviderModelMaxTokens: '最大输出 token',
    settingsProviderModelMaxTokensPlaceholder: '例如 32K',
    settingsProviderModelLimitsInvalid: '上下文窗口和最大输出 token 必须是正整数，可使用 K/M 后缀',
    settingsProviderApiKey: 'API Key',
    settingsProviderCustomOptions: '自定义选项',
    settingsProviderCustomOptionsOpen: '收起自定义选项',
    settingsProviderId: 'Provider ID',
    settingsProviderIdHint: '修改 ID 后可以为同一个供应商保存多个不同的 API Key',
    settingsProviderDisplayName: '显示名称',
    settingsProviderApiProtocol: 'API 协议',
    settingsProviderIdRequired: '请输入 Provider ID',
    settingsProviderBaseUrlRequired: '请输入 Base URL',
    loading: '加载中…',
    save: '保存',
    settingsUpdateSection: '应用更新',
    settingsUpdateCurrent: '当前版本',
    settingsCheckUpdate: '检查更新',
    settingsDownloadUpdate: '下载更新',
    settingsRuntimeSection: '运行状态',
    settingsRuntimePort: '端口',
    settingsRestartRuntime: '重启 Runtime',
    settingsRuntimeInstances: 'DSH Runtime 实例',
    settingsRuntimeInstancesHint: '查看当前机器上所有 DSH Runtime；多于 1 个时，非当前实例的进程通常是自行启动的或异常退出时遗留的 Runtime。',
    settingsRuntimeRefresh: '刷新列表',
    settingsRuntimeCurrent: '当前 EzDSH 启动',
    settingsRuntimeOwned: 'EzDSH 启动的孤儿实例',
    settingsRuntimeExternal: '用户或其他进程启动',
    settingsRuntimePid: 'PID',
    settingsRuntimeStartedAt: '启动时间',
    settingsRuntimeStop: '停止',
    settingsRuntimeStopping: '停止中…',
    settingsRuntimeEmpty: '当前没有检测到 DSH Runtime',
    settingsRuntimeLoading: '正在检测 DSH Runtime…',
    settingsRuntimeLoadFailed: '检测 DSH Runtime 失败，请刷新重试',
    settingsRuntimePortUnavailable: '未检测到',
    settingsExternalServices: '外部服务',
    settingsExternalServicesHint: '“跟随启动”表示 DSH Runtime 就绪后自动启动该服务；关闭后仍可手动管理。服务失败不会影响 EzDSH。',
    externalServicesAdd: '添加服务',
    externalServicesEdit: '编辑',
    externalServicesDelete: '删除',
    externalServicesStart: '开始',
    externalServicesStop: '停止',
    externalServicesRestart: '重启',
    externalServicesSave: '保存',
    externalServicesCancel: '取消',
    externalServicesName: '名称',
    externalServicesCommand: '命令',
    externalServicesCommandHint: '可填写 npm run dev 等一行命令，也可只填写可执行文件。',
    externalServicesArgs: '参数',
    externalServicesArgsHint: '每行一个参数；例如 pnpm run dev --port 3690 应拆为 run、dev、--port、3690 四行。默认不经过 Shell 解析。',
    externalServicesCwd: '工作目录（可选）',
    externalServicesEnv: '环境变量（可选）',
    externalServicesEnvHint: '每行一个 KEY=VALUE，敏感值不会显示在状态中。',
    externalServicesAutoStart: '跟随启动',
    externalServicesEmpty: '还没有外部服务。',
    externalServicesLoading: '正在加载外部服务…',
    externalServicesFailed: '外部服务操作失败',
    externalServicesStateStopped: '已停止',
    externalServicesStateStarting: '启动中',
    externalServicesStateRunning: '运行中',
    externalServicesStateStopping: '停止中',
    externalServicesStateFailed: '启动失败',
    externalServicesStateExited: '已退出',
    externalServicesNameRequired: '请输入服务名称',
    externalServicesCommandRequired: '请输入启动命令',
    externalServicesEnvInvalid: '环境变量格式应为 KEY=VALUE',
    externalServicesSecurityHint: '外部服务会以当前用户权限运行。只添加你信任的命令。',
    settingsTabGeneral: '通用',
    settingsTabRemoteControl: '远程控制',
    settingsTabNavigation: '导航管理',
    navSectionHint: '选择要在标签栏显示的页面，拖动调整顺序；也可以添加自定义链接标签。',
    navShortcutHint: '快捷键可以快速跳转标签页，按当前标签顺序：Windows/Linux 使用 Ctrl+1–9，macOS 使用 ⌘1–9；设置页使用 Ctrl+0/⌘0。',
    navSystemBadge: '系统',
    navAddLink: '添加链接',
    navEdit: '编辑',
    navDelete: '删除',
    navSave: '保存',
    navCancel: '取消',
    navName: '名称',
    navUrlPlaceholder: 'https://example.com',
    navShow: '显示',
    navHide: '隐藏',
    navNameRequired: '请输入名称',
    navInvalidUrl: '请输入有效的 http/https 链接地址',
    navSaveFailed: '保存失败，请重试',
    channelBridgeTitle: '远程控制',
    channelBridgeHint: '为每个 IM 平台配置凭证并启用后，即可通过对应机器人远程向 EzDSH 发送消息。',
    channelBridgeAllowList: '白名单用户 ID（每行一个）',
    remoteControlFeishuEnabled: '启用飞书',
    channelBridgeSessionId: 'DSH 会话 ID',
    channelBridgeSessionIdPlaceholder: '留空则首次使用时自动创建',
    channelBridgeSessionTimeout: '单轮等待超时（毫秒）',
    channelBridgeStatusInterval: '状态更新间隔（毫秒）',
    channelBridgeListSessions: '查看现有会话',
    channelBridgeListingSessions: '正在加载会话…',
    channelBridgeSessionRunning: '运行中',
    channelBridgeSessionIdle: '空闲',
    channelBridgeUntitledSession: '未命名会话',
    channelBridgeUseSession: '使用此会话',
    channelBridgeSaved: '已保存',
    channelBridgePairTitle: '用户配对',
    channelBridgePairHint: '点击开始后，把验证码发给已接入的机器人，即可自动完成配对。',
    channelBridgeStartPairing: '开始配对',
    channelBridgeCancelPairing: '取消配对',
    channelBridgePairing: '正在配对…',
    channelBridgePairingCode: '验证码',
    channelBridgePairingCodeHint: (code: string, secondsLeft: number) =>
      `请在 ${secondsLeft} 秒内把验证码「${code}」发给机器人完成配对。`,
    channelBridgePairingExpired: '验证码已过期，请重新生成。',
    channelBridgePairingSuccess: '配对成功，已加入白名单。',
    channelBridgePairingFailed: '配对失败',
    remoteControlFeishuTitle: '飞书',
    remoteControlFeishuHint: '在飞书开放平台创建企业自建应用，把应用的凭证填写到下面即可接入。',
    remoteControlFeishuAppId: 'App ID',
    remoteControlFeishuAppIdPlaceholder: 'cli_xxx',
    remoteControlFeishuAppSecret: 'App Secret',
    remoteControlFeishuAppSecretPlaceholder: 'xxx',
    remoteControlFeishuEncryptKey: '事件订阅 Encrypt Key（可选）',
    remoteControlFeishuIncomplete: '已启用飞书，但 App ID 和 App Secret 尚未填写完整。',
    remoteControlFeishuNav: '飞书',
    remoteControlGeneral: '通用',
    remoteControlGeneralHint: '这些设置对所有 IM 平台生效。每个平台还可以单独配置会话和白名单。',
    remoteControlIMPlatforms: 'IM 平台',
    remoteControlQQ: 'QQ',
    remoteControlWeChat: '微信',
    remoteControlComingSoon: '即将推出',
  },
  en: {
    loadingConfig: 'Reading EzDSH configuration…',
    runtimeStartFailed: 'DSH Runtime could not start. Try again.',
    runtimeRestartFailed: 'Configuration saved, but DSH Runtime could not restart. Try again.',
    configReadFailed: 'Could not read configuration',
    setupEyebrow: 'EzDSH initial setup',
    setupTitle: 'Configure a model provider',
    setupLede: 'A model provider enables conversations. You can skip this step and explore EzDSH; keys are stored locally by the main process in a protected credentials file.',
    provider: 'Provider',
    apiKeyPlaceholder: 'Enter API Key',
    baseUrl: 'Base URL',
    optional: '(optional)',
    baseUrlPlaceholder: 'https://api.example.com/v1',
    saving: 'Saving…',
    saveAndEnter: 'Save and enter EzDSH',
    testing: 'Testing…',
    testConnection: 'Test connection',
    skip: 'Skip for now and explore EzDSH',
    connectionTestFailed: 'Connection test failed',
    saveFailed: 'Save failed. Try again.',
    ready: 'Runtime is ready',
    runtimeFailed: 'DSH Runtime could not start. Try again.',
    starting: 'Starting DSH Runtime; first launch may take longer…',
    preparing: 'Preparing Runtime, please wait…',
    retryStart: 'Retry startup',
    appTitle: 'Your local AI workspace',
    appSubtitle: 'Easy Way to the DeepSeek‑Harness',
    menuAbout: 'About EzDSH',
    menuCheckForUpdates: 'Check for Updates…',
    menuQuit: 'Quit EzDSH',
    later: 'Later',
    updateDownloadFailed: 'Update download failed',
    updateDownloaded: 'Update downloaded',
    updateDownloadedDetail: 'Restart and install the update now?',
    restartAndInstall: 'Restart and Install',
    latestVersionDetail: (version) => 'You are up to date',
    latestVersionLastChecked: (time) => `Last checked ${time}`,
    updateCheckFailed: 'Update check failed',
    updateDisabledInDevelopment: 'Update checks are disabled in development mode',
    updateSafetyTitle: 'A recovery snapshot will be created before updating',
    updateSafetySessions: 'Sessions snapshot',
    updateSafetySettings: 'Settings backup',
    updateSafetyPlugins: 'Plugin list snapshot',
    updateSafetyPresets: 'Presets backup',
    updateSafetyRuntime: 'Current Runtime version recorded',
    recoveryTitle: 'EzDSH needs recovery',
    recoveryDetail: 'DSH Runtime did not start after the last update. Your pre-update snapshot is still available; restore the previous user environment and try again.',
    recoveryLastError: 'Failure reason',
    recoveryRestorePrevious: 'Restore previous environment',
    recoveryRetryRuntime: 'Retry Runtime',
    recoveryOpenBackups: 'Open backup folder',
    recoveryRestoring: 'Restoring previous environment…',
    recoveryRestoreFailed: 'Restore failed. Open the backup folder or try again.',
    recoveryDoctor: 'Check Session Logs',
    recoveryDoctorRunning: 'Checking Session Logs…',
    recoveryDoctorDone: (issues, repaired) => `Check complete: ${issues} issue(s), repaired ${repaired} tail record(s)`,
    recoveryRepairSessionTail: 'Repair incomplete tail record',
    settingsRecovery: 'Backup & recovery',
    settingsRecoveryHint: 'Backs up sessions, settings, skills, plugins, profiles, and state. Plaintext Credentials stay in a restricted local vault and never enter the Archive; moving to a new machine requires re-entry.',
    settingsRecoveryCreate: 'Back up now',
    settingsRecoveryCreating: 'Backing up…',
    settingsRecoveryCheckLogs: 'Check Session Logs',
    settingsRecoveryOpen: 'Open backup folder',
    settingsRecoveryEmpty: 'No recovery snapshots yet',
    settingsRecoveryCreated: 'Backup created',
    settingsRecoveryVerified: (ok) => ok ? 'Checksum OK' : 'Checksum FAILED',
    settingsRecoveryIssues: (count) => String(count) + ' Session Log issue(s)',
    tabHarness: 'DeepSeek Harness',
    tabStore: 'Skills',
    tabPresets: 'Preset',
    tabDocs: 'Docs',
    tabSettings: 'Settings',
    menuNavigate: 'Go',
    menuOpenLog: 'Open Runtime Log…',
    menuOpenHarnessDir: 'Open Harness Data Directory…',
    storeSearchPlaceholder: 'Search…',
    storeAllCategories: 'All categories',
    storeInstalledSection: 'Installed',
    storeAvailableSection: 'Available',
    storeInstall: 'Install',
    storeInstalled: 'Installed',
    storeUninstall: 'Uninstall',
    storeUpdate: 'Update',
    storeLoadFailed: 'Failed to load the store',
    storeRetry: 'Retry',
    storeDemoBadge: 'Demo catalog',
    storeRefresh: 'Refresh',
    storeRefreshing: 'Refreshing…',
    storeRefreshFailed: 'Refresh failed',
    storeLastUpdated: (time) => `Updated ${time}`,
    storeNeverRefreshed: 'Bundled catalog, never refreshed',
    storeEmpty: 'Nothing here yet',
    storeLoading: 'Loading…',
    storeTotalCount: (count) => `Total ${count}`,
    storePagination: 'Catalog pagination',
    storePreviousPage: 'Previous',
    storeNextPage: 'Next',
    storePage: (page, pageCount) => `Page ${page} of ${pageCount}`,
    storeDetailFiles: 'Bundled files',
    storeDetailMcp: 'MCP server wiring',
    storeDetailPlugin: 'DSH plugin source',
    storeConfirmTitle: 'Security audit report',
    storeConfirmInstall: 'Confirm install',
    storeInstallAnyway: 'Install anyway',
    storeCancel: 'Cancel',
    storeRuntimeRestartRequired: 'The plugin is installed and will be active after restarting Runtime.',
    storeRuntimeRestartNow: 'Restart now',
    storeRuntimeRestartLater: 'Later',
    storeRuntimeRestarting: 'Restarting Runtime…',
    storeRuntimeRestartDeferred: 'The plugin is installed and will be active after you restart Runtime.',
    storeRuntimeRestartFailed: 'Runtime restart failed. Try again later.',
    storeAuditReport: 'Audit result',
    storeAuditFindingsNone: 'No issues found',
    storeAuditExternalUrls: 'External URLs',
    storeAuditBlocked: 'This content failed the security audit; install blocked',
    auditVerified: 'Verified',
    auditBasic: 'Basic',
    auditUnaudited: 'Unaudited',
    phaseDownloading: 'Downloading…',
    phaseAuditing: 'Auditing…',
    phaseInstalling: 'Installing…',
    phaseDone: 'Installed',
    phaseFailed: 'Operation failed',
    storeSurfaceSkills: 'Skills',
    storeSurfacePlugins: 'Plugins',
    storeSurfaceMcp: 'Tool extensions (MCP)',
    languageTagLabel: 'Change interface language',
    languageTagChinese: '简体中文',
    languageTagEnglish: 'English',
    settingsLanguage: 'Interface language',
    settingsLanguageHint: 'Follows the DeepSeek Harness language setting; every surface updates together',
    settingsLanguageTag: 'Top-right language shortcut',
    settingsLanguageTagHint: 'Show a quick language selector in the top-right corner',
    settingsLanguageTagToggle: 'Show the top-right language shortcut',
    settingsLanguageTagError: 'Could not update the language shortcut. Try again.',
    settingsWorkspace: 'Default workspace folder',
    settingsWorkspaceHint: 'EzDSH stores configuration, sessions, plugins, and logs here. Migration moves the complete current folder; switching to an empty folder initializes it like a new install.',
    settingsWorkspaceMigrate: 'Migrate here',
    settingsWorkspaceSwitch: 'Switch here',
    settingsWorkspaceSelect: 'Choose folder',
    settingsWorkspaceMoving: 'Moving files. Please do not quit EzDSH…',
    settingsWorkspaceSwitching: 'Switching workspace. Please do not quit EzDSH…',
    settingsWorkspaceRestarting: 'Workspace updated. Reinitializing EzDSH…',
    settingsWorkspaceMigrateConfirm: 'Start migration',
    settingsWorkspaceMigrateConfirmDetail: 'All contents of the current workspace will move to the selected folder and will no longer remain at the old location. Please do not quit EzDSH during migration.',
    settingsWorkspaceError: 'Workspace operation failed',
    settingsOpenLog: 'Open Runtime log',
    settingsOpenHarnessDir: 'Open Harness data directory',
    settingsDeveloperMode: 'Developer mode',
    settingsDeveloperModeHint: 'The preview update feed is enabled. It may include unfinished releases.',
    settingsDeveloperModeExit: 'Exit developer mode',
    settingsDeveloperModeError: 'Could not update developer mode. Try again.',
    settingsAbout: 'About',
    settingsStoreSource: 'Store source',
    settingsProviders: 'Model providers',
    settingsProvidersHint: 'Manage API keys for preset providers, same flow as first-run setup',
    settingsNotifications: 'Notifications',
    settingsNotificationsHint: 'Stay informed about important Agent state changes while EzDSH is minimized or in the background. Sounds are generated locally with WebAudio—no audio files or network required.',
    settingsNotificationsEnable: 'Enable notification sounds',
    settingsNotificationsEnableHint: 'Master switch. Turn it off to silence all notification sounds.',
    settingsNotificationsDesktop: 'Desktop notifications',
    settingsNotificationsDesktopHint: 'Use native OS notifications, including when the EzDSH window is minimized.',
    settingsNotificationsVolume: 'Sound volume',
    settingsNotificationsPreview: 'Preview',
    settingsNotificationsSound: 'Sound',
    settingsNotificationsSaveFailed: 'Could not save notification settings. Try again.',
    settingsNotificationsOn: 'On',
    settingsNotificationsOff: 'Off',
    settingsNotificationQuestion: 'Questions',
    settingsNotificationQuestionHint: 'Notify when the Agent needs an answer.',
    settingsNotificationApproval: 'Approval',
    settingsNotificationApprovalHint: 'Notify when a tool call is waiting for approval.',
    settingsNotificationTask: 'Turn complete',
    settingsNotificationTaskHint: 'Notify when the current conversation turn completes.',
    settingsNotificationJob: 'Background jobs',
    settingsNotificationJobHint: 'Notify when a background job completes or is killed.',
    settingsNotificationSubagent: 'Subagents',
    settingsNotificationSubagentHint: 'Notify when a subagent finishes work. Off by default.',
    settingsNotificationError: 'Errors',
    settingsNotificationErrorHint: 'Notify when a turn, background job, or Agent errors.',
    settingsProviderAdd: 'Add provider',
    settingsProviderCustomProvider: 'Custom provider',
    settingsProviderUsable: 'Usable',
    settingsProviderConfigured: 'Configured',
    settingsProviderSave: 'Save',
    settingsProviderEdit: 'Edit',
    settingsProviderDelete: 'Delete',
    settingsProviderListModels: 'Fetch available models',
    settingsProviderModelList: 'Model catalog',
    settingsProviderSelectAll: 'Select all',
    settingsProviderDeselectAll: 'Deselect all',
    settingsProviderModelsEmpty: 'No models returned',
    settingsProviderModelsEmptyHint: 'No models will appear in the model picker; IDs outside the catalog can still be sent directly.',
    settingsProviderFetchFailed: 'Failed to fetch models',
    settingsProviderModelsRequired: 'Add or select at least one model',
    settingsProviderAddModel: 'Add model',
    settingsProviderModelId: 'Model ID',
    settingsProviderModelIdRequired: 'Enter a model ID',
    settingsProviderModelName: 'Display name (optional)',
    settingsProviderModelNamePlaceholder: 'Uses the model ID when empty',
    settingsProviderModelContextWindow: 'Context window',
    settingsProviderModelContextWindowPlaceholder: 'e.g. 256K',
    settingsProviderModelMaxTokens: 'Max output tokens',
    settingsProviderModelMaxTokensPlaceholder: 'e.g. 32K',
    settingsProviderModelLimitsInvalid: 'Context window and max output tokens must be positive integers; K/M suffixes are supported',
    settingsProviderApiKey: 'API Key',
    settingsProviderCustomOptions: 'Custom options',
    settingsProviderCustomOptionsOpen: 'Hide custom options',
    settingsProviderId: 'Provider ID',
    settingsProviderIdHint: 'Change the ID to save multiple API keys for the same provider',
    settingsProviderDisplayName: 'Display name',
    settingsProviderApiProtocol: 'API protocol',
    settingsProviderIdRequired: 'Enter a Provider ID',
    settingsProviderBaseUrlRequired: 'Enter a Base URL',
    loading: 'Loading…',
    save: 'Save',
    settingsUpdateSection: 'Application updates',
    settingsUpdateCurrent: 'Current version',
    settingsCheckUpdate: 'Check for updates',
    settingsDownloadUpdate: 'Download update',
    settingsRuntimeSection: 'Runtime status',
    settingsRuntimePort: 'Port',
    settingsRestartRuntime: 'Restart runtime',
    settingsRuntimeInstances: 'DSH Runtime instances',
    settingsRuntimeInstancesHint: 'View every DSH Runtime on this machine. When more than one is present, instances not started by the current EzDSH are usually manually started or left over after an abnormal exit.',
    settingsRuntimeRefresh: 'Refresh list',
    settingsRuntimeCurrent: 'Started by current EzDSH',
    settingsRuntimeOwned: 'Orphaned EzDSH instance',
    settingsRuntimeExternal: 'Started by user or another process',
    settingsRuntimePid: 'PID',
    settingsRuntimeStartedAt: 'Started',
    settingsRuntimeStop: 'Stop',
    settingsRuntimeStopping: 'Stopping…',
    settingsRuntimeEmpty: 'No DSH Runtime processes detected',
    settingsRuntimeLoading: 'Detecting DSH Runtime processes…',
    settingsRuntimeLoadFailed: 'Could not detect DSH Runtime processes. Refresh to try again.',
    settingsRuntimePortUnavailable: 'Unavailable',
    settingsExternalServices: 'External services',
    settingsExternalServicesHint: '“Follow startup” starts the service after the DSH Runtime is ready. Turning it off keeps manual controls available, and service failures never block EzDSH.',
    externalServicesAdd: 'Add service',
    externalServicesEdit: 'Edit',
    externalServicesDelete: 'Delete',
    externalServicesStart: 'Start',
    externalServicesStop: 'Stop',
    externalServicesRestart: 'Restart',
    externalServicesSave: 'Save',
    externalServicesCancel: 'Cancel',
    externalServicesName: 'Name',
    externalServicesCommand: 'Command',
    externalServicesCommandHint: 'You can enter npm run dev as one line or provide only the executable.',
    externalServicesArgs: 'Arguments',
    externalServicesArgsHint: 'One argument per line; for pnpm run dev --port 3690, use four lines: run, dev, --port, 3690. Shell parsing is disabled by default.',
    externalServicesCwd: 'Working directory (optional)',
    externalServicesEnv: 'Environment (optional)',
    externalServicesEnvHint: 'One KEY=VALUE per line; values are not shown in process status.',
    externalServicesAutoStart: 'Follow startup',
    externalServicesEmpty: 'No external services yet.',
    externalServicesLoading: 'Loading external services…',
    externalServicesFailed: 'External service operation failed',
    externalServicesStateStopped: 'Stopped',
    externalServicesStateStarting: 'Starting',
    externalServicesStateRunning: 'Running',
    externalServicesStateStopping: 'Stopping',
    externalServicesStateFailed: 'Start failed',
    externalServicesStateExited: 'Exited',
    externalServicesNameRequired: 'Enter a service name',
    externalServicesCommandRequired: 'Enter a start command',
    externalServicesEnvInvalid: 'Environment entries must use KEY=VALUE',
    externalServicesSecurityHint: 'External services run with your current user permissions. Add only commands you trust.',
    settingsTabGeneral: 'General',
    settingsTabRemoteControl: 'Remote control',
    settingsTabNavigation: 'Navigation',
    navSectionHint: 'Choose which pages appear in the tab bar, drag to reorder, or add custom link tabs.',
    navShortcutHint: 'Shortcuts follow the current tab order: Ctrl+1–9 on Windows/Linux or ⌘1–9 on macOS; Ctrl+0/⌘0 opens Settings.',
    navSystemBadge: 'System',
    navAddLink: 'Add link',
    navEdit: 'Edit',
    navDelete: 'Delete',
    navSave: 'Save',
    navCancel: 'Cancel',
    navName: 'Name',
    navUrlPlaceholder: 'https://example.com',
    navShow: 'Show',
    navHide: 'Hide',
    navNameRequired: 'Name is required',
    navInvalidUrl: 'Enter a valid http/https URL',
    navSaveFailed: 'Save failed. Try again.',
    channelBridgeTitle: 'Remote control',
    channelBridgeHint: 'Configure credentials and enable each IM platform to send messages to EzDSH remotely via its bot.',
    channelBridgeAllowList: 'Whitelisted user IDs (one per line)',
    remoteControlFeishuEnabled: 'Enable Lark',
    channelBridgeSessionId: 'DSH session ID',
    channelBridgeSessionIdPlaceholder: 'Leave empty to create a session on first use',
    channelBridgeSessionTimeout: 'Turn wait timeout (ms)',
    channelBridgeStatusInterval: 'Status update interval (ms)',
    channelBridgeListSessions: 'List existing sessions',
    channelBridgeListingSessions: 'Loading sessions…',
    channelBridgeSessionRunning: 'Running',
    channelBridgeSessionIdle: 'Idle',
    channelBridgeUntitledSession: 'Untitled session',
    channelBridgeUseSession: 'Use this session',
    channelBridgeSaved: 'Saved',
    channelBridgePairTitle: 'User pairing',
    channelBridgePairHint: 'Click start, then send the code to any connected bot to pair automatically.',
    channelBridgeStartPairing: 'Start pairing',
    channelBridgeCancelPairing: 'Cancel pairing',
    channelBridgePairing: 'Pairing…',
    channelBridgePairingCode: 'Verification code',
    channelBridgePairingCodeHint: (code: string, secondsLeft: number) =>
      `Send the code "${code}" to the bot within ${secondsLeft} seconds to complete pairing.`,
    channelBridgePairingExpired: 'The verification code has expired. Generate a new one.',
    channelBridgePairingSuccess: 'Pairing successful. Your Open ID has been added to the allowlist.',
    channelBridgePairingFailed: 'Pairing failed',
    remoteControlFeishuTitle: 'Lark',
    remoteControlFeishuHint: 'Create a custom app on the Lark Open Platform, then paste its credentials below.',
    remoteControlFeishuAppId: 'App ID',
    remoteControlFeishuAppIdPlaceholder: 'cli_xxx',
    remoteControlFeishuAppSecret: 'App Secret',
    remoteControlFeishuAppSecretPlaceholder: 'xxx',
    remoteControlFeishuEncryptKey: 'Event subscription Encrypt Key (optional)',
    remoteControlFeishuIncomplete: 'Lark is enabled, but the App ID and App Secret are not filled in yet.',
    remoteControlFeishuNav: 'Lark',
    remoteControlGeneral: 'General',
    remoteControlGeneralHint: 'These settings apply to every IM platform. Each platform can also configure its own session and allowlist.',
    remoteControlIMPlatforms: 'IM platforms',
    remoteControlQQ: 'QQ',
    remoteControlWeChat: 'WeChat',
    remoteControlComingSoon: 'Coming soon',
  },
}

export function getAppCopy(locale: AppLocale): AppCopy {
  return APP_COPY[locale]
}
