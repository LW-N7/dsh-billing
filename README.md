# dsh-billing

> DeepSeek Harness 计费插件：账户余额 + 会话费用 + 持久化账本

在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh web`）的会话头部显示 **DeepSeek 账户余额** 与 **会话费用** 双胶囊，悬停查看明细；带**持久化账本**，重启不丢历史；支持斜杠命令与模型工具查询。

纯 JavaScript 双面插件（host + browser），**零构建、零运行时依赖**。

## 功能

| 入口 | 说明 |
| --- | --- |
| 会话头双胶囊 | `余额 ¥X` + `会话 ¥Y` 并排显示，点击任意胶囊立即刷新两个 |
| 悬停明细 | 余额胶囊：人民币/美元、充值/赠金、账户可用性；费用胶囊：本会话 token 拆分 + **今日/本月/累计账本汇总** |
| `/balance` | 查询账户余额（人民币优先，附美元） |
| `/cost` | 当前会话费用明细 |
| 工具 `deepseek_billing` | 让模型直接查余额/费用（`query = balance / cost / both`） |
| 持久化账本 | 逐条消息**幂等**记账（`(sessionId, messageId)` 主键），重启/重放不重复累计 |
| 改价自愈 | 官方调价或配置变更后，重启时按当前规则**自动重估全部存量记录** |
| 价格在线同步 | 默认每 12h 拉取官方价格页，失败回退上次在线值 → 内置默认 |

刷新策略：事件驱动（回合结束 / 每 10 步 / 点击 / 页面切回可见），**空闲零请求**，无定时轮询。

## 计价

内置官方政策时间线（策展自 DeepSeek 官方公告，以官方页面为准）：

| 生效时间（北京） | 政策 |
| --- | --- |
| 2025-02-09 | deepseek-chat / deepseek-reasoner 标准价 |
| 2026-05-22 | V4 系列 75% 降价转永久（v4-flash / v4-pro） |
| 2026-08-17 | **峰谷定价**：高峰 09:00–12:00 / 14:00–18:00（北京），空闲时段半价 |

政策链继承：新政策未点名的模型沿用最近一次被点名的价格，历史账单与平台一致。
费用为**估算值**，实际扣费以 DeepSeek 官方账单为准。

## 安装

### 从 GitHub 安装（推荐）

```sh
dsh plugin --profile web add github:<你的用户名>/dsh-billing
```

重启 `dsh web` 并刷新页面（F5）即生效。API Key 在 Web 的**模型设置页**保存（或设置环境变量 `DEEPSEEK_API_KEY`）。

### 本地开发安装（link 模式，改代码即时生效）

```sh
dsh plugin --profile web add D:\path\to\dsh-billing --store-dir=<你的 pnpm store 路径>
```

> 提示：`dsh plugin` 实际调用 pnpm；若报 `ERR_PNPM_UNEXPECTED_STORE`，
> 带上 `--store-dir=<store 物理路径>` 即可（见 [pnpm store](https://pnpm.io/settings#store-dir)）。

### 卸载

```sh
dsh plugin --profile web remove dsh-billing
```

## 配置（可选，全部有默认值）

在 `~/.dsh/profiles/web/cordis.patch.yml` 按 id 覆写整行（覆盖会替换整份 config，需重述所有键）：

```yaml
- id: dsh-billing
  name: 'dsh-billing'
  config:
    apiKeyEnv: DEEPSEEK_API_KEY
    baseURL: https://api.deepseek.com
    timezone: Asia/Shanghai
    peakWindows: [[9, 12], [14, 18]]
    prices:
      deepseek-v4-pro: { input: 3, cacheRead: 0.025, output: 6 }
    priceSync: { enabled: true, url: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/', intervalMs: 43200000 }
    loopbackOnly: true
    persistPath: '<默认 $DSH_HOME/storages/dsh-billing.json>'
```

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `apiKeyEnv` | `DEEPSEEK_API_KEY` | 凭据引用（环境变量名），经 `ctx.credentials` 逐次解析 |
| `baseURL` | `https://api.deepseek.com` | 余额接口前缀（`/user/balance` 追加在其后） |
| `timezone` | `Asia/Shanghai` | 峰谷时段判定时区（IANA） |
| `peakWindows` | `[[9,12],[14,18]]` | 高峰时段（本地小时，`[start, end)`） |
| `prices` | `{}` | 用户单价覆盖 `{ model: { input, cacheRead, output } }`（元/百万 tokens） |
| `priceSync` | `{ enabled: true, ... }` | 官方价格页在线同步开关与参数 |
| `loopbackOnly` | `true` | `/billing` 端点仅允许回环地址访问 |
| `persistPath` | `$DSH_HOME/storages/dsh-billing.json` | 账本文件位置 |

## 只读端点（默认仅回环）

- `GET /billing/state` — 余额 + 今日/本月/累计/按模型/最近流水 + 计价信息
- `GET /billing/session/<id>` — 单会话费用与逐条消息明细

## 开发

```sh
git clone https://github.com/<你的用户名>/dsh-billing
cd dsh-billing
npm test          # node --test tests/，覆盖定价引擎/账本幂等/重估/余额解析
```

## 已知限制

- 同一 `$DSH_HOME` 只运行一个实例（账本文件争写）
- 费用为估算值；余额数据来自官方 `GET /user/balance`
- 无历史用量或非人民币账户时不显示费用估算

## 参考与致谢

本插件参考了以下开源项目（MIT / 相关许可）：

- [TheTianzz/dsh-billing](https://github.com/TheTianzz/dsh-billing) — 命令/工具/事件驱动刷新/价格同步
- [bpc-oss/dsh-web-billing](https://github.com/bpc-oss/dsh-web-billing) — 持久化账本/官方政策时间线
- [WilliamLIiii/DeepSeek-Harness-billing-plugin](https://github.com/WilliamLIiii/DeepSeek-Harness-billing-plugin) — 插件结构参考

## License

[MIT](LICENSE)
