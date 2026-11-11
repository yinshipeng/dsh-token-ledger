/**
 * Browser half of @local/dsh-token-ledger.
 *
 * Renders one compact pill in the conversation header utilities — the top-right
 * of the conversation window — with the machine-wide lifetime token total kept
 * by the Host half. The number is polled from `/token-ledger/state`; it grows
 * as turns complete everywhere on this machine, not only in the open session.
 *
 * Click copies the exact total. Hovering shows the bucket breakdown.
 */
window.__ModuleLoader__.load({
  id: 'dsh-token-ledger',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Locale namespace shared by the dictionaries and `props.t`. */
    const NS = 'token-ledger'
    /** Right-aligned Session utilities in the conversation header. */
    const SLOT = 'conversation.session.header.utilities'
    /** Between the shipped log-download entry (0) and the sidebar toggles (10). */
    const ORDER = 5
    /** Poll cadence while the page is visible. */
    const POLL_MS = 5000
    /** How long the "copied" feedback stays. */
    const COPIED_MS = 1200

    /** Simplified Chinese dictionary. */
    const zh = {
      'pill.label': '累计',
      'pill.aria': '本机 DSH 累计 Token：{value}',
      'pill.scanning': '统计中',
      'pill.unavailable': '统计不可用',
      'tip.title': '本机 DSH 累计 Token（所有会话）',
      'tip.total': '总计',
      'tip.input': '未缓存输入',
      'tip.cacheRead': '缓存读取',
      'tip.cacheWrite': '缓存写入',
      'tip.output': '输出',
      'tip.inOut': '非缓存合计（输入+输出）',
      'tip.sessions': '统计会话',
      'tip.updated': '更新于 {time}',
      'tip.copy': '点击复制总数',
      'copied': '已复制',
    }

    /** English dictionary. */
    const en = {
      'pill.label': 'Total',
      'pill.aria': 'Lifetime tokens on this DSH: {value}',
      'pill.scanning': 'Counting',
      'pill.unavailable': 'Unavailable',
      'tip.title': 'Lifetime tokens on this DSH (all sessions)',
      'tip.total': 'Total',
      'tip.input': 'Uncached input',
      'tip.cacheRead': 'Cache read',
      'tip.cacheWrite': 'Cache write',
      'tip.output': 'Output',
      'tip.inOut': 'Uncached input + output',
      'tip.sessions': 'Sessions',
      'tip.updated': 'Updated {time}',
      'tip.copy': 'Click to copy the exact total',
      'copied': 'Copied',
    }

    /** Replace `{name}` placeholders in one dictionary string. */
    function format(template, vars) {
      if (typeof template !== 'string') return ''
      if (vars === undefined) return template
      return template.replace(/\{(\w+)\}/g, (match, key) => {
        const value = vars[key]
        return value === undefined ? match : String(value)
      })
    }

    /** Local fallback translator, used only when the slot hands no `t`. */
    function fallbackTranslate(key, vars) {
      let language = ''
      try {
        language = document.documentElement.lang ?? ''
      } catch {
        language = ''
      }
      const dict = language.toLowerCase().startsWith('zh') ? zh : en
      return format(dict[key] ?? en[key] ?? key, vars)
    }

    /** Active page locale, for number and time formatting. */
    function localeId() {
      try {
        return document.documentElement.lang || navigator.language || 'en'
      } catch {
        return 'en'
      }
    }

    /** Compact count, e.g. `21.69亿` (zh) or `2.17B` (en). */
    function compact(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      try {
        return new Intl.NumberFormat(localeId(), {
          notation: 'compact',
          maximumFractionDigits: 2,
        }).format(value)
      } catch {
        return String(value)
      }
    }

    /** Grouped exact count. */
    function exact(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      try {
        return new Intl.NumberFormat(localeId()).format(value)
      } catch {
        return String(value)
      }
    }

    /** Local clock time for the last refresh. */
    function clock(value) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '—'
      try {
        return new Date(value).toLocaleTimeString(localeId(), {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        })
      } catch {
        return '—'
      }
    }

    /**
     * The lifetime pill.
     * @param props - composed entry props; the slot is locale-bound via `t`.
     */
    function TokenLedgerPill(props) {
      const t = typeof props.t === 'function' ? props.t : fallbackTranslate
      /** undefined = first load, null = unreachable, else the state value. */
      const [state, setState] = React.useState(undefined)
      const [copied, setCopied] = React.useState(false)
      const copiedTimer = React.useRef(undefined)
      /** Receipt: tells the Host which total the pill decoded last. */
      const acknowledged = React.useRef(0)

      React.useEffect(() => {
        let alive = true
        let pending = false
        const load = async () => {
          if (pending) return
          pending = true
          try {
            const response = await fetch('token-ledger/state?client=pill', {
              method: 'GET',
              headers: { accept: 'application/json' },
              cache: 'no-store',
            })
            const envelope = await response.json()
            if (!alive) return
            if (envelope !== null && typeof envelope === 'object' && envelope.ok === true) {
              setState(envelope.value ?? null)
              const value = envelope.value
              if (value !== null && typeof value === 'object'
                && typeof value.total === 'number' && value.total !== acknowledged.current) {
                acknowledged.current = value.total
                fetch(`token-ledger/state?client=pill&ack=${value.total}`, {
                  method: 'GET',
                  headers: { accept: 'application/json' },
                  cache: 'no-store',
                }).catch(() => {})
              }
            } else {
              setState(null)
            }
          } catch {
            if (alive) setState(null)
          } finally {
            pending = false
          }
        }
        load()
        const onFocus = () => {
          load()
        }
        const onVisibility = () => {
          if (document.visibilityState === 'visible') load()
        }
        window.addEventListener('focus', onFocus)
        document.addEventListener('visibilitychange', onVisibility)
        const timer = window.setInterval(() => {
          if (document.visibilityState === 'visible') load()
        }, POLL_MS)
        return () => {
          alive = false
          window.removeEventListener('focus', onFocus)
          document.removeEventListener('visibilitychange', onVisibility)
          window.clearInterval(timer)
        }
      }, [])

      React.useEffect(() => () => {
        if (copiedTimer.current !== undefined) window.clearTimeout(copiedTimer.current)
      }, [])

      if (state === undefined || state === null) return null

      const total = typeof state.total === 'number' ? state.total : 0
      const ready = state.ready === true
      const sessions = typeof state.sessions === 'number' ? state.sessions : 0
      const inOut = typeof state.inOut === 'number' ? state.inOut : 0

      const titleLines = [t('tip.title')]
      if (ready) {
        titleLines.push(
          `${t('tip.total')}: ${exact(state.total)}`,
          `${t('tip.input')}: ${exact(state.uncachedInput)}`,
          `${t('tip.cacheRead')}: ${exact(state.cacheRead)}`,
          `${t('tip.cacheWrite')}: ${exact(state.cacheWrite)}`,
          `${t('tip.output')}: ${exact(state.output)}`,
          `${t('tip.inOut')}: ${exact(inOut)}`,
          `${t('tip.sessions')}: ${exact(sessions)}`,
          t('tip.updated', { time: clock(state.updatedAt) }),
        )
        if (typeof state.error === 'string' && state.error !== '') titleLines.push(state.error)
        titleLines.push(t('tip.copy'))
      } else {
        titleLines.push(t('pill.scanning'))
      }

      const onCopy = () => {
        try {
          if (navigator.clipboard !== undefined && typeof navigator.clipboard.writeText === 'function') {
            navigator.clipboard.writeText(String(total)).catch(() => {})
          }
        } catch {
          // Clipboard is optional; the label feedback still confirms the click.
        }
        setCopied(true)
        if (copiedTimer.current !== undefined) window.clearTimeout(copiedTimer.current)
        copiedTimer.current = window.setTimeout(() => {
          setCopied(false)
        }, COPIED_MS)
      }

      const label = ready ? compact(total) : t('pill.scanning')
      const icon = h('svg', {
        className: 'dtl-icon',
        width: 13,
        height: 13,
        viewBox: '0 0 16 16',
        fill: 'none',
        'aria-hidden': true,
      },
      h('ellipse', { cx: 8, cy: 4.2, rx: 5.2, ry: 2.2, stroke: 'currentColor', strokeWidth: 1.3 }),
      h('path', { d: 'M2.8 4.2v3.4c0 1.2 2.3 2.2 5.2 2.2s5.2-1 5.2-2.2V4.2', stroke: 'currentColor', strokeWidth: 1.3 }),
      h('path', { d: 'M2.8 7.6V11c0 1.2 2.3 2.2 5.2 2.2s5.2-1 5.2-2.2V7.6', stroke: 'currentColor', strokeWidth: 1.3 }))

      return h('div', { className: 'dtl-row', 'data-dsh-plugin': 'token-ledger', 'data-dsh-part': 'pill' },
        h('style', { key: 'style' }, CSS),
        h('button', {
          type: 'button',
          className: 'dtl-pill',
          'data-copied': copied ? 'true' : undefined,
          'data-ready': ready ? 'true' : 'false',
          title: titleLines.join('\n'),
          'aria-label': ready
            ? format(t('pill.aria'), { value: exact(total) })
            : t('pill.scanning'),
          onClick: onCopy,
        },
        icon,
        h('span', { className: 'dtl-prefix' }, t('pill.label')),
        h('span', { className: 'dtl-value' }, copied ? t('copied') : label)))
    }

    /** Scoped styles: theme alias tokens only, so light/dark themes follow. */
    const CSS = [
      '.dtl-row{display:flex;align-items:center;min-width:0}',
      '.dtl-pill{box-sizing:border-box;display:inline-flex;align-items:center;gap:5px;height:24px;margin:0;padding:0 9px;',
      'border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:transparent;',
      'color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:12px;line-height:1;white-space:nowrap;cursor:pointer;',
      'font-variant-numeric:tabular-nums;transition:background-color .12s,border-color .12s,color .12s}',
      '.dtl-pill:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.dtl-pill:active{background:var(--dsw-alias-bg-layer-1)}',
      '.dtl-pill:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-brand-primary)}',
      '.dtl-pill[data-copied=true]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}',
      '.dtl-icon{flex:none;opacity:.85}',
      '.dtl-prefix{flex:none;opacity:.85}',
      '.dtl-value{flex:none;color:var(--dsw-alias-label-primary);font-weight:600}',
      '.dtl-pill[data-ready=false] .dtl-value{color:var(--dsw-alias-label-secondary);font-weight:400}',
    ].join('')

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        try {
          ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'token-ledger: dictionaries')
        } catch (error) {
          console.warn('[token-ledger] locale registration failed', error)
        }
        ctx.slots.inject(SLOT, () => {
          try {
            return ctx.slots.register({
              name: SLOT,
              id: 'token-ledger',
              order: ORDER,
              locale: NS,
            }, TokenLedgerPill)
          } catch (error) {
            console.warn('[token-ledger] slot registration failed', error)
            return () => {}
          }
        })
      },
    }
  },
})