window.__ModuleLoader__.load({
  id: '@ezdsh/chat-search',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const { jsx, jsxs } = require('react/jsx-runtime')
    const { useCallback, useEffect, useRef, useState } = require('react')
    const {
      IconSearchOutline16,
      IconChevronDownOutline14,
      IconChevronUpOutline14,
      IconCloseOutline16,
    } = require('@deepseek-ai/dsh-client-ui-primitives')

    const NS = 'ezdshChatSearch'
    const ROUTE = '/api/ezdsh.chat-search'
    const HIGHLIGHT_NAME = 'ezdsh-chat-search'
    const ACTIVE_CLASS = 'ezdsh-chat-search-target'
    const STYLE_ID = 'ezdsh-chat-search/styles'
    const SEARCH_DELAY_MS = 180

    const en = {
      open: 'Search conversation',
      placeholder: 'Search this conversation',
      previous: 'Previous match',
      next: 'Next match',
      close: 'Close search',
      idle: 'Type to search the complete conversation',
      loading: 'Searching…',
      empty: 'No matches',
      resultCount: '{current} / {total}',
      failed: 'Search failed',
      unavailable: 'That match could not be displayed',
    }
    const zh = {
      open: '搜索当前会话',
      placeholder: '搜索当前会话',
      previous: '上一个匹配项',
      next: '下一个匹配项',
      close: '关闭搜索',
      idle: '输入关键词以搜索完整会话',
      loading: '正在搜索…',
      empty: '没有匹配项',
      resultCount: '{current} / {total}',
      failed: '搜索失败',
      unavailable: '无法显示该匹配项',
    }

    function installCss() {
      if (document.getElementById(STYLE_ID) !== null) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.setAttribute('data-plugin', '@ezdsh/chat-search')
      style.textContent = `
.ezdsh-chat-search-trigger {
  width: 30px;
  height: 30px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 8px;
  color: var(--dsw-alias-label-secondary);
  background: transparent;
  cursor: pointer;
}
.ezdsh-chat-search-trigger:hover,
.ezdsh-chat-search-trigger[aria-expanded="true"] {
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-interactive-bg-hover);
}
.ezdsh-chat-search-panel {
  position: fixed;
  z-index: 1200;
  top: 58px;
  right: 22px;
  width: min(420px, calc(100vw - 32px));
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  background: var(--dsw-specific-menu);
  box-shadow: 0 12px 36px rgba(0, 0, 0, 0.18);
}
.ezdsh-chat-search-field {
  min-width: 0;
  flex: 1;
  height: 32px;
  padding: 0 9px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  outline: none;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-specific-input-major);
  font: inherit;
}
.ezdsh-chat-search-field:focus {
  border-color: var(--dsw-alias-state-business-primary);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-business-primary) 24%, transparent);
}
.ezdsh-chat-search-status {
  flex: 0 0 auto;
  min-width: 48px;
  max-width: 92px;
  overflow: hidden;
  color: var(--dsw-alias-label-caption);
  font-size: 12px;
  text-align: center;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ezdsh-chat-search-action {
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  border: 0;
  border-radius: 7px;
  color: var(--dsw-alias-label-secondary);
  background: transparent;
  cursor: pointer;
}
.ezdsh-chat-search-action:hover:not(:disabled) {
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-interactive-bg-hover);
}
.ezdsh-chat-search-action:disabled {
  cursor: default;
  opacity: 0.35;
}
.${ACTIVE_CLASS} {
  border-radius: 10px;
  outline: 2px solid var(--dsw-alias-state-business-primary);
  outline-offset: 5px;
}
::highlight(${HIGHLIGHT_NAME}) {
  color: inherit;
  background: rgba(255, 196, 61, 0.58);
}
@media (max-width: 700px) {
  .ezdsh-chat-search-panel {
    top: 52px;
    right: 12px;
    width: calc(100vw - 24px);
  }
  .ezdsh-chat-search-status { min-width: 42px; }
}
`
      document.head.appendChild(style)
    }

    function clearHighlight() {
      document.querySelectorAll(`.${ACTIVE_CLASS}`).forEach((element) => {
        element.classList.remove(ACTIVE_CLASS)
      })
      const registry = globalThis.CSS?.highlights
      if (registry !== undefined) registry.delete(HIGHLIGHT_NAME)
    }

    function textRanges(root, query) {
      const terms = [...new Set(query.trim().split(/\s+/u).filter(Boolean))]
        .sort((left, right) => right.length - left.length)
      if (terms.length === 0) return []
      const ranges = []
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      let node = walker.nextNode()
      while (node !== null) {
        const parent = node.parentElement
        if (parent !== null && parent.closest('button, input, textarea, style, script') === null) {
          const source = node.nodeValue ?? ''
          const lower = source.toLocaleLowerCase()
          for (const term of terms) {
            const needle = term.toLocaleLowerCase()
            let offset = 0
            while (needle.length > 0) {
              const found = lower.indexOf(needle, offset)
              if (found === -1) break
              const range = document.createRange()
              range.setStart(node, found)
              range.setEnd(node, found + needle.length)
              ranges.push(range)
              offset = found + needle.length
            }
          }
        }
        node = walker.nextNode()
      }
      return ranges
    }

    function applyHighlight(element, query) {
      const HighlightCtor = globalThis.Highlight
      const registry = globalThis.CSS?.highlights
      if (typeof HighlightCtor !== 'function' || registry === undefined) return
      const ranges = textRanges(element, query)
      if (ranges.length > 0) registry.set(HIGHLIGHT_NAME, new HighlightCtor(...ranges))
    }

    function selectorForNodeKey(nodeKey) {
      const escaped = globalThis.CSS?.escape?.(nodeKey)
        ?? nodeKey.replace(/["\\]/gu, (character) => `\\${character}`)
      return `[data-chat-anchor-key="${escaped}"]`
    }

    function revealHidden(element) {
      const hidden = []
      let current = element
      while (current !== null) {
        if (current.getAttribute?.('hidden') === 'until-found') hidden.push(current)
        current = current.parentElement
      }
      for (const candidate of hidden.reverse()) candidate.dispatchEvent(new Event('beforematch'))
    }

    function nextFrame() {
      return new Promise((resolve) => requestAnimationFrame(() => resolve()))
    }

    async function locateNode(nodeKey) {
      const selector = selectorForNodeKey(nodeKey)
      for (let attempt = 0; attempt < 24; attempt += 1) {
        const element = document.querySelector(selector)
        if (element !== null) return element
        await nextFrame()
      }
      return null
    }

    function ChatSearchAction({ sessionId, search, focusHit, clear, t }) {
      const [open, setOpen] = useState(false)
      const [query, setQuery] = useState('')
      const [items, setItems] = useState([])
      const [active, setActive] = useState(-1)
      const [loading, setLoading] = useState(false)
      const [error, setError] = useState(null)
      const inputRef = useRef(null)
      const requestRef = useRef(0)
      const itemsRef = useRef(items)
      const activeRef = useRef(active)
      const queryRef = useRef(query)
      itemsRef.current = items
      activeRef.current = active
      queryRef.current = query

      const focusInput = useCallback(() => {
        requestAnimationFrame(() => {
          inputRef.current?.focus()
          inputRef.current?.select()
        })
      }, [])

      const show = useCallback(() => {
        setOpen(true)
        focusInput()
      }, [focusInput])

      const hide = useCallback(() => {
        setOpen(false)
        setError(null)
        clear()
      }, [clear])

      const activate = useCallback((index) => {
        const matches = itemsRef.current
        if (matches.length === 0) return
        const normalized = (index + matches.length) % matches.length
        setActive(normalized)
        setError(null)
        void focusHit(sessionId, matches[normalized], queryRef.current).catch(() => {
          setError(t('unavailable'))
        })
      }, [focusHit, sessionId, t])

      useEffect(() => {
        const onKeyDown = (event) => {
          const find = (event.metaKey || event.ctrlKey)
            && !event.altKey
            && event.key.toLocaleLowerCase() === 'f'
          if (find) {
            event.preventDefault()
            event.stopPropagation()
            show()
            return
          }
          if (!open) return
          if (event.key === 'Escape') {
            event.preventDefault()
            hide()
          }
        }
        document.addEventListener('keydown', onKeyDown, true)
        return () => document.removeEventListener('keydown', onKeyDown, true)
      }, [hide, open, show])

      useEffect(() => {
        const normalized = query.trim().replace(/\s+/gu, ' ')
        const requestId = ++requestRef.current
        const controller = new AbortController()
        if (normalized.length === 0) {
          setItems([])
          setActive(-1)
          setLoading(false)
          setError(null)
          clear()
          return () => controller.abort()
        }
        setLoading(true)
        setError(null)
        const timer = setTimeout(() => {
          void search(sessionId, normalized, controller.signal).then((matches) => {
            if (requestRef.current !== requestId || controller.signal.aborted) return
            setItems(matches)
            itemsRef.current = matches
            setActive(matches.length === 0 ? -1 : 0)
            setLoading(false)
            clear()
            if (matches.length > 0) {
              void focusHit(sessionId, matches[0], normalized).catch(() => {
                setError(t('unavailable'))
              })
            }
          }, () => {
            if (requestRef.current !== requestId || controller.signal.aborted) return
            setItems([])
            setActive(-1)
            setLoading(false)
            setError(t('failed'))
            clear()
          })
        }, SEARCH_DELAY_MS)
        return () => {
          clearTimeout(timer)
          controller.abort()
        }
      }, [clear, focusHit, query, search, sessionId, t])

      const onInputKeyDown = (event) => {
        if (event.key !== 'Enter') return
        event.preventDefault()
        activate(activeRef.current + (event.shiftKey ? -1 : 1))
      }

      const status = error !== null
        ? error
        : loading
          ? t('loading')
          : query.trim().length === 0
            ? t('idle')
            : items.length === 0
              ? t('empty')
              : t('resultCount', { current: active + 1, total: items.length })

      return jsxs('div', {
        children: [
          jsx('button', {
            type: 'button',
            className: 'ezdsh-chat-search-trigger',
            title: t('open'),
            'aria-label': t('open'),
            'aria-expanded': open,
            onClick: open ? hide : show,
            children: jsx(IconSearchOutline16, {}),
          }),
          open ? jsxs('div', {
            className: 'ezdsh-chat-search-panel',
            role: 'search',
            children: [
              jsx('input', {
                ref: inputRef,
                className: 'ezdsh-chat-search-field',
                value: query,
                maxLength: 500,
                placeholder: t('placeholder'),
                'aria-label': t('placeholder'),
                onChange: (event) => setQuery(event.currentTarget.value),
                onKeyDown: onInputKeyDown,
              }),
              jsx('span', {
                className: 'ezdsh-chat-search-status',
                role: 'status',
                title: status,
                children: status,
              }),
              jsx('button', {
                type: 'button',
                className: 'ezdsh-chat-search-action',
                title: t('previous'),
                'aria-label': t('previous'),
                disabled: loading || items.length === 0,
                onClick: () => activate(activeRef.current - 1),
                children: jsx(IconChevronUpOutline14, {}),
              }),
              jsx('button', {
                type: 'button',
                className: 'ezdsh-chat-search-action',
                title: t('next'),
                'aria-label': t('next'),
                disabled: loading || items.length === 0,
                onClick: () => activate(activeRef.current + 1),
                children: jsx(IconChevronDownOutline14, {}),
              }),
              jsx('button', {
                type: 'button',
                className: 'ezdsh-chat-search-action',
                title: t('close'),
                'aria-label': t('close'),
                onClick: hide,
                children: jsx(IconCloseOutline16, {}),
              }),
            ],
          }) : null,
        ],
      })
    }

    const inject = ['slots', 'locale', 'sessions']

    function apply(ctx) {
      installCss()
      ctx.effect(() => ctx.get('locale').register(NS, { zh, en }))
      ctx.inject(['slots', 'locale', 'sessions'], (scope) => {
        const clear = () => clearHighlight()
        const search = async (sessionId, query, signal) => {
          const response = await globalThis.fetch(ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId, query }),
            signal,
          })
          const result = await response.json()
          if (!response.ok || !result.ok) throw new Error(result.error?.code ?? `HTTP ${response.status}`)
          return Array.isArray(result.value?.items) ? result.value.items : []
        }
        const focusHit = async (sessionId, hit, query) => {
          const binding = scope.sessions.binding(sessionId)
          if (binding === undefined) throw new Error('session is not loaded')
          await binding.session.loadThrough(hit.seq)
          const element = await locateNode(hit.nodeKey)
          if (element === null) throw new Error('chat node is not rendered')
          revealHidden(element)
          await nextFrame()
          clearHighlight()
          element.classList.add(ACTIVE_CLASS)
          applyHighlight(element, query)
          element.scrollIntoView({ block: 'center', behavior: 'smooth' })
        }
        return scope.slots.inject('conversation.session.header.actions', () =>
          scope.slots.register({
            name: 'conversation.session.header.actions',
            id: 'ezdsh-chat-search',
            order: 40,
            locale: NS,
            inject: () => ({ search, focusHit, clear }),
          }, ChatSearchAction))
      }, '@ezdsh/chat-search: conversation search')
    }

    exports.apply = apply
    exports.inject = inject
    exports.clearHighlight = clearHighlight
    exports.selectorForNodeKey = selectorForNodeKey
    exports.textRanges = textRanges
    return module.exports
  },
})
