# ReviewAgent RPC / HTTP / JSON-RPC Server 实现方案

> **文首说明**（2026-10-20）：本文以 vendored pi 锚定 commit `6671c604`（v0.85.1+11d）的源码为准，
> 分析 pi 实验性 `protocol` / `client` / `server` / `session-backends` 栈，并给出 ReviewAgent
> 自建 HTTP / JSON-RPC server 的落地设计。
>
> **一句话结论**：**不整体 vendor pi 这四个包**。pi 栈是「CBOR 帧 + Unix socket + Chord service
> + 持久 Session 附件」的本地多端会话框架；ReviewAgent 需要的是「HTTP JSON-RPC 2.0 + SSE +
> 有界 review job 队列」。两者在传输、寻址语义、会话模型、鉴权与部署形态上都不同。落地形态为
> **拓扑 B**（ADR-0013）：HTTP 线落在 review-pi 实现包 `src/server/` 子树（与 stdio 线同包
> 共享 `ReviewService`），`reviewagent` 自包含产品包单 bundle 含 CLI / stdio / server；
> 以 `ReviewService` 为深模块，
> `runReview` 为执行适配器，HTTP/JSON-RPC 只做薄传输适配；pi 栈仅作为协议设计参照，
> 后续如有真实 pi 客户端需求再加兼容适配器。
>
> **2026-10-21 补充**：补齐调用方触发流程、服务启动与部署、鉴权线格式、产物下载、
> SSE 调用契约，以及与 stdio v1 的契约对齐表；见 §4.6 / §4.7 / §8.6 / §8.7。
>
> **2026-10-23 落地注记**：用户可见命令统一为 `reviewagent`，构建入口统一为
> `pnpm build:reviewagent`；`packages/reviewagent` 是自包含 npm 包。
>
> **2026-10-24 修订**：**ADR-0013** 已落档并成为本线唯一权威决策源；本文与其冲突处
> 一律以 ADR 为准（已同步修订：§3.2 拓扑 B、§4.2 统一 `ReviewRequest` 扁平
> `repoPath`、§4.3 SSE 跨重启 replay 提前开、§4.4 补 `-32018`、§8.1 HTTP 层
> 错误信封、§5.2 幂等内容哈希口径、§5.3 schema 列名）。

---

## 0. 决策摘要

| 决策点 | 结论 |
|---|---|
| 是否 vendor pi `protocol/client/server/session-backends` | **否**（整栈不 vendor） |
| 对外主协议 | **HTTP + JSON-RPC 2.0**（`POST /rpc`） |
| 进度推送 | **SSE**（`GET /v1/jobs/{jobId}/events`，支持 `Last-Event-ID` 重放） |
| 会话模型 | 先做 **job-oriented**（一次 MR 检视 = 一个 job），不引入 pi 的 attachment / 多 presentation |
| 持久化 | `ReviewJobStore` 端口：内存适配器（测试）+ `node:sqlite` 适配器（生产） |
| 执行形态 | `ReviewExecutor` 端口：P1 进程内适配器；P3 切 worker 池，隔离 CPU/parser 并支持硬取消 |
| 与 pi 内核的关系 | 只依赖 `runReview` 与 `Agent`/agent-loop 稳定面；**不依赖 harness/session/chord**（上游 1.x 会移除这些） |
| 默认配置 | `configId` 必填显式（ADR-0011）；服务端不给隐式缺省 |
| 三形态调用参数 | **统一 `ReviewRequest`**：CLI flags / stdio `review.submit` params / HTTP `review.submit` params 共享同一字段模型（见 §4.2） |
| repo 路径策略 | 三形态统一使用 `repoPath`（绝对/相对）+ `diff.kind=file|inline`；**本次不实现** `repo-id` / `repo-registry` / `repo-root`，也不把它们做成可选能力 |
| 与 pi-protocol 兼容 | 作为 P4 可选适配器；不作为核心协议，因为上游已于 `7472cda0d`（2026-10-12）移除该实验栈 |
| 调用方主路径 | 异步 job：`capabilities → submit → SSE/poll → terminal → artifact`；不做同步阻塞式 `review.run` |
| 服务启动 | `reviewagent server` 长驻进程（`reviewagent` 自包含包）；HTTP 监听 + 单实例 job 执行；SIGTERM 优雅 drain |
| 包拓扑 | **拓扑 B**（ADR-0013 决策 6）：不建 `review-pi-server` 独立包——HTTP 线落 review-pi 实现包 `src/server/` 子树，与 stdio 线同包共享 `ReviewService`；内核隔离由边界测试强制（server 子树只经 executor 端口 import 内核） |
| Node 运行时（SQLite 适配器） | `node:sqlite` 内置，无 npm 依赖；`engines.node` 对齐 pi 的 `>=22.19.0`（server / SQLite 进 bundle 时生效；当前 CLI/stdio-only 阶段为 `>=22`，ADR-0013 决策 8） |
| 多实例 | v1 单实例；job 状态绑定执行者。多实例需 sticky routing 或 lease/fence，另立 ADR |

> **拍板状态**：2026-10-21 推荐内容已被接受；2026-10-24 **ADR-0013** 落档为本线
> 唯一权威决策源（协议/状态机/统一 `ReviewRequest`/幂等/调用方契约/拓扑 B/
> SSE replay/自包含打包/错误码收口/拆票 #27–#31）。实现以 ADR-0013 为准；
> 本文是其实现 spec，冲突处已在各节同步修订。

---

## 1. pi 实验性 server 栈源码事实（锚定 `6671c604`）

### 1.1 包与依赖关系

| 包 | 作用 | 依赖 |
|---|---|---|
| `@earendil-works/pi-protocol` | 传输无关的 routed envelope + CBOR 编解码 + 4 字节大端长度帧 | `chord`、`typebox` |
| `@earendil-works/pi-server` | 实验性本地 server：连接握手、路由、会话附件、subscription 发布 | `chord`、`pi-agent-core`、`pi-protocol` |
| `@earendil-works/pi-client` | 传输无关客户端：请求相关、订阅、附件切换 | `chord`、`pi-protocol` |
| `@earendil-works/pi-session-backend-sqlite-node` | `pi-agent-core` Session 的 Node `node:sqlite` 后端 | `pi-ai`、`pi-agent-core` |

上游 `coding-agent` 在锚定版本里把 `pi-client` / `pi-protocol` / `pi-server` 列为 **devDependencies**，
且 npm 发布物与 standalone binary 不包含 server/client 命令与 experimental 源码。这本身就说明它们
是开发期实验面，不是稳定产品面。

### 1.2 `pi-protocol`：传输无关的 CBOR 协议

- 协议版本：`PROTOCOL_VERSION = 8`（`packages/protocol/src/protocol.ts`）。
- 客户端首帧必须是 `hello`；服务端回 `hello`（带 `serverId`）或 `hello_error`。
- 客户端消息：`request` / `cancel`；服务端消息：`response` / `service_update` / `attachment`。
- 寻址目标只有两类：
  - `server`：`{ serverId }`
  - `session`：`{ serverId, sessionId, attachmentId }`
- `request.call` 与 `response.result` 是不透明 strict JSON；协议只校验 JSON 值域，不理解业务语义。
- 帧格式：4 字节无符号大端 payload 长度 + 一个 definite-length CBOR item。
- 默认上限：16 MiB/帧、1,000,000 个数组元素或 map 项、64 层嵌套。
- **没有鉴权**：README 明确写「Peer authentication and authenticated service contexts are not
  implemented by the experimental transport.」

关键事实：pi-protocol 不是 JSON-RPC，也不是 HTTP。它是 CBOR + 长度前缀的字节流协议。

### 1.3 `pi-server`：会话路由 + Chord 服务 + 多 presentation

核心接口（`packages/server/src/types.ts`）：

```ts
interface ServerHost<TMetadata extends SessionMetadata> {
  readonly serverServices: RoutedServerServiceHost;
  resolveSession(sessionId: string, context: Context): Promise<TMetadata>;
  openSession(metadata: TMetadata, context: Context): Promise<RoutedSessionHandle>;
}
```

- `RoutedServerServiceHost.attachClient()`：每条连接拿到一个 server-scoped 服务端点。
- `RoutedSessionHandle.attachClient()`：每次 attach 生成一个 presentation-scoped attachment。
- `RoutedSessionAttachment.invokeService()`：把 `ServiceCall` 原样转发给 owning provider。
- `SessionRouter`：维护 `hostedSessions`、`attachmentsByClient`、`openingSessions`、
  `clientOperations`，保证同一 session 的多 presentation 路由、断线释放、关闭排空。
- 服务调用的 payload 语义由 **Chord** 拥有：`{ serviceId, instance?, member, args }`、
  订阅快照/更新、错误码、状态 codec。server 本身不做业务解码。
- 传输实现只有 **Unix domain socket**（`transports/unix`）。没有 HTTP listener。
- 生命周期：server shutdown 关闭所有 routed Session handle；断线只释放该 presentation 的
  attachment，已 admitted 的调用仍可能完成。

关键事实：pi-server 是「本地多 presentation 会话服务器」，不是「无状态 RPC 服务」。

### 1.4 `pi-client`：长连接 + 请求相关 + 订阅，不自动重连

- 传输抽象是 ordered byte transport（Unix socket / 其它有序字节流）。
- 请求按 `id` 相关；`attach` 成功后由服务端 out-of-band 发 `attachment`。
- 断线时 pending request 本地拒绝，但已 accepted 的工作**可能仍在远端完成**。
- **不自动 reconnect、不自动 replay**；重连后必须重新 attach，并显式重放安全操作。

关键事实：pi-client 面向「可重连的交互式会话」，ReviewAgent 面向「一次提交、异步完成」的
长任务，二者生命周期语义不同。

### 1.5 `session-backends/sqlite-node`

- 实现的是 `pi-agent-core` 的 `SessionRepo` / Session storage 接口。
- 每个 Session 一个 SQLite 文件；支持 append-only entries、branch/fork、usage ledger。
- 明确要求 host 保证「一个 Session 同一时刻只有一个 writable owner」；不提供跨进程
  lease / lock / fence / heartbeat / takeover。
- 与 ReviewAgent 的 `RunRecord` / audit 文件模型没有直接映射。

关键事实：如果未来要做「可续聊的 Review Session」，它是候选底座；但对一次 MR 检视 job
的队列、状态、幂等、取消没有帮助。

### 1.6 另一条线：`coding-agent` 自带 stdio JSONL RPC

`packages/coding-agent/src/modes/rpc/` 在锚定版本里已有 headless RPC mode：

- stdin 收 JSON line 命令（`prompt` / `abort` / `set_model` / `get_state` / session 管理等）。
- stdout 发 JSON line 响应与事件。
- 与 `AgentSessionRuntime`、extension UI、TUI 生命周期耦合，是 application-specific 的
  stdio 协议，不是 HTTP，也不是 pi-protocol。

关键事实：ReviewAgent 若需要「本地嵌入」，可借鉴这种 JSONL stdio 形态，但不应复用
coding-agent 的命令集。

### 1.7 上游现状（2026-10-20）

- 上游在 `7472cda0d`（2026-10-12）已删除 `protocol` / `client` / `server` 包，并重写 chord；
  `v1.3.0` main 上不再有这套 server 栈。
- 本仓 vendored 锚点仍是 `6671c604`；《Pi 内核上游更新影响分析》结论是「短期锚定不动，
  升级留到下一个内核变更窗口整体跳 1.x」。
- 因此本方案按锚定树设计，但**不把实现绑死在这套实验栈上**；未来升级 1.x 时 server 不应
  被连带重构。

---

## 2. ReviewAgent 需求与 pi 栈的差异

| 维度 | pi 实验栈 | ReviewAgent server 需要 |
|---|---|---|
| 传输 | CBOR 帧 + Unix socket | HTTP/1.1（可扩展 HTTP/2）+ JSON-RPC 2.0 |
| 推送 | `service_update` + attachment 路由 | SSE 事件流（按 job 订阅），可重连重放 |
| 寻址 | `{serverId, sessionId, attachmentId}` | `{tenantId, jobId}` + 可选 `caseId` |
| 会话 | durable Session + 多 presentation attachment | 一次 MR 检视 = 一个 job；future 可加 session 分组 |
| payload 语义 | Chord ServiceCall，server 不解析 | 明确方法契约，server 必须校验与授权 |
| 持久化 | pi-agent-core Session entries + SQLite backend | job 状态机 + 事件日志 + audit/record 引用 |
| 鉴权 | 应用自己实现；协议不含 | 必须内置 principal/scopes；企业接入硬要求 |
| 生命周期 | 长连接、断线释放 attachment | 提交即入队；HTTP 断开不等于取消 job |
| 并发 | 连接/session 维度 | 有界 worker 池 + 队列深度 + 背压 |

**结论**：pi 栈解决的是 A 问题，ReviewAgent 需要 B 问题；强行 vendor 会得到一套
「还要再写 HTTP listener、再写鉴权、再写 job 状态机」的框架，收益为负。

---

## 3. 推荐架构

### 3.1 总览

```text
                       ┌────────────────────────────────────────┐
  HTTP/JSON-RPC client │  reviewagent (bundle)                  │
  ────────────────────>│  http adapter (node:http)              │
                       │    ├─ POST /rpc        JSON-RPC 2.0    │
                       │    ├─ GET  /v1/jobs/{id}/events  SSE   │
                       │    ├─ GET  /healthz /readyz            │
                       │    └─ auth / limits / error mapping    │
                       │                 │                      │
                       │                 v                      │
                       │        ReviewService (deep module)     │
                       │  submit/get/list/cancel/subscribe/close│
                       │                 │                      │
                       │    ┌────────────┼────────────┐         │
                       │    v            v            v         │
                       │ JobStore   JobQueue   EventLog        │
                       │ (memory/   (bounded   (append-only)    │
                       │  sqlite)    worker)                   │
                       │                 │                      │
                       │                 v                      │
                       │      ReviewExecutor (port)             │
                       │                 │                      │
                       └─────────────────┼──────────────────────┘
                                         v
                              runReview (review-pi)
                                    │
                                    v
                         pi-ai / pi-agent-core (vendored)
```

设计要点：

- **`ReviewService` 是唯一深模块**：调用者只需要知道 6 个方法；队列、状态机、幂等、
  持久化、取消、事件重放全部藏在接口后面。
- **传输是适配器**：HTTP/JSON-RPC + SSE 是 P1 唯一适配器；stdio JSONL 或 pi-protocol
  兼容是 P4 可选适配器。传输层薄到只做解析、鉴权、错误映射、流控。
- **执行是端口**：`ReviewExecutor` 把 `runReview` 包起来；测试用 fake executor，
  生产 P1 用 in-process，P3 用 worker 池。两个以上适配器 = 真实 seam。
- **不依赖 chord/harness/session**：只依赖 `runReview` 与 pi `Agent`/agent-loop 稳定面，
  避免未来 pi 1.x 移除 harness 时 server 被连带重写。

### 3.2 包与文件布局（拓扑 B，ADR-0013 决策 6）

2026-10-24 修订（取代 10-23「内部实现包 `review-pi-server`」折中与更早的双包
布局）：**不建 `review-pi-server` 独立包**。三形态共享 `ReviewService` 后，
stdio 与 HTTP 之间的包边界只剩成本——要么依赖环，要么把 service 再抽第三个
共享包。HTTP 线落在 review-pi 实现包 `src/server/` 子树，service / contracts /
executor 端口与 stdio 线（`src/rpc/`）同包共享；内核隔离改由**边界测试**
强制（见下）。

```text
packages/reviewagent/                  # 用户可见自包含包（唯一发布/npm 安装面）
  package.json                         # name=reviewagent；bin=reviewagent
  bin/reviewagent.js                   # reviewagent 主入口（require dist/cli.mjs）
  scripts/build.mjs                    # esbuild 单 bundle + pnpm pack
  dist/cli.mjs                         # 自包含 bundle（含 CLI / stdio / server）
  README.md
  THIRD-PARTY-NOTICES.md

packages/review-pi/                    # 实现包（workspace 内，不单独发布）
  src/
    cli/                               # 现有：一次性命令 + main（rpc / server 子命令装配）
    rpc/                               # stdio 线（已落地）：jsonl / protocol / service /
                                        #   executor（含 fake）/ main / stdio-guard / client
    server/                            # HTTP 线（本方案新增子树）：
      server.ts                        # node:http 路由 + 生命周期 + drain
      json-rpc.ts                      # JSON-RPC 2.0 解析/校验/错误映射
      sse.ts                           # text/event-stream + Last-Event-ID + 心跳
      auth.ts                          # Authenticator：Bearer→principal 映射 + 热轮换
      artifacts.ts                     # GET /v1/jobs/{id}/artifacts/{kind}
      stores/sqlite.ts                 # node:sqlite 生产适配器（#30）
      ...                              # 其余件随票（#28–#31）落位
```

布局要点：

- `ReviewService` / 统一 `ReviewRequest` / 错误码契约在 `src/rpc/` 已建基础上
  共享扩展（`CallContext` 升级、per-job seq——ADR-0013 中性后果项）；HTTP 子树
  只新增传输适配与 HTTP 特有件（auth / sse / artifacts / sqlite store）。
- worker 池（#31）属执行层共享件，与 stdio 线共用 executor 端口与 fake。

构建接线：

- 根 `package.json` 只暴露统一入口：
  `"build:reviewagent": "pnpm --filter reviewagent pack --pack-destination .artifacts/reviewagent"`。
- `packages/reviewagent/scripts/build.mjs` 的构建顺序：
  vendored pi 四包 → `review-llm` → `review-pi` →
  esbuild 把 CLI / stdio / server 打成 `reviewagent/dist/cli.mjs` → `pnpm pack`。
- `reviewagent` 的运行时依赖只允许普通第三方包（当前：
  `@vscode/ripgrep`、`openai`、`tree-sitter-java`、`web-tree-sitter`）；
  **不得依赖或发布 `@earendil-works/pi-*`**。
- SQLite 使用 Node 内置 `node:sqlite`，不引原生第三方依赖；server / SQLite 进
  bundle 后 `engines.node` 为 `>=22.19.0`（当前 CLI/stdio-only 阶段 `>=22`，
  ADR-0013 决策 8）。

**边界测试（内核隔离的强制机制，取代包边界）**：`src/server/` 子树对内核
（`src/run` 等）的 import 面只允许经 executor 端口（`ReviewRunExecutor` /
`runReview`、`Agent` 稳定面），不触碰 harness / session / chord；违例即测试红。
stdio 线 `src/rpc/` 已按同纪律运行（executor 是唯一 import `runReview` 的模块）。

### 3.3 深模块接口

```ts
export interface ReviewService {
  submit(input: ReviewRequest, ctx: CallContext): Promise<ReviewJobView>;
  get(jobId: string, ctx: CallContext): Promise<ReviewJobView | undefined>;
  list(query: ReviewJobQuery, ctx: CallContext): Promise<ReviewJobPage>;
  cancel(jobId: string, ctx: CallContext): Promise<ReviewJobView>;
  subscribe(
    jobId: string,
    afterSeq: number,
    listener: ReviewJobEventListener,
    ctx: CallContext,
  ): Promise<ReviewSubscription>;
  close(): Promise<void>;
}
```

接口不变量：

- `submit` 对 `(tenantId, clientRequestId)` 幂等；重复提交返回既有 job
  （对比口径 = 执行相关字段内容哈希，见 §5.2）。
- job 状态单调推进；终态不可逆。
- 同一 job 至多一个执行实例。
- `get/list/cancel/subscribe` 在 store 查询层做 tenant 过滤，越权统一按 not found 处理。
- HTTP 连接断开**不取消 job**；只有显式 `review.cancel` 才取消。
- `subscribe` 从 `afterSeq` 之后重放，支持 SSE `Last-Event-ID`。
- `close` 停止收单、排空运行中 job；超时后按配置硬停 worker。

`ReviewExecutor` 端口：

```ts
export interface ReviewExecutor {
  execute(
    request: ReviewExecutionRequest,
    ctx: ReviewExecutionContext,
  ): Promise<ReviewRunResult>;
}

export interface ReviewExecutionContext {
  readonly jobId: string;
  readonly signal: AbortSignal;
  readonly onProgress?: (event: ReviewProgressEvent) => void;
}
```

- `ReviewExecutionRequest` 从统一 `ReviewRequest` 投影而来：直接取统一的
  `repoPath`，再解析 `diff.kind=inline|file` 得到 diff 文本，并带上
  caseId / issueDescription / configId / modelId；凭据由 server 配置注入，不来自客户端。
- 执行只经 `ReviewRunExecutor` 端口（stdio 线 `src/rpc/executor.ts` 已建，
  `KernelReviewRunExecutor` 复用）；HTTP 子树不直接 import 内核 `runReview`——
  由 §3.2 边界测试强制。测试用 `FakeReviewRunExecutor`。
- `persistRecord` 保持内核默认 `true`：server 只存 job 索引与 `recordPath`/`auditPath` 引用，
  不另写一份 RunRecord，避免双写。

`ReviewJobStore` 端口：

```ts
export interface ReviewJobStore {
  create(job: ReviewJobRecord): Promise<ReviewJobRecord>;
  get(tenantId: string, jobId: string): Promise<ReviewJobRecord | undefined>;
  list(tenantId: string, query: ReviewJobQuery): Promise<ReviewJobPage>;
  transition(
    tenantId: string,
    jobId: string,
    from: readonly ReviewJobStatus[],
    to: ReviewJobRecord,
  ): Promise<ReviewJobRecord>;
  appendEvent(event: ReviewJobEvent): Promise<void>;
  readEvents(tenantId: string, jobId: string, afterSeq: number): Promise<ReviewJobEvent[]>;
  close(): Promise<void>;
}
```

### 3.4 调用方契约相关端口

```ts
export interface Principal {
  readonly tenantId: string;
  readonly subject: string;
  readonly scopes: readonly (
    | "review:submit"
    | "review:read"
    | "review:cancel"
    | "artifact:read"
    | "admin"
  )[];
}

export interface CallContext {
  readonly principal: Principal;
  readonly requestId: string;
  readonly signal: AbortSignal;
}

export interface Authenticator {
  /** 未认证返回 undefined；401 由 HTTP 适配器映射。 */
  authenticate(header: string | undefined): Promise<Principal | undefined>;
}

export interface ArtifactRef {
  readonly kind: "audit" | "record";
  readonly ref: string;
}

export interface ArtifactStore {
  resolve(jobId: string, kind: ArtifactRef["kind"], principal: Principal): Promise<string | undefined>;
  /** 返回逻辑引用，不返回服务器绝对路径。 */
  refFor(jobId: string, kind: ArtifactRef["kind"]): ArtifactRef;
}
```

调用方不直接构造 `Principal`；它来自 HTTP `Authorization` 头经 `Authenticator` 解析。
`ArtifactStore` 必须在 store 查询层按 tenant 过滤，越权统一按 not found 处理。
**本次不实现 RepoRegistry / repoId；repo 一律用 `repoPath`（绝对/相对）**。

---

## 4. 对外协议契约

### 4.1 HTTP 端点

| 方法 | 路径 | 用途 |
|---|---|---|
| `POST` | `/rpc` | JSON-RPC 2.0（单请求；不做 batch，ADR-0013 决策 1） |
| `GET` | `/v1/jobs/{jobId}/events` | SSE 事件流；支持 `Last-Event-ID` |
| `GET` | `/v1/jobs/{jobId}/artifacts/{audit\|record}` | 产物下载；需 `artifact:read` |
| `GET` | `/healthz` | liveness；只证明进程在 |
| `GET` | `/readyz` | readiness；store 可写、worker 池已启动 |
| `GET` | `/v1/capabilities` | 协议版本、方法表、limits、serverId、版本信息 |

约定：

- JSON-RPC 业务错误返回 HTTP 200 + JSON-RPC error object；鉴权失败、body 过大、
  限流、draining 在 HTTP 层返回 401/403/413/429/503——**响应体仍为 `id: null` 的
  JSON-RPC error envelope**，调用方单一路径解析（ADR-0013 决策 1）。
- **已拍板**：`review.submit` 成功返回 `202 Accepted` + `Location: /v1/jobs/{jobId}`；
  其余 JSON-RPC 方法成功返回 `200 OK`。capabilities 声明 `submitHttpStatus: 202`；
  若未来必须兼容严格 JSON-RPC over HTTP 的单一状态码，再通过版本化协商改。
- `POST /rpc` 要求 `Content-Type: application/json`；body 上限默认 32 MiB。
- 不接受客户端传入的 `apiKey` / 任意 `baseUrl`；模型接入点由 server 配置决定。
- 认证：`Authorization: Bearer <token>`（SSE 与产物下载同头）；调用方可带
  `X-Request-Id`，服务端回显并在日志中透传。
- `GET /healthz` 可不鉴权；`/readyz`、`/v1/capabilities`、`/rpc`、SSE、产物下载都走鉴权。

### 4.2 JSON-RPC 方法

#### `server.capabilities`

```json
{
  "jsonrpc": "2.0",
  "id": "1",
  "method": "server.capabilities"
}
```

```json
{
  "jsonrpc": "2.0",
  "id": "1",
  "result": {
    "protocolVersion": 2,
    "serverId": "0f2f...",
    "methods": ["server.capabilities", "review.submit", "review.get", "review.list", "review.cancel"],
    "features": {
      "sse": true,
      "artifactDownload": true,
      "idempotency": true,
      "listFilters": ["status", "caseId", "limit", "cursor"],
      "submitHttpStatus": 202
    },
    "limits": {
      "maxBodyBytes": 33554432,
      "maxDiffBytes": 8388608,
      "maxQueueDepth": 100,
      "maxConcurrentJobs": 2
    },
    "build": { "version": "0.1.0", "node": "22.19.0", "sqliteBackend": "node:sqlite" }
  }
}
```

#### `review.submit`

三形态共享同一个 `ReviewRequest`（CLI flags 映射到该模型；stdio 与 HTTP 的
`review.submit.params` 直接使用该模型）：

```ts
export interface ReviewRequest {
  readonly clientRequestId?: string;
  readonly caseId: string;
  /**
   * 仓库路径：绝对或相对。省略时按形态默认：
   * - CLI/stdio：process.cwd()（可用 --cwd 覆盖）
   * - HTTP：不设默认，必须显式传 repoPath（绝对/相对均可）
   * 本次不引入 repoId / repo-registry / repo-root。
   */
  readonly repoPath?: string;
  readonly diff:
    | { readonly kind: "inline"; readonly text: string }
    | { readonly kind: "file"; readonly path: string };
  readonly issueDescription?: string;
  readonly configId: ConfigId;
  readonly modelId?: string;
  readonly metadata?: Readonly<Record<string, JsonValue>>;
}
```

CLI flags → `ReviewRequest` 映射：

| CLI flag | `ReviewRequest` 字段 |
|---|---|
| `--repo <path>` | `repoPath` |
| `--mr <file>` / `--diff-file <file>` | `diff={kind:"file",path}` |
| `--diff <text>` | `diff={kind:"inline",text}` |
| `--case-id <id>` | `caseId`（缺省仍可从 `--mr` 文件名派生，兼容旧行为） |
| `--issue <text>` / `--issue-description <text>` | `issueDescription` |
| `--config <A-E>` | `configId` |
| `--model <id>` / `--model-id <id>` | `modelId` |
| `--client-request-id <id>` | `clientRequestId` |
| `--metadata <json>` | `metadata` |
| `--out <dir>` | 运行时产物根；不属于 `ReviewRequest` |

默认仓库解析（参考 pi 的 `cwd` 设计）：

| 形态 | 省略 `repoPath` 时 | 显式覆盖 | 说明 |
|---|---|---|---|
| CLI | `process.cwd()` | `--repo <path>` | 在当前打开的文件夹直接跑 `reviewagent review`；绝对/相对路径都可用 |
| stdio | `--cwd <dir>`，未给则 `process.cwd()` | submit 里显式 `repoPath` | 子进程 cwd 由宿主设置；`--cwd` 只改默认值 |
| HTTP | **不允许省略** | submit 传 `repoPath`（绝对/相对） | 企业内部平台已提前准备 repo/diff；HTTP 无 cwd 默认，必须显式（绝对/相对均可） |

CLI 默认 cwd 示例：

```bash
cd /path/to/opened-repo
reviewagent review \
  --mr ./MR-12345.diff \
  --case-id MR-12345 \
  --config E \
  --model deepseek-v4-flash
# 统一模型内部等价：repoPath = process.cwd()
```

pi 源码依据（锚定 `6671c604`）：

- `packages/coding-agent/src/core/sdk.ts:174`：
  `const cwd = resolvePath(options.cwd ?? options.sessionManager?.getCwd() ?? process.cwd());`
- `CreateAgentSessionOptions.cwd` 注释：`Working directory for project-local discovery. Default: process.cwd()`。
- `DefaultResourceLoader` 用 `cwd` 发现项目 extensions / skills / prompts / `AGENTS.md`；
  `docs/sdk.md` 的哲学是「omit to discover, provide to override」。

复用决策：

- **不 import `@earendil-works/pi-coding-agent`**（未 vendor，引入会带整条 coding-agent）。
- 可**直接移植** `packages/coding-agent/src/utils/paths.ts` 中的
  `normalizePath` / `resolvePath` / `getCwdRelativePath`（MIT；移植时在
  `THIRD-PARTY-NOTICES.md` 补 coding-agent 条目——现行清单仅覆盖 vendored
  四包）到 ReviewAgent 的共享 `paths.ts`，带 fork 注释与归属。
- ReviewAgent 侧只复用「cwd 默认 + 显式覆盖 + 路径归一化/根前缀校验」这一层，
  不复用 coding-agent 的 session / 工具 / 资源发现运行时。

模式差异只在默认值，不在字段名/结构：

| 形态 | `repoPath` | `diff` | 说明 |
|---|---|---|---|
| CLI | 可省，默认 `process.cwd()` | `file` / `inline` | `--mr` 映射为 `file` |
| stdio | 可省，默认 `--cwd` / `process.cwd()` | `file` / `inline` | 本地可信 |
| HTTP | **必填**，绝对/相对都可以 | `file` / `inline` | 企业内部平台集成，允许绝对路径 |

`server.capabilities.features` 声明：`defaultRepo: "cwd" | null`、
`diffKinds: ["file","inline"]`、`submitHttpStatus: 202 | null`（HTTP 声明
`202`——`review.submit` 成功返回 202 + `Location`，其余方法 200；stdio 等无
HTTP 传输的形态不声明）。本次不声明 `repoKinds`（无 repoId/registry）。
`protocolVersion` 三形态同源单源为 **2**（标识统一契约代数；stdio v1 旧参数形
在 v2 直接 `invalid_params` 拒绝——ADR-0013 决策 3）。

HTTP 示例：

```json
{
  "jsonrpc": "2.0",
  "id": "2",
  "method": "review.submit",
  "params": {
    "clientRequestId": "mr-12345-rev-1",
    "caseId": "VUL4J-1",
    "repoPath": "/srv/repos/vul4j/VUL4J-1-f5903fa564",
    "diff": {
      "kind": "file",
      "path": "/srv/diffs/VUL4J-1.diff"
    },
    "issueDescription": "Vulnerability CVE-...",
    "configId": "E",
    "modelId": "deepseek-v4-flash",
    "metadata": { "project": "platform-x", "mr": "12345" }
  }
}
```

```json
{
  "jsonrpc": "2.0",
  "id": "2",
  "result": { "jobId": "01J...", "status": "queued", "submittedAt": "2026-10-20T..." }
}
```

- 企业内部平台集成：HTTP 允许绝对 `repoPath` 与绝对 `diff.path`；repo/diff 由平台
  提前准备好，server 直接读取。
- **本次不实现** `repoId` / `repo-registry` / `repo-root`，也不把它们做成可选能力。
- 未来若需要平台按 MR 拉取，可另立 `source` / `mr` 扩展，不并入本次 `repoPath` 契约。
- `configId` 必填（ADR-0011）；server 不提供隐式缺省。

#### `review.get` / `review.list` / `review.cancel`

```json
{ "jsonrpc": "2.0", "id": "3", "method": "review.get", "params": { "jobId": "01J..." } }
```

```json
{
  "jsonrpc": "2.0",
  "id": "3",
  "result": {
    "jobId": "01J...",
    "status": "succeeded",
    "caseId": "VUL4J-1",
    "configId": "E",
    "modelId": "deepseek-v4-flash",
    "submittedAt": "...",
    "startedAt": "...",
    "finishedAt": "...",
    "result": {
      "runId": "...",
      "findings": [],
      "usage": { "inputTokens": 0, "outputTokens": 0, "cacheReadTokens": 0 },
      "rounds": 1,
      "toolCalls": 0,
      "truncated": false,
      "auditRef": "artifact:audit/<runId>",
      "recordRef": "artifact:record/<runId>"
    }
  }
}
```

- `review.list` 参数：`status?`、`caseId?`、`limit?`、`cursor?`。
- `review.cancel` 返回最新 JobView；`queued` 直接 `cancelled`；`running` 进入 `cancelling`
  后 `cancelled`；已终态**幂等返回终态 view**（`-32005` 为保留码，不发射，与 ADR-0012
  / stdio v1 对齐）。

> **互注**（2026-10-21，stdio 线拍板；2026-10-24 由 ADR-0013 收口）：姊妹篇
> 《ReviewAgent stdio JSONL 长驻模式实现方案》已拍板 running cancel、终态 cancel
> 幂等返回 view、`review.list` 暂只有 `status?`、`clientRequestId` 幂等随 S4
> 持久化、本地 `repoPath` 直传。
> HTTP 线与 stdio 的**完整契约对齐表见 §4.7**；§4.2 示例是 HTTP 目标形态，
> 不是 stdio 的逐字契约。

### 4.3 SSE 事件

```text
GET /v1/jobs/01J.../events
Accept: text/event-stream
Last-Event-ID: 7
```

```text
id: 8
event: job
data: {"seq":8,"jobId":"01J...","status":"running","progress":{"phase":"Deep Reasoning","round":1,"toolCalls":2}}
```

事件类型：

- `job`：状态或进度变化。
- `artifact`：可选，产物就绪（`record` / `audit`）。
- `error`：job 失败；同时终态 job 里带 error object。

`Last-Event-ID` 之后的事件从 `job_events` 表重放；不能重放（超出保留窗口）时发
`event: reset` + 最新快照，要求客户端重新 `review.get`。

**已拍板**（ADR-0013 决策 7，修订 2026-10-21「跨重启 replay 留 v2」）：v1 只做
SSE，不做 WebSocket；心跳 **20s**、`retry: 5000`；`Last-Event-ID` 重放**跨重启
支持**——SQLite store 下 `job_events` 持久化使然（随 #30 落地）；memory store
或事件已清理时发 `reset` + 最新快照。每 job 订阅者上限 8、每 tenant 32；慢消费者
超写队列上限断开，靠重连或 `review.get` 恢复。

### 4.4 错误码

JSON-RPC 标准码：

| code | 含义 |
|---|---|
| -32700 | parse error |
| -32600 | invalid request |
| -32601 | method not found |
| -32602 | invalid params |
| -32603 | internal error |

应用码（推荐区间 -32001 起）：

| code | 语义 | HTTP 配套 |
|---|---|---|
| -32001 | `job_not_found` | 200 + error |
| -32002 | `queue_full` | 429 |
| -32003 | `repo_not_allowed`（保留码；本次不启用 allowlist，不发射） | 403 |
| -32004 | `payload_too_large` | 413 |
| -32005 | `cancel_not_allowed`（保留码；与 stdio v1 统一为「终态幂等返回 view」后不发射） | 200 + error |
| -32006 | `unauthorized`（HTTP 层 401；**不作为方法级业务错误发射**——响应体为 `id: null` 的 JSON-RPC error envelope，见 §8.1） | 401 |
| -32007 | `forbidden`（HTTP 层 403；同上） | 403 |
| -32008 | `gateway_unavailable` | 502 |
| -32009 | `job_failed` | 200 + error |
| -32010 | `server_draining` | 503 |
| -32011 | `cancel_not_supported`（保留/过渡期；running cancel 可用时不发射） | 200 + error |
| -32012 | `repo_not_found`（`repoPath` / `diff.path` 不存在或不可访问） | 404/200 + error |
| -32013 | `rate_limited`（与 queue_full 区分：租户级限流） | 429 |
| -32014 | `job_timeout` | 200 + error |
| -32015 | `server_restart`（重启恢复时 running → failed） | 200 + error |
| -32016 | `idempotency_conflict`（同 clientRequestId 不同参数） | 200 + error |
| -32017 | `artifact_expired`（产物超出保留窗口） | 404/200 + error |
| -32018 | `queue_timeout`（排队超 `queueTimeout`（30 min）自动终态化 failed；§7.2 引用，ADR-0013 决策 9 补号） | 200 + error |

`error.data` 只放安全细节：`jobId`、`caseId`、`limit`、`retryAfterMs`；不放路径、key、内部堆栈。
`429` 响应必须带 `Retry-After`（秒）；`503 server_draining` 同样应带 `Retry-After`。

### 4.5 版本与能力协商

- `protocolVersion` 整数单源推进（三形态同源，当前 **2**——统一契约代数，
  ADR-0013 决策 3）；破坏性变更 +1。
- 客户端可在 `hello`/`capabilities` 阶段比对；服务端拒绝未知 major。
- `serverId` 是逻辑身份（UUID），不是地址；用于日志与多实例排障。
- `capabilities` 返回方法表与 limits，客户端据此降级或提示。
- `features` 明确声明 transport 能力：SSE、产物下载、幂等、列表过滤。stdio 的
  capabilities 是 HTTP 的子集（无 SSE/artifactDownload，idempotency=false 待 S4，
  listFilters=["status"]；`defaultRepo:"cwd"` 而 HTTP 为 `null`、无
  `submitHttpStatus`）。
- `build.node` 与 `build.sqliteBackend` 用于排障：启用 SQLite 时要求 `node:sqlite`
  可用，并在启动时检测失败 fail fast。

### 4.6 调用方触发流程（HTTP 目标形态）

> 本节描述方案落地后的调用契约。当前仓库尚无可用的 HTTP server；调用方不应按本节
> 对接未完成的实现。今天的可用路径是 `reviewagent review` 进程调用、进程内 `runReview`
> 或已落地的 stdio 模式（见姊妹篇）。

#### 4.6.1 前置条件

1. `reviewagent server` 已启动，并在 `GET /readyz` 返回 ready。
2. 调用方持有 bearer token，且具备 `review:submit` / `review:read` /
   `review:cancel` / `artifact:read` 中所需的 scope。
3. 调用方提供平台已准备好的 repo 绝对路径（`repoPath`）与 diff 文件绝对路径
   （`diff.path`）；对应仓库快照停在 MR 的 **base 侧**（server 不 apply diff）。
4. `REVIEWER_URL` / `REVIEWER_API_KEY` 已由 server 运维面配置；调用方不传这些值。

#### 4.6.2 触发序列

```text
GET  /v1/capabilities              # 可选：协议版本 / limits / features
POST /rpc  server.capabilities     # 可选：JSON-RPC 形态同样能力
POST /rpc  review.submit           # 202 + jobId
GET  /v1/jobs/{jobId}/events       # SSE（或轮询 review.get）
POST /rpc  review.get              # SSE 断线 / 不支持 SSE 时轮询
POST /rpc  review.cancel           # 可选：显式取消
GET  /v1/jobs/{jobId}/artifacts/audit|record   # 可选：取审计/记录
```

#### 4.6.3 最小 curl 触发

能力发现：

```bash
curl -sS https://review.example.com/v1/capabilities \
  -H "Authorization: Bearer $REVIEW_TOKEN"
```

提交 job：

```bash
curl -sS -X POST https://review.example.com/rpc \
  -H "Authorization: Bearer $REVIEW_TOKEN" \
  -H "Content-Type: application/json" \
  -H "X-Request-Id: 9f2c7b1e" \
  -d '{
    "jsonrpc": "2.0",
    "id": "2",
    "method": "review.submit",
    "params": {
      "clientRequestId": "mr-12345-rev-1",
      "caseId": "MR-12345",
      "repoPath": "/srv/repos/platform-x/base-5f2a1c9",
      "diff": {
        "kind": "file",
        "path": "/srv/diffs/MR-12345.diff"
      },
      "issueDescription": "CVE-...",
      "configId": "E",
      "modelId": "deepseek-v4-flash",
      "metadata": { "project": "platform-x", "mr": "12345" }
    }
  }'
```

预期：

```http
202 Accepted
Location: /v1/jobs/01J...
```

```json
{"jsonrpc":"2.0","id":"2","result":{"jobId":"01J...","status":"queued","submittedAt":"..."}}
```

SSE 跟踪：

```bash
curl -N https://review.example.com/v1/jobs/01J.../events \
  -H "Authorization: Bearer $REVIEW_TOKEN" \
  -H "Accept: text/event-stream" \
  -H "Last-Event-ID: 7"
```

```text
id: 8
event: job
data: {"seq":8,"jobId":"01J...","status":"running","progress":{"phase":"Deep Reasoning","round":1,"toolCalls":2}}

id: 9
event: job
data: {"seq":9,"jobId":"01J...","status":"succeeded","result":{"runId":"...","findings":[],"usage":{"inputTokens":0,"outputTokens":0,"cacheReadTokens":0},"rounds":1,"toolCalls":0,"truncated":false,"auditRef":"artifact:audit/...","recordRef":"artifact:record/..."}}
```

轮询替代：

```json
{"jsonrpc":"2.0","id":"3","method":"review.get","params":{"jobId":"01J..."}}
```

显式取消：

```json
{"jsonrpc":"2.0","id":"4","method":"review.cancel","params":{"jobId":"01J..."}}
```

产物下载：

```bash
curl -sS https://review.example.com/v1/jobs/01J.../artifacts/audit \
  -H "Authorization: Bearer $REVIEW_TOKEN" \
  -o audit.json
```

#### 4.6.4 调用方状态处理

| 终态 | 调用方动作 |
|---|---|
| `succeeded` | 读 `result.findings` / usage / rounds / toolCalls / truncated；按需下载 artifact |
| `failed` | 读 `error.code` / `error.message`；按错误分类决定重试 |
| `cancelled` | 不再当成功处理；如需重评，用新的 `clientRequestId` 重新 submit |

`HTTP 连接断开不等于取消 job`：只有显式 `review.cancel` 或服务端 drain 才取消。
SSE 断线后用 `Last-Event-ID` 重连；若服务端返回 `event: reset`，改走 `review.get`
取快照。

#### 4.6.5 调用方重试策略

| 情况 | 动作 |
|---|---|
| `401` / `403` | 检查 token / scope；不重试 |
| `413 payload_too_large` | 缩小 diff/body；不重试原请求 |
| `429 queue_full` / `rate_limited` | 读 `Retry-After`，指数退避后重试 |
| `502 gateway_unavailable` | 可重试；同 `clientRequestId` 避免重复 job |
| `503 server_draining` | 等 `Retry-After` 或换实例；不取消已有 job |
| JSON-RPC 业务错误 | 按 `error.code` 分类；不要只看 HTTP 200 |

幂等约定：`review.submit` 对 `(tenantId, clientRequestId)` 唯一；重复提交返回既有
job。若同一 `clientRequestId` 携带不同参数，返回 `idempotency_conflict`（建议
`-32016`），调用方必须换 id。

### 4.7 三形态调用参数统一与 stdio v1 对齐表

stdio v1 的拍板记录见 ADR-0012 与姊妹篇 §12。以下内容已于 2026-10-21 拍板：

| 契约点 | HTTP 方案 | stdio v1 | 已拍板落法（2026-10-21） | 状态 |
|---|---|---|---|---|
| `review.submit` 调用参数 | 统一 `ReviewRequest`：`repoPath` + `diff:{kind,inline\|file}` + `caseId` / `configId` / `modelId` | 同一 `ReviewRequest` | CLI flags 映射到同一模型；stdio/HTTP 的 `review.submit.params` 直接使用该模型 | **2026-10-24 统一拍板** |
| `review.submit` diff 参数 | 统一 `diff:{kind:"inline"\|"file"}` | 同一 `diff` 判别联合 | CLI `--mr` 映射 `{kind:"file"}`，`--diff` 映射 `{kind:"inline"}`；三形态都允许两种 | **2026-10-24 统一拍板** |
| 默认仓库 | HTTP 不允许省略 `repoPath` | CLI/stdio 省略 `repoPath` 时默认 `process.cwd()` | CLI/stdio 走 pi 风格 cwd 默认 + 显式覆盖；HTTP 无 cwd 默认，但可显式传绝对 `repoPath` | **2026-10-24 拍板** |
| repoId / registry / allowlist | 本次不实现 | 本次不实现 | 不把 `repo-id` / `repo-registry` / `repo-root` 做成可选能力；统一只用 `repoPath` | **2026-10-24 拍板** |
| `clientRequestId` | HTTP 支持幂等 | 字段接受，v1 不承诺跨进程幂等 | 三形态 `ReviewRequest` 都接受该字段；capabilities `features.idempotency` 声明实际语义（HTTP=true；stdio v1=false，S4 开；CLI 单进程可接受） | 已拍板 |
| `review.list` | `status/caseId/limit/cursor` | 只 `status?` | capabilities `features.listFilters` 声明；HTTP 全量，stdio v1 仅 status | 已拍板 |
| 终态 `review.cancel` | 原写 `-32005` | 幂等返回终态 view | 统一幂等返回终态 view；`-32005` 保留但不发射 | 已拍板（与 ADR-0012 一致） |
| `shutdown` 方法 | HTTP 无（SIGTERM） | stdio 有 `shutdown` | 保持差异：HTTP 用进程信号，stdio 用方法；capabilities 方法表各自声明 | 已拍板 |
| `jobId` 格式 | 示例 ULID 形 `01J...` | `job-<启动毫秒>-<序号>` | 对外统一为**不透明字符串**；调用方不得解析格式 | 已拍板 |
| 错误码表 | 缺 `-32011`～`-32017` | 仅 `-32011` | 以 §4.4 扩展表为准（含 `-32018`）；stdio 侧同步补齐 | 已拍板 |
| `maxConcurrentJobs` 默认 | §7.2 写 2 | 默认 1 | P1 统一默认 1；P3 worker 池验证后再把生产默认调到 2 | 已拍板 |

补充拍板（同一次评审通过）：

| 议题 | 已拍板落法 |
|---|---|
| `review.submit` HTTP 状态 | `202 Accepted` + `Location`；其余方法 200；capabilities 声明 `submitHttpStatus: 202` |
| 鉴权模型 | P1 `Authorization: Bearer`；tenant 从 principal 派生；scopes 分 `review:submit/read/cancel`、`artifact:read`、`admin`；P3 再加 mTLS |
| SQLite / Node | 只使用 `node:sqlite`；`engines.node` 对齐 `>=22.19.0`（server / SQLite 进 bundle 时生效；当前 CLI/stdio-only 阶段 `>=22`，ADR-0013 决策 8），启动时检测 `node:sqlite` 可用性、失败 fail fast 不静默降级；不引 `better-sqlite3` |
| 产物下载 | `GET /v1/jobs/{jobId}/artifacts/{audit\|record}`；`audit` 需独立 `artifact:read`；默认保留 30 天，可配；过期 `artifact_expired` |
| 多实例 | v1 明确单实例；SQLite 只解决重启恢复；多实例需 sticky routing 或 lease/fence，另立 ADR |
| 事件传输 | v1 只做 SSE，不做 WebSocket；心跳 20s + `retry: 5000` + `Last-Event-ID`；**跨重启 replay 提前开**（#30 SQLite `job_events` 持久化；ADR-0013 决策 7，修订 10-21「等 SQLite v2」） |
| `repoPath` 语义 | 绝对/相对路径；企业内部平台集成直接传服务器上已准备好的绝对路径 |
| diff 传输 | 支持 `inline` 与 `file`；inline 上限 8 MiB；file 直接读服务器已准备好的 diff 文件；更大 diff 走 P4 artifact/upload |

**关键结论**：三条形态共享**统一 `ReviewRequest` 参数模型**与状态机语义；
`repoPath` 与 `diff` 三形态一致。HTTP 面向企业内部可信平台，允许直接传服务器上
已准备好的绝对 `repoPath` / `diff.path`；本次不引入 `repoId` / registry / allowlist。

---

## 5. Job 模型与持久化

### 5.1 状态机

```text
queued ──> running ──> succeeded
   │          │
   │          ├──────> failed
   │          │
   │          └──────> cancelling ──> cancelled
   │
   └──> cancelled
```

| 状态 | 语义 |
|---|---|
| `queued` | 已受理，等待 worker |
| `running` | executor 正在执行 |
| `cancelling` | 已发 abort，等待执行侧确认 |
| `succeeded` | 完成，result 可用 |
| `failed` | 执行失败，error 可用 |
| `cancelled` | 客户端取消或服务端 drain 取消 |

### 5.2 幂等与重试

- `(tenantId, clientRequestId)` 唯一；重复 `review.submit` 返回既有 job。
- **对比口径 = 执行相关字段内容哈希**（ADR-0013 决策 4）：归一化 `repoPath`、
  解析后的 diff 文本（`kind:"file"` 按文件内容）、issue 文本、`configId`、
  `modelId`；`metadata` 不参与。
- 没有 `clientRequestId` 时不去重；客户端重试需自带稳定 id。
- 同一 `clientRequestId` 携带不同 params → `idempotency_conflict`（`-32016`），
  不覆盖既有 job。
- 幂等记录保留窗口 7 天；过期后可复用同一 id（不建议，调用方应使用新 id）。
- `429` / `503` 返回 `Retry-After`；调用方按该值退避，不自行无限重试。
- `queued` job 在服务重启后可恢复（input blob + repo snapshot 仍在）。
- `running` / `cancelling` job 在服务重启后标记 `failed`，错误码 `-32015 server_restart`；
  不假装续跑，因为当前 `runReview` 没有 checkpoint/resume 语义。

### 5.3 SQLite schema（生产适配器）

```sql
CREATE TABLE jobs (
  job_id            TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL,
  client_request_id TEXT,
  case_id           TEXT NOT NULL,
  config_id         TEXT NOT NULL,
  model_id          TEXT,
  status            TEXT NOT NULL,
  diff_kind         TEXT NOT NULL,
  repo_path         TEXT,
  request_fingerprint TEXT,    -- 执行相关字段内容哈希（§5.2 口径：repoPath/diff/issue/configId/modelId）
  diff_sha256       TEXT NOT NULL,
  issue_sha256      TEXT NOT NULL,
  metadata_json     TEXT,
  submitted_at      TEXT NOT NULL,
  started_at        TEXT,
  finished_at       TEXT,
  kernel_run_id     TEXT,
  record_path       TEXT,
  audit_path        TEXT,
  result_json       TEXT,
  error_code        TEXT,
  error_message     TEXT,
  UNIQUE (tenant_id, client_request_id)
);

CREATE TABLE job_events (
  job_id   TEXT NOT NULL,
  seq      INTEGER NOT NULL,
  at       TEXT NOT NULL,
  type     TEXT NOT NULL,
  data_json TEXT NOT NULL,
  PRIMARY KEY (job_id, seq)
);

CREATE INDEX jobs_status_submitted ON jobs (tenant_id, status, submitted_at);
```

### 5.4 产物布局

```text
<dataRoot>/
  jobs.sqlite
  blobs/<sha256>.diff
  blobs/<sha256>.issue
  runs/<jobId>/...          # runReview 的 runsRoot/experimentId 落点
```

- `experimentId = jobId`，保证 audit/record 目录互不冲突；`runId` 仍由内核生成并返回。
- API 返回 artifact 的**逻辑引用**（`artifact:audit/<runId>`），不返回服务器绝对路径；
  admin scope 才可走单独 artifact 下载接口。
- 下载端点：`GET /v1/jobs/{jobId}/artifacts/{audit|record}`，要求 `artifact:read`；
  返回 `application/json`（审计为 JSON 文档）。`audit` 与 `record` 分开授权，避免
  审计原文（含 wireBody）被普通读权限拉到。
- 产物保留窗口由 `--artifact-retention-days` 配置；过期后下载返回 404 +
  `artifact_expired`（建议 -32017），但 job 元数据仍可按保留策略保留。

---

## 6. 内核需要的配套改造

### 6.1 取消：`ReviewRunInput.signal`

现状：`runReview` 没有取消入口；`pi-ai` 的 `StreamOptions` 已有 `signal`，`Agent` 已有
`abort()` / `activeRun.abortController`。

改造：

1. `ReviewRunInput` 增加可选 `signal?: AbortSignal`。
2. A/B 直驱路径：`runReviewTurn` 透传 `signal` 到 `deepseekProvider().stream(..., { signal })`。
3. C/D/E agent 路径：`runAgentReviewLoop` 监听 `signal`，abort 时调用 `agent.abort()`；
   工具循环在工具调用边界检查 `signal.aborted`。
4. 取消错误统一为 `ReviewAbortedError`（`name = "AbortError"`，`code = "review_aborted"`）。
5. 语义决定：abort 不产生 `succeeded` run record；server 在 job store 记 `cancelled`。
   P1 允许无 partial audit；P2 再补「partial audit flush + 引用」。

验收：取消响应的 p95 上界（不含网关在飞请求）、不写半截 record、不污染指标数据。
对调用方：queued → 直接 `cancelled`；running → `cancelling` → `cancelled`；已终态
`review.cancel` **幂等返回终态 view**（不发射 -32005，与 ADR-0012 对齐）。HTTP
连接断开不触发取消。

### 6.2 进度：`ReviewRunInput.onProgress`

新增观测钩子（不进入 wire，不影响审计字节）：

```ts
export type ReviewProgressEvent =
  | { kind: "phase"; round: number; phase: ReviewPhase; requestCount: number }
  | { kind: "tool"; round: number; toolCall: number }
  | { kind: "usage"; usage: LlmUsage };
```

- 只在既有 phase 边界发出；不改变消息构造顺序，不改变 `wireBody`。
- `onProgress === undefined` 时行为与现在逐字节一致；t1–t5 门必须零漂移。
- server 把事件写 `job_events` 并扇出到 SSE。

### 6.3 结果投影：`ReviewRunSummary`

server 不应直接依赖 `RunRecord` 的内部形状。该投影已在 #23 随 stdio 线落地
（`packages/review-pi/src/rpc/executor.ts` 导出 `ReviewRunSummary`——`runId` /
`findings` / `usage` / `rounds` / `toolCalls` / `truncated` / `auditPath` /
`recordPath`），并由适配器单源产出；HTTP server 直接复用，内核改 `RunRecord`
内部字段时 server 不受影响。

### 6.4 不得触碰的字节纪律

- `signal` 与 `onProgress` 都是**可选观测/控制面**；不进入请求体、不影响 messages 顺序。
- 任何 server 需求都不得改 Zone A 常量、Zone B 组装、六阶段 phase 指令文本。
- server 的 `configId` 必须显式传入；不得在 server 内设「默认 E」这类隐式缺省。

---

## 7. 并发、隔离与运行形态

### 7.1 为什么用 worker 池

- `runReview` 内含同步 tree-sitter Java 解析与仓库扫描；大仓解析会占满 event loop。
- HTTP server 要与 job 执行解耦：健康检查、提交、查询、SSE 不能被解析阻塞。
- 取消的硬边界：worker 可 `terminate()`；进程内只能协作式 abort。

推荐（#31 P3b 已落地）：

- `--executor inprocess`（进程内执行器，`concurrency = 1`）：逃生口——与 stdio
  面同款执行器，本地开发与测试用。
- `--executor worker`（**#31 起 server 缺省**，`concurrency = 2`）：worker_threads
  池——每 worker 独立 V8 isolate（parser 与模块状态天然隔离），懒启动常驻复用；
  取消 = abort 命令 + ~10s 协作宽限后 `terminate()`（被终止 worker 由池补齐，
  池大小恒定）。`--concurrency` 显式指定恒优先。
- 线程体入口是独立加载面：`reviewagent` 产品包双入口 bundle（`dist/cli.mjs` +
  `dist/review-worker.mjs`，池缺省探测 cli.mjs 旁的 review-worker.mjs；
  `REVIEWAGENT_WORKER_ENTRY` 环境变量可覆盖）。

### 7.2 队列与背压

- `maxQueueDepth`：默认 100；满则 `-32002 queue_full` / HTTP 429。
- `maxConcurrentJobs`：stdio / CLI / `--executor inprocess` 恒 **1**（与 stdio v1
  对齐）；HTTP server **#31 起缺省 2**（worker 池生产档，`--concurrency` 可调）。
- 每 tenant 可加 `maxInFlight`，防单租户饿死其它租户。
- `queued` 超时（默认 30 min）自动 `failed`，错误码 `-32018 queue_timeout`（#31
  已落地：submit 时武装定时器，超时自动终态化，死单不无限占用）。
- `jobTimeoutMs`：默认 60 min；超时 abort + `failed`，错误码 `-32014 job_timeout`
  （#31 已落地：dispatch 时武装，超时自动终态化）。
- SSE 每 job 订阅者上限默认 8、每 tenant 默认 32；慢消费者超过写队列上限后断开，
  客户端靠 `Last-Event-ID` 重连或 `review.get` 快照恢复。
- `429` 与 `503` 都必须带 `Retry-After`（秒）。

### 7.3 内存与仓库规模

- `RepoContext` 对每个 job 缓存源码与 symbol index；并发 × 大仓会放大内存。
- 准入检查：`maxRepoFiles`、`maxRepoBytes`、`maxDiffBytes`；超限在 submit 阶段拒绝。
- 预取预算与 config 语义不变；server 不额外注入上下文。

**缺省值标定（#31 soak 落档）**：`maxRepoFiles = 20_000`、`maxRepoBytes = 512 MiB`
（capabilities 面可见）。标定依据：RepoContext 缓存 Java 源码 + symbol index
（≈3–5× 源码字节的内存形态）× 并发 worker 数；企业服务仓 base 快照典型
<5k 文件 / <100 MiB——20k / 512 MiB 是只拦病理输入（monorepo 整检出仓——应传
子目录）的宽松天花板，正常服务仓零误伤。点开头目录不计（与 rg 缺省跳隐藏面
同口径）。

---

## 8. 安全与运维

### 8.1 鉴权与授权

- `Authenticator` 端口：P1 支持 bearer token；P3 支持 mTLS / 企业网关头。
- `Principal`：`tenantId`、`subject`、`scopes`（`review:submit` / `review:read` /
  `review:cancel` / `artifact:read` / `admin`）。
- wire 约定：`Authorization: Bearer <token>`；token 由 server 运维面签发/轮换，
  `tenantId` 从 token principal 派生，客户端不得在 params 里自报 tenant。
- token→principal 映射文件（JSON）+ 每请求 mtime 检测热轮换；缺 token 文件
  **fail fast 拒启动**（ADR-0013 决策 5）。
- 所有端点（`/rpc`、SSE、artifact 下载）都走同一认证；`/healthz` 可匿名，
  `/readyz` 与 `/v1/capabilities` 默认也要求认证（便于限流与审计）。
- 授权在 service 层按 principal 执行；store 查询强制 tenant 过滤。
- 未授权不泄漏资源存在性：统一 `job_not_found`。
- 401 = 缺 token / token 无效（`-32006`）；403 = token 有效但 scope 不足
  （`-32007`）。两者都在 HTTP 层返回、**不作为方法级业务错误发射**，但响应体
  仍是 `id: null` 的 JSON-RPC error envelope——调用方单一路径解析
  （ADR-0013 决策 1/9）。

### 8.2 仓库与路径

- 三形态统一使用 `repoPath`（绝对/相对）；HTTP 面向企业内部可信平台，允许直接传
  服务器上已准备好的绝对路径。`diff` 支持 `inline` 与 `file`，`file` 直接读服务器
  本地 diff 文件。
- **本次不实现** `repoId` / `repo-registry` / `repo-root`，也不把它们作为可选能力；
  不引入 registry/allowlist 语义。
- CLI/stdio 省略 `repoPath` 时默认 `--cwd` / `process.cwd()`（pi 风格「当前打开
  文件夹」）；HTTP 无 cwd 默认，必须显式传 `repoPath`。
- 解析只做 `realpath` + 目录/文件存在性校验；失败返回 `invalid_params` /
  `repo_not_found`，不引入 allowlist 越界错误。
- base 快照语义：仓库必须停在 MR 的 **base 侧**；server 只读，不 apply diff、不写仓库。
  快照由调用方/物化流水线保证；server 只做路径与可读性校验。
- P4 若需要平台按 MR 拉取，另立 `source` 扩展；不并入本次 `repoPath` 契约。

### 8.3 秘钥与出站

- `REVIEWER_API_KEY` / `REVIEWER_URL` 只从 server 环境或 secret provider 读取。
- 客户端不能指定 `baseUrl`、`apiKey`、任意模型端点；防 SSRF。
- 日志/事件/错误/审计四类输出统一 redaction；key 永不落盘、永不回显。

### 8.4 可观测性

- 结构化日志字段：`requestId`、`jobId`、`tenantId`、`caseId`、`configId`、`modelId`、
  `status`、`durationMs`、`rounds`、`usage`、`errorCode`。
- `X-Request-Id`：调用方可带；服务端回显同一值并在所有日志/事件中透传；缺失则生成。
- `/healthz`：进程活着即可；`/readyz`：store 可写 + worker 池 ready + 不在 drain。
- 可选 `/metrics`：计数器（submit/success/fail/cancel/queue_full）、直方图（queue wait、
  run duration）、gauge（queue depth、running jobs）。
- access log 至少记录：method、path、status、requestId、tenantId、jobId、durationMs。

### 8.5 生命周期

- SIGTERM：停止收单（`server_draining`）→ 排空 running → 关闭 store → 退出。
- drain 超时（默认 60s）后 abort 剩余 job，标记 `cancelled`（reason=`SERVER_DRAIN`）。
- `close()` 幂等；重复调用返回同一 Promise。

**#31 落地序（drain 窗口可观察）**：`service.close()` 先 kick——draining 同步
置位，**监听保持绑定**直到排空完成：drain 窗口内新 submit → 503 +
`-32010 server_draining` + `Retry-After: 5`、`/readyz` → 503（滚动发布门可
观察，非连接拒绝）、`/healthz` → 200、读 / 取消面照常应答（客户端可 cancel
加速 drain）。排空完成后才断 SSE（open stream 会卡死 `server.close`）→
`closeIdleConnections` + `server.close` → store / 幂等表 / worker 池收口 →
进程以 128+信号号退出码退出（SIGTERM 143）。Windows 无信号语义——优雅
drain 的进程级验证走 POSIX 门控（CI ubuntu）；Windows 面由进程内 fake 信号
全链路 + soak（真池同构装配）覆盖。

### 8.6 服务启动与部署

> **2026-10-24 已按拓扑 B 收口（ADR-0013 决策 6，修订 10-23「内部实现包」折中）**：
> 不建 `review-pi-server` 独立包——HTTP 线落 review-pi 实现包 `src/server/` 子树
> （§3.2）；`reviewagent` 自包含产品包单 bundle 含 CLI / stdio / server，用户命令
> 统一为 `reviewagent`，构建入口统一为 `pnpm build:reviewagent`。

生产/本地安装：

```bash
# 一条命令：构建 vendored pi + review runtime + server，输出自包含 tarball
pnpm build:reviewagent

# 本地 npm 安装（或私有 registry 分发同版本 tarball）
npm install -g ./.artifacts/reviewagent/reviewagent-0.1.0.tgz

# 用户可见启动命令：reviewagent server
reviewagent server \
  --host 127.0.0.1 \
  --port 8787 \
  --data-dir /var/lib/review-agent \
  --auth-token-file /etc/review-agent/rpc-token \
  --concurrency 2 \
  --max-body-bytes 33554432 \
  --max-diff-bytes 8388608 \
  --artifact-retention-days 30

```

开发态（不安装全局包）：

```bash
pnpm build:reviewagent

node packages/reviewagent/bin/reviewagent.js server \
  --host 127.0.0.1 \
  --port 8787 \
  --data-dir ./.artifacts/server-data \
  --auth-token-file ./token
```

| 配置 | 说明 |
|---|---|
| `--host` / `--port` | 监听地址；已拍板默认 `127.0.0.1:8787`，可经 `--host/--port` 或 `HOST/PORT` 环境变量覆盖；生产由反代对外 |
| `--data-dir` | `jobs.sqlite`、blobs、runs/audit 落盘根 |
| `--auth-token-file` | bearer token 或 token→principal 映射文件；支持轮换 |
| `--concurrency` | 执行并发；P1 默认 1，P3 worker 池验证后可调 2 |
| `--max-body-bytes` / `--max-diff-bytes` | 请求与 diff 上限 |
| `--artifact-retention-days` | 审计/记录产物保留窗口 |

环境变量：

```ini
REVIEWER_URL=...      # 评审模型网关（服务端专属，客户端不可覆盖）
REVIEWER_API_KEY=...  # 只在服务端注入；日志/事件/审计绝不回显
```

Node 运行时：

```text
engines.node >=22.19.0              # server / SQLite 进 reviewagent bundle 后（对齐 pi sqlite backend）
                                    # 当前 CLI/stdio-only 阶段为 >=22（ADR-0013 决策 8）
启动检测 node:sqlite；不可用则 fail fast，不静默降级
```

部署边界：

- `reviewagent` tarball 内联 vendored pi 运行时；用户侧不解析 `@earendil-works/pi-*`。
- v1 单实例；job 状态与执行者绑定，SQLite 只解决重启恢复，不解决多实例。
- 多实例需 sticky routing 或 lease/fence，另立 ADR；在此之前不要把同一租户打到多实例。
- TLS 建议由反向代理终止；server 默认只监听内网/本机。若直连 TLS，后续加
  `--tls-cert` / `--tls-key`。
- `/readyz` 作为滚动发布门；SIGTERM 后先失败 readiness，再 drain。

### 8.7 调用方网络与 SSE 注意

- 反向代理需为 SSE 关闭响应缓冲（`X-Accel-Buffering: no`）、放宽 read timeout，
  并把 `Last-Event-ID` 原样透传。
- SSE 连接必须带 `Authorization`；浏览器直连需 CORS 预检与 `Access-Control-Allow-Headers`
  包含 `Authorization`、`Last-Event-ID`、`X-Request-Id`。服务到服务集成不需要 CORS。
- 调用方 HTTP 超时应短于 job 超时；`review.submit` 是异步受理，不要用长连接等结果。
- 代理对 429/503 的 `Retry-After` 不要改写；调用方按该值退避。

---

## 9. 实施顺序与验收

| 阶段 | 内容 | 验收 | 估计 |
|---|---|---|---|
| P-1 | 调用方契约收口：§4.6 触发流程、§4.7 stdio 对齐表、§8.6 启动/部署 | **已完成拍板**（2026-10-21；2026-10-24 收成 ADR-0013）；调用方可用 §4.6 curl 契约评审 | 已收口 |
| P0 | 内核 seam：`signal`、`onProgress`、`ReviewRunSummary` | **已随 stdio 线 #22/#23 落地**：取消不写 succeeded record；progress 钩子开启/关闭 t1–t5 字节门零漂移 | 已完成 |
| P1 | `ReviewService` 核心（复用 stdio 线已建 `src/rpc/` 件）+ 统一 `ReviewRequest` + memory store + fake executor + in-process executor + stdio v2（拓扑 B，票 #27） | 服务接口测试：submit/get/list/cancel/幂等/队列满/tenant 隔离/取消/close drain；无 HTTP 参与 | 1–2 天 |
| P2 | HTTP JSON-RPC + SSE + auth + limits + `/healthz` `/readyz` + artifact 下载 + typed `ReviewHttpClient` + demo（票 #28 + #29）；server 随 `reviewagent` bundle，用户命令 `reviewagent server` | 原始 HTTP 契约测试：JSON-RPC 错误码、401/403/413/429、SSE `Last-Event-ID` 重放、断线不取消 job、artifact 权限；安装后 `reviewagent server` 可启动 | 1–2 天 |
| P3 | SQLite store + worker 池 + 重启恢复 + drain + 跨重启 replay；启动时检测 `node:sqlite`；`reviewagent` `engines.node >=22.19.0`（票 #30 + #31） | 崩溃恢复（queued 恢复、running 标 failed/`-32015 server_restart`）、worker 取消、并发 soak、内存上限；Node 版本门 | 2–3 天 |
| P4 | 可选适配器：MR source provider / pi-protocol v8 | 每个适配器只加 transport/source 测试，不动 ReviewService | 视需求 2–5 天/项 |

> stdio JSONL 长驻模式已独立成线落地（ADR-0012 + #22/#23/#24），不在 P4 之列。

**已立 ADR-0013**（`docs/adr/0013-http-jsonrpc-server-line-unified-contract-and-topology-b.md`，
2026-10-24 落档，本线唯一权威决策源），收编内容与原建议逐项对应：

1. server 协议选型：HTTP JSON-RPC 2.0 + SSE，不 vendor pi server 栈（决策 1）；
2. job 生命周期与持久化：SQLite job store + job-oriented（决策 2/7）；
3. 取消语义：协作式 abort + worker 硬终止边界，断开≠取消、终态 cancel 幂等（决策 2）；
4. repo 路径模型：三形态统一扁平 `repoPath`（绝对/相对）；不实现
   `repoId` / `repo-registry` / `repo-root`，不保留 stdio 旧参数形 alias（决策 3）；
5. 调用方契约：HTTP JSON-RPC 触发流程、stdio 对齐表、artifact 下载与错误码表
   （决策 5/9；本方案 §4.6/§4.7/§8.6 为其实现 spec）；
6. 自包含 npm 打包：`reviewagent` 单包、`pnpm build:reviewagent` 单入口、
   vendored pi 内联 bundle、用户侧不解析 `@earendil-works/pi-*`（决策 8）；
   外加拓扑 B（决策 6）、幂等口径（决策 4）与拆票 #27–#31（决策 10）。

---

## 10. 风险与开放问题

| 风险/问题 | 说明 | 建议 |
|---|---|---|
| 鉴权模型 | bearer token 为 P1 默认；mTLS / 网关注入为 P3 | **已拍板**：按 §8.1 落地；token 轮换与 tenant 映射实现时定 |
| 仓库来源 | 内部平台提前准备绝对路径 vs 可选 registry | P1 支持绝对/相对 `repoPath` / `diff.path`；P4 加 MR provider |
| 取消粒度 | 网关在飞请求无法瞬时终止 | 定义「取消响应上界」；worker 超时 terminate |
| partial audit | abort 时可能没有完整 record | P1 允许无 audit；P2 补 partial flush |
| SSE vs WebSocket | SSE 单向但简单；WebSocket 双向但复杂 | **已拍板**：v1 只用 SSE；WebSocket 后置 |
| pi-protocol 兼容 | 上游已删除该栈 | 仅当有真实 pi 客户端时做 P4 适配器 |
| 并发 parser | 进程级 memoized parser | P3 worker 池隔离；P1 concurrency=1 |
| 多实例部署 | job 状态与执行者绑定 | **已拍板**：v1 单实例；多实例需 lease/fence，另立 ADR |
| `node:sqlite` 版本/实验性 | Node <22.13 需要 flag；当前 Node 仍打 ExperimentalWarning | **已拍板**：`engines.node` 对齐 `>=22.19.0`（server 进 bundle 时生效；当前阶段 `>=22`）；启动检测 fail fast；不引 `better-sqlite3` |
| stdio/HTTP 契约分歧 | params 结构、幂等、列表过滤、终态 cancel 等未逐字对齐 | **已拍板**：以 §4.7 对齐表为准；capabilities `features` 声明能力 |
| SSE 慢消费者 | 写队列膨胀会拖垮 server | 每 job/tenant 订阅上限 + 慢消费者断开 + `Last-Event-ID` 重连 |
| artifact 保留 | audit 含 wireBody，体积与敏感度都高 | **已拍板**：独立 scope、默认 30 天保留窗口、过期 `artifact_expired` |
| 调用方重试重复 job | 网络抖动可能重复 submit | `clientRequestId` 幂等；`idempotency_conflict` 拒绝不同参数 |

---

## 11. 明确不做

- 不 vendor `pi-protocol` / `pi-server` / `pi-client` / `session-backends` 整栈。
- 不复用 `AgentHarness` / `SessionRepo` 作为 server 底座；上游 1.x 会移除 harness。
- 不把 Chord service 语义引入对外契约；JSON-RPC 方法名就是契约。
- 不做同步阻塞式 `review.run`（检视分钟级，HTTP 超时不可控）；只做 submit + poll/SSE。
- HTTP 允许客户端传绝对/相对 `repoPath` / `diff.path`（内部可信平台集成）；仍不允许
  客户端传 `apiKey` / 任意 `baseUrl`。
- 不改变 Zone A/B、六阶段指令、Finding/Evidence 契约与判定链口径。
- v1 不做多实例共享执行；SQLite 不等于多实例 job 调度。
- 不把 `jobId` 格式当契约；调用方只能把它当不透明字符串。
- 不要求 stdio v1 与 HTTP 的 params 逐字相同；共享方法名/状态机，能力差异由
  `server.capabilities.features` 声明。
- 不建 `review-pi-server` 独立包（拓扑 B：HTTP 落 review-pi `src/server/` 子树，
  ADR-0013 决策 6）；不发布或依赖公共 npm 的 `@earendil-works/pi-*`。
- 不要求用户安装后额外构建 pi 运行时；`reviewagent` tarball 必须自包含。

---

## 附录 A：pi SDK 能力边界（为什么 SDK 不能直接解决 RPC）

### A.1 pi SDK 是什么

锚定版本 `6671c604` 的「SDK」指 `@earendil-works/pi-coding-agent` 主包导出的
**coding-agent 进程内嵌入 API**，不是独立的 RPC 协议包。核心导出：

- `createAgentSession()` / `AgentSession`：单会话生命周期、prompt、steer、followUp、
  subscribe、abort、compaction、模型切换、消息历史。
- `createAgentSessionRuntime()` / `AgentSessionRuntime`：会话替换（new / resume / fork / import）。
- `SessionManager`、`ModelRuntime`、`ResourceLoader`、`DefaultResourceLoader`：
  会话持久化、模型/凭据解析、extensions / skills / prompt templates / context files 发现。
- 内置工具、工具工厂、extension API、slash command、skills、prompt templates。
- `runRpcMode()` + `RpcClient`：**stdio JSONL** headless 模式（stdin 命令 / stdout 事件）。

`docs/sdk.md` 的定位是「把 pi 嵌入你自己的应用、搭自定义 UI、跑自动化流水线」；
`docs/rpc.md` 明确写：Node/TS 用户应优先直接用 `AgentSession`，而不是起子进程。

### A.2 SDK / stdio RPC / experimental server 是三条不同的线

| 形态 | 传输 | 语义 | 适用 |
|---|---|---|---|
| `AgentSession` SDK | 进程内 TypeScript API | coding-agent 会话 | 嵌入 Node 应用 |
| `runRpcMode()` | stdin/stdout JSONL | coding-agent 命令集 | 子进程嵌入 / IDE |
| `pi-protocol` + `pi-server` + `pi-client` | CBOR 帧 + Unix socket | Chord service + Session attachment | 实验性本地多端会话 |

三者都不是 HTTP/JSON-RPC server。

### A.3 SDK 能解决什么

- 本地 Node 进程内嵌入：不经过网络，直接 `await session.prompt(...)`。
- 本地子进程嵌入：用 stdio JSONL RPC，按行发命令、收事件。
- 会话级事件流、abort、模型切换、compaction、session 持久化。
- coding-agent 语义的 extensions / skills / prompt templates / 工具装载。

### A.4 SDK 不能解决什么

- **不是 HTTP server**：没有 `listen()`、没有 HTTP 路由、没有 JSON-RPC 2.0 方法契约。
- **不是远程多客户端服务**：没有 principal/scopes、tenant 隔离、并发连接与背压。
- **不是 job 服务**：没有 submit/get/list/cancel 的异步 job 生命周期、幂等、队列、
  服务重启恢复、SSE 订阅重放。
- **不是 ReviewAgent 的 review 语义**：`AgentSession` 是 coding-agent 会话（工具是
  read/bash/edit/write，带 extensions/skills/compaction），不是六阶段 Review Runtime；
  用它替换 `runReview` 会直接改变 Zone A/B、工具面与审计口径。
- **仍是 stdio / 本地**：`runRpcMode()` 的 stdin/stdout 协议没有远程鉴权、没有 HTTP
  状态码、没有多客户端 attach 语义；要放到企业平台前面，仍要自写 HTTP 网关。

### A.5 结论

- 若目标是「本地嵌入」：可以用 pi SDK / stdio RPC，但那是 coding-agent 语义，
  不是 ReviewAgent review job 语义；ReviewAgent 自己已有更贴合的低层 `Agent` 路径。
- 若目标是「远程 HTTP/JSON-RPC server」：SDK 只能帮你写 agent 内核那一层，**不能
  替代 server 层**；鉴权、job 状态机、队列、SSE、审计产物与 tenant 隔离仍需自建。
- 因此本方案继续采用：`ReviewService`（自建深模块）+ `runReview`（已有内核执行缝）
  + HTTP/JSON-RPC/SSE 适配器；pi SDK 仅作为「本地嵌入形态」的参考实现。

---

## 附录 B：当前 ReviewAgent 进程模型（2026-10-20 现状）

### B.1 当前支持

> 注：命令名为 2026-10-20 快照时名；2026-10-23 起用户可见命令统一为
> `reviewagent`（内部实现包仍名 `review-pi`），2026-10-24 起 stdio 长驻模式
> （`reviewagent rpc`）已落地（ADR-0012 + #22–#24）。

| 形态 | 命令 / 入口 | 生命周期 |
|---|---|---|
| 单案 CLI | `reviewagent review --repo ... --mr ...` | 一进程一案，stdout 单个 JSON，进程退出 |
| 冒烟自检 | `reviewagent smoke` | 一进程一次双探针，进程退出 |
| 处置记录 | `reviewagent disposition ...` | 一进程一次本地写库，进程退出 |
| 进程内库调用 | `import { runReview } from "review-pi"` | 由宿主进程决定；每次调用一个 run |
| 矩阵实验 | `pnpm experiment -- ...` | 一进程跑矩阵；完成后退出 |

「断点续跑」是实验 runner 的能力：它扫描 `runs/` 已有记录并跳过已完成单元。
这是**跨进程恢复**，不是长驻进程，也不是 stdin 协议。

### B.2 当前不支持

- 没有 daemon / server / 常驻 worker 启动模式。
- 没有 `process.stdin` 读取面；CLI 只解析 `process.argv`。
- 没有 stdin/stdout JSONL 协议；stdout 是单文档或一次性终端输出，不是命令/事件流。
- 一个进程不能连续接收第二个命令；`review-pi` bin 经 `spawnSync` 等子进程结束后退出。
- 没有 JSON-RPC / HTTP 监听口。

> **注**：B.2 是 2026-10-20 立项时的实现事实，不是设计取向（stdio 长驻模式此后
> 已落地——见姊妹篇）。HTTP server 方案的目标就是补齐
> daemon / server / 常驻 worker：`reviewagent server` 长驻进程 + HTTP 监听 +
> 有界 job 队列 + worker 池 + 优雅 drain。当前缺失的原因是历史实现先落了 CLI 与
> stdio RPC，网络服务面留在本方案 P1–P3。

代码证据：

- `packages/review-pi/bin/review-pi.js`：`spawnSync` + argv 透传 + 退出码透传。
- `packages/review-pi/src/cli/main.ts`：`main()` 解析 argv 一次，执行一个子命令后
  `exitGracefully`；注释明确「本线无协议宿主，无 stdin 停读面」。
- `packages/review-pi/src/cli/args.ts`：`review` / `smoke` / `disposition` 均为 argv 子命令。

### B.3 与目标形态的差距

> **2026-10-24 注**：本节为 2026-10-20 立项时的差距清单；下述 1–5 已随后
> **stdio 线独立落地**（ADR-0012 + #22–#24，`reviewagent rpc` 子命令 + 进程内
> 会话核心），不再属本方案 P4。保留原文以记录立项基线。

1. 新入口（独立 bin 或 `--mode rpc`）：读 stdin，保持事件循环常驻。
2. 严格 LF-only JSONL 编解码；一行一个 JSON 文档。
3. 命令与响应按 `id` 相关；命令包括 `review.submit` / `review.get` / `review.list` /
   `review.cancel`；事件单独成行。
4. stdout 只写协议文档；日志走 stderr；EOF 或 `shutdown` 命令触发优雅 drain。
5. 复用同一 `ReviewService` 深模块；HTTP 适配器与 stdio 适配器只换传输。

现有 `reviewagent review` 单文档 stdout 契约不得改变；stdio JSONL 是**新增模式**，
不能把现有 CLI 改造成多文档流。
