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
  settingsRecoveryDeleted: string
  settingsRecoveryVerify: string
  settingsRecoveryVerifyHint: string
  settingsRecoveryRestore: string
  settingsRecoveryDelete: string
  settingsRecoveryDeleteConfirm: (name: string) => string
  settingsRecoveryBridgeOutdated: string
  settingsRecoveryVerified: (ok: boolean) => string
  settingsRecoveryIssues: (count: number) => string
  settingsArchivedSessions: string
  settingsSessionManagement: string
  settingsArchivedSessionsHint: string
  settingsArchivedSessionsEmpty: string
  settingsArchivedSessionsRefresh: string
  settingsArchivedSessionsRefreshing: string
  settingsArchivedSessionsRestore: string
  settingsArchivedSessionsRestoring: string
  settingsArchivedSessionsRestoreAndOpen: string
  settingsArchivedSessionsRestored: string
  settingsArchivedSessionsDelete: string
  settingsArchivedSessionsDeleting: string
  settingsArchivedSessionsDeleteConfirm: (name: string) => string
  settingsArchivedSessionsDeleted: string
  settingsArchivedSessionsDeveloperHint: string
  tabHarness: string
  tabWorkflow: string
  tabStore: string
  tabPresets: string
  tabDocs: string
  tabEmployees: string
  tabSettings: string
  employeesTitle: string
  employeesHint: string
  employeesEmptyTitle: string
  employeesEmptyHint: string
  employeesPreviewBadge: string
  employeesList: string
  employeesRefresh: string
  employeesRefreshContext: string
  employeesRefreshingContext: string
  employeesProject: string
  employeesSession: string
  employeesSelectProject: string
  employeesSelectSession: string
  employeesLoadingContext: string
  employeesNewSession: string
  employeesCreatingSession: string
  employeesSessionTitlePrompt: string
  employeesAdd: string
  employeesDescribeNeed: string
  employeesDescribeNeedHint: string
  employeesDescribeNeedPlaceholder: string
  employeesGenerate: string
  employeesGenerating: string
  employeesGeneratedHint: string
  employeesGenerationRequired: string
  employeesManualInput: string
  employeesUseAiGeneration: string
  employeesAssignTask: string
  employeesEdit: string
  employeesDelete: string
  employeesSave: string
  employeesCancel: string
  employeesLoading: string
  employeesFailed: string
  employeesEmpty: string
  employeesName: string
  employeesRole: string
  employeesDescription: string
  employeesBusinessBoundary: string
  employeesSystemPrompt: string
  employeesOperatingGuidelines: string
  employeesOperatingGuidelinesHint: string
  employeesQualityStandards: string
  employeesQualityStandardsHint: string
  employeesSkillIds: string
  employeesSkillIdsHint: string
  employeesProfileVersion: string
  employeesProfileSections: string
  employeesCapabilities: string
  employeesWorkflow: string
  employeesAddStep: string
  employeesStepName: string
  employeesStepInstruction: string
  employeesStepDelete: string
  employeesStepEnabled: string
  employeesEnabled: string
  employeesDisabled: string
  employeesEnable: string
  employeesDisable: string
  employeesRun: string
  employeesTask: string
  employeesTaskHint: string
  employeesRunning: string
  employeesSessionLocked: string
  employeesRunId: string
  employeesForceUnlock: string
  employeesRunResults: string
  employeesRunCompleted: string
  employeesRunFailed: string
  employeesOutput: string
  employeesBuiltIn: string
  employeesNameRequired: string
  employeesRoleRequired: string
  employeesPromptRequired: string
  employeesTaskRequired: string
  employeesProjectRequired: string
  employeesSessionRequired: string
  employeesStepRequired: string
  workflowTitle: string
  workflowHint: string
  workflowChoose: string
  workflowRefresh: string
  workflowBack: string
  workflowEditor: string
  workflowExecutions: string
  workflowWorkspace: string
  workflowChooseRun: string
  workflowNew: string
  workflowDuplicate: string
  workflowDelete: string
  workflowDeleteConfirm: (name: string) => string
  workflowSave: string
  workflowUndo: string
  workflowRedo: string
  workflowContextMenu: string
  workflowDeleteNode: string
  workflowDeleteEdge: string
  workflowDeleteSelection: string
  workflowFitView: string
  workflowAlign: string
  workflowAlignLeft: string
  workflowAlignCenterHorizontal: string
  workflowAlignRight: string
  workflowAlignTop: string
  workflowAlignCenterVertical: string
  workflowAlignBottom: string
  workflowDistribute: string
  workflowDistributeHorizontal: string
  workflowDistributeVertical: string
  workflowCancelCreate: string
  workflowCancelEdit: string
  workflowDeleted: string
  workflowUndoDelete: string
  workflowRestored: string
  workflowSaved: string
  workflowDismiss: string
  workflowLoading: string
  workflowLoadFailed: string
  workflowEmpty: string
  workflowName: string
  workflowDescription: string
  workflowCanvas: string
  workflowInspector: string
  workflowNodeSelectHint: string
  workflowAddNode: string
  workflowNodeType: string
  workflowNodeLabel: string
  workflowInstruction: string
  workflowAiMode: string
  workflowAiModeSingle: string
  workflowAiModeAutonomous: string
  workflowOutputMode: string
  workflowOutputText: string
  workflowOutputJson: string
  workflowSkillIds: string
  workflowSkillId: string
  workflowMcpTool: string
  workflowMcpArguments: string
  workflowMcpArgumentsHint: string
  workflowConditionOperator: string
  workflowConditionValue: string
  workflowTransformTemplate: string
  workflowShellCommand: string
  workflowShellArgs: string
  workflowFileOperation: string
  workflowFilePath: string
  workflowFileContent: string
  workflowValidate: string
  workflowRun: string
  workflowRunning: string
  workflowRunSetup: string
  workflowRunSetupHint: string
  workflowStartRun: string
  workflowModel: string
  workflowUseDefaultModel: string
  workflowModelHint: string
  workflowRefreshModels: string
  workflowRefreshingModels: string
  workflowNoModels: string
  workflowCancelSetup: string
  workflowNoLaunchInputs: string
  workflowCancel: string
  workflowApprove: string
  workflowReject: string
  workflowWaitingApproval: string
  workflowMaxIterations: string
  workflowSystemPrompt: string
  workflowTransformText: string
  workflowResume: string
  workflowRunHistory: string
  workflowNoRuns: string
  workflowInput: string
  workflowNodeInput: string
  workflowNodeOutput: string
  workflowManualInput: string
  workflowInputFromUpstream: string
  workflowNodeNoInput: string
  workflowInputHint: string
  workflowOutput: string
  workflowOutputViewLabel: string
  workflowOutputMarkdown: string
  workflowCopyOutput: string
  workflowOpenOutputWindow: string
  workflowOutputCopied: string
  workflowDecreaseFont: string
  workflowIncreaseFont: string
  workflowHideRunSidebar: string
  workflowShowRunSidebar: string
  workflowResizeExecutionPanel: string
  workflowHistoryCount: (count: number) => string
  workflowUnviewedRuns: (count: number) => string
  workflowViewUnviewedRun: string
  workflowCloseOutputWindow: string
  workflowOutputWindow: string
  workflowDragOutputWindow: string
  workflowExpandInput: string
  workflowCollapseInput: string
  workflowGoUpstream: string
  workflowExport: string
  workflowImportJson: string
  workflowExported: string
  workflowImported: string
  workflowGenerate: string
  workflowGenerateHint: string
  workflowGeneratePlaceholder: string
  workflowGenerating: string
  workflowGenerated: string
  workflowGeneratedWithEmployees: (names: string) => string
  workflowGeneratedEmployeeWarnings: (warnings: string) => string
  workflowAllowShellFile: string
  workflowAllowShellFileHint: string
  workflowDebugRun: string
  workflowDebugRunHint: string
  workflowValidationFailed: string
  workflowValidationOk: string
  workflowRunFailed: string
  workflowRunCompleted: string
  workflowRunPaused: string
  workflowRunCancelled: string
  workflowShowMap: string
  workflowHideMap: string
  workflowNodePending: string
  workflowNodeRunning: string
  workflowNodeCompleted: string
  workflowNodeSkipped: string
  workflowNodeFailed: string
  workflowNodeCancelled: string
  workflowNodeResult: string
  workflowNodeResultHint: string
  workflowNodeNoOutput: string
  workflowNodeStartedAt: string
  workflowNodeCompletedAt: string
  workflowNodeEvents: string
  workflowImportEmployee: string
  workflowSelectEmployee: string
  workflowImportedEmployee: string
  workflowEmployeeProfile: string
  employeeCapabilityResearch: string
  employeeCapabilityCopywriting: string
  employeeCapabilityImageGeneration: string
  employeeCapabilityFileRead: string
  employeeCapabilityFileWrite: string
  employeeCapabilityWorkflow: string
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
  storeInstallFailed: string
  storeInstallLogPath: (path: string) => string
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
  storeEntryTypePlugin: string
  storeEntryTypeMcp: string
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
  settingsProxy: string
  settingsProxyHint: string
  settingsProxyAdd: string
  settingsProxyEdit: string
  settingsProxyDelete: string
  settingsProxyTest: string
  settingsProxyTesting: string
  settingsProxyTestSuccess: string
  settingsProxyTestFailed: string
  settingsProxyEnable: string
  settingsProxyDisable: string
  settingsProxyActive: string
  settingsProxyInactive: string
  settingsProxyEmpty: string
  settingsProxyName: string
  settingsProxyNamePlaceholder: string
  settingsProxyProtocol: string
  settingsProxyHost: string
  settingsProxyHostPlaceholder: string
  settingsProxyPort: string
  settingsProxyUsername: string
  settingsProxyUsernamePlaceholder: string
  settingsProxyPassword: string
  settingsProxyPasswordPlaceholder: string
  settingsProxyPasswordHint: string
  settingsProxyBypass: string
  settingsProxyBypassPlaceholder: string
  settingsProxyBypassHint: string
  settingsProxySave: string
  settingsProxyCancel: string
  settingsProxyDeleteConfirm: string
  settingsProxyOperationFailed: string
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
  settingsTabNotifications: string
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
  mobileRemoteTitle: string
  mobileRemoteHint: string
  mobileRemoteStatusStarting: string
  mobileRemoteStatusError: string
  mobileRemoteStatusReady: string
  mobileRemoteStatusStopped: string
  mobileRemoteLanTitle: string
  mobileRemoteLanHint: string
  mobileRemoteStartPairing: string
  mobileRemotePairing: string
  mobileRemoteUnavailable: string
  mobileRemoteQrAlt: string
  mobileRemoteQrTitle: string
  mobileRemoteQrHint: string
  mobileRemoteCancelPairing: string
  mobileRemotePendingTitle: string
  mobileRemoteUnknownDevice: string
  mobileRemoteApprove: string
  mobileRemoteReject: string
  mobileRemoteApproved: string
  mobileRemoteRejected: string
  mobileRemotePublicTitle: string
  mobileRemotePublicHint: string
  mobileRemotePublicStart: string
  mobileRemotePublicStarting: string
  mobileRemotePublicStop: string
  mobileRemotePublicWarning: string
  mobileRemoteDevicesTitle: string
  mobileRemoteDevicesHint: string
  mobileRemoteDisconnect: string
  mobileRemoteNoDevices: string
  mobileRemoteOperationFailed: string
  mobileRemoteCopyUrl: string
  mobileRemoteCopyFailed: string
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
    updateSafetySessions: '会话快照',
    updateSafetySettings: '设置备份',
    updateSafetyPlugins: '插件列表快照',
    updateSafetyPresets: '预设备份',
    updateSafetyRuntime: '记录当前 Runtime 版本',
    recoveryTitle: '需要恢复 EzDSH 环境',
    recoveryDetail: '上次升级后 DSH Runtime 未能正常启动。你的升级前快照仍然保留，可以恢复上一份用户环境后重试。',
    recoveryLastError: '失败原因',
    recoveryRestorePrevious: '恢复上一份环境',
    recoveryRetryRuntime: '重试 Runtime',
    recoveryOpenBackups: '打开备份目录',
    recoveryRestoring: '正在恢复上一份环境…',
    recoveryRestoreFailed: '恢复失败，请查看备份目录或重试。',
    recoveryDoctor: '检查会话日志',
    recoveryDoctorRunning: '正在检查会话日志…',
    recoveryDoctorDone: (issues, repaired) => `检查完成：${issues} 个问题，修复 ${repaired} 个尾记录`,
    recoveryRepairSessionTail: '修复未完成的尾记录',
    settingsRecovery: '备份与恢复',
    settingsRecoveryHint: '备份会话、设置、技能、插件、配置文件和状态。凭据明文保存在本机受限保险库，不进入归档；换机恢复时需要重新输入。',
    settingsRecoveryCreate: '立即备份',
    settingsRecoveryCreating: '正在备份…',
    settingsRecoveryCheckLogs: '检查会话日志',
    settingsRecoveryOpen: '打开备份目录',
    settingsRecoveryEmpty: '还没有可用的恢复快照',
    settingsRecoveryCreated: '备份已创建',
    settingsRecoveryDeleted: '备份已删除',
    settingsRecoveryVerify: '校验备份',
    settingsRecoveryVerifyHint: '“校验备份”只检查文件是否与生成时的 SHA-256 一致，不会恢复或修改任何数据。',
    settingsRecoveryRestore: '恢复',
    settingsRecoveryDelete: '删除备份',
    settingsRecoveryDeleteConfirm: (name) => `确定删除备份“${name}”？此操作无法撤销。`,
    settingsRecoveryBridgeOutdated: '恢复功能已更新，请完全退出并重新启动 EzDSH 后重试。',
    settingsRecoveryVerified: (ok) => ok ? '校验通过' : '校验失败',
    settingsRecoveryIssues: (count) => String(count) + ' 个会话日志问题',
    settingsArchivedSessions: '已归档会话',
    settingsSessionManagement: '会话管理',
    settingsArchivedSessionsHint: '归档不会删除会话记录。取消归档可让它重新出现在 Harness 列表中；永久删除将在 DSH 本身支持以后添加，当前强行删除可能会带来未知风险。已有备份快照和共享附件对象不会自动清理。',
    settingsArchivedSessionsEmpty: '当前没有已归档会话',
    settingsArchivedSessionsRefresh: '刷新列表',
    settingsArchivedSessionsRefreshing: '正在刷新…',
    settingsArchivedSessionsRestore: '取消归档',
    settingsArchivedSessionsRestoring: '正在恢复…',
    settingsArchivedSessionsRestoreAndOpen: '恢复并打开',
    settingsArchivedSessionsRestored: '会话已恢复',
    settingsArchivedSessionsDelete: '永久删除',
    settingsArchivedSessionsDeleting: '正在删除…',
    settingsArchivedSessionsDeleteConfirm: (name) => `确定从当前工作区永久删除会话“${name}”？删除后不能从会话管理恢复；已有备份仍可能包含它。`,
    settingsArchivedSessionsDeleted: '会话已从当前工作区永久删除',
    settingsArchivedSessionsDeveloperHint: '开发者模式提示：DSH 尚未原生支持永久删除，当前强行删除可能会带来未知风险。已有备份快照和共享附件不会自动删除。',
    tabHarness: 'DeepSeek Harness',
    tabWorkflow: 'Workflow',
    tabStore: 'Skills',
    tabPresets: 'Preset',
    tabDocs: '使用手册',
    tabEmployees: '员工',
    tabSettings: '设置',
    employeesTitle: 'AI 员工',
    employeesHint: '把可复用的专业角色定义为员工档案，统一管理业务边界、执行规范、质量标准和技能 ID。',
    employeesEmptyTitle: '员工控制台正在构建中',
    employeesEmptyHint: '下一步将支持员工角色、能力绑定、任务分派和工作流运行状态。',
    employeesPreviewBadge: '开发者预览',
    employeesList: '员工列表',
    employeesRefresh: '刷新页面',
    employeesRefreshContext: '刷新项目和会话',
    employeesRefreshingContext: '正在刷新项目和会话…',
    employeesProject: '项目',
    employeesSession: '会话',
    employeesSelectProject: '选择项目',
    employeesSelectSession: '选择会话',
    employeesLoadingContext: '正在加载项目和会话…',
    employeesNewSession: '新建会话',
    employeesCreatingSession: '正在新建会话…',
    employeesSessionTitlePrompt: '请输入会话标题（可留空使用默认标题）',
    employeesAdd: '新增员工',
    employeesDescribeNeed: '描述你需要的员工',
    employeesDescribeNeedHint: '用自然语言说明职责、工作范围、输出方式和质量要求，系统会生成可编辑的员工档案。',
    employeesDescribeNeedPlaceholder: '例如：我需要一名负责抖音短视频选题和脚本的员工，面向职场新人，输出有依据、可直接拍摄的内容。',
    employeesGenerate: '生成员工',
    employeesGenerating: '正在生成…',
    employeesGeneratedHint: '已根据描述生成，可继续修改字段后保存。',
    employeesGenerationRequired: '请先描述你需要的员工并生成档案。',
    employeesManualInput: '使用手工输入',
    employeesUseAiGeneration: '切换到 AI 生成',
    employeesAssignTask: '指派任务',
    employeesEdit: '编辑员工',
    employeesDelete: '删除员工',
    employeesSave: '保存员工',
    employeesCancel: '取消',
    employeesLoading: '正在加载员工…',
    employeesFailed: '员工数据加载失败',
    employeesEmpty: '还没有员工，先创建一个员工角色。',
    employeesName: '员工名称',
    employeesRole: '角色',
    employeesDescription: '职责简介',
    employeesBusinessBoundary: '业务边界',
    employeesSystemPrompt: '工作原则与系统提示词',
    employeesOperatingGuidelines: '执行规范',
    employeesOperatingGuidelinesHint: '每行一条，说明员工处理任务时应遵循的方法。',
    employeesQualityStandards: '质量标准',
    employeesQualityStandardsHint: '每行一条，说明任务结果必须满足的验收要求。',
    employeesSkillIds: '技能 ID',
    employeesSkillIdsHint: '每行一个可调用技能 ID；不需要技能时可以留空。',
    employeesProfileVersion: '档案版本',
    employeesProfileSections: '专业档案',
    employeesCapabilities: '能力',
    employeesWorkflow: '工作流步骤',
    employeesAddStep: '新增步骤',
    employeesStepName: '步骤名称',
    employeesStepInstruction: '步骤说明',
    employeesStepDelete: '删除步骤',
    employeesStepEnabled: '启用步骤',
    employeesEnabled: '已启用',
    employeesDisabled: '已停用',
    employeesEnable: '启用',
    employeesDisable: '停用',
    employeesRun: '提交',
    employeesTask: '交给员工的任务',
    employeesTaskHint: '提交一个真实任务，让员工按业务边界、执行规范和质量标准完成工作。',
    employeesRunning: '执行中…',
    employeesSessionLocked: '会话已锁定',
    employeesRunId: '运行 ID',
    employeesForceUnlock: '强制解锁',
    employeesRunResults: '执行结果',
    employeesRunCompleted: '执行完成',
    employeesRunFailed: '执行失败',
    employeesOutput: '输出',
    employeesBuiltIn: '内置示例',
    employeesNameRequired: '请输入员工名称。',
    employeesRoleRequired: '请输入员工角色。',
    employeesPromptRequired: '请输入工作原则或系统提示词。',
    employeesTaskRequired: '请输入要执行的任务。',
    employeesProjectRequired: '请选择项目。',
    employeesSessionRequired: '请选择会话。',
    employeesStepRequired: '每个工作流步骤都需要名称和说明。',
    workflowTitle: 'Workflow 编排',
    workflowHint: '用“智能处理”完成轻量任务，用“专业员工”承担有明确业务边界的岗位工作，并与 Skill、MCP、条件和文件节点协作。',
    workflowChoose: '选择一个工作流开始',
    workflowRefresh: '刷新列表',
    workflowBack: '工作流列表',
    workflowEditor: '编辑器',
    workflowExecutions: '执行记录',
    workflowWorkspace: '工作区',
    workflowChooseRun: '选择一条运行记录查看详情',
    workflowNew: '新建工作流',
    workflowDuplicate: '复制工作流',
    workflowDelete: '删除工作流',
    workflowDeleteConfirm: (name) => `确定删除工作流“${name}”？已有运行记录会保留。`,
    workflowSave: '保存',
    workflowUndo: '撤销',
    workflowRedo: '重做',
    workflowContextMenu: '工作流画布菜单',
    workflowDeleteNode: '删除节点',
    workflowDeleteEdge: '删除连线',
    workflowDeleteSelection: '删除选中内容',
    workflowFitView: '适配画布',
    workflowAlign: '对齐节点',
    workflowAlignLeft: '左对齐',
    workflowAlignCenterHorizontal: '水平居中',
    workflowAlignRight: '右对齐',
    workflowAlignTop: '顶端对齐',
    workflowAlignCenterVertical: '垂直居中',
    workflowAlignBottom: '底端对齐',
    workflowDistribute: '平均排布',
    workflowDistributeHorizontal: '水平平均排布',
    workflowDistributeVertical: '垂直平均排布',
    workflowCancelCreate: '取消创建',
    workflowCancelEdit: '取消编辑',
    workflowDeleted: '工作流已删除',
    workflowUndoDelete: '撤销删除',
    workflowRestored: '工作流已恢复',
    workflowSaved: '工作流已保存',
    workflowDismiss: '关闭提示',
    workflowLoading: '正在加载工作流…',
    workflowLoadFailed: '工作流加载失败',
    workflowEmpty: '还没有工作流，先创建一个可运行的工作流。',
    workflowName: '名称',
    workflowDescription: '说明',
    workflowCanvas: '画布',
    workflowInspector: '节点配置',
    workflowNodeSelectHint: '选择画布中的节点来编辑配置。',
    workflowAddNode: '添加节点',
    workflowNodeType: '节点类型',
    workflowNodeLabel: '节点名称',
    workflowInstruction: '指令',
    workflowAiMode: '处理模式',
    workflowAiModeSingle: '单次处理',
    workflowAiModeAutonomous: '自主处理',
    workflowOutputMode: '输出格式',
    workflowOutputText: '文本',
    workflowOutputJson: 'JSON',
    workflowSkillIds: '允许使用的技能 ID（每行一个）',
    workflowSkillId: 'Skill ID',
    workflowMcpTool: 'MCP 工具',
    workflowMcpArguments: 'MCP 参数（JSON）',
    workflowMcpArgumentsHint: '使用 {{input}} 引用工作流输入，使用 {{value}} 引用上游输出。',
    workflowConditionOperator: '条件操作',
    workflowConditionValue: '比较值',
    workflowTransformTemplate: '转换模板',
    workflowShellCommand: 'Shell 命令',
    workflowShellArgs: '参数（每行一个）',
    workflowFileOperation: '文件操作',
    workflowFilePath: '工作区相对路径',
    workflowFileContent: '写入内容',
    workflowValidate: '校验',
    workflowRun: '运行',
    workflowRunning: '运行中…',
    workflowRunSetup: '配置运行',
    workflowRunSetupHint: '填写这个工作流输入节点需要的值，然后开始运行。',
    workflowStartRun: '开始运行',
    workflowModel: '模型',
    workflowUseDefaultModel: '使用默认模型',
    workflowModelHint: '不选择时使用设置中配置的默认模型。',
    workflowRefreshModels: '刷新模型',
    workflowRefreshingModels: '刷新中…',
    workflowNoModels: '暂无可用模型，请检查供应商配置后刷新。',
    workflowCancelSetup: '取消',
    workflowNoLaunchInputs: '这个工作流没有配置输入节点，可直接开始运行。',
    workflowCancel: '取消运行',
    workflowApprove: '通过审批',
    workflowReject: '拒绝审批',
    workflowWaitingApproval: '等待人工审批',
    workflowMaxIterations: '最大迭代次数',
    workflowSystemPrompt: '系统提示词',
    workflowTransformText: '文本',
    workflowResume: '恢复运行',
    workflowRunHistory: '运行记录',
    workflowNoRuns: '还没有运行记录。',
    workflowInput: '运行输入',
    workflowNodeInput: '节点输入',
    workflowNodeOutput: '节点输出',
    workflowManualInput: '手工输入',
    workflowInputFromUpstream: '来自上游节点',
    workflowNodeNoInput: '该节点还没有输入数据。',
    workflowInputHint: '请输入这个输入节点的值。',
    workflowOutput: '运行输出',
    workflowOutputViewLabel: '输出查看方式',
    workflowOutputMarkdown: 'Markdown',
    workflowCopyOutput: '复制结果',
    workflowOpenOutputWindow: '在浮层中打开',
    workflowOutputCopied: '结果已复制',
    workflowDecreaseFont: '减小字体',
    workflowIncreaseFont: '增大字体',
    workflowHideRunSidebar: '隐藏运行记录',
    workflowShowRunSidebar: '显示运行记录',
    workflowResizeExecutionPanel: '调整结果区域高度',
    workflowHistoryCount: (count) => `${count} 条历史记录`,
    workflowUnviewedRuns: (count) => `${count} 条未查看的执行结果`,
    workflowViewUnviewedRun: '查看未读结果',
    workflowCloseOutputWindow: '关闭结果浮层',
    workflowOutputWindow: '结果浮层',
    workflowDragOutputWindow: '拖动查看窗口',
    workflowExpandInput: '展开输入',
    workflowCollapseInput: '收起输入',
    workflowGoUpstream: '到上游',
    workflowExport: '导出 JSON',
    workflowImportJson: '导入 JSON',
    workflowExported: '工作流 JSON 已导出',
    workflowImported: '工作流 JSON 已导入，请确认后保存。',
    workflowGenerate: 'AI 生成',
    workflowGenerateHint: '描述你想自动化的任务，AI 会生成草稿并直接进入编辑器；确认后保存或取消，不会直接执行。',
    workflowGeneratePlaceholder: '例如：读取项目说明，交给智能处理节点总结，再把结果写入 summary.md',
    workflowGenerating: '正在生成…',
    workflowGenerated: '已生成工作流草稿，请确认后保存或取消。',
    workflowGeneratedWithEmployees: (names) => `已生成工作流草稿，并自动创建专业员工：${names}。员工已保存，可直接在“员工”页查看。`,
    workflowGeneratedEmployeeWarnings: (warnings) => `员工创建提示：${warnings}`,
    workflowAllowShellFile: '允许 Shell / 文件节点',
    workflowAllowShellFileHint: '运行前需要显式允许；文件路径仍被限制在当前工作区内。',
    workflowDebugRun: '调试运行',
    workflowDebugRunHint: '保留 30 天的运行记录和内部诊断会话；普通成功运行保留 14 天。',
    workflowValidationFailed: 'Workflow 校验未通过',
    workflowValidationOk: 'Workflow 校验通过',
    workflowRunFailed: 'Workflow 运行失败',
    workflowRunCompleted: 'Workflow 运行完成',
    workflowRunPaused: 'Workflow 已暂停，可恢复',
    workflowRunCancelled: 'Workflow 已取消',
    workflowShowMap: '显示地图',
    workflowHideMap: '隐藏地图',
    workflowNodePending: '等待中',
    workflowNodeRunning: '执行中',
    workflowNodeCompleted: '已完成',
    workflowNodeSkipped: '已跳过',
    workflowNodeFailed: '失败',
    workflowNodeCancelled: '已取消',
    workflowNodeResult: '节点结果',
    workflowNodeResultHint: '点击画布中的节点，查看该节点的输出、错误和运行事件。',
    workflowNodeNoOutput: '该节点暂时没有可查看的输出。',
    workflowNodeStartedAt: '开始',
    workflowNodeCompletedAt: '完成',
    workflowNodeEvents: '节点事件',
    workflowImportEmployee: '为员工创建工作流',
    workflowSelectEmployee: '选择员工',
    workflowImportedEmployee: '已创建员工工作流',
    workflowEmployeeProfile: '员工档案',
    employeeCapabilityResearch: '资料研究',
    employeeCapabilityCopywriting: '文案创作',
    employeeCapabilityImageGeneration: '图像生成',
    employeeCapabilityFileRead: '读取文件',
    employeeCapabilityFileWrite: '写入文件',
    employeeCapabilityWorkflow: '工作流编排',
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
    storeInstallFailed: '插件安装失败',
    storeInstallLogPath: (path) => `详细安装日志：${path}`,
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
    storeEntryTypePlugin: '插件',
    storeEntryTypeMcp: 'MCP 服务',
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
    settingsProxy: '网络代理',
    settingsProxyHint: '为 DSH Runtime 配置 HTTP/HTTPS 代理。启用、停用或切换代理后会立即重启 Runtime；代理密码只保存在主进程中。',
    settingsProxyAdd: '添加代理',
    settingsProxyEdit: '修改',
    settingsProxyDelete: '删除',
    settingsProxyTest: '测试',
    settingsProxyTesting: '测试中…',
    settingsProxyTestSuccess: '代理可用',
    settingsProxyTestFailed: '代理不可用',
    settingsProxyEnable: '启用',
    settingsProxyDisable: '停用',
    settingsProxyActive: '当前启用',
    settingsProxyInactive: '未启用',
    settingsProxyEmpty: '还没有保存代理',
    settingsProxyName: '名称',
    settingsProxyNamePlaceholder: '例如：公司网络',
    settingsProxyProtocol: '协议',
    settingsProxyHost: '地址',
    settingsProxyHostPlaceholder: '例如：127.0.0.1',
    settingsProxyPort: '端口',
    settingsProxyUsername: '用户名（可选）',
    settingsProxyUsernamePlaceholder: '代理认证用户名',
    settingsProxyPassword: '密码（可选）',
    settingsProxyPasswordPlaceholder: '新增密码；修改时留空则保留原密码',
    settingsProxyPasswordHint: '密码不会回传到设置页面。',
    settingsProxyBypass: '绕过地址（可选）',
    settingsProxyBypassPlaceholder: '每行一个域名/IP，例如：example.com',
    settingsProxyBypassHint: 'localhost、127.0.0.1 和 ::1 始终直连。',
    settingsProxySave: '保存代理',
    settingsProxyCancel: '取消',
    settingsProxyDeleteConfirm: '确定删除这个代理吗？',
    settingsProxyOperationFailed: '代理操作失败，请重试',
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
    settingsTabNotifications: '通知和消息',
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
    channelBridgeSessionId: 'DSH 会话标识',
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
    mobileRemoteTitle: '手机浏览器控制',
    mobileRemoteHint: '通过局域网二维码配对手机；配对后可在手机浏览器中查看会话并发送任务。',
    mobileRemoteStatusStarting: '启动中',
    mobileRemoteStatusError: '服务异常',
    mobileRemoteStatusReady: '局域网服务已就绪',
    mobileRemoteStatusStopped: '未启动',
    mobileRemoteLanTitle: '局域网访问',
    mobileRemoteLanHint: '手机和电脑连接同一个 Wi-Fi 后，生成二维码并在桌面端批准本次配对。',
    mobileRemoteStartPairing: '生成配对二维码',
    mobileRemotePairing: '正在生成…',
    mobileRemoteUnavailable: '暂时没有可用的局域网地址。',
    mobileRemoteQrAlt: '手机配对二维码',
    mobileRemoteQrTitle: '请用手机扫描',
    mobileRemoteQrHint: '二维码和链接在 5 分钟后失效；扫码后仍需回到这里点击“允许”。',
    mobileRemoteCancelPairing: '取消配对',
    mobileRemotePendingTitle: '待确认的手机',
    mobileRemoteUnknownDevice: '手机浏览器',
    mobileRemoteApprove: '允许',
    mobileRemoteReject: '拒绝',
    mobileRemoteApproved: '已允许',
    mobileRemoteRejected: '已拒绝',
    mobileRemotePublicTitle: '公网访问（可选）',
    mobileRemotePublicHint: '使用 cloudflared 建立临时 HTTPS 地址，无需配置路由器端口转发。',
    mobileRemotePublicStart: '开启公网访问',
    mobileRemotePublicStarting: '连接中…',
    mobileRemotePublicStop: '关闭公网访问',
    mobileRemotePublicWarning: '临时公网地址适合测试；要长期使用，请改用固定的安全隧道或 VPN。开启后请重新生成配对二维码。',
    mobileRemoteDevicesTitle: '已配对设备',
    mobileRemoteDevicesHint: '设备凭据仅保存在本机；移除后该设备需要重新扫码配对。',
    mobileRemoteDisconnect: '移除',
    mobileRemoteNoDevices: '还没有已配对设备。',
    mobileRemoteOperationFailed: '手机远程服务操作失败',
    mobileRemoteCopyUrl: '点击复制链接',
    mobileRemoteCopyFailed: '复制失败，请手动选择链接。',
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
    settingsRecoveryDeleted: 'Backup deleted',
    settingsRecoveryVerify: 'Verify backup',
    settingsRecoveryVerifyHint: '“Verify backup” only compares the archive with its recorded SHA-256 checksum. It does not restore or modify any data.',
    settingsRecoveryRestore: 'Restore',
    settingsRecoveryDelete: 'Delete backup',
    settingsRecoveryDeleteConfirm: (name) => `Delete backup “${name}”? This cannot be undone.`,
    settingsRecoveryBridgeOutdated: 'The recovery bridge was updated. Fully quit and restart EzDSH, then try again.',
    settingsRecoveryVerified: (ok) => ok ? 'Checksum OK' : 'Checksum FAILED',
    settingsRecoveryIssues: (count) => String(count) + ' Session Log issue(s)',
    settingsArchivedSessions: 'Archived sessions',
    settingsSessionManagement: 'Session management',
    settingsArchivedSessionsHint: 'Archiving does not delete session records. Unarchiving lets a session reappear in the Harness list; permanent deletion will be added once DSH supports it natively, and forcing it now may introduce unknown risks. Existing backup snapshots and shared attachment objects are not removed automatically.',
    settingsArchivedSessionsEmpty: 'No archived sessions',
    settingsArchivedSessionsRefresh: 'Refresh list',
    settingsArchivedSessionsRefreshing: 'Refreshing…',
    settingsArchivedSessionsRestore: 'Unarchive',
    settingsArchivedSessionsRestoring: 'Restoring…',
    settingsArchivedSessionsRestoreAndOpen: 'Restore and open',
    settingsArchivedSessionsRestored: 'Session restored',
    settingsArchivedSessionsDelete: 'Delete permanently',
    settingsArchivedSessionsDeleting: 'Deleting…',
    settingsArchivedSessionsDeleteConfirm: (name) => `Permanently delete session “${name}” from the current workspace? It cannot be restored from Session management; an existing backup may still contain it.`,
    settingsArchivedSessionsDeleted: 'Session permanently deleted from the current workspace',
    settingsArchivedSessionsDeveloperHint: 'Developer mode notice: DSH does not natively support permanent deletion yet, so forcing it now may introduce unknown risks. Existing backup snapshots and shared attachments are not removed automatically.',
    tabHarness: 'DeepSeek Harness',
    tabWorkflow: 'Workflow',
    tabStore: 'Skills',
    tabPresets: 'Preset',
    tabDocs: 'Docs',
    tabEmployees: 'Employees',
    tabSettings: 'Settings',
    employeesTitle: 'AI employees',
    employeesHint: 'Define reusable professional roles as employee profiles with business boundaries, operating guidelines, quality standards, and skill IDs.',
    employeesEmptyTitle: 'Employee control center is in progress',
    employeesEmptyHint: 'The next iteration will add employee roles, capability bindings, task dispatch, and workflow status.',
    employeesPreviewBadge: 'Developer preview',
    employeesList: 'Employee list',
    employeesRefresh: 'Refresh page',
    employeesRefreshContext: 'Refresh projects and sessions',
    employeesRefreshingContext: 'Refreshing projects and sessions…',
    employeesProject: 'Project',
    employeesSession: 'Session',
    employeesSelectProject: 'Select a project',
    employeesSelectSession: 'Select a Session',
    employeesLoadingContext: 'Loading projects and sessions…',
    employeesNewSession: 'New session',
    employeesCreatingSession: 'Creating session…',
    employeesSessionTitlePrompt: 'Enter a session title. Leave it empty to use the default title.',
    employeesAdd: 'New employee',
    employeesDescribeNeed: 'Describe the employee you need',
    employeesDescribeNeedHint: 'Describe the responsibilities, scope, outputs, and quality bar in natural language. The system will generate an editable employee profile.',
    employeesDescribeNeedPlaceholder: 'For example: I need a short-form video strategist who creates evidence-based topics and shoot-ready scripts for early-career professionals.',
    employeesGenerate: 'Generate employee',
    employeesGenerating: 'Generating…',
    employeesGeneratedHint: 'Generated from your description. Review or edit the fields before saving.',
    employeesGenerationRequired: 'Describe the employee you need and generate a profile first.',
    employeesManualInput: 'Enter manually',
    employeesUseAiGeneration: 'Switch to AI generation',
    employeesAssignTask: 'Assign task',
    employeesEdit: 'Edit employee',
    employeesDelete: 'Delete employee',
    employeesSave: 'Save employee',
    employeesCancel: 'Cancel',
    employeesLoading: 'Loading employees…',
    employeesFailed: 'Failed to load employees',
    employeesEmpty: 'No employees yet. Create an employee role to get started.',
    employeesName: 'Employee name',
    employeesRole: 'Role',
    employeesDescription: 'Responsibility summary',
    employeesBusinessBoundary: 'Business boundary',
    employeesSystemPrompt: 'Working principles and system prompt',
    employeesOperatingGuidelines: 'Operating guidelines',
    employeesOperatingGuidelinesHint: 'One per line. Describe how this employee should approach a task.',
    employeesQualityStandards: 'Quality standards',
    employeesQualityStandardsHint: 'One per line. Define the acceptance criteria for completed work.',
    employeesSkillIds: 'Skill IDs',
    employeesSkillIdsHint: 'One callable skill ID per line. Leave empty when no skill is required.',
    employeesProfileVersion: 'Profile version',
    employeesProfileSections: 'Professional profile',
    employeesCapabilities: 'Capabilities',
    employeesWorkflow: 'Workflow steps',
    employeesAddStep: 'Add step',
    employeesStepName: 'Step name',
    employeesStepInstruction: 'Step instruction',
    employeesStepDelete: 'Delete step',
    employeesStepEnabled: 'Enable step',
    employeesEnabled: 'Enabled',
    employeesDisabled: 'Disabled',
    employeesEnable: 'Enable',
    employeesDisable: 'Disable',
    employeesRun: 'Submit',
    employeesTask: 'Task for this employee',
    employeesTaskHint: 'Use a real task to test the employee boundary, guidelines, quality standards, and skill configuration.',
    employeesRunning: 'Running…',
    employeesSessionLocked: 'Session locked',
    employeesRunId: 'Run ID',
    employeesForceUnlock: 'Force unlock',
    employeesRunResults: 'Run result',
    employeesRunCompleted: 'Run completed',
    employeesRunFailed: 'Run failed',
    employeesOutput: 'Output',
    employeesBuiltIn: 'Built-in example',
    employeesNameRequired: 'Enter an employee name.',
    employeesRoleRequired: 'Enter the employee role.',
    employeesPromptRequired: 'Enter working principles or a system prompt.',
    employeesTaskRequired: 'Enter a task to run.',
    employeesProjectRequired: 'Select a project.',
    employeesSessionRequired: 'Select a Session.',
    employeesStepRequired: 'Every workflow step needs a name and instruction.',
    workflowTitle: 'Workflow orchestration',
    workflowHint: 'Use AI Processing for lightweight tasks and Professional Employees for governed roles, composed with Skills, MCP tools, conditions, and file nodes.',
    workflowChoose: 'Choose a workflow to begin',
    workflowRefresh: 'Refresh list',
    workflowBack: 'Workflow list',
    workflowEditor: 'Editor',
    workflowExecutions: 'Executions',
    workflowWorkspace: 'Workspace',
    workflowChooseRun: 'Choose a run to inspect',
    workflowNew: 'New workflow',
    workflowDuplicate: 'Duplicate workflow',
    workflowDelete: 'Delete workflow',
    workflowDeleteConfirm: (name) => `Delete workflow “${name}”? Existing run records will be kept.`,
    workflowSave: 'Save',
    workflowUndo: 'Undo',
    workflowRedo: 'Redo',
    workflowContextMenu: 'Workflow canvas menu',
    workflowDeleteNode: 'Delete node',
    workflowDeleteEdge: 'Delete edge',
    workflowDeleteSelection: 'Delete selection',
    workflowFitView: 'Fit canvas',
    workflowAlign: 'Align nodes',
    workflowAlignLeft: 'Align left',
    workflowAlignCenterHorizontal: 'Align center horizontally',
    workflowAlignRight: 'Align right',
    workflowAlignTop: 'Align top',
    workflowAlignCenterVertical: 'Align center vertically',
    workflowAlignBottom: 'Align bottom',
    workflowDistribute: 'Distribute evenly',
    workflowDistributeHorizontal: 'Distribute horizontally',
    workflowDistributeVertical: 'Distribute vertically',
    workflowCancelCreate: 'Cancel creation',
    workflowCancelEdit: 'Cancel editing',
    workflowDeleted: 'Workflow deleted',
    workflowUndoDelete: 'Undo delete',
    workflowRestored: 'Workflow restored',
    workflowSaved: 'Workflow saved',
    workflowDismiss: 'Dismiss notification',
    workflowLoading: 'Loading workflows…',
    workflowLoadFailed: 'Could not load workflows',
    workflowEmpty: 'No workflows yet. Create one to automate a task.',
    workflowName: 'Name',
    workflowDescription: 'Description',
    workflowCanvas: 'Canvas',
    workflowInspector: 'Node configuration',
    workflowNodeSelectHint: 'Select a node on the canvas to edit its configuration.',
    workflowAddNode: 'Add node',
    workflowNodeType: 'Node type',
    workflowNodeLabel: 'Node label',
    workflowInstruction: 'Instruction',
    workflowAiMode: 'Processing mode',
    workflowAiModeSingle: 'Single task',
    workflowAiModeAutonomous: 'Autonomous',
    workflowOutputMode: 'Output format',
    workflowOutputText: 'Text',
    workflowOutputJson: 'JSON',
    workflowSkillIds: 'Allowed skill IDs (one per line)',
    workflowSkillId: 'Skill ID',
    workflowMcpTool: 'MCP tool',
    workflowMcpArguments: 'MCP arguments (JSON)',
    workflowMcpArgumentsHint: 'Use {{input}} for workflow input and {{value}} for upstream output.',
    workflowConditionOperator: 'Condition operator',
    workflowConditionValue: 'Comparison value',
    workflowTransformTemplate: 'Transform template',
    workflowShellCommand: 'Shell command',
    workflowShellArgs: 'Arguments (one per line)',
    workflowFileOperation: 'File operation',
    workflowFilePath: 'Workspace-relative path',
    workflowFileContent: 'Write content',
    workflowValidate: 'Validate',
    workflowRun: 'Run',
    workflowRunning: 'Running…',
    workflowRunSetup: 'Configure run',
    workflowRunSetupHint: 'Fill in the values required by this workflow’s Input nodes, then start the run.',
    workflowStartRun: 'Start run',
    workflowModel: 'Model',
    workflowUseDefaultModel: 'Use default model',
    workflowModelHint: 'When no model is selected, the configured default model is used.',
    workflowRefreshModels: 'Refresh models',
    workflowRefreshingModels: 'Refreshing…',
    workflowNoModels: 'No available models. Check provider settings and refresh.',
    workflowCancelSetup: 'Cancel',
    workflowNoLaunchInputs: 'This workflow has no Input nodes configured and can run immediately.',
    workflowCancel: 'Cancel run',
    workflowApprove: 'Approve',
    workflowReject: 'Reject',
    workflowWaitingApproval: 'Waiting for approval',
    workflowMaxIterations: 'Max iterations',
    workflowSystemPrompt: 'System prompt',
    workflowTransformText: 'Text',
    workflowResume: 'Resume run',
    workflowRunHistory: 'Run history',
    workflowNoRuns: 'No run records yet.',
    workflowInput: 'Run input',
    workflowNodeInput: 'Node input',
    workflowNodeOutput: 'Node output',
    workflowManualInput: 'Manual input',
    workflowInputFromUpstream: 'From upstream node',
    workflowNodeNoInput: 'This node has no input data yet.',
    workflowInputHint: 'Enter a value for this Input node.',
    workflowOutput: 'Run output',
    workflowOutputViewLabel: 'Output view',
    workflowOutputMarkdown: 'Markdown',
    workflowCopyOutput: 'Copy result',
    workflowOpenOutputWindow: 'Open in floating window',
    workflowOutputCopied: 'Result copied',
    workflowDecreaseFont: 'Decrease font size',
    workflowIncreaseFont: 'Increase font size',
    workflowHideRunSidebar: 'Hide run history',
    workflowShowRunSidebar: 'Show run history',
    workflowResizeExecutionPanel: 'Resize result area',
    workflowHistoryCount: (count) => `${count} history record${count === 1 ? '' : 's'}`,
    workflowUnviewedRuns: (count) => `${count} unviewed run${count === 1 ? '' : 's'}`,
    workflowViewUnviewedRun: 'View unviewed result',
    workflowCloseOutputWindow: 'Close result window',
    workflowOutputWindow: 'Result window',
    workflowDragOutputWindow: 'Drag result window',
    workflowExpandInput: 'Expand input',
    workflowCollapseInput: 'Collapse input',
    workflowGoUpstream: 'Go upstream',
    workflowExport: 'Export JSON',
    workflowImportJson: 'Import JSON',
    workflowExported: 'Workflow JSON exported',
    workflowImported: 'Workflow JSON imported. Review it, then save.',
    workflowGenerate: 'Generate with AI',
    workflowGenerateHint: 'Describe the task to automate. AI creates a draft and opens it in the editor; save or cancel after review, and never executes it directly.',
    workflowGeneratePlaceholder: 'For example: read the project brief, summarize it with AI Processing, then write the result to summary.md',
    workflowGenerating: 'Generating…',
    workflowGenerated: 'Workflow draft generated. Review it, then save or cancel.',
    workflowGeneratedWithEmployees: (names) => `Workflow draft generated and professional employees created: ${names}. They are saved and visible on the Employees page.`,
    workflowGeneratedEmployeeWarnings: (warnings) => `Employee creation notice: ${warnings}`,
    workflowAllowShellFile: 'Allow Shell / File nodes',
    workflowAllowShellFileHint: 'Explicit permission is required before a run; file paths remain confined to the workspace.',
    workflowDebugRun: 'Debug run',
    workflowDebugRunHint: 'Keep run history and internal diagnostics for 30 days; normal successful runs are kept for 14 days.',
    workflowValidationFailed: 'Workflow validation failed',
    workflowValidationOk: 'Workflow validation passed',
    workflowRunFailed: 'Workflow run failed',
    workflowRunCompleted: 'Workflow run completed',
    workflowRunPaused: 'Workflow paused and can be resumed',
    workflowRunCancelled: 'Workflow run cancelled',
    workflowShowMap: 'Show map',
    workflowHideMap: 'Hide map',
    workflowNodePending: 'Pending',
    workflowNodeRunning: 'Running',
    workflowNodeCompleted: 'Completed',
    workflowNodeSkipped: 'Skipped',
    workflowNodeFailed: 'Failed',
    workflowNodeCancelled: 'Cancelled',
    workflowNodeResult: 'Node result',
    workflowNodeResultHint: 'Select a node on the canvas to inspect its output, error, and run events.',
    workflowNodeNoOutput: 'This node has no output available yet.',
    workflowNodeStartedAt: 'Started',
    workflowNodeCompletedAt: 'Completed',
    workflowNodeEvents: 'Node events',
    workflowImportEmployee: 'Create workflow for employee',
    workflowSelectEmployee: 'Select employee',
    workflowImportedEmployee: 'Employee workflow created',
    workflowEmployeeProfile: 'Employee profile',
    employeeCapabilityResearch: 'Research',
    employeeCapabilityCopywriting: 'Copywriting',
    employeeCapabilityImageGeneration: 'Image generation',
    employeeCapabilityFileRead: 'Read files',
    employeeCapabilityFileWrite: 'Write files',
    employeeCapabilityWorkflow: 'Workflow orchestration',
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
    storeInstallFailed: 'Plugin installation failed',
    storeInstallLogPath: (path) => `Detailed install log: ${path}`,
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
    storeEntryTypePlugin: 'Plugin',
    storeEntryTypeMcp: 'MCP server',
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
    settingsProxy: 'Network proxy',
    settingsProxyHint: 'Configure an HTTP/HTTPS proxy for the DSH Runtime. Enabling, disabling, or switching a proxy restarts the Runtime immediately; proxy passwords stay in the main process.',
    settingsProxyAdd: 'Add proxy',
    settingsProxyEdit: 'Edit',
    settingsProxyDelete: 'Delete',
    settingsProxyTest: 'Test',
    settingsProxyTesting: 'Testing…',
    settingsProxyTestSuccess: 'Proxy is reachable',
    settingsProxyTestFailed: 'Proxy is unavailable',
    settingsProxyEnable: 'Enable',
    settingsProxyDisable: 'Disable',
    settingsProxyActive: 'Active',
    settingsProxyInactive: 'Inactive',
    settingsProxyEmpty: 'No saved proxies yet',
    settingsProxyName: 'Name',
    settingsProxyNamePlaceholder: 'e.g. Office network',
    settingsProxyProtocol: 'Protocol',
    settingsProxyHost: 'Host',
    settingsProxyHostPlaceholder: 'e.g. 127.0.0.1',
    settingsProxyPort: 'Port',
    settingsProxyUsername: 'Username (optional)',
    settingsProxyUsernamePlaceholder: 'Proxy authentication username',
    settingsProxyPassword: 'Password (optional)',
    settingsProxyPasswordPlaceholder: 'New password; leave blank while editing to keep the old one',
    settingsProxyPasswordHint: 'The password is never sent back to the settings page.',
    settingsProxyBypass: 'Bypass addresses (optional)',
    settingsProxyBypassPlaceholder: 'One domain/IP per line, e.g. example.com',
    settingsProxyBypassHint: 'localhost, 127.0.0.1, and ::1 always connect directly.',
    settingsProxySave: 'Save proxy',
    settingsProxyCancel: 'Cancel',
    settingsProxyDeleteConfirm: 'Delete this proxy?',
    settingsProxyOperationFailed: 'Proxy operation failed. Try again.',
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
    settingsTabNotifications: 'Notifications & messages',
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
    mobileRemoteTitle: 'Mobile browser control',
    mobileRemoteHint: 'Pair a phone over LAN with a QR code, then view sessions and send tasks from its browser.',
    mobileRemoteStatusStarting: 'Starting',
    mobileRemoteStatusError: 'Service error',
    mobileRemoteStatusReady: 'LAN service ready',
    mobileRemoteStatusStopped: 'Stopped',
    mobileRemoteLanTitle: 'LAN access',
    mobileRemoteLanHint: 'Connect the phone and computer to the same Wi-Fi, generate a QR code, then approve the pairing here.',
    mobileRemoteStartPairing: 'Generate pairing QR',
    mobileRemotePairing: 'Generating…',
    mobileRemoteUnavailable: 'No usable LAN address is available right now.',
    mobileRemoteQrAlt: 'Phone pairing QR code',
    mobileRemoteQrTitle: 'Scan with your phone',
    mobileRemoteQrHint: 'The QR code and link expire in 5 minutes. After scanning, return here and approve the request.',
    mobileRemoteCancelPairing: 'Cancel pairing',
    mobileRemotePendingTitle: 'Phone awaiting approval',
    mobileRemoteUnknownDevice: 'Mobile browser',
    mobileRemoteApprove: 'Allow',
    mobileRemoteReject: 'Reject',
    mobileRemoteApproved: 'Allowed',
    mobileRemoteRejected: 'Rejected',
    mobileRemotePublicTitle: 'Internet access (optional)',
    mobileRemotePublicHint: 'Use cloudflared to create a temporary HTTPS address without router port forwarding.',
    mobileRemotePublicStart: 'Enable internet access',
    mobileRemotePublicStarting: 'Connecting…',
    mobileRemotePublicStop: 'Disable internet access',
    mobileRemotePublicWarning: 'Temporary public addresses are for testing. For long-term use, choose a fixed secure tunnel or VPN. Generate a new pairing QR after enabling it.',
    mobileRemoteDevicesTitle: 'Paired devices',
    mobileRemoteDevicesHint: 'Device credentials stay on this computer. Removed devices must pair again.',
    mobileRemoteDisconnect: 'Remove',
    mobileRemoteNoDevices: 'No paired devices yet.',
    mobileRemoteOperationFailed: 'Mobile remote operation failed',
    mobileRemoteCopyUrl: 'Click to copy link',
    mobileRemoteCopyFailed: 'Copy failed; select the link manually.',
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
