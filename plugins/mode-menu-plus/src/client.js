window.__ModuleLoader__.load({
  id: 'mode-menu-plus',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const { jsx, jsxs } = require('react/jsx-runtime')
    const { useState, useEffect } = require('react')
    const { createSnapshotStore } = require('@deepseek-ai/dsh-client-runtime/client')
    const {
      Menu,
      IconAgentPresetOutline16,
      IconChevronDownOutline14,
    } = require('@deepseek-ai/dsh-client-ui-primitives')

    const NS = 'modeMenuPlus'
    const SLOT_NAME = 'conversation.hero.agentPreset'
    const HUB_URL = 'https://hub.ezdsh.com'
    const FOOTER_ID = 'mode-menu-plus:see-more'

    const en = {
      seeMore: 'See more plugins',
      seatHint: 'Agent preset for the session you are about to start',
      userTrust: 'Custom',
      noDescription: 'No description.',
      presetStandardName: 'Standard mode',
      presetStandardDescription:
        'Full coding agent with file editing, shell, file and web search, skills, planning, goals, subagents, and workflows.',
      presetCodeName: 'Code mode',
      presetCodeDescription:
        'All Standard mode capabilities, with tools exposed through the Code Mode SDK so the model can combine multi-step operations in one TypeScript program.',
      presetMinimalName: 'Minimal mode',
      presetMinimalDescription: 'Two-tool coding agent with persistent bash and str_replace_editor.',
      presetCordisName: 'Creator mode',
      presetCordisDescription:
        'Built for creating custom agent presets, with all Standard mode capabilities plus runtime inspection, plugin experiments, and preset-authoring guidance.',
    }
    const zh = {
      seeMore: '查看更多插件',
      seatHint: '即将开始的这个会话所用的 Agent 预设',
      userTrust: '自定义',
      noDescription: '暂无描述。',
      presetStandardName: '标准模式',
      presetStandardDescription:
        '功能完整的编码 Agent，支持文件编辑、Shell、文件与网页检索、Skills、计划、目标、子代理和工作流。',
      presetCodeName: 'PTC 模式',
      presetCodeDescription:
        '具备标准模式的全部能力，并通过 Code Mode SDK 呈现工具，让模型用一个 TypeScript 程序组合多步操作。',
      presetMinimalName: '极简模式',
      presetMinimalDescription: '仅提供持久 bash 与 str_replace_editor 的双工具编码 Agent。',
      presetCordisName: '创造模式',
      presetCordisDescription:
        '用于创建自定义 Agent preset：具备标准模式的全部能力，并提供运行时检查、插件实验和 preset 创作指导。',
    }

    const BUILT_IN_PRESET_KEYS = {
      standard: { name: 'presetStandardName', description: 'presetStandardDescription' },
      code: { name: 'presetCodeName', description: 'presetCodeDescription' },
      minimal: { name: 'presetMinimalName', description: 'presetMinimalDescription' },
      cordis: { name: 'presetCordisName', description: 'presetCordisDescription' },
    }

    function presetDisplayText(preset, t) {
      const keys = preset.trust === 'system' ? BUILT_IN_PRESET_KEYS[preset.id] : void 0
      if (keys !== void 0) return { name: t(keys.name), description: t(keys.description) }
      return {
        name: preset.name ?? preset.id,
        ...(preset.description === void 0 ? {} : { description: preset.description }),
      }
    }

    function presetOptions(presets) {
      return presets
        .filter((preset) => preset.broken === void 0)
        .map((preset) => ({
          id: preset.id,
          trust: preset.trust,
          ...(preset.name === void 0 ? {} : { name: preset.name }),
          ...(preset.description === void 0 ? {} : { description: preset.description }),
        }))
    }

    function messageOf(error) {
      return error instanceof Error ? error.message : String(error)
    }

    const css = {
      seat: 'mmp_seat',
      seatIcon: 'mmp_seatIcon',
      chevron: 'mmp_chevron',
      item: 'mmp_item',
      itemName: 'mmp_itemName',
      itemDesc: 'mmp_itemDesc',
    }

    const CSS_TEXT =
      '.mmp_seat{max-width:min(100%,240px);min-height:28px;color:var(--dsw-alias-label-primary);white-space:nowrap;text-overflow:ellipsis;cursor:pointer;background:0 0;border:none;border-radius:16px;align-items:center;gap:4px;padding:0 8px;font-size:13px;font-weight:500;line-height:20px;display:inline-flex;overflow:hidden}.mmp_seat:not(:disabled):hover,.mmp_seat[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover)}.mmp_seat:disabled{cursor:default;color:var(--dsw-alias-label-quaternary)}.mmp_seatIcon{color:var(--dsw-alias-label-primary);flex:none}.mmp_chevron{color:var(--dsw-alias-label-caption);flex:none}.mmp_item{flex-direction:column;gap:2px;max-width:280px;display:flex}.mmp_itemName{color:var(--dsw-alias-label-primary);font-size:14px;line-height:20px}.mmp_itemDesc{color:var(--dsw-alias-label-caption);white-space:normal;font-size:11px;line-height:16px}'

    function installCss() {
      if (typeof document === 'undefined') return
      const tagId = 'mode-menu-plus/ModeMenuSeat.module.css'
      if (document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') !== null) return
      const tag = document.createElement('style')
      tag.dataset.plugin = 'mode-menu-plus'
      tag.dataset.pluginCss = tagId
      tag.textContent = CSS_TEXT
      document.head.appendChild(tag)
    }

    const INITIAL = { options: [], current: '', error: null, busy: false, introduce: false }

    class ModeMenuSeatController {
      constructor(api, currentSession, onApplied) {
        this.api = api
        this.currentSession = currentSession
        this.onApplied = onApplied
      }

      store = createSnapshotStore(INITIAL)
      fallback = ''
      staged

      set(patch) {
        this.store.set({ ...this.store.getSnapshot(), ...patch })
      }

      async load() {
        try {
          const response = await this.api.agentPresets.list({})
          if (!response.result.ok) {
            this.set({ error: response.result.error.message })
            return
          }
          const { presets } = response.result.value
          this.fallback = presets.find((preset) => preset.isDefault)?.id ?? presets[0]?.id ?? ''
          this.set({
            options: presetOptions(presets),
            current: this.staged ?? this.currentSession()?.agentPreset ?? this.fallback,
            error: null,
          })
        } catch (error) {
          this.set({ error: messageOf(error) })
        }
      }

      async select(id) {
        if (this.store.getSnapshot().busy) return
        this.stage(id)
        await this.apply()
      }

      stage(id, introduce = false) {
        this.staged = id
        this.set({ current: id, error: null, introduce })
      }

      introduced() {
        if (!this.store.getSnapshot().introduce) return
        this.set({ introduce: false })
      }

      async apply() {
        const staged = this.staged
        const session = this.currentSession()
        if (staged === void 0 || session === void 0) return
        if (!session.blank || session.agentPreset === staged) {
          this.staged = void 0
          return
        }
        this.set({ busy: true, error: null })
        try {
          const response = await this.api.agentPresets.select({ sessionId: session.id, agentPreset: staged })
          this.staged = void 0
          if (!response.result.ok) {
            this.set({ busy: false, error: response.result.error.message, current: this.fallback })
            return
          }
          this.set({ busy: false, current: response.result.value.agentPreset })
          this.onApplied?.(session.id, response.result.value.agentPreset)
        } catch (error) {
          this.staged = void 0
          this.set({ busy: false, error: messageOf(error), current: this.fallback })
        }
      }
    }

    function ModeMenuSeat({ useAgentPresetSeat, load, select, t }) {
      const state = useAgentPresetSeat((snapshot) => snapshot)
      const [open, setOpen] = useState(false)
      useEffect(() => {
        load()
      }, [load])
      const chosen = state.options.find((option) => option.id === state.current)
      const label = (chosen === void 0 ? void 0 : presetDisplayText(chosen, t).name) ?? state.current
      const ready = state.options.length > 0 && state.current !== ''
      if (!ready) return null
      return jsx(Menu, {
        open,
        onClose: () => {
          setOpen(false)
        },
        items: state.options.map((option) => {
          const text = presetDisplayText(option, t)
          return {
            id: option.id,
            label: jsxs('span', {
              className: css.item,
              children: [
                jsx('span', { className: css.itemName, children: text.name }),
                jsx('span', { className: css.itemDesc, children: text.description ?? t('noDescription') }),
              ],
            }),
          }
        }),
        footer: [{ id: FOOTER_ID, label: t('seeMore') }],
        selectedId: state.current,
        onSelect: (id) => {
          setOpen(false)
          if (id === FOOTER_ID) {
            window.open(HUB_URL, '_blank', 'noopener')
            return
          }
          select(id)
        },
        align: 'start',
        portal: true,
        anchor: jsxs('button', {
          type: 'button',
          className: css.seat,
          'aria-haspopup': 'menu',
          'aria-expanded': open,
          title: state.error ?? t('seatHint'),
          disabled: state.busy,
          onClick: () => {
            setOpen((value) => !value)
          },
          children: [
            jsx(IconAgentPresetOutline16, { className: css.seatIcon }),
            label,
            jsx(IconChevronDownOutline14, { className: css.chevron }),
          ],
        }),
      })
    }

    const inject = ['slots', 'locale', 'connection', 'remote']

    function apply(ctx) {
      installCss()
      ctx.effect(() => ctx.get('locale').register(NS, { zh, en }))
      ctx.inject(['slots', 'sessions'], (scope) => {
        const api = scope.get('connection').api
        const seat = new ModeMenuSeatController(
          api,
          () => {
            const state = scope.sessions.list.getSnapshot()
            const summary = state.current === void 0 ? void 0 : state.byId[state.current]
            return summary === void 0
              ? void 0
              : {
                  id: summary.id,
                  blank: summary.blank,
                  ...(summary.agentPreset === void 0 ? {} : { agentPreset: summary.agentPreset }),
                }
          },
          (sessionId, agentPreset) => {
            scope.sessions.noteAgentPreset(sessionId, agentPreset)
          },
        )
        const seatInjected = () => ({
          hooks: { agentPresetSeat: seat.store },
          load: () => seat.load(),
          select: (id) => seat.select(id),
          introduced: () => {
            seat.introduced()
          },
        })
        const stop = scope.sessions.list.subscribe(() => {
          seat.apply()
        })
        const settingsMoved = scope.remote.$on('settings/document-updated', (ns) => {
          if (ns !== 'agent-presets') return
          seat.load()
        })
        const presetSelected = scope.remote.$on('agent-preset/selected', (sessionId, agentPreset) => {
          scope.sessions.noteAgentPreset(sessionId, agentPreset)
        })
        const chip = scope.slots.register(
          {
            name: SLOT_NAME,
            priority: -1,
            locale: NS,
            inject: seatInjected,
          },
          ModeMenuSeat,
        )
        return () => {
          stop()
          settingsMoved()
          presetSelected()
          chip()
        }
      }, 'mode-menu-plus: new-session mode menu')
    }

    exports.apply = apply
    exports.inject = inject
    exports.presetDisplayText = presetDisplayText
    exports.presetOptions = presetOptions
    exports.messageOf = messageOf
    return module.exports
  },
})
