/**
 * Smoke test for the Host half of dsh-token-ledger.
 *
 * The plugin is exercised through a minimal stand-in for the Cordis context and
 * the Web carrier: the real `apply()` runs, the real HTTP handler answers fake
 * request/response objects, and the real projection-cache service shape is
 * faked. No DSH process is required.
 *
 * Run with: node test/smoke.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Isolate the durable ledger of this run. */
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-token-ledger-test-'))

/** Fake persisted sessions. */
const sessions = [
  { header: { id: 'session-a', version: 4, createdAt: 1, cwd: '/tmp/a', isSeeded: false } },
  { header: { id: 'session-b', version: 4, createdAt: 2, cwd: '/tmp/b', isSeeded: false } },
]

/** Fake `tokenUsage` projections, mutable so a later "checkpoint" can move. */
const usageById = {
  'session-a': { uncachedInputTokens: 100, outputTokens: 10, cacheReadTokens: 1000, cacheWriteTokens: 5 },
  'session-b': { uncachedInputTokens: 200, outputTokens: 20, cacheReadTokens: 2000, cacheWriteTokens: 0 },
}
const seqById = { 'session-a': 42, 'session-b': 7 }

/** Connection behaviour for the current case: 'missing' | 'unauthorized' | 'admitted'. */
let connectionCase = 'missing'

const connectionService = {
  requestRejection() {
    if (connectionCase === 'unauthorized') return 401
    if (connectionCase === 'forbidden') return 403
    return undefined
  },
}

/** Captured registrations. */
const registered = { route: undefined, listeners: new Map(), disposers: [] }

const ctx = {
  get(name) {
    if (name === 'sessionPersistence') return { list: async () => sessions }
    if (name === 'sessionProjectionCache') {
      return {
        cachedSnapshot(header) {
          const usage = usageById[header.id]
          if (usage === undefined) return undefined
          return { asOfSeq: seqById[header.id], values: { tokenUsage: usage } }
        },
      }
    }
    if (name === 'connection') return connectionCase === 'missing' ? undefined : connectionService
    return undefined
  },
  effect(callback) {
    const dispose = callback()
    registered.disposers.push(dispose)
    return () => {
      if (typeof dispose === 'function') dispose()
    }
  },
  on(event, listener) {
    registered.listeners.set(event, listener)
    return () => registered.listeners.delete(event)
  },
  webServer: {
    register(route) {
      registered.route = route
      return () => {
        registered.route = undefined
      }
    },
  },
  logger: { warn() {} },
}

/** One fake HTTP request. */
function request(overrides = {}) {
  return {
    method: 'GET',
    url: '/token-ledger/state',
    headers: { cookie: 'fake' },
    socket: {},
    ...overrides,
  }
}

/** One fake HTTP response capturing the handler's writes. */
function response() {
  const captured = { status: 0, headers: {}, body: '' }
  return {
    captured,
    writeHead(status, headers = {}) {
      captured.status = status
      Object.assign(captured.headers, headers)
    },
    end(body = '') {
      captured.body = body
    },
  }
}

/** Invoke the registered route handler and decode its JSON body. */
async function call(req) {
  const res = response()
  await registered.route.handler(req, res)
  let json
  try {
    json = JSON.parse(res.captured.body)
  } catch {
    json = undefined
  }
  return { status: res.captured.status, json }
}

/** Let pending microtasks settle. */
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))

/** Wait until `predicate` holds or the deadline passes. */
async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await tick(100)
  }
  assert.fail(`timed out waiting for ${label}`)
}

const { apply } = await import('../index.js')
apply(ctx, {})

assert.ok(registered.route !== undefined, 'the plugin registered its route')
assert.equal(registered.route.kind, 'prefix')
assert.equal(registered.route.path, '/token-ledger')
assert.ok(registered.listeners.has('session/event'), 'the plugin subscribed to session/event')

// 1. No Connection service: refuse rather than fall back to a weaker check.
connectionCase = 'missing'
{
  const { status, json } = await call(request())
  assert.equal(status, 403)
  assert.equal(json.ok, false)
}

// 2. Connection refuses the credential.
connectionCase = 'unauthorized'
{
  const { status } = await call(request())
  assert.equal(status, 401)
}

// 3. Authenticated browser: the aggregate equals both projections.
connectionCase = 'admitted'
{
  const { status, json } = await call(request())
  assert.equal(status, 200)
  assert.equal(json.ok, true)
  const value = json.value
  assert.equal(value.total, (100 + 10 + 1000 + 5) + (200 + 20 + 2000 + 0))
  assert.equal(value.uncachedInput, 300)
  assert.equal(value.cacheRead, 3000)
  assert.equal(value.cacheWrite, 5)
  assert.equal(value.output, 30)
  assert.equal(value.inOut, 330)
  assert.equal(value.sessions, 2)
  assert.equal(value.cacheSource, 'service')
  assert.equal(value.ready, true)
}

// 4. A live assistant message lands before the next checkpoint and shows up
//    after the response memo expires.
{
  const listener = registered.listeners.get('session/event')
  listener({ id: 'session-a' }, {
    type: 'assistant/message',
    seq: 43,
    data: { usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 50, cacheWriteTokens: 0 } },
  })
  await tick(1600)
  const { status, json } = await call(request())
  assert.equal(status, 200)
  assert.equal(json.value.uncachedInput, 300 + 1000)
  assert.equal(json.value.output, 30 + 100)
  assert.equal(json.value.cacheRead, 3000 + 50)
}

// 5. The checkpoint covers the live sample: it is not counted twice.
{
  usageById['session-a'] = {
    uncachedInputTokens: 100 + 1000,
    outputTokens: 10 + 100,
    cacheReadTokens: 1000 + 50,
    cacheWriteTokens: 5,
  }
  seqById['session-a'] = 43
  await tick(1600)
  const { json } = await call(request())
  assert.equal(json.value.uncachedInput, 300 + 1000)
  assert.equal(json.value.output, 30 + 100)
  assert.equal(json.value.cacheRead, 3000 + 50)
}

// 6. Unknown paths and non-GET requests are refused.
{
  const notFound = await call(request({ url: '/token-ledger/elsewhere' }))
  assert.equal(notFound.status, 404)
  const wrongMethod = await call(request({ method: 'POST' }))
  assert.equal(wrongMethod.status, 405)
}

// 7. The durable ledger eventually lands on disk with the final aggregate.
{
  const file = join(process.env.DSH_HOME, 'token-ledger', 'ledger.json')
  const expectedTotal = (1100 + 200) + (110 + 20) + (1050 + 2000) + 5
  const readDocument = () => {
    try {
      return JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      return undefined
    }
  }
  await waitFor(() => {
    const document = readDocument()
    return document !== undefined
      && document.stats?.total === expectedTotal
      && document.entries?.['session-a']?.usage?.uncachedInput === 1100
      && (document.entries?.['session-a']?.pending?.length ?? 0) === 0
  }, 8000, 'the ledger file with the checkpointed total')
  const document = readDocument()
  assert.equal(document.version, 1)
  assert.equal(document.stats.sessions, 2)
  assert.ok(typeof document.stats.pillRequests === 'number')
  assert.equal(document.entries['session-a'].usage.uncachedInput, 1100)
  assert.equal(document.entries['session-b'].usage.uncachedInput, 200)
}

// 8. Disposal releases the route and listeners.
{
  for (const dispose of registered.disposers) {
    if (typeof dispose === 'function') dispose()
  }
}

console.log('smoke: all checks passed')