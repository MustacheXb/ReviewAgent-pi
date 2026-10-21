# ReviewAgent stdio JSONL 长驻模式实现方案

> **文首说明**（2026-10-21）：本文是 **stdio 模式专属方案**，独立于
> 《ReviewAgent RPC-HTTP-JSON-RPC Server 实现方案》。本文只覆盖「长驻子进程 +
> stdin/stdout JSONL」这一条本地嵌入通道；HTTP / SSE / 网络鉴权 / pi-protocol
> 兼容层不在本文范围内。
>
> **一句话结论**：pi 在锚定版本已有完整的 stdio JSONL RPC 实现（`rpc-mode.ts` +
> `rpc-client.ts` + `jsonl.ts` + `output-guard.ts`）。本方案**复用其传输/进程/输出
> 纪律与客户端相关机制**，但**不复用其命令语义**——pi 的命令是 coding-agent 会话
> 命令，ReviewAgent 需要的是 review job 命令。实现形态为 `review-pi rpc`：stdin/stdout
> 严格 LF-only JSONL，每行一个 JSON-RPC 2.0 文档；`ReviewService` 作为唯一深模块
> 承载 job 状态机、队列、取消与事件；`runReview` 经 `ReviewRunExecutor` 端口执行。
> v1 只做本地可信集成，不做网络服务面。
>
> **校验记录**（2026-10-21，两侧逐项核验后合入本文）：pi 侧 18 项机制断言
> 14 属实 / 3 部分属实（U+2028 写侧不转义、SIGTERM 跳过 flush、backpressure
> 不暂停 stdin——均已吸收进正文）；`jsonl.ts` / `output-guard.ts` /
> `rpc-entry.ts` 在锚定 `6671c604` 与当前 checkout HEAD（`73f8de80b`）间
> 逐字节零变化。本仓侧声明全部属实（`runReview` / configId A–E / bin
> `spawnSync` / t1–t5 门 / 内核路径零 stdout 污染、rg 子进程 piped 非
> inherit）。**拍板**（2026-10-21）：v1 必须 running cancel（内核 signal
> 透传进 v1，字节门零漂移证明随 S2 验收）；终态 cancel 幂等返回 view；
> 事件粒度 = 阶段/轮次边界 + 计数快照；`review.get` 不做呈现投影。
> 完整拍板记录见 §12。决策入档 **ADR-0012**（`docs/adr/0012-stdio-jsonl-
> resident-rpc-reuses-pi-transport-not-command-semantics.md`）；实现级 spec 见
> **#21**（GitHub Issues，S0 交付物）。

---

## 1. 定位与边界

### 1.1 目标

stdio 模式解决的是「宿主进程需要以子进程方式嵌入 ReviewAgent」：

- 宿主保持一个长驻 `review-pi rpc` 子进程；
- stdin 发命令，stdout 收响应与事件；
- 一次进程启动可连续提交多个 MR 检视 job；
- 宿主可按 job 查询、取消、订阅进度；
- 进程退出前可优雅 drain。

### 1.2 明确不做

- 不做 HTTP / TCP / SSE / WebSocket。
- 不做多租户鉴权与网络暴露；stdio 假设调用方是本地可信宿主。
- 不做 pi-protocol v8（CBOR 帧 + Unix socket + Chord service + Session attachment）。
- 不改现有 `review-pi review` / `review-pi smoke` / `review-pi disposition` 的
  stdout 单文档契约。
- 不复用 pi coding-agent 的命令集（`prompt` / `bash` / `set_model` / session 管理等）；
  ReviewAgent 使用自己的 review job 方法名。

### 1.3 pi 已有完整实现：逐文件分析与复用决策

pi 在锚定版本 `6671c604` 确实已经有完整的 stdio JSONL RPC 实现。它是两条不同的线：

| pi 实现线 | 路径 | 是否与本文同类 |
|---|---|---|
| stdio JSONL RPC | `packages/coding-agent/src/modes/rpc/` + `src/rpc-entry.ts` + `src/core/output-guard.ts` | **是**，本文的直接参考 |
| CBOR/Unix 实验协议 | `packages/protocol` + `packages/client` + `packages/server` | 否，传输与会话语义都不同 |

#### 1.3.1 逐文件映射

| pi 文件 | pi 中的作用 | ReviewAgent 决策 |
|---|---|---|
| `modes/rpc/jsonl.ts` | 严格 LF-only JSONL reader/writer；只按 `\n` 分行，允许行尾 `\r`；StringDecoder 处理多字节 UTF-8 分片；**写侧不转义 U+2028/U+2029**（纪律全在读侧 LF-only + 客户端禁用通用行读取器） | **移植/等价实现**；作为 framing 单源，不再手写第二套 |
| `modes/rpc/rpc-types.ts` | `RpcCommand` / `RpcResponse` / 事件类型全集（prompt/session/model/bash 等） | **只参考形状**，不复用命令集；ReviewAgent 定义 `review.submit/get/list/cancel` |
| `modes/rpc/rpc-mode.ts` | `runRpcMode(runtimeHost)`：stdin 循环、id 相关、事件流、stdout 接管、backpressure（写队列 + 事件管线阻塞，**不暂停 stdin**）、shutdown；退出码 EOF→0 / SIGTERM→143 / SIGHUP→129 / 写失败→1；**SIGTERM 时跳过 stdout flush**（宿主可能已停读，flush 会卡死） | **复用进程/输出/退出纪律**；不复用 `AgentSessionRuntime` 与 extension UI |
| `modes/rpc/rpc-client.ts` | spawn 子进程、stderr 捕获、pendingRequests 按 id 相关、30s 超时、进程退出错误、事件监听 | **镜像到 ReviewAgent 客户端**：同样的相关/超时/退出错误机制，typed review 方法 |
| `src/rpc-entry.ts` | 独立 RPC 入口：设置进程标题/env、`main(["--mode","rpc",...])` | **形态参考**；ReviewAgent 用 `review-pi rpc`，不引入 coding-agent main |
| `src/core/output-guard.ts` | `takeOverStdout()`：把直接 stdout 写入改道 stderr；raw stdout 写队列；ENOBUFS/EAGAIN 重试；`waitForRawStdoutBackpressure` / `flushRawStdout` | **必须吸收**：这是 stdout 协议纯度的 pi 实证机制，本方案 v1 必须等价具备 |
| `packages/coding-agent/docs/rpc.md`（HEAD 版已把命令表拆至 `rpc-commands.md`） | framing、id 相关、生命周期、错误纪律 | 参考 framing 与相关纪律；命令表换成 review job 方法 |
| `packages/coding-agent/docs/sdk.md` | `AgentSession` 进程内嵌入；Node/TS 优先于子进程 | 不采用；ReviewAgent 的 stdio 是子进程集成面，内核仍是 `runReview` |

#### 1.3.2 为什么不能直接 `import` pi 的 `runRpcMode` / `RpcClient`

1. **coding-agent 没有 vendor**。直接 import 会把 extensions / TUI / 内置工具 /
   `AgentSessionRuntime` / session 管理整条链路带进 ReviewAgent，违背 ADR-0009 的
   四包 vendor 边界。
2. **命令语义不匹配**。pi 的 RPC 命令是会话命令（`prompt` / `steer` / `abort` /
   `set_model` / `new_session` / `bash` / `get_entries` …）；ReviewAgent 需要的是
   job 命令（`review.submit` / `get` / `list` / `cancel`）。二者没有一一映射。
3. **运行时绑定不同**。`runRpcMode(runtimeHost: AgentSessionRuntime)` 强绑定
   coding-agent 的 session 运行时；ReviewAgent 的内核入口是 `runReview` + 六阶段
   自研 loop。换成 `AgentSession` 会直接改变 Zone A/B、工具面与审计口径。
4. **信封不同**。pi RPC 用 `{type, id, command, success, data/error}`；
   本文用 JSON-RPC 2.0，以便未来 HTTP 适配器共享同一方法契约。直接复用 pi 信封会
   放弃这条共享路径。
5. **extension UI 不需要**。pi RPC 含 `extension_ui_request` /
   `extension_ui_response` 交互；ReviewAgent 没有 extension/TUI 面，v1 不承担这部分。

#### 1.3.3 复用策略（本方案相对上一版的修正）

- **直接移植或等价重写** pi 的 `jsonl.ts` framing 纪律与 `output-guard.ts` 输出纪律；
  尤其是 stdout 接管 + 写队列 + backpressure + ENOBUFS/EAGAIN 重试，v1 必须覆盖。
- **镜像** `rpc-client.ts` 的客户端机制：子进程 spawn、stderr 捕获、pendingRequests
  按 id 相关、超时、进程退出时 reject 所有 pending；但类型换成 review 方法。
- **镜像** `rpc-mode.ts` 的生命周期：stdin 读循环、`end` 触发 shutdown、
  SIGTERM/SIGHUP 退出码映射、输出 flush 后再退出。
- **不复用** pi 的 `RpcCommand` / `RpcResponse` 类型、`AgentSessionRuntime`、
  extension UI 协议与命令集。
- **可选兼容层**：如果未来明确要求「现有 pi RPC 客户端可直接连 ReviewAgent」，
  再加一个 P4 适配器，把 pi 信封与命令映射到 ReviewService；v1 不做，因为命令语义
  仍无法无损映射。

锚定有效性（2026-10-21 核验）：`jsonl.ts` / `output-guard.ts` / `rpc-entry.ts`
在 `6671c604` 与当前 checkout HEAD（`73f8de80b`）间逐字节零变化；
`rpc-mode.ts` / `rpc-types.ts` / `rpc-client.ts` 仅 16–30 行小改（prompt/steer/
follow_up 响应增加 `disposition` 字段、事件监听器快照遍历）。本文引用的机制层
描述对当前 checkout 全部有效。

---

## 2. 进程模型

### 2.1 命令形态

```text
review-pi rpc [--out <dir>] [--repo-root <dir>] [--concurrency <n>]
```

进程级参数：

| 参数 | 必需 | 说明 |
|---|---|---|
| `--out <dir>` | 否 | 审计与运行记录落盘根；缺省 `review-pi-output` |
| `--repo-root <dir>` | 否 | 仓库 allowlist 根；submit 的 `repoPath` 必须落在其下 |
| `--concurrency <n>` | 否 | 并发执行 job 数；缺省 1；正整数 |

每案参数（`configId` / `modelId` / `diff` / issue）经 stdin 逐 job 传入，不做进程级
隐式缺省。

内核参数派生（对齐 `runReview` 必填面，镜像 CLI 装配 `cli/main.ts`）：`--out` →
`runsRoot`；`experimentId` 恒 `RPC_EXPERIMENT_ID = "review-pi-rpc"`（镜像
`CLI_EXPERIMENT_ID` 模式——审计落 `{out}/review-pi-rpc/audit/vul4j/...`）；
`rep` 恒 1（宿主重跑即再 submit）；`apiKey` / `baseUrl` 启动期经
`resolveReviewerEndpoint()` 解析一次；`fetch` 恒 `globalThis.fetch`。

### 2.2 启动顺序

1. 解析 argv；
2. 从当前 cwd 装载 `.env.local`（已有环境变量优先，不覆盖）；
3. `resolveReviewerEndpoint()` fail fast：缺 key 直接退出；
4. 创建 `ReviewService` 与 executor；
5. 订阅 job 事件；
6. 进入 stdin 读循环。

### 2.3 退出路径

| 触发 | 行为 | 退出码 |
|---|---|---|
| `shutdown` 方法 | 先回响应，再停止收单、取消 queued、等待 running、flush 后退出 | 0 |
| stdin EOF | 先排空已读入的命令，再执行同样的 drain | 0 |
| SIGINT | 同样的 graceful drain，**跳过 stdout flush** | 130 |
| SIGTERM | 同上（pi 实证：信号到达时宿主可能已停读，flush 会卡死——`rpc-mode.ts` 仅非 SIGTERM 才 flush） | 143 |
| SIGHUP（非 win32） | 同上 | 129 |
| 启动失败 / 协议不可恢复错误 / stdout 写失败 | stderr 人话诊断 | 1 |

退出码映射沿用 128+信号号惯例（pi 同款）。pi 只注册 SIGTERM/SIGHUP；本仓加
SIGINT（Windows Ctrl+C 可达，pi 无此需求因其宿主经 stdin EOF 关闭）。

退出纪律（本仓实证教训，`cli/main.ts` `exitGracefully`）：Windows 上立即
`process.exit` 与 undici / AbortSignal 句柄清理竞态，崩 0xC0000409、退出码被吞。
rpc 进程真跑过 fetch 后退出必须：flush → `process.exitCode` 置码 → 事件循环
自然排干 → unref 兜底强退定时器（8s）。

### 2.4 bin 形态

`review-pi` bin 对 `rpc` 子命令必须使用异步 `spawn` + SIGINT/SIGTERM 转发；
普通一次性子命令继续走现有 `spawnSync`。原因：`spawnSync` 会让父进程阻塞，无法
正确转发信号，长驻子进程的中断语义不可控。

---

## 3. Framing

- 编码：UTF-8。
- 分隔：只按 `\n` 分行。
- 允许行尾单个 `\r`（兼容 CRLF 输入）。
- 不允许把 U+2028 / U+2029 当分隔符。**写侧不转义**（`JSON.stringify` 原样输出，
  与 pi 一致）——协议文档必须写明客户端约束：禁用通用行读取器（Node `readline`
  会按 U+2028/U+2029 断行），必须用 LF-only 读取（等价 `jsonl.ts` 的 reader）。
- 一行恰好一个 JSON 文档；空行忽略。
- 非空非法 JSON → `-32700 Parse error`。
- stdout 每一行都必须是完整 JSON 文档；任何日志、env 摘要、诊断只能走 stderr。

---

## 4. JSON-RPC 2.0 信封

### 4.1 请求

```json
{"jsonrpc":"2.0","id":"1","method":"server.capabilities"}
```

```json
{"jsonrpc":"2.0","id":"2","method":"review.submit","params":{"caseId":"VUL4J-1","repoPath":".cache/datasets/vul4j-repos/VUL4J-1-f5903fa564","diff":"...","issueDescription":"...","configId":"E","modelId":"deepseek-v4-flash"}}
```

### 4.2 响应

```json
{"jsonrpc":"2.0","id":"2","result":{"jobId":"job-1761020800000-1","status":"queued"}}
```

```json
{"jsonrpc":"2.0","id":"2","error":{"code":-32001,"message":"Unknown job: ..."}}
```

### 4.3 事件通知

```json
{"jsonrpc":"2.0","method":"review.event","params":{"seq":3,"job":{"jobId":"job-1761020800000-1","status":"running","progress":{"phase":"Deep Reasoning","round":1,"toolCalls":0}}}}
```

### 4.4 错误码

| code | 语义 |
|---|---|
| -32700 | parse error |
| -32600 | invalid request |
| -32601 | method not found |
| -32602 | invalid params |
| -32603 | internal error |
| -32001 | job_not_found |
| -32002 | queue_full |
| -32003 | repo_not_allowed |
| -32004 | payload_too_large |
| -32005 | cancel_not_allowed（保留码：v1 不发射——终态 cancel 幂等返回 view；留待与 HTTP 方案 409 语义对齐时启用或删除） |
| -32010 | server_draining |
| -32011 | cancel_not_supported（保留/过渡期；running cancel 可用时不发射） |
| -32012 | repo_not_found |
| -32013 | rate_limited（stdio v1 不发射，保留与 HTTP 对齐） |
| -32014 | job_timeout（stdio v1 不发射，保留与 HTTP 对齐） |
| -32015 | server_restart（stdio v1 不发射，保留与 HTTP 对齐） |
| -32016 | idempotency_conflict（stdio v1 不发射；v2 幂等落地后启用） |
| -32017 | artifact_expired（stdio v1 无 artifact 下载面，保留与 HTTP 对齐） |

不支持 JSON-RPC batch（数组信封）→ `-32600 invalid request`。

`error.data` 只放安全细节：`jobId` / `limit` / `maxDiffBytes` 等；不放路径、key、
内部堆栈。完整错误码来源 = RPC/HTTP 方案 §4.4；stdio 侧只发射其能力子集。

---

## 5. 方法契约

| 方法 | 参数 | 返回 | 语义 |
|---|---|---|---|
| `server.capabilities` | 无 | 协议版本、serverId、方法表、limits | 握手与能力协商 |
| `review.submit` | `caseId` / `repoPath` / `diff` / `issueDescription?` / `configId` / `modelId?` | `jobId` + `status` | 校验、入队、立即返回；不阻塞等检视完成 |
| `review.get` | `jobId` | job view | 查询状态、进度、结果或错误 |
| `review.list` | `status?` | `{ jobs }` | 列出 job，按提交时间倒序 |
| `review.cancel` | `jobId` | job view | queued → 直接 `cancelled`；running → `cancelling` → `cancelled`（内核 AbortSignal，v1 实装）；已终态 → **幂等返回终态 view**（不报错） |
| `shutdown` | 无 | `{status:"shutdown"}` | 排空并退出 |

参数纪律：

- `configId` 必填，合法值 `A–E`；stdio 层不设隐式缺省。
- `issueDescription` 可省，缺省空串（内核面是必填 `string`，service 层补齐）。
- `modelId` 可省，缺省走内核 `REVIEW_MODEL_ID`。
- `diff` 必须有最大字节数上限（建议 8 MiB，可配置）；inline 传入（拍板 2026-10-21，
  文件路径形态留 v2 参数扩展）。
- `repoPath` 相对路径以进程 cwd 为基准解析（与 CLI `--repo` 同语义）；在设置
  `--repo-root` 时必须落在 allowlist 根内。
- `review.get` 的 findings 恒为**原始英文源**，不应用 ADR-0010 呈现投影
  （投影是 CLI 人话呈现档的事，不进机对机协议；宿主要中文呈现自行投影）。

---

## 6. Job 模型

### 6.1 状态机

```text
queued ──> running ──> succeeded
   │          │
   │          ├────> failed
   │          │
   │          └────> cancelling ──> cancelled
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

### 6.2 v1 边界

- job 状态与队列在内存；进程退出即丢失。
- 默认 `concurrency = 1`；可用 `--concurrency` 调整。`--concurrency > 1` 的安全
  前提：每案独立构建 toolkit / RepoContext / rg 子进程，无进程内共享可变状态
  （spec 阶段确认；worker 池隔离仍是 v2）。
- `review.cancel` 支持 queued 与 running（running 经内核 AbortSignal）；已终态
  幂等返回终态 view（拍板 2026-10-21）。
- 事件是 live-only；客户端断线后用 `review.get` 查快照，不做事件重放。
- 事件粒度 = 阶段/轮次边界 + 计数快照（累计 toolCalls / usage），不逐 toolCall
  发事件（拍板 2026-10-21）。
- `clientRequestId` 幂等 v1 不做（S4 与 HTTP 方案 tenant 幂等一并对齐）。
- jobId 为进程内单调 id（`job-<启动毫秒>-<序号>`，repo 无 ULID 依赖不引入），
  与内核 `runId` 是两个标识；v2 持久化时再议 ULID。

### 6.3 v2 扩展

- append-only job event log + 断线重放。
- SQLite job store + 重启恢复。
- worker 池隔离 CPU / tree-sitter parser。

---

## 7. 模块边界

### 7.1 文件布局

```text
packages/review-pi/src/rpc/
  jsonl.ts       # 严格 JSONL 编解码
  protocol.ts    # JSON-RPC 2.0 信封、错误码、参数校验
  service.ts     # ReviewService 深模块：job 状态机、队列、事件
  executor.ts    # ReviewRunExecutor 端口 + runReview 适配器
  main.ts        # stdin 命令循环、事件输出、EOF/信号 drain
  stdio-guard.ts # stdout 接管 / raw 写队列 / backpressure（pi output-guard 等价物）
  client.ts      # 宿主侧客户端：spawn + JSONL + id 相关 + 超时（pi rpc-client 模式）
```

### 7.2 ReviewService 接口

```ts
export interface ReviewService {
  submit(params: unknown): Promise<ReviewJobView>;
  get(jobId: string): ReviewJobView | undefined;
  list(params: unknown): { jobs: readonly ReviewJobView[] };
  cancel(jobId: string): Promise<ReviewJobView>;
  subscribe(listener: (event: ReviewJobEvent) => void): () => void;
  close(): Promise<void>;
}
```

不变量：

- `submit` 只受理并入队，不等待执行完成。
- 同一 job 至多一个执行实例。
- job 状态单调推进；终态不可逆。
- HTTP 断开 / stdio 断线不取消 job；只有显式 `review.cancel` 或 drain 才取消。
- `close` 幂等；停止收单、取消 queued、等待 running。

### 7.3 ReviewRunExecutor 端口

```ts
export interface ReviewRunExecutor {
  execute(
    request: ReviewRunRequest,
    ctx: { readonly jobId: string; readonly signal: AbortSignal },
  ): Promise<ReviewRunSummary>;
}
```

`runReview` 适配器是唯一 import `review-pi` 内核执行入口的模块；测试使用 fake
executor。服务层拥有 job 状态，executor 只负责执行。

---

## 8. 内核配套

### 8.1 已拍板：running cancel 进 v1（2026-10-21）

v1 就要 running cancel，内核改造（下述四项）随 v1 交付，且必须通过 t1–t5
字节门与语义门零漂移证明——signal / onProgress 是纯旁路线，未配置时字节
行为不变（缺席省键纪律）。

### 8.2 内核改造内容

1. `ReviewRunInput.signal?: AbortSignal`
   - A/B 直驱路径透传到 pi-ai provider 请求 `signal`（`ProviderRequestOptions.signal`，
     `packages/ai/src/types.ts:125`）；
   - C/D/E agent 路径 abort 时调用 `agent.abort()`（`packages/agent/src/agent.ts:319`）；
   - 新增 `ReviewAbortedError`；abort 上抛时审计与 RunRecord 均不落盘（半途中止
     无对照价值——现行内核审计本就在循环完成后统一落盘），job 层以 `cancelled`
     终态留内存记录。

2. `ReviewRunInput.onProgress?`
   - 在既有 phase 边界发出 phase / round / toolCall / usage 观测事件；
   - 不进入 wire，不改变消息顺序；未配置时字节行为不变。

3. `ReviewRunSummary` 纯投影
   - `runId` / `findings` / `usage` / `rounds` / `toolCalls` / `truncated` /
     artifact 引用；stdio 层不直接消费内部 `RunRecord`。
   - 落位：rpc 层 `executor.ts` 适配器从 `ReviewRunResult`
     （`{runId, record, recordPath, auditPath}`）本地投影，**不改内核返回类型**——
     内核只新增 signal / onProgress 两个可选缝。

4. 字节纪律
   - 不改 Zone A/B、六阶段指令、Finding/Evidence 契约；
   - t1–t5 字节门与语义门必须零漂移。

---

## 9. 安全与运行纪律

- stdio 模式假定调用方是本地可信宿主，不直接暴露到网络。
- `repoPath` 必须受 `--repo-root` allowlist 约束；相对路径以进程 cwd 为基准，
  解析后做 realpath + 根前缀校验，拒绝绝对路径逃逸与 symlink/junction 逃逸。
- API key 只从 `REVIEWER_URL` / `REVIEWER_API_KEY`（> 旧 `DEEPSEEK_*` 别名）或
  `.env.local` 读取（已有环境变量优先），绝不回显。
- `diff` 设最大字节数；队列设最大深度；job 设超时。
- stdout 只写协议；日志、env 摘要、错误诊断全部走 stderr。
- v1 不做鉴权；如果未来要跨用户/跨进程暴露，必须另立鉴权与 tenant 方案。

---

## 10. 测试与验收

### 10.1 单元测试

- JSONL：分片、合并、CRLF、U+2028/U+2029、EOF 尾行。
- Protocol：信封校验、id 相关、错误码、参数校验。
- Service：排队、并发、queued cancel、terminal cancel、close drain、repo allowlist。

### 10.2 进程测试

- spawn 真 bin，保持进程不退出。
- 连续发 `server.capabilities` / `review.submit` / `review.get` / `shutdown`。
- 断言 stdout 每行都是 JSON、stderr 不含 key。
- stdout 纯度：故意写一条非协议诊断（模拟 `console.log`）后，断言它不进入 stdout 协议流。
- EOF 路径：先排空 pending 命令再退出。
- SIGINT / SIGTERM 路径：drain 后退出码正确（130 / 143），信号路径不 flush。
- running cancel 路径：提交后取消 running job，断言 `cancelling` → `cancelled`，
  abort 不落审计与 RunRecord。
- 退出纪律（Windows 实证回归）：真 fetch 后退出不得立即 `process.exit`——
  断言退出码不被 0xC0000409 吞掉。

### 10.3 门与回归

- `review-pi` 全量测试。
- 根测试套件。
- t1–t5 字节门与语义门。
- 若加 signal/onProgress：必须证明字节门零漂移。

---

## 11. 实施顺序

| 阶段 | 内容 | 验收 | 预估 |
|---|---|---|---|
| S0 | ADR + 独立 spec（协议、错误码、取消语义、退出语义、Windows 退出纪律） | 评审通过 | 0.5 天 |
| S1 | JSONL + stdio-guard + protocol + service core（内存、concurrency=1、queued/running cancel 状态机、事件；fake executor）；JSONL/output-guard 机制对齐 pi 实现 | 单元测试 + in-process loop 测试 + stdout 纯度测试 | 1–2 天 |
| S2 | 内核 signal/onProgress + runReview 接线 + executor 真适配器（running cancel 实装） | **t1–t5 字节门零漂移**；取消测试 | 1–2 天 |
| S3 | 真 bin 长驻模式 + EOF/信号 drain + 宿主客户端 `client.ts` + 进程烟测 | 进程级测试；stdout 契约；Windows 退出码回归 | 0.5–1 天 |
| S4（v2） | SQLite job store + 事件重放 + `clientRequestId` 幂等 + worker 池 | 崩溃恢复 + replay 语义 | 2–3 天 |

v1 = S0–S3（running cancel 已拍板进 v1，原「内核改造 S3」提前为 S2）。worker 池
隔离与 S4 一并后移（v1 `--concurrency > 1` 的安全前提见 §6.2）。

---

## 12. 拍板记录（2026-10-21 全部收口）

1. v1 必须 running cancel → **是**。内核 signal 透传进 v1（S2），字节门零漂移
   证明随 S2 验收。
2. `clientRequestId` 幂等 → v1 不做，S4 与 HTTP 方案 tenant 幂等一并对齐。
3. 事件跨断线重放 → v1 live-only + `review.get` 快照，v2 再做 replay。
4. `repoPath` → 本地 allowlist 路径（`repoId` 是多租户网络面概念，stdio 不需要）。
5. 默认并发 → 1。
6. diff → inline 传入 + 8 MiB 上限（可配置）；文件路径形态留 v2 参数扩展。

校验时追加拍板：

7. 终态 `review.cancel` → 幂等返回终态 view（`-32005` 为保留码，v1 不发射）。
8. 事件粒度 → 阶段/轮次边界 + 计数快照，不逐 toolCall 发。
9. `review.get` findings → 原始英文源，不应用 ADR-0010 呈现投影。
10. 两方案契约分歧处置：stdio v1 契约 = HTTP 方案契约的子集；已知分歧
    （终态 cancel 幂等 vs `-32005`、`review.list` 无分页参数）在两侧文档互注，
    待 HTTP 线启动时统一收口。

跨传输对齐二次拍板（2026-10-21，用户接受推荐）：

11. 共享的是**方法名与状态机语义**，不是逐字相同的 params：HTTP=`{kind:"inline",repoId}`，
    stdio=`{kind:"local-path",repoPath}`；内部归一化为同一个 `ReviewSubmitInput.source`。
12. `clientRequestId`：HTTP v1 支持；stdio v1 不做，capabilities 声明
    `features.idempotency=false`；S4 持久化落地后再开。
13. `review.list`：HTTP 支持 `status/caseId/limit/cursor`；stdio v1 只支持 `status`；
    能力经 `features.listFilters` 声明。
14. 终态 `review.cancel`：两侧统一幂等返回终态 view；`-32005` 保留不发射。
15. `shutdown`：stdio 保留方法；HTTP 走 SIGTERM，不提供同名 JSON-RPC 方法。
16. `jobId`：对外为不透明字符串；HTTP 可用 UUIDv7/ULID，stdio 维持
    `job-<启动毫秒>-<序号>`，调用方不得解析。
17. 错误码：以 RPC/HTTP 方案 §4.4 为单一来源；stdio 侧已同步保留码，
    只发射其能力子集。
18. 并发默认：stdio 与 HTTP P1 都默认 1；HTTP P3 worker 池验证后生产可配 2。
19. 差异总表与触发流程以 RPC/HTTP 方案 §4.6/§4.7 为准；stdio 本文只保留
    本地可信面差异（无鉴权、无 SSE、无 artifact 下载、`repoPath`）。

---

## 13. 明确不做

- 不把 stdio 模式与 HTTP/JSON-RPC 方案混写；两者共享方法契约（stdio v1 为其
  子集，已知分歧见 §12.10），但传输与部署面独立。
- 不做网络监听、不做 SSE、不做多租户鉴权。
- 不 vendor pi `protocol/client/server/session-backends`。
- 不改现有 `review-pi review/smoke/disposition` 契约。
- 不在 stdio 层改 Zone A/B、六阶段指令、Finding/Evidence 契约与判定链口径。
- 不在 stdio 层做呈现投影（ADR-0010 投影是 CLI 人话呈现档专用，机对机协议
  返回原始 findings）。
