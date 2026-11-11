/**
 * Host half of @local/dsh-token-ledger.
 *
 * The pill in the conversation header shows one number: how many tokens this
 * machine's DSH has consumed since the ledger existed. Two sources feed it:
 *
 * 1. `ctx.sessionProjectionCache.cachedSnapshot(header)` — the per-session
 *    `tokenUsage` projection DSH already checkpoints on session creation,
 *    `turn/end`, session disposal and the configured throttles. That value
 *    covers the complete durable log of every session, including subagent and
 *    forked sessions, and reading it costs no session-log I/O.
 * 2. `session/event` — post-commit append feed. Assistant messages carry
 *    provider usage; those events arrive between checkpoints and are kept as
 *    per-session pending increments until a checkpoint covers them.
 *
 * A durable ledger ($DSH_HOME/token-ledger/ledger.json) accumulates the
 * maximum observed usage per session, so the number is monotonic, survives
 * DSH restarts and keeps the usage of sessions deleted later.
 *
 * If the projection cache service serves nothing (for example a cache that was
 * never hydrated in this process), the same rows are read straight from the
 * documented projection-cache files under `$DSH_HOME/storages`.
 *
 * HTTP: `GET /token-ledger/state` returns `{ ok: true, value: {...} }`.
 * The route admits a request only through the Host's own browser
 * authentication (`connection.requestRejection`); without that service the
 * route refuses every request instead of falling back to a weaker check.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Hard dependency: this row serves HTTP routes. */
export const inject = ['webServer']

/** Route family this row owns. */
const ROUTE = '/token-ledger'
/** Response memo: repeated polls inside this window share one refresh. */
const REFRESH_TTL_MS = 1500
/** Debounce for the durable ledger write. */
const SAVE_DEBOUNCE_MS = 2000
/** Deferred refresh after a live usage event, so checkpoints can catch up. */
const LIVE_REFRESH_MS = 3000
/** Folder names for the token buckets, in display order. */
const BUCKETS = ['uncachedInput', 'cacheRead', 'cacheWrite', 'output']
/** Fold this many pending live samples into the base before a checkpoint lands. */
const PENDING_FOLD_THRESHOLD = 400
/** At most one ledger write per window when only diagnostics changed. */
const STATS_SAVE_INTERVAL_MS = 60000

/** Resolve `$DSH_HOME` the same way the rest of the harness does. */
function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv
  return join(homedir(), '.dsh')
}

/** Durable ledger file. */
function ledgerPath() {
  return join(dshHome(), 'token-ledger', 'ledger.json')
}

/** Coerce a candidate counter to a non-negative finite number. */
function count(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/** Fresh zeroed bucket record. */
function emptyUsage() {
  return { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
}

/** Add one usage record into another (mutates `target`). */
function addUsage(target, usage) {
  for (const key of BUCKETS) target[key] += count(usage?.[key])
}

/** Sum two usage records into a fresh one. */
function plusUsage(a, b) {
  const out = emptyUsage()
  for (const key of BUCKETS) out[key] = count(a?.[key]) + count(b?.[key])
  return out
}

/** Whether a usage record carries any tokens at all. */
function hasUsage(usage) {
  return BUCKETS.some((key) => count(usage?.[key]) > 0)
}

/**
 * Normalize the several shapes the `tokenUsage` projection may appear in:
 * the client view (`{uncachedInputTokens, outputTokens, ...}`), the projection
 * row (`{val: {totals: {...}}}`), or a bare `{totals: {...}}`. Returns undefined
 * when the value carries no recognizable counters.
 * @param value - candidate projection value.
 * @returns normalized buckets, or undefined.
 */
function normalizeProjectionUsage(value) {
  if (value === null || typeof value !== 'object') return undefined
  const rowValue = value.val !== null && typeof value.val === 'object' ? value.val : value
  const totals = rowValue.totals !== null && typeof rowValue.totals === 'object' ? rowValue.totals : rowValue
  const input = totals.uncachedInputTokens ?? totals.inputTokens
  if (input === undefined && totals.outputTokens === undefined) return undefined
  return {
    uncachedInput: count(input),
    cacheRead: count(totals.cacheReadTokens),
    cacheWrite: count(totals.cacheWriteTokens),
    output: count(totals.outputTokens),
  }
}

/**
 * Normalize the `usage` of one `assistant/message` event. The event carries
 * provider usage in the `TokenUsage` shape, where `inputTokens` is the
 * cache-miss (billed) prompt share.
 * @param usage - event payload usage.
 * @returns normalized buckets, or undefined.
 */
function normalizeEventUsage(usage) {
  if (usage === null || typeof usage !== 'object') return undefined
  const normalized = {
    uncachedInput: count(usage.inputTokens),
    cacheRead: count(usage.cacheReadTokens),
    cacheWrite: count(usage.cacheWriteTokens),
    output: count(usage.outputTokens),
  }
  return hasUsage(normalized) ? normalized : undefined
}

/**
 * Check that a stored cache record belongs to this session header. Records
 * written before the v4 session format carry neither `formatVersion` nor
 * `isSeeded`; for those the creation time and working directory are the only
 * witnesses available.
 * @param identity - the record's stored identity.
 * @param header - the authoritative session header.
 * @returns true when the record can be attributed to this session.
 */
function identityMatches(identity, header) {
  if (identity.createdAt !== header.createdAt) return false
  if (identity.cwd !== header.cwd) return false
  if (identity.formatVersion === undefined) return true
  return identity.isSeeded === header.isSeeded
}

/** One JSON response with the shared envelope headers. */
function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  })
  res.end(payload)
}

/** Resolve a logger without touching an un-injected service property. */
function resolveLogger(ctx) {
  try {
    const logger = ctx.get('logger', false)
    if (logger !== undefined && logger !== null && typeof logger.warn === 'function') return logger
  } catch {
    // Fall through to the console.
  }
  return console
}

/** Host-global timer helpers, so no optional service property is touched. */
const schedule = setTimeout
const cancel = clearTimeout

/**
 * Ledger entry: the last absorbed checkpoint (`usage` as of `seq`) plus live
 * samples committed after it.
 */
function emptyEntry() {
  return { usage: emptyUsage(), seq: -1, pending: [] }
}

/**
 * Fold pending live samples into the base once they pile up. Safe because the
 * samples come from the post-commit feed: any later checkpoint covers them, so
 * a snapshot that still trails the folded seq is simply not adopted.
 * @param entry - the session entry to fold in place.
 */
function foldPending(entry) {
  if (entry.pending.length === 0) return
  let maxSeq = entry.seq
  for (const [seq, usage] of entry.pending) {
    addUsage(entry.usage, usage)
    if (seq > maxSeq) maxSeq = seq
  }
  entry.pending = []
  entry.seq = Math.max(entry.seq, maxSeq)
  revision += 1
}

/** Effective per-session usage: absorbed checkpoint plus pending live samples. */
function effectiveUsage(entry) {
  let total = entry.usage
  for (const [, usage] of entry.pending) total = plusUsage(total, usage)
  return total
}

/**
 * Mount the aggregation service, the HTTP route and the live feed.
 * @param ctx - Host context carrying webServer; session services are optional.
 */
export function apply(ctx) {
  const log = resolveLogger(ctx)

  /** Session id → ledger entry. Includes sessions whose logs were deleted. */
  const entries = new Map()
  /** Bumped whenever an entry changes, so a same-total checkpoint still persists. */
  let revision = 0
  /** Cached direct-file fallbacks, filled only when the service serves nothing. */
  const directCache = new Map()
  /** Latest refresh bookkeeping. */
  const state = {
    ready: false,
    refreshing: undefined,
    lastRefreshAt: 0,
    lastError: undefined,
    sessions: 0,
    sessionsWithUsage: 0,
    cacheSource: 'pending',
    cacheHits: 0,
    requests: 0,
    pillRequests: 0,
    statsDirty: false,
    lastSaveAt: 0,
    savedRevision: 0,
    browserRequests: 0,
    lastUserAgent: '',
    lastReferer: '',
    clientAckTotal: 0,
    clientAckAt: 0,
    lastRequestAt: 0,
    totals: emptyUsage(),
    updatedAt: 0,
  }

  let loaded
  let dirty = false
  let saveTimer
  let liveTimer

  /** Load the durable ledger once. Malformed content is discarded, not fatal. */
  function loadLedger() {
    if (loaded !== undefined) return loaded
    loaded = (async () => {
      try {
        const text = await readFile(ledgerPath(), 'utf8')
        const document = JSON.parse(text)
        const saved = document?.entries
        if (saved === null || typeof saved !== 'object') return
        for (const [id, entry] of Object.entries(saved)) {
          if (typeof id !== 'string' || entry === null || typeof entry !== 'object') continue
          const usage = emptyUsage()
          for (const key of BUCKETS) usage[key] = count(entry.usage?.[key])
          const pending = []
          if (Array.isArray(entry.pending)) {
            for (const sample of entry.pending) {
              if (!Array.isArray(sample) || typeof sample[0] !== 'number') continue
              const sampleUsage = normalizeEventUsage(sample[1])
              if (sampleUsage !== undefined) pending.push([sample[0], sampleUsage])
            }
          }
          entries.set(id, {
            usage,
            seq: typeof entry.seq === 'number' && Number.isFinite(entry.seq) ? entry.seq : -1,
            pending,
          })
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          log.warn(`[token-ledger] could not read ledger: ${String(error)}`)
        }
      }
    })()
    return loaded
  }

  /** Persist the ledger atomically; debounced by callers. */
  async function saveLedger() {
    saveTimer = undefined
    if (!dirty) return
    dirty = false
    const document = { version: 1, updatedAt: Date.now(), entries: {} }
    for (const [id, entry] of entries) {
      if (!hasUsage(entry.usage) && entry.pending.length === 0) continue
      document.entries[id] = {
        usage: entry.usage,
        seq: entry.seq,
        pending: entry.pending.map(([seq, usage]) => [seq, usage]),
      }
    }
    const totals = state.totals ?? emptyUsage()
    document.stats = {
      savedAt: Date.now(),
      updatedAt: state.updatedAt,
      sessions: state.sessions,
      sessionsWithUsage: state.sessionsWithUsage,
      sessionsKnown: entries.size,
      cacheSource: state.cacheSource,
      serviceHits: state.serviceHits ?? 0,
      directHits: state.directHits ?? 0,
      requests: state.requests,
      pillRequests: state.pillRequests,
      browserRequests: state.browserRequests,
      clientAckTotal: state.clientAckTotal,
      clientAckAt: state.clientAckAt,
      lastRequestAt: state.lastRequestAt,
      total: BUCKETS.reduce((sum, key) => sum + count(totals[key]), 0),
      totals,
    }
    const target = ledgerPath()
    const temporary = `${target}.${process.pid}.tmp`
    try {
      await mkdir(dirname(target), { recursive: true })
      await writeFile(temporary, JSON.stringify(document), 'utf8')
      await rename(temporary, target)
    } catch (error) {
      log.warn(`[token-ledger] could not write ledger: ${String(error)}`)
    }
    state.lastSaveAt = Date.now()
    state.savedRevision = revision
    state.statsDirty = false
  }

  /** Schedule one debounced durable write. */
  function markDirty() {
    dirty = true
    if (saveTimer !== undefined) return
    saveTimer = schedule(() => {
      void saveLedger()
    }, SAVE_DEBOUNCE_MS)
  }

  /**
   * Read the projection cache row for one session straight from the storage
   * domain files. Only used when the service serves nothing; identity fields
   * are compared with the header so a stale record cannot be mixed in.
   * @param header - session header from persistence.
   * @returns normalized usage and its watermark, or undefined.
   */
  async function readDirectCache(header) {
    const id = header.id
    if (directCache.has(id)) return directCache.get(id)
    const file = join(dshHome(), 'storages', 'session_projcache', 'sessions', `${id}.json`)
    let result
    try {
      const document = JSON.parse(await readFile(file, 'utf8'))
      const identity = document?.record?.identity
      const row = document?.record?.rows?.tokenUsage
      if (identity === null || typeof identity !== 'object' || row === null || typeof row !== 'object') {
        result = undefined
      } else if (!identityMatches(identity, header)) {
        result = undefined
      } else {
        const usage = normalizeProjectionUsage(row.val)
        const seq = typeof row.seq === 'number' && Number.isFinite(row.seq) ? row.seq : -1
        result = usage === undefined ? undefined : { usage, seq }
      }
    } catch {
      result = undefined
    }
    directCache.set(id, result)
    return result
  }

  /** Apply one checkpoint value onto a session entry. */
  function absorb(entry, usage, seq) {
    if (seq < entry.seq) return
    const merged = emptyUsage()
    for (const key of BUCKETS) merged[key] = Math.max(count(entry.usage[key]), count(usage[key]))
    entry.usage = merged
    entry.seq = seq
    if (entry.pending.length > 0) {
      entry.pending = entry.pending.filter(([sampleSeq]) => sampleSeq > seq)
    }
    revision += 1
  }

  /** One aggregation pass over every persisted session. */
  async function refresh() {
    await loadLedger()
    const persistence = ctx.get('sessionPersistence')
    if (persistence === undefined || typeof persistence.list !== 'function') {
      state.lastError = 'sessionPersistence is unavailable in this profile'
      return
    }
    const cache = ctx.get('sessionProjectionCache')
    const cacheUsable = cache !== undefined && typeof cache.cachedSnapshot === 'function'

    let snapshots
    try {
      snapshots = await persistence.list()
    } catch (error) {
      state.lastError = `could not list sessions: ${String(error)}`
      return
    }

    let serviceHits = 0
    let directHits = 0
    const headers = []
    const missed = []
    for (const snapshot of snapshots) {
      const header = snapshot?.header
      if (header === null || typeof header !== 'object' || typeof header.id !== 'string') continue
      headers.push(header)
    }

    // Phase 1: the projection cache service, which answers from memory.
    if (cacheUsable) {
      for (const header of headers) {
        let usage
        let seq = -1
        try {
          // Only the `tokenUsage` row is requested: the block's `asOfSeq` is
          // then that row's own watermark, which the pending-prune below
          // compares against live sample seqs.
          const projection = cache.cachedSnapshot(header, ['tokenUsage'])
          if (projection !== null && typeof projection === 'object') {
            usage = normalizeProjectionUsage(projection.values?.tokenUsage)
            if (typeof projection.asOfSeq === 'number') seq = projection.asOfSeq
          }
        } catch {
          usage = undefined
        }
        if (usage === undefined) {
          missed.push(header)
          continue
        }
        serviceHits += 1
        const entry = entries.get(header.id) ?? emptyEntry()
        absorb(entry, usage, seq)
        entries.set(header.id, entry)
      }
    } else {
      missed.push(...headers)
    }

    // Phase 2: the projection-cache files themselves, memoized per session.
    // This covers rows the service refuses to view (older schema versions) and
    // a cache the service could not hydrate at all.
    for (const header of missed) {
      const direct = await readDirectCache(header)
      if (direct === undefined) continue
      directHits += 1
      const entry = entries.get(header.id) ?? emptyEntry()
      absorb(entry, direct.usage, direct.seq)
      entries.set(header.id, entry)
    }

    // Aggregate. Entries for sessions whose logs are already gone stay in the
    // ledger on purpose: their consumption is still part of this machine total.
    const totals = emptyUsage()
    let withUsage = 0
    const noUsage = []
    for (const header of headers) {
      const entry = entries.get(header.id)
      const usage = entry === undefined ? undefined : effectiveUsage(entry)
      if (usage === undefined || !hasUsage(usage)) {
        noUsage.push(header.id)
        continue
      }
      withUsage += 1
    }
    for (const entry of entries.values()) addUsage(totals, effectiveUsage(entry))

    state.sessions = headers.length
    state.sessionsWithUsage = withUsage
    state.cacheHits = serviceHits + directHits
    state.serviceHits = serviceHits
    state.directHits = directHits
    state.cacheSource = serviceHits > 0
      ? (directHits > 0 ? 'service+files' : 'service')
      : (directHits > 0 ? 'files' : 'none')
    state.noUsageIds = noUsage.slice(0, 15)
    state.noUsageCount = noUsage.length
    state.ready = true
    state.lastError = undefined
    state.updatedAt = Date.now()
    const changed = state.totals === undefined
      || BUCKETS.some((key) => count(totals[key]) !== count(state.totals[key]))
    state.totals = totals
    const entriesChanged = revision !== state.savedRevision
    if (changed || entriesChanged
      || (state.statsDirty && Date.now() - state.lastSaveAt > STATS_SAVE_INTERVAL_MS)) {
      markDirty()
    }
  }

  /** Refresh at most once per TTL; concurrent callers share the pass. */
  async function ensureFresh() {
    const now = Date.now()
    if (state.ready && now - state.lastRefreshAt < REFRESH_TTL_MS) return
    await loadLedger()
    state.lastRefreshAt = now
    if (state.refreshing !== undefined) return state.refreshing
    state.refreshing = refresh()
      .catch((error) => {
        state.lastError = String(error)
        log.warn(`[token-ledger] refresh failed: ${String(error)}`)
      })
      .finally(() => {
        state.refreshing = undefined
      })
    return state.refreshing
  }

  /** Public response body. */
  function snapshotValue() {
    const totals = state.totals ?? emptyUsage()
    const total = BUCKETS.reduce((sum, key) => sum + count(totals[key]), 0)
    return {
      total,
      inOut: count(totals.uncachedInput) + count(totals.output),
      uncachedInput: count(totals.uncachedInput),
      cacheRead: count(totals.cacheRead),
      cacheWrite: count(totals.cacheWrite),
      output: count(totals.output),
      sessions: state.sessions,
      sessionsWithUsage: state.sessionsWithUsage,
      sessionsKnown: entries.size,
      cacheSource: state.cacheSource,
      cacheHits: state.cacheHits ?? 0,
      serviceHits: state.serviceHits ?? 0,
      directHits: state.directHits ?? 0,
      sessionsWithoutUsage: state.noUsageCount ?? 0,
      noUsageIds: state.noUsageIds ?? [],
      requests: state.requests,
      pillRequests: state.pillRequests,
      browserRequests: state.browserRequests,
      lastUserAgent: state.lastUserAgent,
      lastReferer: state.lastReferer,
      clientAckTotal: state.clientAckTotal,
      clientAckAt: state.clientAckAt,
      lastRequestAt: state.lastRequestAt,
      ready: state.ready,
      updatedAt: state.updatedAt,
      error: state.lastError,
    }
  }

  /**
   * Admit one request through the Host's browser-authentication gate — the
   * same `connection.requestRejection` check Connection applies to its own
   * routes. A deployment without Connection, or one whose check throws, is
   * refused rather than degraded to a weaker Host/Origin/loopback test.
   * @param req - incoming HTTP request.
   * @returns the HTTP status to reject with, or undefined when admitted.
   */
  function admissionRejection(req) {
    let connection
    try {
      connection = ctx.get('connection', false)
    } catch {
      connection = undefined
    }
    if (connection === undefined || connection === null
      || typeof connection.requestRejection !== 'function') {
      return 403
    }
    try {
      const rejection = connection.requestRejection({ headers: req.headers })
      return rejection === 401 || rejection === 403 ? rejection : undefined
    } catch {
      return 403
    }
  }

  /** The `/token-ledger` route family. */
  const handler = async (req, res) => {
    const rejection = admissionRejection(req)
    if (rejection !== undefined) {
      writeJson(res, rejection, {
        ok: false,
        error: {
          code: rejection === 401 ? 'unauthorized' : 'forbidden',
          message: 'browser authentication required',
        },
      })
      return
    }
    let pathname = '/'
    try {
      pathname = new URL(req.url ?? '/', 'http://local').pathname
    } catch {
      pathname = '/'
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' })
      res.end()
      return
    }
    if (pathname !== `${ROUTE}/state`) {
      res.writeHead(404)
      res.end()
      return
    }
    state.requests += 1
    state.statsDirty = true
    state.lastRequestAt = Date.now()
    const userAgent = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : ''
    if (userAgent.toLowerCase().includes('mozilla')) state.browserRequests += 1
    state.lastUserAgent = userAgent
    state.lastReferer = typeof req.headers.referer === 'string' ? req.headers.referer : ''
    const query = new URL(req.url ?? '/', 'http://local').searchParams
    if (query.get('client') === 'pill') state.pillRequests += 1
    const ack = Number(query.get('ack'))
    if (Number.isFinite(ack) && ack > 0) {
      state.clientAckTotal = ack
      state.clientAckAt = Date.now()
      state.statsDirty = true
      markDirty()
    }
    try {
      await ensureFresh()
    } catch (error) {
      state.lastError = String(error)
    }
    writeJson(res, 200, { ok: true, value: snapshotValue() })
  }

  ctx.effect(() => {
    const disposeRoute = ctx.webServer.register({ kind: 'prefix', path: ROUTE, handler })
    return () => {
      disposeRoute()
    }
  }, 'token-ledger: /token-ledger route')

  ctx.effect(() => {
    const disposeEvent = ctx.on('session/event', (session, event) => {
      const id = session?.id
      if (typeof id !== 'string' || event === null || typeof event !== 'object') return
      if (event.type !== 'assistant/message') return
      const usage = normalizeEventUsage(event.data?.usage)
      if (usage === undefined) return
      const seq = typeof event.seq === 'number' && Number.isFinite(event.seq) ? event.seq : -1
      const entry = entries.get(id) ?? emptyEntry()
      if (seq > entry.seq) entry.pending.push([seq, usage])
      if (entry.pending.length > PENDING_FOLD_THRESHOLD) foldPending(entry)
      entries.set(id, entry)
      revision += 1
      state.updatedAt = Date.now()
      markDirty()
      if (liveTimer !== undefined) return
      liveTimer = schedule(() => {
        liveTimer = undefined
        void ensureFresh()
      }, LIVE_REFRESH_MS)
    })
    return () => {
      disposeEvent()
    }
  }, 'token-ledger: live usage feed')

  ctx.effect(() => () => {
    if (saveTimer !== undefined) cancel(saveTimer)
    if (liveTimer !== undefined) cancel(liveTimer)
    void saveLedger()
  }, 'token-ledger: durable ledger')

  // Warm the ledger in the background so the first poll is cheap.
  void ensureFresh()
}