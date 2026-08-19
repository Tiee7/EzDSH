export const APP_LOCALES = ['zh', 'en'] as const
export type AppLocale = (typeof APP_LOCALES)[number]

export const DEFAULT_APP_LOCALE: AppLocale = 'zh'

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
  storeDetailFiles: string
  storeDetailMcp: string
  storeConfirmTitle: string
  storeConfirmInstall: string
  storeCancel: string
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
  storeSurfaceMcp: string
  settingsLanguage: string
  settingsLanguageHint: string
  settingsOpenLog: string
  settingsOpenHarnessDir: string
  settingsAbout: string
  settingsStoreSource: string
  settingsProviders: string
  settingsProvidersHint: string
  settingsProviderAdd: string
  settingsProviderCustomProvider: string
  settingsProviderCustomProviderHint: string
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
  settingsTabGeneral: string
  settingsTabRemoteControl: string
  settingsTabNavigation: string
  navSectionHint: string
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
    storeDetailFiles: '包含文件',
    storeDetailMcp: 'MCP 服务器配置',
    storeConfirmTitle: '安全检测报告',
    storeConfirmInstall: '确认安装',
    storeCancel: '取消',
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
    storeSurfaceMcp: '工具扩展（MCP）',
    settingsLanguage: '界面语言',
    settingsLanguageHint: '跟随 DeepSeek Harness 的语言设置，切换后各界面同步更新',
    settingsOpenLog: '打开运行日志',
    settingsOpenHarnessDir: '打开 Harness 数据目录',
    settingsAbout: '关于',
    settingsStoreSource: '商店数据源',
    settingsProviders: '模型供应商',
    settingsProvidersHint: '管理预设供应商的 API Key，与首次运行的配置流程一致',
    settingsProviderAdd: '添加供应商',
    settingsProviderCustomProvider: '自定义供应商',
    settingsProviderCustomProviderHint: '填写供应商的全部连接和模型信息',
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
    settingsTabGeneral: '通用',
    settingsTabRemoteControl: '远程控制',
    settingsTabNavigation: '导航管理',
    navSectionHint: '选择要在标签栏显示的页面，拖动调整顺序；也可以添加自定义链接标签。',
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
    storeDetailFiles: 'Bundled files',
    storeDetailMcp: 'MCP server wiring',
    storeConfirmTitle: 'Security audit report',
    storeConfirmInstall: 'Confirm install',
    storeCancel: 'Cancel',
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
    storeSurfaceMcp: 'Tool extensions (MCP)',
    settingsLanguage: 'Interface language',
    settingsLanguageHint: 'Follows the DeepSeek Harness language setting; every surface updates together',
    settingsOpenLog: 'Open Runtime log',
    settingsOpenHarnessDir: 'Open Harness data directory',
    settingsAbout: 'About',
    settingsStoreSource: 'Store source',
    settingsProviders: 'Model providers',
    settingsProvidersHint: 'Manage API keys for preset providers, same flow as first-run setup',
    settingsProviderAdd: 'Add provider',
    settingsProviderCustomProvider: 'Custom provider',
    settingsProviderCustomProviderHint: 'Fill in the connection and model details yourself',
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
    settingsTabGeneral: 'General',
    settingsTabRemoteControl: 'Remote control',
    settingsTabNavigation: 'Navigation',
    navSectionHint: 'Choose which pages appear in the tab bar, drag to reorder, or add custom link tabs.',
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
