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
  updateAvailable: (version: string) => string
  updateAvailableDetail: string
  downloadUpdate: string
  later: string
  updateDownloadFailed: string
  updateDownloaded: string
  updateDownloadedDetail: string
  restartAndInstall: string
  latestVersion: string
  updateCheckFailed: string
  updateDisabledInDevelopment: string
  tabHarness: string
  tabStore: string
  tabPresets: string
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
    starting: '正在启动 DSH Runtime…',
    preparing: 'Runtime 准备中',
    retryStart: '重试启动',
    appTitle: '你的本地 AI 工作台',
    appSubtitle: 'Easy Way to the DeepSeek‑Harness',
    menuAbout: '关于 EzDSH',
    menuCheckForUpdates: '检查更新…',
    menuQuit: '退出 EzDSH',
    updateAvailable: (version) => `发现新版本 ${version}`.trim(),
    updateAvailableDetail: '可以现在下载，下载完成后再决定是否重启安装。',
    downloadUpdate: '下载更新',
    later: '稍后',
    updateDownloadFailed: '更新下载失败',
    updateDownloaded: '更新已下载',
    updateDownloadedDetail: '现在重启并安装更新吗？',
    restartAndInstall: '重启并安装',
    latestVersion: '已是最新版本',
    updateCheckFailed: '检查更新失败',
    updateDisabledInDevelopment: '开发模式不检查更新',
    tabHarness: 'DeepSeek Harness',
    tabStore: '技能商店',
    tabPresets: '人设商店',
    tabSettings: '设置',
    menuNavigate: '前往',
    menuOpenLog: '打开运行日志…',
    menuOpenHarnessDir: '打开 Harness 数据目录…',
    storeSearchPlaceholder: '搜索技能…',
    storeAllCategories: '全部分类',
    storeInstalledSection: '已安装',
    storeAvailableSection: '可安装',
    storeInstall: '安装',
    storeInstalled: '已安装',
    storeUninstall: '卸载',
    storeUpdate: '更新',
    storeLoadFailed: '加载商店失败',
    storeRetry: '重试',
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
    starting: 'Starting DSH Runtime…',
    preparing: 'Preparing Runtime',
    retryStart: 'Retry startup',
    appTitle: 'Your local AI workspace',
    appSubtitle: 'Easy Way to the DeepSeek‑Harness',
    menuAbout: 'About EzDSH',
    menuCheckForUpdates: 'Check for Updates…',
    menuQuit: 'Quit EzDSH',
    updateAvailable: (version) => `New version ${version} is available`.trim(),
    updateAvailableDetail: 'Download it now, then choose when to restart and install it.',
    downloadUpdate: 'Download Update',
    later: 'Later',
    updateDownloadFailed: 'Update download failed',
    updateDownloaded: 'Update downloaded',
    updateDownloadedDetail: 'Restart and install the update now?',
    restartAndInstall: 'Restart and Install',
    latestVersion: 'You are up to date',
    updateCheckFailed: 'Update check failed',
    updateDisabledInDevelopment: 'Update checks are disabled in development mode',
    tabHarness: 'DeepSeek Harness',
    tabStore: 'Skill Store',
    tabPresets: 'Presets',
    tabSettings: 'Settings',
    menuNavigate: 'Go',
    menuOpenLog: 'Open Runtime Log…',
    menuOpenHarnessDir: 'Open Harness Data Directory…',
    storeSearchPlaceholder: 'Search skills…',
    storeAllCategories: 'All categories',
    storeInstalledSection: 'Installed',
    storeAvailableSection: 'Available',
    storeInstall: 'Install',
    storeInstalled: 'Installed',
    storeUninstall: 'Uninstall',
    storeUpdate: 'Update',
    storeLoadFailed: 'Failed to load the store',
    storeRetry: 'Retry',
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
  },
}

export function getAppCopy(locale: AppLocale): AppCopy {
  return APP_COPY[locale]
}
