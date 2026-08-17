import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  priceAt,
  costOf,
  parseBalanceResponse,
  BillingLedger,
} from '../host.js'

// ---- 定价引擎 ----

const before = new Date('2026-08-16T10:00:00+08:00').getTime()
const peak = new Date('2026-08-18T10:00:00+08:00').getTime() // 10:00 北京 = 高峰
const offpeak = new Date('2026-08-18T20:00:00+08:00').getTime() // 20:00 = 空闲

test('08-17 之前使用 V4 扁平价', () => {
  const r = priceAt('deepseek-v4-flash', before, {})
  assert.equal(r.cny.input, 1)
  assert.equal(r.mode, 'flat')
})

test('高峰时段取峰价', () => {
  const r = priceAt('deepseek-v4-flash', peak, {})
  assert.equal(r.cny.input, 3)
  assert.equal(r.mode, 'peak')
})

test('空闲时段取闲价', () => {
  const r = priceAt('deepseek-v4-flash', offpeak, {})
  assert.equal(r.cny.input, 1.5)
  assert.equal(r.mode, 'offPeak')
})

test('政策链继承：deepseek-chat 未被 08-17 政策点名，沿用 05-22 价格', () => {
  const r = priceAt('deepseek-chat', peak, {})
  assert.equal(r.cny.input, 2)
})

test('costOf 双币种费用计算', () => {
  const unit = { cny: { input: 3, cacheRead: 0.1, output: 9 }, usd: { input: 0.44, cacheRead: 0.014, output: 1.32 } }
  const c = costOf({ inputTokens: 1000, cacheReadTokens: 1000, outputTokens: 500 }, unit)
  assert.ok(Math.abs(c.cost - 0.0076) < 1e-9)
  assert.ok(Math.abs(c.costUsd - (1000 * 0.44 + 1000 * 0.014 + 500 * 1.32) / 1e6) < 1e-9)
})

// ---- 余额解析 ----

test('parseBalanceResponse 解析 CNY', () => {
  const b = parseBalanceResponse({
    is_available: true,
    balance_infos: [
      { currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' },
    ],
  })
  assert.equal(b.cny.total, 110)
  assert.equal(b.cny.granted, 10)
  assert.equal(b.cny.toppedUp, 100)
  assert.equal(b.usd, null)
})

test('parseBalanceResponse 非法响应返回 null', () => {
  assert.equal(parseBalanceResponse(null), null)
  assert.equal(parseBalanceResponse({}), null)
})

// ---- 账本 ----

function makeLedger() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-billing-'))
  return new BillingLedger(path.join(dir, 'ledger.json'), 100, 100)
}

const pricing = { hash: 'test-v1', at: (model, time) => priceAt(model, time, {}) }

test('账本幂等：重放同一消息不重复累计', () => {
  const ledger = makeLedger()
  const mk = (mid, time) => ({
    sessionId: 's1', messageId: mid, time, provider: 'deepseek', model: 'deepseek-v4-flash',
    inputTokens: 1000, cacheReadTokens: 0, outputTokens: 0,
    ...ledger.price('deepseek-v4-flash', time, { inputTokens: 1000, cacheReadTokens: 0, outputTokens: 0 }, pricing),
  })
  ledger.record(mk('m1', peak))
  ledger.record(mk('m2', offpeak))
  assert.equal(ledger.totals.calls, 2)
  ledger.record(mk('m1', peak)) // 重放
  assert.equal(ledger.totals.calls, 2)
})

test('账本重估：换定价规则后按新价重建聚合', async () => {
  const ledger = makeLedger()
  const mk = (time) => ({
    sessionId: 's1', messageId: 'm1', time, provider: 'deepseek', model: 'deepseek-v4-flash',
    inputTokens: 1000, cacheReadTokens: 0, outputTokens: 0,
    ...ledger.price('deepseek-v4-flash', time, { inputTokens: 1000, cacheReadTokens: 0, outputTokens: 0 }, pricing),
  })
  ledger.record(mk(peak))
  await ledger.flush()

  const pricing2 = {
    hash: 'test-v2',
    at: () => ({ cny: { input: 9, cacheRead: 1, output: 27 }, usd: { input: 1, cacheRead: 0.1, output: 3 }, mode: 'flat', policy: undefined }),
  }
  ledger.reprice(pricing2)
  assert.equal(ledger.totals.calls, 1)
  assert.ok(Math.abs(ledger.totals.cost - 0.009) < 1e-9)
})
