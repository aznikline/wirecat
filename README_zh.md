<div align="center">

[English](README.md) · **简体中文**

# Wirecat

### 桌面应用内部协议的版本化目录——"应用协议界的 SteamTracking"。

**每个交付的应用都自带 RPC 契约。Wirecat 负责读取、版本化、差异对比。**

[![CI: track-cursor](https://img.shields.io/github/actions/workflow/status/aznikline/wirecat/track-cursor.yml?style=flat-square&label=track-cursor)](https://github.com/aznikline/wirecat/actions/workflows/track-cursor.yml)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A518-339933?style=flat-square&logo=nodedotjs&logoColor=white)](#快速开始)
[![零依赖](https://img.shields.io/badge/%E4%BE%9D%E8%B5%96-0-5c4ee5?style=flat-square)](#提取内容)
[![MIT 许可证](https://img.shields.io/badge/license-MIT-f4c430?style=flat-square)](LICENSE)

[快速开始](#快速开始) · [提取内容](#提取内容) · [目录现状](#目录现状) · [自动化](#自动化) · [法律边界](#范围与法律姿态) · [路线图](#路线图)

<code>node tools/extract-bundle-protos.mjs app/out/**/*.js --out catalog.json</code>

</div>

---

每个商业桌面应用——IDE、聊天工具、AI 工具、设计软件——都在其
JavaScript/Electron bundle 中内置了私有 RPC 面:protobuf 服务注册、
消息与枚举定义、Electron IPC 契约、后端端点、认证头。今天,任何想
做互操作的项目都在手工重复推导同一份 `.proto` 面——并在每次发版
时腐烂失效。

Wirecat 把提取自动化:**bundle 进 → 类型化目录出**,逐版本 diff,
并可回写为可用的 `.proto` 文件。它是规范流水线,不是一次性逆向
工程——目录本身就是产品。

## 产出长什么样

```proto
// protos/cursor/3.26.16/agent.v1.proto —— 机器生成,非手写
service AgentHostService {
  rpc CreateSession(SessionCreateRequest) returns (SessionCreateResponse);
  rpc SendMessage(SendMessageRequest) returns (SendMessageResponse);
  rpc WatchSessions(SessionWatchRequest) returns (stream SessionWatchResponse);
  rpc RespondToInteraction(InteractionResponse) returns (InteractionResponseResponse);
  // …… 还有 27 个方法,request/response 类型全部解析
}
```

```diff
# diffs/cursor-3.24.12-to-3.26.16.md —— 版本间协议演进
+ aiserver.v1.McpToolService.AddMcpServer          # MCP 管理转为 RPC
+ cursor_files.v1.CursorFilesService             # 新包
+ scmapi.v0.ScmService                           # 新包
~ aiserver.v1.AiService(11 个方法变更)
+ 新端点 host: api.origin-staging.cursor.com
```

## 快速开始

需要 **Node.js 18+**,无需其他任何依赖——工具链是零依赖 ESM。

```bash
# 1. 用提取器扫描解包后的 Electron 应用 JS bundle
grep -rlE "makeMessageType|typeName:|ipcRenderer|ipcMain|exposeInMainWorld" \
  --include="*.js" /path/to/App.app/Contents/Resources/app > files.txt

# 2. 提取完整协议面
node tools/extract-bundle-protos.mjs --files files.txt --out catalog.json

# 3. 与上一版本对比
node tools/diff-catalogs.mjs old.json catalog.json --md

# 4. 生成可用的 .proto3 文件
node tools/emit-proto.mjs catalog.json --out protos/

# 5. 渲染可读规范文档
node tools/render-spec.mjs catalog.json [--packages aiserver.v1,agent.v1]
```

纯静态分析——只解析目标 bundle,绝不执行。

## 提取内容

| 协议面 | 识别的生成代码形态 | 产出 |
|---|---|---|
| **protobuf-es** | `makeMessageType`、`makeEnum`、`{typeName, methods}` 服务字面量 | 服务、方法(unary/流式)、消息、枚举、字段(编号、kind、标量/消息/枚举类型、存在性标志) |
| **protobuf-ts** | `X.typeName="pkg.Msg"`、`X.fields=…newFieldList`、webpack `t.X=I` 导出 | 同上;命名空间成员引用按位置配对解析,歧义如实标 `unresolved:` |
| **protobufjs** | `setJSON`/`addJSON`/`fromJSON` 描述符字面量 | 完整描述符树遍历——嵌套类型、oneof、`keyType` map、流式方法 |
| **Electron IPC** | `ipcRenderer`/`ipcMain`/`webContents`/`webFrame` 字面量调用、`exposeInMainWorld` | 按 channel 统计 send/invoke/listener/handler 次数与调用点;暴露的全局对象;命名空间过滤的 channel 词表 |
| **端点** | `https://` 字面量 URL | 按 host 分组的 URL 清单、逐 host 源文件归属、凭证类内容自动脱敏 |

诚实性保证:无法解析或有歧义的引用一律输出 `unresolved:<ident>`,
绝不猜测。生成的 `.proto` 以 `Unresolved_*` 占位符保留缺口。

## 目录现状

| 应用 | 协议面 | 备注 |
|---|---|---|
| **Cursor** `3.14.7` → `3.26.16` | 87 服务 / 5 万+ 消息 / 1.7 万+ 方法 + IPC + 端点 | `aiserver.v1`、`agent.v1`、`origin.v1`、`cursor_files.v1`、`scmapi.v0`——CI 持续跟踪 |
| **Devin.app** `3.10.67` | 29 服务 / 6.9k protobuf-ts 消息 | 在另一种 codegen 上验证了 protobuf-ts pass |
| **VS Code** `1.141.0` | 186 个 IPC channel | 正确的负例——VS Code 本体不带 protobuf 服务 |
| **Signal Desktop** `8.32.0` | 360 个 IPC channel(preload bridge 即其客户端 API) | proto 在 Rust 原生库中——诚实的 IPC-only 目录 |
| **Slack** `4.52.182` | 桥接 IPC + 端点词表 | 薄壳——真实面经 web 分发,见[目标评估](docs/target-assessment.md) |
| **Discord** `0.0.418` | updater/splash IPC | 薄壳——同样的获取限制 |

`specs/cursor/auth-surface.md` 记录了认证层:Connect-RPC 传输证据、
完整 header 清单(`x-cursor-checksum`、`x-ghost-mode`、`x-client-key`
等)、凭证存储键,以及带置信度标注的 host→角色 / 服务→端点映射。

## 目录结构

```
catalogs/<app>/<version>.json   机器目录(services/messages/enums/ipc/endpoints)
protos/<app>/<version>/         生成的 .proto3 文件——可直接用于 codegen
specs/<app>/<version>-*.md      渲染的规范文档 + 认证面
diffs/<app>-<a>-to-<b>.md       逐版本协议演进报告
docs/target-assessment.md       哪些应用适合本流水线(fat vs thin bundle)
tools/                          提取器 · 对比器 · 渲染器 · proto 生成器 · 版本跟踪器
```

## 自动化

`.github/workflows/track-cursor.yml` 每 6 小时轮询官方稳定版 feed
(`api2.cursor.sh/updates/api/download/stable/darwin-arm64/cursor`)
——不爬虫、不依赖 Vercel 防护的网站 API。检测到新 `version`+`commitSha`
时自动下载 release zip、解包、重新生成 catalog+spec+diff+protos 并提交。
`catalogs/cursor/LATEST` 记录最新跟踪版本。同一流程也可通过
`tools/track-cursor-release.sh` 独立运行。

## 范围与法律姿态

- **为付费用户做互操作。** 这些工件描述的是你自己已授权的客户端
  本来就在使用的协议。不做付费墙、试用、配额、机器码绕过的任何内容
  ——设计上就排除在范围之外。
- **仅客户端可见面。** 服务端逻辑无法从客户端 bundle 恢复,也从不声称。
- **逐字提取。** 字段编号、名称、结构来自交付代码;歧义如实报告
  (`unresolved:`、notes),不做平滑处理。
- **仅静态分析。** bundle 只被解析,从不执行。
- **凭证卫生。** Sentry DSN key 与 URL userinfo 在发布的 catalog 中
  一律脱敏。

## 路线图

- 认证流关联:把 header/凭证键绑定到具体服务
- protobufjs pass 的真实目标验证(Discord web bundle 有 auth 门禁)
- 动态 IPC channel 展开(运行期拼接的 channel 名,如 `DISCORD_${event}`、
  `redux-action` 多路复用——当前仅字面量捕获,已记录)
- 新的 fat-bundle 目标(Windsurf feed 已验证;欢迎 issue 提名更多 Electron 应用)

## 文档

- [目标评估](docs/target-assessment.md)——哪些应用适合本流水线及原因
- [Cursor 认证面](specs/cursor/auth-surface.md)——传输、header、host、置信度标注
- [服务规范示例](specs/cursor/3.26.16-services.md)——87 服务 × 2285+ 方法渲染

## 常见问题

**能基于这个写一个 Cursor 客户端吗?**
catalog 给出协议面——服务、消息结构、传输线索。你自己账号的 auth token
获取与运行时行为需自行实现;请遵守上述法律边界。

**对非 Electron 应用有效吗?**
protobuf pass 对任何交付的 JS bundle 有效。IPC 提取需要 Electron
(`ipcRenderer`/`ipcMain`/`contextBridge` 标记)。

**Slack/Discord 的协议呢?**
它们的 `.app` 是薄壳——真正的客户端代码经 web 分发且有 auth 门禁。
Wirecat 如实记录交付产物中真实存在的内容(桥接 IPC + 端点),
并明确文档化缺口而不是假装完整。
