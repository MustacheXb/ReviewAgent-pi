# 0012. stdio JSONL 长驻模式——复用 pi 传输/输出纪律、不复用命令语义，running cancel 进 v1

**状态**：已接受（2026-10-21，用户评审通过）
**关联**：ADR-0009（pi 内核从 0 重写、四包 vendor 边界）、ADR-0010（呈现投影不进机对面）、ADR-0011（configId 必填显式——rpc 层沿用）、#21（stdio 模式 v1 实现 spec）、《ReviewAgent stdio JSONL 长驻模式实现方案》（`docs/design/`，2026-10-21 双侧校验修正后为本文的设计母本）、《ReviewAgent RPC-HTTP-JSON-RPC Server 实现方案》（姊妹篇，方法契约共享方）

## Context

- 宿主进程需要以**长驻子进程**方式嵌入 ReviewAgent：一次进程启动连续提交多个 MR 检视 job、查询、取消、订阅进度、优雅 drain。现有 `review-pi review/smoke/disposition` 是一次性单命令形态（bin 为 `spawnSync` 薄壳），无法承载。
- pi 锚定版本（`6671c604`）已有完整的 stdio JSONL RPC 实现（`packages/coding-agent/src/modes/rpc/` + `src/core/output-guard.ts` + `src/rpc-entry.ts`）。2026-10-21 逐项校验（对照 `reference_project/pi`，HEAD `73f8de80b`）：18 项机制断言 14 属实 / 3 部分属实（U+2028 写侧不转义、SIGTERM 跳过 flush、backpressure 不暂停 stdin——均已吸收进方案）；`jsonl.ts` / `output-guard.ts` / `rpc-entry.ts` 在锚定版与 HEAD 间**逐字节零变化**——机制层稳定可移植。
- 但 pi RPC 的命令语义是 coding-agent **会话命令**（`prompt`/`steer`/`abort`/`set_model`/`new_session`/`bash`…），与 review **job 命令**无映射；`runRpcMode` 强绑定 `AgentSessionRuntime`；信封是自定 `{type,id,command,success,data/error}` 而非 JSON-RPC。
- 姊妹篇 HTTP 方案已定义 review job 方法契约（`review.submit/get/list/cancel` + `server.capabilities`）——两条传输面应共享该方法契约。
- 内核（`runReview`）当前无 signal / onProgress 缝；pi-ai `ProviderRequestOptions.signal` 与 pi-agent-core `Agent.abort()` 的取消缝存在但未接线。

## Decision

1. **新增 `review-pi rpc` 子命令**：stdin/stdout 严格 LF-only JSONL（每行一个 JSON-RPC 2.0 文档），方法集 = `server.capabilities` / `review.submit` / `review.get` / `review.list` / `review.cancel` / `shutdown`——与 HTTP 方案共享方法契约（stdio v1 为其子集，已知分歧互注于两侧文档，待 HTTP 线启动统一收口）。v1 只做本地可信集成，不做网络面。
2. **复用 pi 的传输/进程/输出纪律，不复用其命令语义与实现**：移植/等价实现 `jsonl.ts`（framing 单源）与 `output-guard.ts`（stdout 接管 + raw 写队列 + ENOBUFS/EAGAIN 重试）；镜像 `rpc-client.ts` / `rpc-mode.ts` 的客户端与生命周期机制；不 import、不 vendor coding-agent（维持 ADR-0009 四包 vendor 边界）。
3. **`ReviewService` 为唯一深模块**：承载 job 状态机、队列、取消与事件；`runReview` 经 `ReviewRunExecutor` 端口执行——executor 是唯一 import 内核执行入口的模块，`ReviewRunSummary` 由 executor 适配器从 `ReviewRunResult` 本地投影，**不改内核返回类型**。
4. **running cancel 进 v1**（2026-10-21 用户拍板，推翻方案初稿的 v2 建议）：内核新增 `ReviewRunInput.signal?` 与 `onProgress?` 两个可选缝（A/B 直驱路径透传 pi-ai provider signal；C/D/E agent 路径 abort 调用 `agent.abort()`；abort 上抛 `ReviewAbortedError`，审计与 RunRecord 均不落盘）。**t1–t5 字节门与语义门零漂移是 S2 硬验收**——signal/onProgress 为纯旁路线，未配置时字节行为不变（缺席省键纪律）。
5. **拍板细则**（10 条收口记录见方案 §12）：终态 cancel 幂等返回 view（`-32005` 保留码不发射）；事件粒度 = 阶段/轮次边界 + 计数快照；`review.get` findings 恒原始英文源（ADR-0010 投影不进机对机协议）；diff inline + 8 MiB 上限；默认并发 1；`clientRequestId` 幂等与 SQLite store 留 v2。

## Options（为什么不是别的）

- **直接 import pi 的 `runRpcMode` / `RpcClient`**：把 extensions / TUI / 内置工具 / `AgentSessionRuntime` 整条链路带进本仓，违背 ADR-0009 四包 vendor 边界；命令语义无映射；复用 pi 信封即放弃与 HTTP 线共享方法契约的路径。
- **进程内 SDK（pi `docs/sdk.md` 的 `AgentSession` 路线）**：把内核入口从 `runReview` + 六阶段自研 loop 换成 `AgentSession`，直接改变 Zone A/B、工具面与审计口径——等于推翻 ADR-0009 的重写姿态；且宿主的明确诉求是子进程隔离。
- **HTTP server 先行**：网络监听 / 鉴权 / 多租户不在本地嵌入的必要面内；stdio 是本地可信宿主的最小暴露面，HTTP 线留待后续按其方案立项。
- **pi-protocol v8（CBOR 帧 + Unix socket + Chord service）**：传输与会话语义都不同，属实验协议；与「复用已锚定验证的机制」的选型原则相反。
- **v1 只做 queued cancel（方案初稿 §8.1）**：被 2026-10-21 拍板否决——宿主需要中断长任务的确定性，signal 缝的成本（1–2 天 + 字节门零漂移证明）可承受。

## Consequences

- **正**：宿主获得低开销长驻嵌入面（省去每案进程启动与冷装配）；方法契约与 HTTP 线共享，未来网络面零协议重设计；内核以零字节漂移方式获得取消与进度观测缝（评测装置同样受益）；stdout 协议纯度有 pi 实证机制兜底（stdio-guard 接管 + 写队列 + 重试）。
- **负/风险**：协议面一旦有宿主接入即承担向后兼容义务（方法 / 错误码 / 事件形状演进需版本化纪律，`server.capabilities` 是协商入口）；stdout 纪律依赖 stdio-guard 接管，绕过接管面的写入（第三方库直写 fd）是残留污染源——进程测试以「故意写诊断」回归覆盖；内存 job store 进程退出即丢（v2 SQLite + replay）；`--concurrency > 1` 的安全前提（每案独立 toolkit / RepoContext / rg）需 S1 验证后才能放开。
- **中性**：v1 无鉴权（本地可信假设，跨用户暴露须另立 tenant 方案）；`-32005` 与 `review.list` 分页的 HTTP/stdio 分歧挂账；bin 对 `rpc` 子命令改异步 spawn + 信号转发，其余子命令维持 `spawnSync` 不动。

跨仓限定语纪律：本 ADR 为本仓序列 0012；引用 DSH 兄弟仓决策须写全限定语「DSH 线 ADR-XXXX」。
