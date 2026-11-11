# dsh-token-ledger · Token 累计

在 DeepSeek Harness（DSH）的对话页顶栏常驻一枚小胶囊，显示**本机 DSH 所有会话累计消耗的 Token 总数**。数字随着 DSH 的持续使用而增长，跨重启保留，连已被删除的会话消耗过的部分也仍然保留。

> A DeepSeek Harness (DSH) Web UI plugin: one compact pill in the conversation header showing this machine's lifetime token consumption across **all** local sessions.

```
🪙 累计 21.85亿      ← 会话标题栏右侧，悬停看分项，点击复制精确值
```

## 它解决什么问题

DSH 自身只展示**当前会话**的上下文与用量。这个插件回答的是另一个问题：

> 我在这一台电脑的 DSH 上，**总共**烧掉了多少 token？

不打开任何面板、不切页面，抬头就能看到数字在涨。

## 功能

- **顶栏常驻**：注册在 `conversation.session.header.utilities`，位于对话窗口标题栏右侧
- **全机累计**：汇总本机所有会话（包括子代理会话、旧版本格式会话），不是只看当前这一轮
- **只会变大**：按会话取单调最大值并落盘，删会话、归档、重启都不会让数字回退
- **实时增长**：每轮结束由 DSH 自己的 checkpoint 校准，一轮进行中由实时事件先行累加；界面每 5 秒刷新
- **分项查看**：悬停显示未缓存输入 / 缓存读取 / 缓存写入 / 输出 / 非缓存合计 / 会话数 / 更新时间
- **一键复制**：点击胶囊把精确总数复制到剪贴板
- **只读、离线**：不读取对话内容，不联网，不上报

## 安装

### 通过插件市场（推荐）

在 DSH 的 **插件 → 发现** 中添加索引源后搜索 `dsh-token-ledger`（收录后可见）：

```text
https://dshopen.org/index.json
```

### 命令行

```bash
# 从插件市场使用的固定提交安装
dsh plugin --profile desktop add 'git+https://github.com/yinshipeng/dsh-token-ledger.git'

# 发布 npm 版本后
dsh plugin --profile desktop add dsh-token-ledger
```

安装后刷新页面（桌面端重启客户端）即可在会话标题栏右侧看到胶囊。

## 统计口径

数字来自 DSH 自己的 `tokenUsage` 投影（`@deepseek-ai/dsh-token-meter`），口径与 DSH 内部一致：

| 分项 | 字段 | 含义 |
| --- | --- | --- |
| 未缓存输入 | `uncachedInputTokens` | 未命中前缀缓存的 prompt token |
| 缓存读取 | `cacheReadTokens` | 命中前缀缓存的 prompt token |
| 缓存写入 | `cacheWriteTokens` | 写入缓存的 token |
| 输出 | `outputTokens` | 模型生成的 token |
| **胶囊上的数字** | 四者之和 | 本机处理过的全部 token |
| 非缓存合计 | 未缓存输入 + 输出 | 悬停可见，适合与账单对照 |

> 缓存读取通常占大头（每一轮都要重新读一遍上下文），所以「总计」会明显大于「非缓存合计」，两者都在悬停面板里。

## 数据从哪来

1. **DSH 的投影缓存**：每个会话在创建、`turn/end`、会话释放时由 DSH 自动把 `tokenUsage` 投影落盘到 `$DSH_HOME/storages/session_projcache/`。插件直接读这份结果，**不回放会话日志**，因此开销接近零，也能覆盖早已结束的会话。
2. **实时事件**：监听 `session/event`，把 `assistant/message` 上 provider 返回的 usage 先记账，等下一次 checkpoint 落盘后自动去重。
3. **持久账本**：`$DSH_HOME/token-ledger/ledger.json` 记录每个会话观察到的最大值与未合并的实时增量，重启后继续累加。会话被删除后，它贡献的消耗仍留在账本里。

## 隐私与安全

- 只统计数字，不读消息正文、不读工具结果、不读附件
- 无任何出网请求；数字只在本机 Host 内存与 `$DSH_HOME/token-ledger/ledger.json` 中
- 插件的 HTTP 接口只接受经 Host `connection.requestRejection` 认证的浏览器请求；拿不到该服务时一律拒绝，不会退化为只检查回环地址
- 接口只提供只读 `GET`，没有写操作

## 兼容性

| 项 | 要求 |
| --- | --- |
| DSH | `>=0.2.2-rc.1`（声明在 `dsh.engines.dsh`） |
| Node.js | `>=22.19.0` |
| 形态 | Web / Desktop 均可（需要 Web UI 宿主） |

已在 macOS + DeepSeek Harness Desktop 0.2.2-rc.1 实测。

## 结构

| 文件 | 职责 |
| --- | --- |
| `index.js` | Host：聚合所有会话的 `tokenUsage` 投影、实时事件、持久账本、`GET /token-ledger/state` |
| `client.js` | Browser：向顶栏 utilities 槽位注册胶囊，轮询状态 |
| `cordis.patch.yml` | 插入一行双端插件 |
| `locale/*.json` | 插件管理页的标题与说明 |
| `icon.svg` | 插件图标 |

## 已知限制

- 远程配对的手机端 UI 不显示（接口仅对已认证的本机浏览器开放）
- 会话日志与投影缓存都缺失的极端情况下，该会话不会被计入
- 「进行中的一轮」在 checkpoint 落盘前是实时估算值，落盘后由 DSH 的投影校准

## 卸载

```bash
dsh plugin --profile desktop remove dsh-token-ledger
```

账本文件可手动删除：`$DSH_HOME/token-ledger/ledger.json`。

## English

**dsh-token-ledger** puts one compact pill in the DSH conversation header showing the lifetime token total of **every session on this machine** — not just the open one. The number only grows: it is checkpointed into a durable ledger, survives restarts and keeps the consumption of sessions that were later deleted.

- Reads DSH's own `tokenUsage` projection cache (no session-log replay), plus live `assistant/message` events between checkpoints
- Hover for the breakdown (uncached input / cache read / cache write / output / uncached total / sessions / updated at); click to copy the exact number
- Read-only, offline, no message content; the HTTP route is admitted only through the Host `connection.requestRejection` gate
- Tested on macOS with DSH 0.2.2-rc.1 (Web and Desktop)

Install:

```bash
dsh plugin --profile desktop add dsh-token-ledger
```

## License

MIT © 2026 yinshipeng