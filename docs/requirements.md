# TTS 中转服务 · 需求文档

版本：v0.2（修订）
日期：2026-02-05
状态：已按用户意见修订（同步为主 / 纯 JavaScript / 设计模式）

---

## 1. 项目概述

### 1.1 背景

需要一个 **TTS（Text-To-Speech）中转服务**：上游对接多个语音合成供应商，向下游（调用方）提供**统一、稳定的 HTTP 接口**。调用方不需要关心供应商差异——只要传文字和发音人，就能拿到语音（MP3 等格式）。第一个接入的供应商是**微软 Edge 浏览器「大声朗读」功能背后的语音合成服务**（Edge TTS 逆向接口，个人使用），后续可平滑扩展其他供应商（Azure TTS、OpenAI TTS、火山引擎、讯飞等）。

### 1.2 目标

- 统一 TTS 接入层：一套 API，多供应商后端。
- **以同步返回音频为主**；同一接口通过参数支持异步任务模式（默认同步）。
- 供应商插件化：新增供应商不修改已有 API 和调用方，通过**设计模式**（策略/工厂/适配器）实现清晰扩展。
- 技术栈：**Node.js + 纯 JavaScript（不用 TypeScript）**，代码直观可读。
- 服务可独立部署、可配置、可观测。

### 1.3 非目标（本期不做）

- 不做 TTS 引擎本身，只做调度/转发/适配。
- 不做复杂的用户/权限体系（默认单租户内网使用，鉴权可配置）。
- 不做语音识别（ASR）、音频转写等。

---

## 2. 术语

| 术语 | 说明 |
| --- | --- |
| 供应商（Provider） | 上游 TTS 能力提供方，如 `edge`（微软大声朗读）、`azure`、`openai` |
| 音频格式（Format） | 输出的编码格式，如 `mp3`、`ogg`、`wav` 等 |
| 异步任务（Task） | 长文本场景下的后台合成任务，有状态（排队/执行中/成功/失败） |
| mode | 调用形态参数：`sync`（默认，同步返回音频）或 `async`（返回 taskId） |

---

## 3. 功能需求

### 3.1 核心能力：文本转语音（统一入口，默认同步）

- 调用方提交：`text`（必填）、`voice`（必填，或供应商默认发音人）、可选参数、`mode`（默认 `sync`）。
- **`mode=sync`**（默认）：服务立即合成并**直接返回音频**。
  - 返回形式由 `output` 参数控制：`stream`（音频流，默认）或 `base64`（JSON 内返回）。
- **`mode=async`**：服务返回 `taskId`，调用方通过任务接口查询状态并下载音频（见 3.2）。

### 3.2 异步任务（可选模式）

- 同一接口 `mode=async` 提交：返回 `{ taskId }`。
- `GET /v1/tts/tasks/:id` 查询状态；成功后可 `GET /v1/tts/tasks/:id/audio` 下载音频。
- 音频文件落盘存储，带**保留时间/TTL**（默认 24h），到期自动清理。
- 失败任务返回明确错误信息，可重新提交。

### 3.3 输入参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `text` | string | 是 | — | 要合成的文字；同步模式默认上限 1000 字，超长建议 `mode=async`（上限可配置） |
| `mode` | string | 否 | `sync` | `sync` 或 `async` |
| `provider` | string | 否 | `edge` | 供应商标识 |
| `voice` | string | 否 | 供应商默认 | 发音人，如 `zh-CN-XiaoxiaoNeural` |
| `language` | string | 否 | 由 voice 推断 | 语言，通常不需要显式传 |
| `rate` | string | 否 | `+0%` | 语速，如 `-20%` / `+50%` |
| `pitch` | string | 否 | `+0Hz` | 音调 |
| `volume` | string | 否 | `+0%` | 音量 |
| `format` | string | 否 | `audio-24khz-48kbitrate-mono-mp3` | 音频格式（供应商支持的枚举；`mp3`/`ogg` 等简称由服务映射） |
| `output` | string | 否 | `stream` | 返回形式：`stream` 或 `base64`（仅 sync 模式有效） |
| `requestId` | string | 否 | — | 调用方透传的追踪 ID，写入日志 |

> 参数统一由服务层做**规范化/校验**，供应商差异在适配器层消化（如格式枚举映射、速率格式）。

### 3.4 发音人（Voice）管理

- `GET /v1/voices?provider=edge`：列出当前供应商可用发音人（含语言、性别）。
- Edge 发音人清单维护为**内置静态清单**（随代码发布），后续可配置刷新。

### 3.5 多供应商扩展与设计模式

架构上明确使用以下设计模式：

| 模式 | 用法 |
| --- | --- |
| 策略模式（Strategy） | 定义统一 `Provider` 接口，每个供应商一个实现类，运行时按 `provider` 参数切换算法 |
| 工厂模式（Factory） | `ProviderRegistry`（注册表）：按名称创建/返回供应商实例，调用方不关心具体类 |
| 适配器模式（Adapter） | 每个供应商的差异协议（如 Edge 的 WebSocket 消息）被封装进各自的适配器实现，对外暴露统一接口 |

- 新供应商 = 新增一个目录 + 实现 `Provider` 接口 + 在注册表登记一行，API 层零改动。

### 3.6 错误处理与状态码

统一错误模型，返回 JSON：`{ "code": "...", "message": "...", "requestId": "..." }`

| HTTP 状态 | 场景 | 错误码示例 |
| --- | --- | --- |
| 400 | 缺参/参数非法/文字超长 | `invalid_parameter` |
| 404 | 供应商不存在/发音人不存在 | `provider_not_found` / `voice_not_found` |
| 429 | 超过并发/频率限制 | `rate_limited` |
| 502 | 上游合成失败/超时 | `upstream_error` / `upstream_timeout` |
| 500 | 内部错误 | `internal_error` |

上游暂时性失败（网络抖动、限流）支持**有限次自动重试**（默认 1 次）。

---

## 4. API 设计草案

Base URL：`http://<host>:<port>/v1`

### 4.1 统一合成入口（默认同步）

```
POST /v1/tts
Content-Type: application/json

{
  "text": "你好，世界",
  "mode": "sync",                 // 默认 sync；async 则返回 taskId
  "provider": "edge",
  "voice": "zh-CN-XiaoxiaoNeural",
  "rate": "+10%",
  "format": "mp3",
  "output": "stream"
}
```

- `mode=sync` + `output=stream`（默认）：`200` + `Content-Type: audio/mpeg`（或对应 mime），直接是音频。
- `mode=sync` + `output=base64`：`200` JSON `{ "audioBase64": "...", "format": "mp3", "durationMs": 1234 }`（时长若可得）。
- `mode=async`：`202` JSON `{ "taskId": "..." }`。

### 4.2 异步任务管理（mode=async 时使用）

```
GET    /v1/tts/tasks/:id       → { "status": "pending|running|succeeded|failed", "result": {...} }
GET    /v1/tts/tasks/:id/audio → 音频文件下载（succeeded 后可用）
DELETE /v1/tts/tasks/:id       → 删除任务及音频文件
```

### 4.3 发音人列表

```
GET /v1/voices?provider=edge → { "provider": "edge", "voices": [ { "name": "...", "language": "...", "gender": "..." } ] }
```

### 4.4 健康检查

```
GET /health → { "status": "ok" }
GET /ready  → 就绪探针（各供应商连通性检查可配置开关）
```

---

## 5. 非功能需求

| 类别 | 要求 |
| --- | --- |
| 性能 | 同步合成 P95 < 5s（受上游影响）；并发上限默认 16，超限返回 429（可配置） |
| 可靠性 | 上游失败自动重试（可配置次数）；异步任务状态存内存（重启丢失可接受，迭代后可换 SQLite） |
| 可观测 | 结构化日志（含 provider、voice、耗时、requestId） |
| 配置 | 集中配置文件（供应商、默认参数、限额、TTL、端口），支持环境变量覆盖 |
| 安全 | 默认无鉴权（个人内网使用）；可配置简单 API Key |
| 部署 | 单进程独立运行，无外部依赖；PM2 / 直接 `node` 启动 |

---

## 6. 技术选型

| 项 | 选择 | 理由 |
| --- | --- | --- |
| 语言 | **JavaScript (ESM)** | 用户明确不用 TypeScript；Node 24 原生支持 |
| Web 框架 | Fastify | 性能好、内置 JSON Schema 校验、插件体系清晰 |
| WebSocket | `ws` | 实现 Edge 协议所需客户端 |
| UUID | `crypto.randomUUID()` | Node 内置，无额外依赖 |
| 任务存储 | 内存 Map + 定时清理 | 轻量零依赖 |
| 测试 | `node:test` + 内置断言 | 零依赖，简单直接 |

> **依赖最小化**：仅 `fastify` + `ws` 两个运行时依赖。

---

## 7. 目录结构草案

```
read_tts/
├── src/
│   ├── server.js              # 服务入口（Fastify 装配、路由注册）
│   ├── config.js              # 配置加载（默认值 + 环境变量覆盖）
│   ├── routes/
│   │   ├── tts.js             # POST /v1/tts（sync/async）
│   │   ├── tasks.js           # 任务查询/下载/删除
│   │   ├── voices.js          # 发音人列表
│   │   └── health.js          # 健康检查
│   ├── providers/
│   │   ├── base.js            # Provider 抽象基类（接口定义，策略模式）
│   │   ├── registry.js        # 供应商注册表（工厂模式）
│   │   ├── edge/              # 微软大声朗读适配器（适配器模式）
│   │   │   ├── provider.js    # EdgeProvider：实现统一接口
│   │   │   ├── protocol.js    # WebSocket 协议封装（token、消息流）
│   │   │   └── voices.js      # 内置发音人清单
│   │   └── example/           # 新供应商示例（README 说明扩展方式）
│   ├── tasks/
│   │   └── manager.js         # 异步任务内存管理 + TTL 清理
│   └── utils/
│       ├── errors.js          # 统一错误模型与 HTTP 状态映射
│       ├── logger.js          # 结构化日志
│       └── retry.js           # 有限次重试
├── data/                      # 异步任务音频文件（gitignore）
├── tests/                     # node:test 测试
├── docs/requirements.md       # 本文档
└── package.json
```

---

## 8. 合规与风险说明

- Edge「大声朗读」为微软产品内置功能的非公开接口，社区逆向实现，**仅限个人使用**（已确认）。
- 该接口可能随时间失效/变更；有隐性使用限制，服务端已设并发上限。
- 用于对外生产时，建议切换官方 Azure TTS（同一发音人体系，迁移成本低）。

---

## 9. 里程碑规划

| 阶段 | 内容 | 验收标准 |
| --- | --- | --- |
| M1 | 项目骨架 + Edge TTS 同步合成（stream/base64）+ 发音人列表 + 错误模型 | curl 完成「文字 → MP3」 |
| M2 | async 模式 + 任务查询/下载/删除 + TTL 清理 | 长文本异步合成全流程可用 |
| M3 | 接入第二个供应商（Azure/OpenAI）+ 配置切换 | 同一 API 无改动切换供应商 |
| M4 | 限流、日志完善、部署文档 | 稳定对外提供服务 |

---

## 10. 已确认事项（用户拍板）

1. 调用形态：**以同步为主**，接口加 `mode` 参数，默认 `sync`；异步作为可选。✅
2. Edge 逆向接口：**个人使用，直接采用**，不做替代。✅
3. 技术栈：**Node.js + 纯 JavaScript（不用 TS）**。✅
4. 多供应商扩展：**使用设计模式**（策略/工厂/适配器）。✅
5. Edge 默认发音人：`zh-CN-XiaoxiaoNeural`（晓晓）。✅
6. 同步文本上限：1000 字（可配置）。✅
7. 异步音频 TTL：24h（可配置）。✅
8. 鉴权：第一阶段不加 API Key（保留开关）。✅