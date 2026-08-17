// @ts-check
/**
 * dsh-billing — DeepSeek Harness 本地计费插件（host 半区）
 *
 * 功能：
 *   - 账户余额：GET /user/balance（复用 DEEPSEEK_API_KEY 凭据），带缓存与容错
 *   - 会话费用：订阅 session/event，对带 usage 的 assistant/message 按官方政策
 *     时间表计价，以 (sessionId, messageId) 为主键幂等记账到持久化账本
 *     （$DSH_HOME/storages/dsh-billing.json），重启不重复累计
 *   - 官方政策时间线：2025-02-09 / 2026-05-22 / 2026-08-17 峰谷价；政策链继承
 *     （新政策未点名的模型沿用旧价）；政策或配置变化后重启自动重估存量记录
 *   - 价格同步（可选，默认开）：每 12h 拉取官方价格页解析；失败回退
 *     上次成功在线值 → 内置默认
 *   - 命令：/balance /cost；工具：deepseek_billing
 *   - 只读端点：GET /billing/state、GET /billing/session/<id>（默认仅回环）
 *
 * 无任何运行时依赖（仅 node 内置模块）。
 */

import { rename, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const name = 'dsh-billing'

/** 依赖的服务：命令注册表 + 工具注册表 + HTTP 路由载体（凭据/会话在调用时按需获取）。 */
export const inject = ['commands', 'tools', 'webServer']

// ---------------------------------------------------------------------------
// 常量与默认配置
// ---------------------------------------------------------------------------

const PUBLIC_BASE_URL = 'https://api.deepseek.com'
const DEFAULT_API_KEY_ENV = 'DEEPSEEK_API_KEY'
const CRED_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const DEFAULT_TIMEZONE = 'Asia/Shanghai'
const DEFAULT_PEAK_WINDOWS = [[9, 12], [14, 18]]

/** 零单价（双币种）。 */
const ZERO_UNIT = Object.freeze({ input: 0, cacheRead: 0, output: 0 })

/**
 * 官方政策时间表（策展自 DeepSeek 官方公告，以官方页面为准）。
 * 每条政策要么是固定单价表（prices），要么是峰谷单价表（peak/offPeak）。
 * 每个模型条目的值为 { cny: {...}, usd: {...} } 双币种单价（元/百万 tokens）。
 * since 最晚且不晚于消息时刻的政策胜出；未点名的模型沿用最近一次被点名的价格。
 */
const OFFICIAL_PRICING_POLICIES = [
  {
    since: '2025-02-09T00:00:00+08:00',
    label: 'deepseek-chat / deepseek-reasoner 标准价（2025-02-09 优惠期结束）',
    prices: {
      'deepseek-chat': { cny: { input: 2, cacheRead: 0.5, output: 8 }, usd: { input: 0.28, cacheRead: 0.028, output: 0.42 } },
      'deepseek-reasoner': { cny: { input: 4, cacheRead: 1, output: 16 }, usd: { input: 0.55, cacheRead: 0.055, output: 1.68 } },
      '*': { cny: { input: 2, cacheRead: 0.5, output: 8 }, usd: { input: 0.28, cacheRead: 0.028, output: 0.42 } },
    },
  },
  {
    since: '2026-05-22T00:00:00+08:00',
    label: 'V4 系列 75% 降价转永久（deepseek-v4-flash / deepseek-v4-pro 上线）',
    prices: {
      'deepseek-v4-flash': { cny: { input: 1, cacheRead: 0.02, output: 2 }, usd: { input: 0.14, cacheRead: 0.0028, output: 0.28 } },
      'deepseek-v4-pro': { cny: { input: 3, cacheRead: 0.025, output: 6 }, usd: { input: 0.435, cacheRead: 0.003625, output: 0.87 } },
      '*': { cny: { input: 1, cacheRead: 0.02, output: 2 }, usd: { input: 0.14, cacheRead: 0.0028, output: 0.28 } },
    },
  },
  {
    since: '2026-08-17T00:00:00+08:00',
    label: '峰谷定价：高峰 09:00-12:00 / 14:00-18:00（北京时间），空闲时段半价',
    peak: {
      'deepseek-v4-flash': { cny: { input: 3, cacheRead: 0.1, output: 9 }, usd: { input: 0.44, cacheRead: 0.014, output: 1.32 } },
      'deepseek-v4-pro': { cny: { input: 9, cacheRead: 0.3, output: 27 }, usd: { input: 1.32, cacheRead: 0.044, output: 3.96 } },
      '*': { cny: { input: 3, cacheRead: 0.1, output: 9 }, usd: { input: 0.44, cacheRead: 0.014, output: 1.32 } },
    },
    offPeak: {
      'deepseek-v4-flash': { cny: { input: 1.5, cacheRead: 0.05, output: 4.5 }, usd: { input: 0.22, cacheRead: 0.007, output: 0.66 } },
      'deepseek-v4-pro': { cny: { input: 4.5, cacheRead: 0.15, output: 13.5 }, usd: { input: 0.66, cacheRead: 0.022, output: 1.98 } },
      '*': { cny: { input: 1.5, cacheRead: 0.05, output: 4.5 }, usd: { input: 0.22, cacheRead: 0.007, output: 0.66 } },
    },
  },
]

const DEFAULT_CONFIG = {
  apiKeyEnv: DEFAULT_API_KEY_ENV,
  baseURL: PUBLIC_BASE_URL,
  timezone: DEFAULT_TIMEZONE,
  peakWindows: DEFAULT_PEAK_WINDOWS,
  /** 用户价格覆盖：{ model: { input, cacheRead, output } }，精确条目覆盖官方价。 */
  prices: {},
  /** 追加到官方时间表之后的政策（since 更晚者覆盖内置条目）。 */
  policyOverrides: [],
  /** 价格在线同步（官方价格页）。 */
  priceSync: { enabled: true, url: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/', intervalMs: 12 * 60 * 60 * 1000, timeoutMs: 15000 },
  /** 账本文件；默认 $DSH_HOME/storages/dsh-billing.json。 */
  persistPath: path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'storages', 'dsh-billing.json'),
  /** recent 流水保留条数。 */
  maxRecent: 20000,
  /** 每个会话消息级明细保留条数。 */
  maxMessagesPerSession: 2000,
  /** /billing 端点仅允许回环地址访问（默认开）。 */
  loopbackOnly: true,
  /** 余额缓存刷新间隔（ms）。 */
  balanceRefreshMs: 60_000,
  balanceTimeoutMs: 5_000,
}

// ---------------------------------------------------------------------------
// 定价引擎（纯函数）
// ---------------------------------------------------------------------------

/** 某时刻是否处于高峰时段（按指定时区与窗口判定；窗口为 [start, end) 小时）。 */
export function isPeak(timeMs, timezone = DEFAULT_TIMEZONE, windows = DEFAULT_PEAK_WINDOWS) {
  let hour = -1
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour12: false, hour: 'numeric', minute: 'numeric' })
      .formatToParts(new Date(timeMs))
    hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0') % 24
  } catch {
    // 非法时区按非高峰处理，不阻断记账。
  }
  return windows.some(([start, end]) => hour >= start && hour < end)
}

/** 某时刻生效的官方政策（第一个 since 之前取第一条）。 */
export function activePolicy(timeMs, policies = OFFICIAL_PRICING_POLICIES) {
  let active = policies[0]
  for (const policy of policies) {
    const since = Date.parse(policy.since)
    if (Number.isFinite(since) && timeMs >= since) active = policy
  }
  return active
}

/** 在单张价格表内取模型单价（含 `*` 兜底）。 */
function priceFor(model, table) {
  return table[model] ?? table['*'] ?? { cny: ZERO_UNIT, usd: ZERO_UNIT }
}

/** 用户覆盖合并：用户表里模型精确条目覆盖官方价；用户 `*` 只填补官方未列模型。 */
function resolvePrice(model, baseTable, overrideTable) {
  const override = overrideTable ?? {}
  const base = priceFor(model, baseTable)
  if (override[model] !== void 0) {
    return {
      cny: { ...base.cny, ...(override[model].cny ?? {}) },
      usd: { ...base.usd, ...(override[model].usd ?? {}) },
    }
  }
  if (baseTable[model] !== void 0) return base
  const wildcard = override['*']
  return wildcard === void 0 ? base : { cny: { ...base.cny, ...(wildcard.cny ?? {}) }, usd: { ...base.usd, ...(wildcard.usd ?? {}) } }
}

/** 规范化用户价格表为双币种覆盖表。 */
function normalizeUserPrices(prices) {
  const normalized = {}
  for (const [model, flat] of Object.entries(prices ?? {})) {
    normalized[model] = { cny: { ...flat }, usd: { ...flat } }
  }
  return normalized
}

/** 组装完整政策表（官方 + 用户追加，按 since 升序）。 */
function composePolicies(overrides) {
  return [...OFFICIAL_PRICING_POLICIES, ...(overrides ?? [])]
    .filter((p) => p.prices !== void 0 || (p.peak !== void 0 && p.offPeak !== void 0))
    .sort((a, b) => Date.parse(a.since) - Date.parse(b.since))
}

/**
 * 计算某模型在某一时刻的单价（双币种）。
 * 解析顺序（政策链继承）：从新到旧遍历不晚于消息时刻的政策，取第一个点名该
 * 模型的单价；没有任何政策点名 → 用最新适用政策的 `*` 兜底；最后应用用户覆盖。
 * @returns {{ cny, usd, mode, policy }} mode: 'flat' | 'peak' | 'offPeak'
 */
export function priceAt(model, timeMs, opts) {
  const { prices = {}, timezone = DEFAULT_TIMEZONE, peakWindows = DEFAULT_PEAK_WINDOWS, policies = OFFICIAL_PRICING_POLICIES } = opts ?? {}
  if (policies.length === 0) {
    const fallback = priceFor(model, prices)
    return { cny: fallback.cny, usd: fallback.usd, mode: 'flat', policy: void 0 }
  }
  const peak = isPeak(timeMs, timezone, peakWindows)
  const applicable = policies.filter((p) => timeMs >= Date.parse(p.since))
  const scope = applicable.length > 0 ? applicable : [policies[0]]
  let winner
  let named = false
  let baseTable
  for (let i = scope.length - 1; i >= 0; i--) {
    const policy = scope[i]
    const table = policy.peak !== void 0 && policy.offPeak !== void 0 ? (peak ? policy.peak : policy.offPeak) : policy.prices
    if (table[model] !== void 0) {
      winner = policy
      named = true
      baseTable = table
      break
    }
  }
  if (winner === void 0) {
    winner = scope[scope.length - 1]
    baseTable = winner.peak !== void 0 && winner.offPeak !== void 0 ? (peak ? winner.peak : winner.offPeak) : winner.prices
  }
  const unit = named
    ? resolvePrice(model, baseTable, prices)
    : { cny: { ...priceFor(model, baseTable).cny, ...(prices['*']?.cny ?? {}) }, usd: { ...priceFor(model, baseTable).usd, ...(prices['*']?.usd ?? {}) } }
  return {
    cny: unit.cny,
    usd: unit.usd,
    mode: winner.peak !== void 0 && winner.offPeak !== void 0 ? (peak ? 'peak' : 'offPeak') : 'flat',
    policy: { since: winner.since, label: winner.label },
  }
}

/** 按 TokenUsage 与单价计算费用（双币种）与 token 拆分。 */
export function costOf(usage, unit) {
  const inputTokens = usage.inputTokens ?? 0
  const cacheReadTokens = usage.cacheReadTokens ?? 0
  const outputTokens = usage.outputTokens ?? 0
  return {
    inputTokens,
    cacheReadTokens,
    outputTokens,
    cost: (inputTokens * unit.cny.input + cacheReadTokens * unit.cny.cacheRead + outputTokens * unit.cny.output) / 1e6,
    costUsd: (inputTokens * unit.usd.input + cacheReadTokens * unit.usd.cacheRead + outputTokens * unit.usd.output) / 1e6,
  }
}

/** 本地日期键（服务器时区）。 */
export function dayKey(time) {
  const d = new Date(time)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 本地月份键。 */
export function monthKey(time) {
  return dayKey(time).slice(0, 7)
}

/** 空计数（双币种）。 */
export function zeroCounts() {
  return { calls: 0, cost: 0, costUsd: 0, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 }
}

/** 把一次计费并入一个计数对象。 */
export function addCounts(target, sample) {
  target.calls += 1
  target.cost += sample.cost
  target.costUsd += sample.costUsd
  target.inputTokens += sample.inputTokens
  target.cacheReadTokens += sample.cacheReadTokens
  target.outputTokens += sample.outputTokens
  return target
}

// ---------------------------------------------------------------------------
// 持久化账本
// ---------------------------------------------------------------------------

/**
 * 持久化账本：聚合计数（累计 / 按模型 / 按日 / 按会话）+ 最近流水 + 每会话消息级明细。
 * 写盘 1s 防抖 + 临时文件原子替换；加载失败从空账本开始并告警。
 * 以 (sessionId, messageId) 为主键幂等：重放/重启只覆盖明细并撤销会话级旧计数，
 * 绝不重复累计全局计数（服务重启会重放历史事件，这是防重复累计的关键）。
 */
export class BillingLedger {
  constructor(persistPath, maxRecent, maxMessagesPerSession) {
    this.path = persistPath
    this.maxRecent = maxRecent
    this.maxMessagesPerSession = maxMessagesPerSession
    this.totals = zeroCounts()
    this.byModel = new Map()
    this.byDay = new Map()
    this.bySession = new Map()
    this.recent = []
    this.writeTimer = null
    this.pendingWrite = null
    this.pricingHash = ''
  }

  /** 从磁盘装载。 */
  load() {
    try {
      if (!existsSync(this.path)) return
      const raw = JSON.parse(readFileSync(this.path, 'utf8'))
      if (raw?.version !== 2) return
      this.totals = { ...zeroCounts(), ...raw.totals }
      this.byModel = new Map(Object.entries(raw.byModel ?? {}))
      this.byDay = new Map(Object.entries(raw.byDay ?? {}))
      this.bySession = new Map(Object.entries(raw.sessions ?? {}).map(([id, value]) => [
        id,
        { ...zeroCounts(), ...value, messages: new Map(Object.entries(value.messages ?? {})) },
      ]))
      this.recent = Array.isArray(raw.recent) ? raw.recent : []
      this.pricingHash = typeof raw.pricingHash === 'string' ? raw.pricingHash : ''
    } catch (error) {
      // 账本损坏时从空账本开始，不阻断 web 启动。
      console.warn('[dsh-billing] ledger load failed, starting empty:', error?.message ?? error)
    }
  }

  /**
   * 计价规则变化后重估：以保留的逐条记录（会话消息明细 ∪ 最近流水）为唯一来源，
   * 按每条消息的时刻重新取价并重建全部聚合。规则未变时不做任何事。
   */
  reprice(pricing) {
    if (this.pricingHash === pricing.hash) return
    const seen = new Set()
    const entries = []
    const push = (sessionId, messageId, record) => {
      const key = `${sessionId}\n${messageId}`
      if (seen.has(key)) return
      seen.add(key)
      entries.push(record)
    }
    for (const [sessionId, session] of this.bySession) {
      for (const [messageId, message] of session.messages) {
        push(sessionId, messageId, {
          sessionId, messageId, time: message.time, provider: message.provider, model: message.model,
          inputTokens: message.inputTokens, cacheReadTokens: message.cacheReadTokens, outputTokens: message.outputTokens,
        })
      }
    }
    for (const entry of this.recent) push(entry.sessionId, entry.messageId, entry)
    this.totals = zeroCounts()
    this.byModel = new Map()
    this.byDay = new Map()
    this.bySession = new Map()
    this.recent = []
    for (const entry of entries) {
      this.record({ ...entry, ...this.price(entry.model, entry.time, entry, pricing) })
    }
    this.pricingHash = pricing.hash
  }

  /** 按定价上下文计算一条消息的费用（双币种，含应用的单价与模式）。 */
  price(model, time, tokens, pricing) {
    const unit = pricing.at(model, time)
    const sample = costOf(tokens, unit)
    return { ...sample, unitPrice: { cny: unit.cny, usd: unit.usd }, mode: unit.mode }
  }

  /** 记一笔（幂等）。 */
  record(entry) {
    let session = this.bySession.get(entry.sessionId)
    if (session === void 0) {
      session = { ...zeroCounts(), messages: new Map() }
      this.bySession.set(entry.sessionId, session)
    }
    const previous = session.messages.get(entry.messageId)
    if (previous !== void 0) {
      // 重放/重复：撤销会话级旧计数。
      session.calls -= 1
      session.cost -= previous.cost
      session.costUsd -= previous.costUsd
      session.inputTokens -= previous.inputTokens
      session.cacheReadTokens -= previous.cacheReadTokens
      session.outputTokens -= previous.outputTokens
    } else {
      addCounts(this.totals, entry)
      const model = entry.model || 'unknown'
      let modelCounts = this.byModel.get(model)
      if (modelCounts === void 0) {
        modelCounts = zeroCounts()
        this.byModel.set(model, modelCounts)
      }
      addCounts(modelCounts, entry)
      const day = dayKey(entry.time)
      let dayCounts = this.byDay.get(day)
      if (dayCounts === void 0) {
        dayCounts = zeroCounts()
        this.byDay.set(day, dayCounts)
      }
      addCounts(dayCounts, entry)
      addCounts(session, entry)
      this.recent.push(entry)
      if (this.recent.length > this.maxRecent) this.recent.splice(0, this.recent.length - this.maxRecent)
    }
    session.messages.set(entry.messageId, {
      cost: entry.cost, costUsd: entry.costUsd, model: entry.model, provider: entry.provider, time: entry.time,
      inputTokens: entry.inputTokens, cacheReadTokens: entry.cacheReadTokens, outputTokens: entry.outputTokens,
      unitPrice: entry.unitPrice, mode: entry.mode,
    })
    if (session.messages.size > this.maxMessagesPerSession) {
      const oldest = [...session.messages.keys()].slice(0, session.messages.size - this.maxMessagesPerSession)
      for (const key of oldest) session.messages.delete(key)
    }
    this.scheduleWrite()
  }

  /** 防抖写盘（1s）。 */
  scheduleWrite() {
    if (this.writeTimer !== null) return
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null
      this.pendingWrite ??= this.flush().finally(() => {
        this.pendingWrite = null
      })
    }, 1000)
  }

  /** 立即落盘（进程退出前调用）。 */
  async flush() {
    if (this.pendingWrite !== null) return this.pendingWrite
    const body = JSON.stringify({
      version: 2,
      pricingHash: this.pricingHash,
      totals: this.totals,
      byModel: Object.fromEntries(this.byModel),
      byDay: Object.fromEntries(this.byDay),
      sessions: Object.fromEntries([...this.bySession].map(([id, value]) => [
        id,
        {
          calls: value.calls, cost: value.cost, costUsd: value.costUsd,
          inputTokens: value.inputTokens, cacheReadTokens: value.cacheReadTokens, outputTokens: value.outputTokens,
          messages: Object.fromEntries(value.messages),
        },
      ])),
      recent: this.recent,
    })
    const tmp = `${this.path}.tmp`
    await writeFile(tmp, body, 'utf8')
    await rename(tmp, this.path)
  }

  /** 会话级公开视图。 */
  sessionView(id) {
    const session = this.bySession.get(id)
    if (session === void 0) return void 0
    return {
      sessionId: id,
      calls: session.calls,
      cost: session.cost,
      costUsd: session.costUsd,
      inputTokens: session.inputTokens,
      cacheReadTokens: session.cacheReadTokens,
      outputTokens: session.outputTokens,
      messages: Object.fromEntries(session.messages),
    }
  }
}

// ---------------------------------------------------------------------------
// 余额抓取
// ---------------------------------------------------------------------------

/** 数值化一个余额字符串；非法/缺失返回 0。 */
function toNumber(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}

/** 解析余额接口响应（纯函数）。 */
export function parseBalanceResponse(json) {
  if (typeof json !== 'object' || json === null || !Array.isArray(json.balance_infos)) return null
  const infos = json.balance_infos.filter((info) => typeof info === 'object' && info !== null && typeof info.currency === 'string')
  if (infos.length === 0) return null
  const pick = (currency) => {
    const info = infos.find((candidate) => candidate.currency === currency)
    if (info === void 0) return null
    return {
      isAvailable: json.is_available === true,
      currency,
      total: toNumber(info.total_balance),
      granted: toNumber(info.granted_balance),
      toppedUp: toNumber(info.topped_up_balance),
    }
  }
  return { cny: pick('CNY'), usd: pick('USD') }
}

/** 余额抓取器：按固定间隔用 provider 的 API key 查询官方余额端点；任何失败都收敛为 error 视图。 */
class BalanceFetcher {
  constructor(deps) {
    this.resolveKey = deps.resolveKey
    this.endpoint = deps.endpoint
    this.refreshMs = deps.refreshMs
    this.timeoutMs = deps.timeoutMs
    this.logger = deps.logger ?? console
    this.view = { status: 'idle', balance: void 0, error: null, updatedAt: void 0 }
    this.timer = null
    this.inFlight = null
    this.disposed = false
  }

  getSnapshot() {
    return this.view
  }

  start() {
    if (this.timer !== null) return
    void this.refresh()
    this.timer = setInterval(() => void this.refresh(), this.refreshMs)
  }

  dispose() {
    this.disposed = true
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
  }

  publish(next) {
    if (this.disposed) return
    this.view = next
  }

  /** 立即刷新（并发去重）。 */
  async refresh() {
    if (this.inFlight !== null) return this.inFlight
    this.publish({ ...this.view, status: this.view.status === 'ready' ? this.view.status : 'loading' })
    this.inFlight = this.fetchOnce()
      .then((balance) => {
        this.publish({ status: 'ready', balance, error: null, updatedAt: Date.now() })
      })
      .catch((error) => {
        this.publish({ status: 'error', balance: void 0, error: error instanceof Error ? error.message : String(error), updatedAt: Date.now() })
      })
      .finally(() => {
        this.inFlight = null
      })
    return this.inFlight
  }

  async fetchOnce() {
    const key = await this.resolveKey()
    if (key === void 0 || key.length === 0) throw new Error('no-api-key')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await fetch(this.endpoint, { headers: { authorization: `Bearer ${key}`, accept: 'application/json' }, signal: controller.signal })
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
      const balance = parseBalanceResponse(await response.json())
      if (balance === null) throw new Error('unexpected-balance-payload')
      return balance
    } finally {
      clearTimeout(timer)
    }
  }
}

// ---------------------------------------------------------------------------
// 价格在线同步
// ---------------------------------------------------------------------------

/** 把 HTML 解析成 {行: [单元格文本]} 的表格列表。 */
export function htmlTables(html) {
  const tables = []
  for (const table of html.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/gi)) {
    const rows = []
    for (const tr of table[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells = []
      for (const cell of tr[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)) {
        cells.push(cell[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\u00a0/g, ' ').trim())
      }
      if (cells.length > 0) rows.push(cells)
    }
    if (rows.length > 0) tables.push(rows)
  }
  return tables
}

function parseYuan(text) {
  const match = String(text).match(/([\d.]+)\s*元/)
  return match ? Number(match[1]) : NaN
}

/**
 * 解析官方价格页 HTML → { models, schedule? }；解析不到任何模型时返回 null。
 * models: { id: { cny: {input,cacheRead,output}, usd: {input,cacheRead,output}, schedules? } }。
 */
export function parsePricingHtml(html) {
  const tables = htmlTables(html)
  const models = {}

  // 1. 主价格表：第一行是模型列（deepseek-*），其后有"百万tokens输入（缓存命中）"等行。
  for (const rows of tables) {
    const header = rows[0] ?? []
    const modelCols = []
    for (let i = 1; i < header.length; i++) {
      if (/^deepseek-[\w.-]+$/.test(header[i])) modelCols.push({ idx: i, model: header[i] })
    }
    if (modelCols.length === 0) continue
    const findRow = (label) => rows.find((r) => r.includes(label)) ?? null
    const hitRow = findRow('百万tokens输入（缓存命中）')
    const missRow = findRow('百万tokens输入（缓存未命中）')
    const outRow = findRow('百万tokens输出')
    if (!hitRow || !missRow || !outRow) continue
    for (const { idx, model } of modelCols) {
      const cny = {
        input: parseYuan(missRow[missRow.indexOf('百万tokens输入（缓存未命中）') + idx]),
        cacheRead: parseYuan(hitRow[hitRow.indexOf('百万tokens输入（缓存命中）') + idx]),
        output: parseYuan(outRow[outRow.indexOf('百万tokens输出') + idx]),
      }
      if ([cny.input, cny.cacheRead, cny.output].every(Number.isFinite)) {
        models[model] = { cny, usd: cny }
      }
    }
  }

  // 2. 峰谷价表：行首为模型名，随后是 空闲时段 / 高峰时段 各一行三价。
  let scheduleTable = null
  for (const rows of tables) {
    if (rows.some((r) => r.includes('空闲时段'))) {
      scheduleTable = rows
      break
    }
  }
  if (scheduleTable) {
    const peak = {}
    const offPeak = {}
    let currentModel = null
    for (const row of scheduleTable) {
      if (/^deepseek-[\w.-]+$/.test(row[0] ?? '')) {
        currentModel = row[0]
        if (row[1] === '空闲时段') offPeak[currentModel] = [parseYuan(row[2]), parseYuan(row[3]), parseYuan(row[4])]
        else if (row[1] === '高峰时段') peak[currentModel] = [parseYuan(row[2]), parseYuan(row[3]), parseYuan(row[4])]
      } else if (currentModel && (row[0] === '空闲时段' || row[0] === '高峰时段')) {
        ;(row[0] === '空闲时段' ? offPeak : peak)[currentModel] = [parseYuan(row[1]), parseYuan(row[2]), parseYuan(row[3])]
      }
    }
    const eff = html.match(/北京时间\s*(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*(\d{1,2}):(\d{2})/)
    const windowsText = html.match(/高峰时段为北京时间([\s\S]*?)(?:（|。|；|<)/)?.[1] ?? ''
    const windows = [...windowsText.matchAll(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/g)].map((m) => [Number(m[1]), Number(m[3])])
    if (eff && windows.length > 0) {
      const effectiveAt = `${eff[1]}-${String(eff[2]).padStart(2, '0')}-${String(eff[3]).padStart(2, '0')}T${String(eff[4]).padStart(2, '0')}:${String(eff[5]).padStart(2, '0')}:00+08:00`
      for (const model of Object.keys(offPeak)) {
        if (peak[model] && offPeak[model].every(Number.isFinite) && peak[model].every(Number.isFinite)) {
          const mk = (arr) => ({ input: arr[0], cacheRead: arr[1], output: arr[2] })
          models[model] = {
            ...(models[model] ?? {}),
            schedules: [{
              effectiveAt,
              timezoneOffsetMinutes: 480,
              peakWindows: windows,
              offPeak: { cny: mk(offPeak[model]), usd: mk(offPeak[model]) },
              peak: { cny: mk(peak[model]), usd: mk(peak[model]) },
            }],
          }
        }
      }
    }
  }

  if (Object.keys(models).length === 0) return null
  return { models }
}

// ---------------------------------------------------------------------------
// 配置合成
// ---------------------------------------------------------------------------

/** 把在线同步结果合成进政策时间线（在线模型条目覆盖内置同名条目）。 */
function layerSyncedPolicies(synced) {
  if (!synced || !synced.models) return OFFICIAL_PRICING_POLICIES
  const overrides = Object.entries(synced.models).map(([model, entry]) => ({
    since: entry.schedules?.[0]?.effectiveAt ?? '2025-01-01T00:00:00+08:00',
    label: `在线同步：${model}`,
    prices: { [model]: entry },
  }))
  return composePolicies(overrides)
}

/** 合并用户配置。 */
function mergeConfig(config) {
  const raw = config && typeof config === 'object' ? config : {}
  const peakWindows = Array.isArray(raw.peakWindows) && raw.peakWindows.length > 0 ? raw.peakWindows : DEFAULT_PEAK_WINDOWS
  return {
    apiKeyEnv: typeof raw.apiKeyEnv === 'string' && raw.apiKeyEnv ? raw.apiKeyEnv : DEFAULT_API_KEY_ENV,
    baseURL: typeof raw.baseURL === 'string' && raw.baseURL ? raw.baseURL : PUBLIC_BASE_URL,
    timezone: typeof raw.timezone === 'string' && raw.timezone ? raw.timezone : DEFAULT_TIMEZONE,
    peakWindows,
    prices: normalizeUserPrices(raw.prices),
    policyOverrides: Array.isArray(raw.policyOverrides) ? raw.policyOverrides : [],
    priceSync: { ...DEFAULT_CONFIG.priceSync, ...(raw.priceSync ?? {}) },
    persistPath: typeof raw.persistPath === 'string' && raw.persistPath ? raw.persistPath : DEFAULT_CONFIG.persistPath,
    maxRecent: Number.isFinite(raw.maxRecent) ? raw.maxRecent : DEFAULT_CONFIG.maxRecent,
    maxMessagesPerSession: Number.isFinite(raw.maxMessagesPerSession) ? raw.maxMessagesPerSession : DEFAULT_CONFIG.maxMessagesPerSession,
    loopbackOnly: raw.loopbackOnly !== false,
    balanceRefreshMs: Number.isFinite(raw.balanceRefreshMs) ? raw.balanceRefreshMs : DEFAULT_CONFIG.balanceRefreshMs,
    balanceTimeoutMs: Number.isFinite(raw.balanceTimeoutMs) ? raw.balanceTimeoutMs : DEFAULT_CONFIG.balanceTimeoutMs,
  }
}

// ---------------------------------------------------------------------------
// 文本格式化（命令/工具输出）
// ---------------------------------------------------------------------------

function fmtMoney(cny) {
  if (cny < 0.01 && cny > 0) return cny.toFixed(4)
  if (cny < 1) return cny.toFixed(3)
  return cny.toFixed(2)
}

/** 余额文本（人民币优先，附美元）。 */
export function formatBalanceText(balance) {
  if (!balance || (!balance.cny && !balance.usd)) return '余额接口返回了无法识别的数据。'
  const lines = ['DeepSeek 账户余额', `账户可用：${balance.cny?.isAvailable ?? balance.usd?.isAvailable ? '是' : '否'}`, '']
  for (const view of [balance.cny, balance.usd]) {
    if (!view) continue
    const symbol = view.currency === 'CNY' ? '¥' : '$'
    lines.push(
      `${view.currency === 'CNY' ? '人民币 (CNY)' : '美元 (USD)'}`,
      `  总余额：${symbol}${view.total}`,
      `  充值余额：${symbol}${view.toppedUp}`,
      `  赠金余额：${symbol}${view.granted}`,
      '',
    )
  }
  return lines.join('\n').trimEnd()
}

/** 会话费用文本（人民币）。 */
export function formatCostText(sessionView, pricingCtx) {
  if (!sessionView || sessionView.calls === 0) {
    return '本会话目前没有已记账的模型用量（assistant/usage 记录）。'
  }
  const lines = ['本会话 API 费用估算（按官方单价，人民币）', '']
  lines.push(
    `  合计：¥${fmtMoney(sessionView.cost)}（${sessionView.calls} 次请求）`,
    `  输入 ${sessionView.inputTokens.toLocaleString()} + 缓存命中 ${sessionView.cacheReadTokens.toLocaleString()} / 输出 ${sessionView.outputTokens.toLocaleString()} tokens`,
  )
  lines.push('', '说明：按每次请求实际计费时间套用单价（2026-08-17 起自动使用峰谷价）；子代理是独立会话，各自单独统计。')
  const src = pricingCtx?.source === 'online'
    ? `单价来源：官方在线同步${pricingCtx.syncedAt ? `（${new Date(pricingCtx.syncedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}）` : ''}`
    : '单价来源：内置默认（官方在线同步不可用，若官方改价请手动更新配置）'
  lines.push('', src)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// 插件主入口
// ---------------------------------------------------------------------------

function isLoopbackAddress(address) {
  if (address === '::1' || address === '::ffff:127.0.0.1' || address === '127.0.0.1') return true
  if (typeof address === 'string' && address.startsWith('127.')) {
    const octets = address.split('.')
    return octets.length === 4 && octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  }
  return false
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

export function apply(ctx, config) {
  const cfg = mergeConfig(config)

  if (!CRED_REF_PATTERN.test(cfg.apiKeyEnv)) {
    throw new TypeError(`dsh-billing: apiKeyEnv "${cfg.apiKeyEnv}" 不是合法的凭据引用（POSIX 环境变量名）`)
  }

  // ---- 计价上下文：内置默认 ← 官方在线同步 ← 用户显式配置 ----
  const policies = composePolicies(cfg.policyOverrides)
  const pricing = {
    hash: JSON.stringify({ policies: cfg.policyOverrides, timezone: cfg.timezone, peakWindows: cfg.peakWindows, prices: cfg.prices }),
    at: (model, time) => priceAt(model, time, { prices: cfg.prices, timezone: cfg.timezone, peakWindows: cfg.peakWindows, policies }),
  }

  // ---- 账本 ----
  const ledger = new BillingLedger(cfg.persistPath, cfg.maxRecent, cfg.maxMessagesPerSession)
  ledger.load()
  ledger.reprice(pricing)

  // ---- 余额 ----
  const resolveKey = async () => {
    const credentials = ctx.get('credentials')
    if (credentials !== void 0) {
      try {
        const hit = await credentials.resolve(cfg.apiKeyEnv)
        if (hit?.value !== void 0 && hit.value.length > 0) return hit.value
      } catch {
        // 凭证服务异常按未配置处理。
      }
    }
    const ambient = process.env[cfg.apiKeyEnv]
    return ambient !== void 0 && ambient.length > 0 ? ambient : void 0
  }
  const baseURL = process.env.DEEPSEEK_BASE_URL?.trim()
    ? `${process.env.DEEPSEEK_BASE_URL.replace(/\/+$/, '')}/user/balance`
    : `${cfg.baseURL.replace(/\/+$/, '')}/user/balance`
  const balance = new BalanceFetcher({
    resolveKey,
    endpoint: baseURL,
    refreshMs: cfg.balanceRefreshMs,
    timeoutMs: cfg.balanceTimeoutMs,
    logger: ctx.logger,
  })
  balance.start()

  // ---- 价格在线同步（可选）----
  const priceSync = cfg.priceSync
  let current = { source: 'builtin', syncedAt: null }
  let syncedPolicies = policies
  let syncTimer = null
  let retryDelay = 60_000

  async function syncPrices() {
    try {
      const response = await fetch(priceSync.url, { signal: AbortSignal.timeout(priceSync.timeoutMs) })
      if (!response.ok) throw new Error(`价格页返回 HTTP ${response.status}`)
      const parsed = parsePricingHtml(await response.text())
      if (!parsed) throw new Error('价格页解析不到任何模型价格')
      syncedPolicies = layerSyncedPolicies(parsed)
      pricing.at = (model, time) => priceAt(model, time, { prices: cfg.prices, timezone: cfg.timezone, peakWindows: cfg.peakWindows, policies: syncedPolicies })
      current = { source: 'online', syncedAt: Date.now() }
      ctx.logger?.info?.('dsh-billing: 官方单价已同步（%d 个模型）', Object.keys(parsed.models).length)
      return true
    } catch (error) {
      ctx.logger?.warn?.('dsh-billing: 官方单价同步失败，继续使用%s：%s', current.source === 'online' ? '上次在线值' : '内置默认值', error instanceof Error ? error.message : String(error))
      return false
    }
  }

  function scheduleSync(delay) {
    if (syncTimer !== null) clearTimeout(syncTimer)
    syncTimer = setTimeout(() => {
      syncPrices().then((ok) => {
        retryDelay = ok ? 60_000 : Math.min(retryDelay * 2, 30 * 60_000)
        scheduleSync(ok ? priceSync.intervalMs : retryDelay)
      })
    }, delay)
  }
  if (priceSync.enabled) {
    syncPrices().then((ok) => scheduleSync(ok ? priceSync.intervalMs : retryDelay))
    ctx.effect(() => () => {
      if (syncTimer !== null) clearTimeout(syncTimer)
    }, 'dsh-billing: price-sync timer')
  }

  // ---- 记账：订阅会话事件 ----
  const headersBySession = new Map()
  ctx.on('session/event', (session, event) => {
    try {
      if (event?.type === 'request/header' && event.data?.header?.config) {
        const header = event.data.header.config
        if (typeof header.provider === 'string' && typeof header.model === 'string') {
          headersBySession.set(session.id, { provider: header.provider, model: header.model })
        }
        return
      }
      if (event?.type !== 'assistant/message') return
      const data = event.data
      if (data?.usage === void 0 || data.usage === null) return
      const usage = data.usage
      if (typeof usage.outputTokens !== 'number' && typeof usage.inputTokens !== 'number') return
      const source = data.message?.source
      const header = headersBySession.get(session.id)
      const provider = typeof source?.provider === 'string' ? source.provider : header?.provider ?? ''
      const model = typeof source?.model === 'string' ? source.model : header?.model ?? 'unknown'
      ledger.record({
        sessionId: session.id,
        messageId: String(data.message?.id ?? `seq-${event.seq}`),
        seq: event.seq,
        time: event.time,
        provider,
        model,
        ...ledger.price(model, event.time, usage, pricing),
      })
    } catch (error) {
      ctx.logger?.warn?.('dsh-billing: record failed: %s', error instanceof Error ? error.message : String(error))
    }
  })

  // 退出/卸载时落盘
  const onSettle = () => {
    void ledger.flush().catch((error) => {
      ctx.logger?.warn?.('dsh-billing: flush failed: %s', error instanceof Error ? error.message : String(error))
    })
  }
  const settled = ctx.get('loader')?.await()
  if (settled === void 0) onSettle()
  else settled.then(onSettle, () => {})
  ctx.effect(() => () => {
    balance.dispose()
    void ledger.flush().catch((error) => {
      ctx.logger?.warn?.('dsh-billing: teardown flush failed: %s', error instanceof Error ? error.message : String(error))
    })
  }, 'dsh-billing: teardown flush')

  // ---- 命令 ----
  ctx.commands.register({
    name: 'balance',
    description: '查询 DeepSeek 账户余额（人民币优先，附美元）',
    handler: async () => {
      try {
        await balance.refresh()
        const snapshot = balance.getSnapshot()
        if (snapshot.status === 'error' || !snapshot.balance) {
          return { kind: 'error', text: `查询余额失败：${snapshot.error ?? '未知错误'}` }
        }
        return { kind: 'success', text: formatBalanceText(snapshot.balance) }
      } catch (error) {
        return { kind: 'error', text: `查询余额失败：${error instanceof Error ? error.message : String(error)}` }
      }
    },
  })

  ctx.commands.register({
    name: 'cost',
    description: '查看当前会话的 DeepSeek API 费用估算（人民币，持久化账本）',
    handler: async ({ agent }) => {
      try {
        const sessionId = agent?.session?.id ?? agent?.session?.sessionId
        if (!sessionId) return { kind: 'error', text: '当前调用没有关联的会话，无法统计费用。' }
        return { kind: 'success', text: formatCostText(ledger.sessionView(sessionId), current) }
      } catch (error) {
        return { kind: 'error', text: `统计费用失败：${error instanceof Error ? error.message : String(error)}` }
      }
    },
  })

  // ---- 工具 ----
  ctx.tools.register({
    name: 'deepseek_billing',
    description:
      '查询 DeepSeek 账户余额或当前会话费用（人民币）。query 取值：balance（余额）、cost（本会话费用）、both（两者）。当用户问"花了多少钱"或"余额"时使用。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          enum: ['balance', 'cost', 'both'],
          description: 'balance=账户余额；cost=当前会话费用；both=两者都要',
        },
      },
      required: ['query'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args, exec) {
      const query = args?.query ?? 'both'
      const parts = []
      if (query === 'balance' || query === 'both') {
        try {
          await balance.refresh()
          const snapshot = balance.getSnapshot()
          parts.push(snapshot.balance ? formatBalanceText(snapshot.balance) : `查询余额失败：${snapshot.error ?? '未知错误'}`)
        } catch (error) {
          parts.push(`查询余额失败：${error instanceof Error ? error.message : String(error)}`)
        }
      }
      if (query === 'cost' || query === 'both') {
        const sessionId = exec.agent?.session?.id ?? exec.agent?.session?.sessionId
        if (sessionId) {
          try {
            parts.push(formatCostText(ledger.sessionView(sessionId), current))
          } catch (error) {
            parts.push(`统计费用失败：${error instanceof Error ? error.message : String(error)}`)
          }
        } else {
          parts.push('当前调用没有关联的会话，无法统计费用。')
        }
      }
      return parts.join('\n\n')
    },
  })

  // ---- 只读端点：/billing/state、/billing/session/<id> ----
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/billing',
    handler: async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405)
          res.end()
          return
        }
        if (cfg.loopbackOnly) {
          const address = req.socket?.remoteAddress ?? ''
          if (!isLoopbackAddress(address)) {
            sendJson(res, 403, { ok: false, error: 'loopback-only' })
            return
          }
        }
        const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)
        const tail = pathname.startsWith('/billing') ? pathname.slice('/billing'.length) : ''
        if (tail === '/state' || tail === '') {
          const now = Date.now()
          const today = dayKey(now)
          const month = monthKey(now)
          const monthCounts = zeroCounts()
          for (const [key, counts] of ledger.byDay) if (key.startsWith(`${month}-`)) addCounts(monthCounts, counts)
          const topSessions = [...ledger.bySession.entries()]
            .map(([sessionId, value]) => ({ sessionId, calls: value.calls, cost: value.cost, costUsd: value.costUsd }))
            .sort((a, b) => b.cost - a.cost)
            .slice(0, 50)
          sendJson(res, 200, {
            ok: true,
            currency: 'CNY',
            symbol: '¥',
            pricing: {
              source: current.source,
              syncedAt: current.syncedAt,
              timezone: cfg.timezone,
              peakWindows: cfg.peakWindows,
              activePolicy: activePolicy(now, syncedPolicies)?.label ?? null,
              effectiveNow: (() => {
                const policy = activePolicy(now, syncedPolicies)
                return policy?.peak !== void 0 ? (isPeak(now, cfg.timezone, cfg.peakWindows) ? 'peak' : 'offPeak') : 'flat'
              })(),
            },
            totals: { ...ledger.totals },
            today: { date: today, ...(ledger.byDay.get(today) ?? zeroCounts()) },
            month: { key: month, ...monthCounts },
            byModel: Object.fromEntries([...ledger.byModel.entries()].sort((a, b) => b[1].cost - a[1].cost)),
            sessions: topSessions,
            recent: ledger.recent.slice(-20).reverse(),
            balance: balance.getSnapshot(),
          })
          return
        }
        const sessionMatch = /^\/session\/([^/]+)$/.exec(tail)
        if (sessionMatch !== null) {
          const view = ledger.sessionView(sessionMatch[1])
          if (view === void 0) {
            sendJson(res, 404, { ok: false, error: 'session-not-found' })
            return
          }
          sendJson(res, 200, { ok: true, ...view })
          return
        }
        sendJson(res, 404, { ok: false, error: 'not-found' })
      },
    }), 'dsh-billing: /billing routes')
}
