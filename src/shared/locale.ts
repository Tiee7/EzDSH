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
    appSubtitle: 'EzDSH 图形界面正在连接本地 DSH Runtime。',
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
    appSubtitle: 'EzDSH is connecting to the local DSH Runtime.',
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
  },
}

export function getAppCopy(locale: AppLocale): AppCopy {
  return APP_COPY[locale]
}
