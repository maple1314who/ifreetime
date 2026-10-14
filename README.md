# read-tts · TTS 中转服务

统一 HTTP 接口对接多家语音合成供应商（第一个：**微软 Edge 大声朗读**），给一段文字 + 发音人，返回语音（MP3 等）。**个人使用**，纯 JavaScript（无 TypeScript），仅依赖 `fastify` + `ws`。

## 快速开始

```bash
npm install
npm start          # 默认 0.0.0.0:3000
npm test           # 跑测试（假供应商，不碰真实网络）
npm run dev        # 开发模式（文件变更自动重启）
```

## API 示例

### 1. 同步合成（默认，直接返回 MP3）

```bash
curl -X POST http://127.0.0.1:3000/v1/tts \
  -H 'Content-Type: application/json' \
  -d '{"text":"你好，世界","voice":"zh-CN-XiaoxiaoNeural","rate":"+0%"}' \
  -o out.mp3
```

| 参数 | 说明 | 默认 |
| --- | --- | --- |
| `text` | 要合成的文字（必填） | — |
| `mode` | `sync`（直接返回音频）/ `async`（返回 taskId） | `sync` |
| `provider` | 供应商 | `edge` |
| `voice` | 发音人 shortName | `zh-CN-XiaoxiaoNeural` |
| `rate` / `pitch` / `volume` | 语速/音调/音量（SSML 格式） | `+0%` / `+0Hz` / `+0%` |
| `format` | `mp3`（默认）/ `mp3-96k` / `ogg` / `webm` 或完整格式串 | `mp3` |
| `output` | `stream`（音频流）/ `base64`（JSON） | `stream` |
| `requestId` | 透传追踪 ID（进日志） | 自动生成 |

### 2. GET 调用（兼容简单客户端/浏览器，发音人用 voiceName）

```bash
curl -G "http://127.0.0.1:3000/v1/tts" \
  --data-urlencode "text=你好，世界" \
  --data-urlencode "voiceName=zh-CN-XiaoxiaoNeural" \
  --data-urlencode "format=audio-24khz-48kbitrate-mono-mp3" \
  -o out.mp3
```

GET 与 POST 参数完全一致；`voice` / `voiceName` 两个名字都认；`rate`、`pitch`、`volume`、`token` 传空串等于不传（用默认值）。

### 3. 同步 + base64

```bash
curl -X POST http://127.0.0.1:3000/v1/tts \
  -H 'Content-Type: application/json' \
  -d '{"text":"你好","output":"base64"}'
# → { "audioBase64": "...", "format": "audio-24khz-48kbitrate-mono-mp3", "extension": "mp3", "bytes": 13968 }
```

### 4. 异步任务（长文本）

```bash
# 提交
curl -X POST http://127.0.0.1:3000/v1/tts \
  -H 'Content-Type: application/json' -d '{"text":"长文本...","mode":"async"}'
# → { "taskId": "...", "status": "pending", "pollUrl": "/v1/tts/tasks/..." }

# 查状态
curl http://127.0.0.1:3000/v1/tts/tasks/<taskId>
# → { "status": "succeeded", "result": { "format": "...", "bytes": 33120 }, ... }

# 下载音频（成功后）
curl http://127.0.0.1:3000/v1/tts/tasks/<taskId>/audio -o long.mp3

# 删除（清理文件）
curl -X DELETE http://127.0.0.1:3000/v1/tts/tasks/<taskId>
```

音频文件默认保留 **24h** 自动清理；同步文本上限 **1000 字**，异步上限 **10000 字**（均可配）。

### 5. 发音人列表

```bash
curl "http://127.0.0.1:3000/v1/voices"   # 在线拉取全量（322 个），失败回退内置清单
```

### 6. 健康检查

```bash
curl http://127.0.0.1:3000/health
```

## 配置（环境变量）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | 监听地址 |
| `DEFAULT_VOICE` | `zh-CN-XiaoxiaoNeural` | 默认发音人 |
| `MAX_TEXT_LENGTH_SYNC` | `1000` | 同步文本上限 |
| `MAX_TEXT_LENGTH_ASYNC` | `10000` | 异步文本上限 |
| `CONCURRENCY` | `16` | 同步合成并发上限（超限返回 429） |
| `UPSTREAM_TIMEOUT_MS` | `30000` | 上游合成超时 |
| `UPSTREAM_RETRIES` | `1` | 上游失败自动重试次数 |
| `TASK_TTL_MS` | `86400000` | 异步音频保留时长 |
| `API_KEY` | 空 | 留空不鉴权；设置后需 `x-api-key` 头 |
| `MIMO_API_KEY` | 空 | **小米 MiMo API Key**（platform.xiaomimimo.com 注册获取）；不配则 mimo 不可用 |
| `MIMO_BASE_URL` | `https://api.xiaomimimo.com/v1` | MiMo API 基地址 |
| `MIMO_MODEL` | `mimo-tts` | MiMo TTS 模型 ID（以官方文档为准） |
| `MIMO_VOICE` | 空 | MiMo 默认音色（不配则请求必须显式传 voice） |
| `LOG_LEVEL` | `info` | `debug/info/warn/error` |

## 多供应商

| provider | 说明 |
| --- | --- |
| `edge` | 微软 Edge 大声朗读（默认，无需密钥） |
| `mimo` | 小米 MiMo 官方 API（需 `MIMO_API_KEY`，OpenAI 兼容 `/v1/audio/speech`，音频格式 mp3/opus/aac/flac/wav/pcm） |

```bash
# 用 mimo 合成（需要先 export MIMO_API_KEY=...）
curl -X POST http://127.0.0.1:3000/v1/tts \
  -H 'Content-Type: application/json' \
  -d '{"text":"你好，世界","provider":"mimo","voice":"alloy"}' -o mimo.mp3
```

## 目录结构

```
src/
├── server.js            # 入口：装配、错误处理、可选鉴权
├── config.js            # 集中配置
├── routes/              # tts / tasks / voices / health
├── providers/
│   ├── base.js          # Provider 抽象基类（策略模式）
│   ├── registry.js      # 供应商注册表（工厂模式）
│   └── edge/            # Edge 适配器（适配器模式）
│       ├── provider.js  # 统一接口 + 格式映射
│       ├── protocol.js  # WebSocket 协议（Sec-MS-GEC、SSML）
│       └── voices.js    # 发音人：在线优先 + 内置兜底
├── tasks/manager.js     # 异步任务 + TTL 清理
└── utils/               # errors / logger / retry / semaphore
```

## 新增一个供应商（设计模式用法）

1. 新建 `src/providers/<name>/`，实现 `Provider` 接口（`synthesize` / `getVoices`）；
2. 在 `registry.js` 里登记一行：`registerProvider('<name>', () => new XxxProvider())`。

API 层零改动，调用方只需传 `"provider": "<name>"`。

## 说明

- Edge「大声朗读」是非公开逆向接口，**仅限个人使用**；可能随时失效，已内置并发限制与失败重试。
- 正式对外生产建议切换官方 Azure TTS（同一套发音人体系，迁移成本低）。