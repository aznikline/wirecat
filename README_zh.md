<div align="center">

[English](README.md) · **简体中文**

# Wirecat

### 静态还原交付代码中的 API 定义并审计其特权边界。

**从已安装应用的 JavaScript 中提取 protobuf 描述符与 IPC 定义——不抓包、不运行目标——输出版本化 `.proto` 文件 + 发版差异。在提取结果之上运行两个边界审计器:Electron 攻击面审计(哪些特权 IPC handler 能从不可信内容触达)与 Node 服务 HTTP 路由×鉴权对账(哪些路由的注册链上没有鉴权标记)——所有 findings 均带置信度分层与 file:line 证据。整条流水线同时通过 MCP 暴露,agent 可直接以工具方式调用。**

[![CI: track-cursor](https://img.shields.io/github/actions/workflow/status/aznikline/wirecat/track-cursor.yml?style=flat-square&label=track-cursor)](https://github.com/aznikline/wirecat/actions/workflows/track-cursor.yml)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A518-339933?style=flat-square&logo=nodedotjs&logoColor=white)](#快速开始)
[![零依赖](https://img.shields.io/badge/%E4%BE%9D%E8%B5%96-0-5c4ee5?style=flat-square)](#提取内容)
[![MIT 许可证](https://img.shields.io/badge/license-MIT-f4c430?style=flat-square)](LICENSE)

[快速开始](#快速开始) · [提取内容](#提取内容) · [目录现状](#目录现状) · [自动化](#自动化) · [法律边界](#范围与法律姿态) · [路线图](#路线图)

<code>node tools/extract-bundle-protos.mjs app/out/**/*.js --out catalog.json</code>

</div>

---

应用用 protobuf 构建时,编译器会把完整的服务描述符嵌进交付的
JavaScript——客户端所知的每个 RPC 服务、消息字段、枚举都会挺过
压缩混淆存留下来。也就是说,客户端完整的对服务端 API 可以直接
**从产物本身恢复**:不抓包、不运行应用、不用猜线上格式。想给它
写个客户端,或者想知道它的 agent 协议长什么样?今天这意味着几天
手工 grep bundle——而且笔记在下个版本就过时了。

**Wirecat 是把这件事机械化的工具。** 它对应用自带的 JS bundle 做静态分析,
产出应用全部暴露面的*类型化目录*——然后 CI 在每个新版本上重跑,
规范永远保鲜。本仓库既是工具(`tools/`),也是它产出的公开目录
(`catalogs/`、`protos/`、`diffs/`、`specs/`)。

```
Cursor.app/out/*.js  ──►  catalogs/cursor/3.26.16.json   (87 服务,1.7 万方法)
                       ──►  protos/cursor/3.26.16/*.proto (可直接用于 codegen)
                       ──►  diffs/cursor-3.24.12-to-3.26.16.md
                       ──►  端点 host + IPC channel 清单
```

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

# 6. 审计 Electron 攻击面
node tools/audit-electron.mjs app/out/main.js app/out/**/preload*.js ... --out audit.json --md audit.md

# 7. 对比两版攻击面
node tools/audit-electron.mjs --diff audits/app/old.json audits/app/new.json

# 8. 审计任意 Node 服务的 HTTP 路由×鉴权覆盖
node tools/audit-routes.mjs src/controllers src/webhooks --out routes.json --md routes.md
```

纯静态分析——只解析目标 bundle,绝不执行。

## 工具一览

| 工具 | 功能 | 关键参数 |
|---|---|---|
| `extract-bundle-protos.mjs` | 从交付 JS 中恢复 protobuf 描述符(protobuf-es / protobuf-ts / protobufjs)、Electron IPC 面与字面量端点 URL | `<bundle.js>... --files list.txt --out catalog.json` |
| `diff-catalogs.mjs` | 两版 catalog 间服务/方法/消息/枚举/字段/IPC channel/端点的新增、移除、变更 | `old.json new.json [--md]` |
| `emit-proto.mjs` | 按包生成可用的 `.proto3` 文件;未解析引用保留为 `Unresolved_*` 占位符 | `catalog.json --out protos/ [--packages a.v1,b.v1]` |
| `render-spec.mjs` | 把 catalog 渲染为按包分组的可读 markdown 规范 | `catalog.json [--packages a.v1] [--full]` |
| `audit-electron.mjs` | Electron 攻击面审计:contextBridge 暴露形态、webPreferences、handler sender 校验 × 危险 sink、TLS 姿态、服务通道可达性;`--diff` 对比两版审计 | `<bundle.js>... --out audit.json [--md] [--diff old.json new.json]` |
| `audit-routes.mjs` | Node 服务 HTTP 路由×鉴权清单:Express 中间件链 + NestJS/n8n 装饰器,鉴权状态分类,有界 handler 内 sink 扫描 | `<src-file-or-dir>... --out routes.json [--md] [--files list.txt]` |
| `mcp-server.mjs` | stdio MCP 适配器,把整条流水线暴露给 MCP 兼容 agent(见下文) | 作为 MCP server 运行,无 CLI 参数 |
| `track-cursor-release.sh` | 轮询 Cursor 官方更新 feed,抽取新版本,重生成 catalog+spec+diff+protos | `[--app-dir <extracted-app>] [--dry-run]` |

全部工具均为零依赖 Node ≥18 ESM 脚本。

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

## 攻击面审计

`tools/audit-electron.mjs` 回答的是赏金猎人目前手工回答的那个问题:
*特权 `ipcMain` handler 能否从不可信内容触达,攻击者输入能否到达危险 sink?*

它**不是**全程序污点分析(在 50MB 混淆 bundle 上不可行)——做的是
边界协议可达性:把压缩混淆后仍存活的信任边界边一条条接起来,每条
finding 带置信度分层(`observed` / `derived` / `inferred` / `unknown`),
未知如实标未知。

检测能力(以 Cursor 3.26.16 真实输出为例):

- **contextBridge 暴露形态**——区分裸 `ipcRenderer` 直通(critical,
  即 Discord-2020-RCE 那类)与 Cursor 的真实姿态:转发调用方可控的
  channel 名但强制 `vscode:` 前缀白名单的*受限通配*
- **可达性合成判定**——把桥和它门后的特权面连起来:
  `bridgeable-privileged-surface`——被攻破的 renderer 可触达
  **52 个已注册 `registerChannel` 服务通道 + 传输通道**
- **`webPreferences` 标志**——`contextIsolation`、`nodeIntegration`、
  `sandbox`、`webSecurity`、`webviewTag`,含解析块外出现的字面量
- **handler 级检查**——sender 校验存在性(`senderFrame`/`getURL`/origin
  检查)× 危险 sink 分类(代码执行、导航、文件写、会话/网络、宿主桥接)
- **TLS 姿态**——证书绕过与*正确分类*的自定义 pinning(朴素规则在所有
  VS Code 系应用上都会误报;已在 Devin.app 上验证)
- **攻击面 diff**——`audit-electron.mjs --diff` 输出两版 findings +
  新增/移除的特权服务通道

验证:Discord-2020-RCE 形态(未隔离窗口 + 裸 `ipcRenderer` 桥 + 无校验
`child_process` handler)回放命中 `critical` + `high`;有 sender 校验的
handler 正确豁免。全部已跟踪应用的审计产物在 `audits/`。

## 路由×鉴权审计

`tools/audit-routes.mjs` 把同一个边界清单思路应用到 Node HTTP 服务:
*有哪些路由、哪些路由的注册链上存在鉴权标记、哪些变更型路由没有。*
它把安全评审员手工做的"端点×scope 对账"机械化。

识别的注册风格:

- **Express 风格**——`app/router.METHOD(path, ...middleware, handler)`、
  `app.use(prefix, middleware|router)` 挂载、跨文件 `require`/`import`
  解析前缀挂载的 router
- **装饰器风格**——NestJS/n8n `@Controller(base)`/`@RestController(base)`
  + `@Get`/`@Post`/`@Put`/`@Patch`/`@Delete`/`@All` 方法装饰器;
  路由装饰器上下两侧的堆叠装饰器都会收集(`@UseGuards`、
  `@ProjectScope`、`@GlobalScope`、`@Licensed` 等)

鉴权词表:Express 中间件名(`requireAuth`、`isAdmin`、
`passport.authenticate` 等)与装饰器名按 auth/scope/permission 词表
匹配;`{ skipAuth: true }` 路由选项与 `@Public()`/`skipAuth` 装饰器
标记为 **explicit-public**。文件内若通过裸 `.use()` 挂载了形似鉴权的
中间件,该文件路由报告 `guarded-inferred`(derived 而非 observed)。

有界 handler 内扫描:每个 handler 体做一次安全相关 sink 类扫描
(`code_exec`、`file_rw`、`path_traversal`、`ssrf`、`sql`、
`session_jwt` 等),与 `req` 派生输入是否到达 sink 联合——
`unauthed-sink`(critical)仅在鉴权缺口与 sink *同时*存在时触发。

**读输出前先看 scope note。** "unguarded" 只表示注册链上无鉴权
标记——handler 内部的服务层检查(如 `findCredentialForUser(id, user,
scopes)`)对字面量扫描不可见。未扫描文件中挂载的中间件不做建模。
这些 findings 是 `inferred` 置信度的*审计线索*——与产出真实发现的
线索同类——不是未认证可达性的证明。无 finding 也不等于安全。

已在 n8n `packages/cli/src` 验证:165 条路由入库;所有
`@ProjectScope`/`@GlobalScope` 路由分类正确;`skipAuth` 的 e2e 路由与
`{ allowSkipMFA }` 路由正确标为 explicit-public;`POST /credentials/test`
正确浮出为 unguarded-mutation lead(该端点实际由
`replaceCredentialContentsForSharee` 在 handler 内防护——正是此类
finding 预期引导的人工验证动作)。

## 审计输出契约

两个审计器输出同一 schema:`{ rule, severity, confidence, title,
detail, evidence }` findings + 路由/端点清单 + 汇总统计。`severity` ∈
`critical | high | medium | info`;`confidence` ∈ `observed`(直接字面
证据)/ `derived`(跨文件 join)/ `inferred`(启发式审计线索)/
`unknown`(明示未解析)。每条 finding 尽量携带 `file:line` 证据。

## MCP 适配器

`tools/mcp-server.mjs` 通过 stdio JSON-RPC 把流水线暴露给 MCP 兼容
agent(Claude Code、Devin 等),无需 shell 调用:

| MCP 工具 | 封装 |
|---|---|
| `wirecat_audit` | `audit-electron.mjs`——markdown findings 报告 |
| `wirecat_audit_diff` | `audit-electron.mjs --diff` |
| `wirecat_extract_protos` | `extract-bundle-protos.mjs` |
| `wirecat_catalog_diff` | `diff-catalogs.mjs` |
| `wirecat_emit_proto` | `emit-proto.mjs` |
| `wirecat_list_audits` | 列出 `audits/` 产物 |

宿主配置:

```json
{
  "mcpServers": {
    "wirecat": {
      "command": "node",
      "args": ["/path/to/wirecat/tools/mcp-server.mjs"]
    }
  }
}
```

同时兼容换行分隔与 Content-Length 框架两种 stdio 传输。

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
audits/<app>/<version>.{json,md} 攻击面 findings + 逐版本攻击面 diff
docs/target-assessment.md       哪些应用适合本流水线(fat vs thin bundle)
tools/                          提取器 · 对比器 · 渲染器 · proto 生成器 · 审计器 ×2 · 版本跟踪器 · MCP 适配器
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

- 更深的审计可达性:`registerChannel` 体的跨模块 DI/服务令牌解析(当前
  为面清单 + 文件内解析;完整方法级 sink 分析需要模块表恢复)
- renderer 侧暴露圈定:哪个加载远程内容的*窗口*能触达哪个桥(需要
  window↔preload↔webPreferences 关联)
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
