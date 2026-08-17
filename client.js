// dsh-billing 浏览器半区：会话头部双胶囊（余额 + 本会话费用），事件驱动更新。
// 工厂格式直接注册进平台模块表，仅依赖平台共享的 react（无构建步骤）。
// 数据来自宿主只读端点：GET /billing/state（余额 + 今日/本月/累计）、GET /billing/session/<id>（本会话费用）。
function makeFactory(require) {
  const react = require('react')
  const { createElement: h, useCallback, useEffect, useRef, useState } = react

  // ---- 宿主只读端点调用 ----
  async function getJson(url) {
    let response
    try {
      response = await fetch(url, { method: 'GET', headers: { accept: 'application/json' } })
    } catch (error) {
      throw new Error(`${url} 网络错误：${error instanceof Error ? error.message : String(error)}`)
    }
    if (!response.ok) throw new Error(`${url} HTTP ${response.status}`)
    return response.json()
  }

  function fmtCost(c) {
    if (!Number.isFinite(c) || c <= 0) return '0.00'
    if (c < 0.01) return c.toFixed(4)
    if (c < 1) return c.toFixed(3)
    return c.toFixed(2)
  }

  /** 从会话快照选取"最近一条已结算助手消息的 turn:step"（原始字符串，步进时变化）。 */
  function selectStepSignal(snapshot) {
    let best = null
    for (const node of snapshot.nodes) {
      if (node.kind !== 'assistant') continue
      if (best === null || node.turn > best.turn || (node.turn === best.turn && node.step > best.step)) {
        best = { turn: node.turn, step: node.step }
      }
    }
    return best ? `${best.turn}:${best.step}` : ''
  }

  /** 从会话快照选取"最近完成的轮次号"（原始值，轮次结束时变化）。 */
  function selectMaxTurnEnd(snapshot) {
    let max = 0
    for (const turn of snapshot.turnEnds.keys()) if (turn > max) max = turn
    return max
  }

  /**
   * 纯函数：根据最新信号决定是否触发一次刷新。
   * fire 条件：轮次结束；或同一轮内步号跨过 10 的整数倍边界。
   */
  function evaluateStepTrigger(st, stepSig, turnEndSig) {
    const cur = stepSig === '' ? null : stepSig.split(':').map(Number)
    const curTurn = cur ? cur[0] : 0
    const curStep = cur ? cur[1] : 0
    if (!st.ready) {
      return { st: { ready: true, turn: curTurn, step: curStep, turnEnd: turnEndSig }, fire: false }
    }
    if (turnEndSig !== st.turnEnd) {
      return { st: { ...st, turnEnd: turnEndSig, turn: curTurn, step: curStep }, fire: true }
    }
    if (curTurn === st.turn && Math.floor(curStep / 10) > Math.floor(st.step / 10)) {
      return { st: { ...st, step: curStep }, fire: true }
    }
    if (curTurn !== st.turn) {
      return { st: { ...st, turn: curTurn, step: curStep }, fire: false }
    }
    return { st, fire: false }
  }

  const pillBase = {
    display: 'inline-flex',
    alignItems: 'center',
    whiteSpace: 'nowrap',
    fontVariantNumeric: 'tabular-nums',
    fontSize: '11px',
    lineHeight: '20px',
    padding: '0 8px',
    borderRadius: '999px',
    border: '1px solid rgba(127, 127, 127, 0.3)',
    background: 'rgba(127, 127, 127, 0.12)',
    cursor: 'pointer',
  }

  // ---- 双胶囊：余额 + 本会话费用（会话头部静态区，order 为负）----
  // 更新策略（按需触发，无空闲轮询）：
  //  1. 轮次中：每完成 10 步刷新一次（跨过 10 的整数倍边界时）
  //  2. 每轮结束（turn/end）：刷新一次，结算本轮的收尾步
  //  3. 挂载 / 切换会话：立即刷新
  //  4. 点击任意一个胶囊：立即刷新两个
  //  5. 页面从后台切回可见：立即刷新一次
  //  空闲时零请求。
  function BillingPills(props) {
    const sessionId = props.sessionId
    const [stateData, setStateData] = useState(null)
    const [sessionData, setSessionData] = useState(null)
    const [stateFailed, setStateFailed] = useState(false)
    const [sessionFailed, setSessionFailed] = useState(false)
    // 两个端点各自独立序号：只丢弃"同端点"的过期响应，互不干扰
    const stateEpochRef = useRef(0)
    const sessionEpochRef = useRef(0)

    const refreshSession = useCallback(async () => {
      if (!sessionId) return
      const epoch = ++sessionEpochRef.current
      try {
        const value = await getJson(`/billing/session/${encodeURIComponent(sessionId)}`)
        if (epoch !== sessionEpochRef.current) return // 丢弃过期响应
        setSessionData(value.ok ? value : null)
        setSessionFailed(false)
      } catch {
        if (epoch === sessionEpochRef.current) setSessionFailed(true)
      }
    }, [sessionId])

    const refreshState = useCallback(async () => {
      const epoch = ++stateEpochRef.current
      try {
        const value = await getJson('/billing/state')
        if (epoch !== stateEpochRef.current) return
        setStateData(value.ok ? value : null)
        setStateFailed(false)
      } catch {
        if (epoch === stateEpochRef.current) setStateFailed(true)
      }
    }, [])

    const refreshAll = useCallback(() => {
      refreshSession()
      refreshState()
    }, [refreshSession, refreshState])

    // 挂载 / 切换会话：立即刷新
    useEffect(() => {
      setSessionData(null)
      setSessionFailed(false)
      refreshAll()
    }, [sessionId, refreshAll])

    // 事件驱动信号（原始值，避免多余渲染）
    const stepSig = typeof props.useSession === 'function' ? props.useSession(selectStepSignal) : ''
    const turnEndSig = typeof props.useSession === 'function' ? props.useSession(selectMaxTurnEnd) : 0

    // 步进触发：同一轮内每跨过 10 的整数倍 → 防抖 300ms 刷新；轮次结束 → 刷新
    const progressRef = useRef({ ready: false, turn: 0, step: 0, turnEnd: 0 })
    useEffect(() => {
      const st = progressRef.current
      const next = evaluateStepTrigger(st, stepSig, turnEndSig)
      progressRef.current = next.st
      if (!next.fire) return
      const timer = setTimeout(refreshAll, 300) // 同批多次变化合并为一次请求
      return () => clearTimeout(timer)
    }, [sessionId, stepSig, turnEndSig, refreshAll])

    // 页面从后台切回可见：立即刷新一次（非轮询）
    useEffect(() => {
      const onVisibility = () => {
        if (!document.hidden) refreshAll()
      }
      document.addEventListener('visibilitychange', onVisibility)
      return () => document.removeEventListener('visibilitychange', onVisibility)
    }, [refreshAll])

    const bal = stateData?.balance
    const cny = bal?.balance?.cny
    const usd = bal?.balance?.usd
    let balTitle = 'DeepSeek 账户余额（点击刷新）'
    if (bal?.status === 'error') {
      balTitle = `DeepSeek 账户余额（查询失败：${bal.error ?? '未知错误'}，点击重试）`
    } else if (cny) {
      balTitle = `DeepSeek 账户余额（点击刷新）\n人民币：总 ¥${cny.total}（充值 ¥${cny.toppedUp}，赠金 ¥${cny.granted}）${cny.isAvailable ? '' : '（当前不可用）'}`
      if (usd) balTitle += `\n美元：总 $${usd.total}（充值 $${usd.toppedUp}，赠金 $${usd.granted}）`
    }

    const sessionCost = sessionData && sessionData.calls > 0 ? sessionData.cost : 0
    let costTitle = '本会话 API 费用估算（持久化账本）\n点击立即刷新'
    if (sessionData && sessionData.calls > 0) {
      const sourceLine = stateData?.pricing?.source === 'online'
        ? `单价来源：官方在线同步${stateData.pricing.syncedAt ? `（${new Date(stateData.pricing.syncedAt).toLocaleString()}）` : ''}`
        : '单价来源：内置默认（在线同步暂不可用，若官方改价可能失准）'
      costTitle = `本会话 API 费用估算\n合计 ¥${fmtCost(sessionData.cost)}（${sessionData.calls} 次请求）\n输入 ${sessionData.inputTokens.toLocaleString()} + 缓存命中 ${sessionData.cacheReadTokens.toLocaleString()} / 输出 ${sessionData.outputTokens.toLocaleString()} tokens\n${sourceLine}\n点击立即刷新`
    }
    // 历史汇总附加在会话费用胶囊标题里（账本持久化数据）
    if (stateData) {
      const today = stateData.today?.cost ?? 0
      const month = stateData.month?.cost ?? 0
      const total = stateData.totals?.cost ?? 0
      costTitle += `\n\n账本汇总（持久化）：\n今日 ¥${fmtCost(today)} · 本月 ¥${fmtCost(month)} · 累计 ¥${fmtCost(total)}`
    }

    return h(
      'span',
      { style: { display: 'inline-flex', alignItems: 'center', gap: '6px' } },
      h(
        'span',
        {
          title: balTitle,
          style: { ...pillBase },
          onClick: () => refreshAll(),
        },
        '余额 ',
        h('b', { style: { color: cny ? 'rgba(64, 158, 106, 1)' : 'inherit' } }, `¥${cny ? cny.total : bal?.status === 'error' || stateFailed ? '—' : '…'}`),
      ),
      h(
        'span',
        {
          title: costTitle,
          style: { ...pillBase, opacity: sessionFailed ? 0.45 : 1 },
          onClick: () => refreshAll(),
        },
        '会话 ',
        h('b', null, `¥${sessionData ? fmtCost(sessionData.cost) : sessionFailed ? '—' : '…'}`),
      ),
    )
  }

  function apply(ctx) {
    const entryName = ctx.fiber?.entry?.options?.name
    if (entryName !== undefined && entryName !== 'dsh-billing') return
    // conversation.session.header.actions：会话头部动作区（list 槽位；负数 order = 静态会话上下文）
    ctx.slots.inject('conversation.session.header.actions', () =>
      ctx.slots.register(
        { name: 'conversation.session.header.actions', id: 'billing-pills', order: -10 },
        BillingPills,
      ),
    )
  }

  const exports = {}
  exports.inject = ['slots']
  exports.apply = apply
  // 测试挂点（生产无副作用）
  exports.testHooks = { evaluateStepTrigger, selectStepSignal, selectMaxTurnEnd }
  return exports
}
window.__ModuleLoader__.load({ id: 'dsh-billing', factory: makeFactory })
