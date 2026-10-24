# 0013. HTTP/JSON-RPC server 线——统一契约（协议/ReviewJob/ReviewRequest/调用方/自包含打包）与拓扑 B

**状态**：已接受（2026-10-24，两轮 grilling（10-23 / 10-24）+ 总结确认，用户拍板）
**关联**：ADR-0009（pi 内核从 0 重写、四包 vendor 边界）、ADR-0010（呈现投影不进机对面——协议面 findings 恒英文原始源）、ADR-0011（configId 必填显式——统一模型沿用）、ADR-0012（stdio 线，方法契约共享方；其拍板 20/21/22 由本文修订）、#25（协议 spec 母本）、#26–#31（落地票）、《ReviewAgent RPC-HTTP-JSON-RPC Server 实现方案》（HTTP 线实现 spec；本文修订其已被取代的段落，以文内各节 2026-10-24 修订注记为准）、《ReviewAgent stdio JSONL 长驻模式实现方案》（stdio 线实现 spec；本文修订其拍板 20/21/22）

## Context

- 企业内部代码托管平台的 MR 检视集成需要远程触发面：平台提交检视、跟踪进度、取消作业、取回产物。当前只有本地形态（CLI 单案 / 进程内 `runReview` / stdio 长驻），且三形态调用参数模型未统一（stdio v1 仍是旧扁平参数形）——跨形态契约存在漂移风险。
- 本线决策经 2026-10-23 / 10-24 两轮 grilling + 总结确认；此前散落在两份设计文档的拍板段与会话记忆。**本文是本线唯一权威决策源**：落地票（#27–#31）与两份方案文档的后续修订一律以本文为准。
- 三处既有拍板被本文取代：HTTP 方案 §3.2 的 `review-pi-server` 独立包拓扑（2026-10-23 曾折中为「内部实现包」）；stdio 方案拍板 20/21 的 repo 判别联合与拍板 22 的 legacy alias 过渡窗口（均为 2026-10-23）；「SSE 跨重启 replay 留 v2」（2026-10-21）。

## Decision

1. **协议选型**：对外主协议 **HTTP + JSON-RPC 2.0**（`POST /rpc`，单请求；不做 batch、不做 WebSocket），进度推送 **SSE**（`GET /v1/jobs/{jobId}/events`，`Last-Event-ID` 重连）。不 vendor pi server 栈（CBOR 帧 + Unix socket + Chord service + Session attachment——传输、寻址、会话模型、鉴权、部署形态均不匹配，HTTP 方案 §1/§2 已核验）。`review.submit` 成功返回 **202 + `Location: /v1/jobs/{jobId}`**，其余方法 200，capabilities 声明 `submitHttpStatus: 202`；HTTP 层错误（401 / 403 / 413 / 429 / 503）响应体仍是 JSON-RPC error envelope（`id: null`）——调用方单一路径解析；`429` / `503` 必带 `Retry-After`（秒）。
2. **ReviewJob 状态机与取消语义**：`queued → running → succeeded | failed | cancelled`（running 取消经 `cancelling`）；单调推进、终态不可逆、同一 job 至多一个执行实例；jobId 对外是**不透明字符串**（调用方不得解析格式，服务端内部形态需处理跨重启防碰撞）。**断开不等于取消**——只有显式 `review.cancel` 或服务端 drain 才取消；终态 cancel **幂等返回终态 view**（`-32005` 保留不发射，与 ADR-0012 对齐）。
3. **统一 `ReviewRequest`（三形态共享）**：`clientRequestId?` / `caseId`（必填，路径安全字符集）/ **`repoPath?`（扁平字符串，绝对或相对）** / `diff` 判别联合 `{kind:"inline",text} | {kind:"file",path}` / `issueDescription?` / `configId`（必填显式 A–E，无隐式缺省——ADR-0011）/ `modelId?` / `metadata?`。CLI/stdio 省略 `repoPath` 时默认 `--cwd <dir>`（未给则 `process.cwd()`，pi 风格「omit to discover, provide to override」）；HTTP 必填显式。CLI flags 映射到同一模型（`--repo` → `repoPath`）；CLI `review` 子命令保持直调 `runReview` 的单文档 stdout 契约逐字节不变。**不引入** repoId / repo-registry / repo-root / allowlist；**不保留** stdio v1 旧扁平参数形的 legacy alias——stdio v1 零外部调用方，`protocolVersion` 升 **2** 即唯一切换信号（旧扁平形在 v2 直接 `invalid_params` 拒绝；修订 stdio 拍板 20/21/22）。`protocolVersion` 三形态同源单源为 **2**（版本号标识统一契约代数；方案文档示例里的 1 是统一拍板前的旧稿，HTTP 首发即 2）。
4. **幂等口径**：`(tenantId, clientRequestId)` 唯一；重复提交返回既有 job。对比口径 = **执行相关字段内容哈希**：归一化 `repoPath`、解析后的 diff 文本（`kind:"file"` 按文件内容）、issue 文本、`configId`、`modelId`；`metadata` 不参与。不同参数冲突 `-32016`（调用方必须换 id）；幂等记录保留 7 天。
5. **调用方契约（Principal / scope / 租户隔离）**：`Principal { tenantId, subject, scopes }`（`review:submit` / `review:read` / `review:cancel` / `artifact:read` / `admin`）由 HTTP `Authorization: Bearer` 头经 `Authenticator` 解析派生，客户端不得在 params 自报 tenant；token→principal 的 JSON 映射文件 + 每请求 mtime 检测热轮换 + 缺 token 文件 fail fast 拒启动。store 查询层强制 tenant 过滤，**越权统一 not found**（不泄漏资源存在性）。`REVIEWER_URL` / `REVIEWER_API_KEY` 只在启动期从环境解析注入；客户端不可传 apiKey / 任意 baseUrl（防 SSRF）；日志 / 事件 / 错误 / 审计统一 redaction，key 永不落盘回显。
6. **拓扑 B（偏离 HTTP 方案 §3.2，含 10-23「内部实现包」折中）**：**不建 `review-pi-server` 独立包**——HTTP 线落在 review-pi 实现包 `src/server/` 子树，service / contracts 与 stdio 线同包共享；CLI main 增加 `server` 子命令；`reviewagent` 产品包 bundle 入口不变（单 bundle 含 CLI / stdio / server）。理由：三形态共享 `ReviewService` 后，stdio 与 HTTP 之间的包边界只制造依赖环或强制组合根外移；内核隔离改由**边界测试**强制——server 子树只经 executor 端口 import 内核（`runReview` / `Agent` 稳定面），不触碰 harness / session / chord。
7. **SSE 跨重启 replay 提前开（修订 2026-10-21「v2 再开」拍板）**：`Last-Event-ID` 之后事件从事件日志重放；SQLite store 下**跨重启支持**（`job_events` 持久化使然，随 #30 落地）；memory store 或事件已清理时发 `reset` + 最新快照。心跳 20s、`retry: 5000`；每 job 订阅者上限 8、每 tenant 32；慢消费者超写队列上限断开，靠重连或 `review.get` 恢复。
8. **自包含打包**：`reviewagent` 自包含 npm 包——vendored pi 内联 bundle，运行时依赖不含 `@earendil-works/pi-*`；`engines.node >=22.19.0`（server / SQLite 进 bundle 时生效；当前 CLI/stdio-only 阶段 `>=22`）；启用 SQLite 时启动检测 `node:sqlite` 可用性，不可用 fail fast 不静默降级；默认监听 `127.0.0.1:8787`（HOST / PORT 可覆盖），TLS 由反向代理终止。产物 API 只回逻辑引用（`artifact:audit|record/<runId>`）不回服务器绝对路径；audit 与 record 分开授权；默认保留 30 天可配，过期 `-32017`。
9. **错误码收口**：以 HTTP 方案 §4.4 全表为单源，补 **`-32018 queue_timeout`**（§7.2 引用但表缺号；queueTimeout 30 min 自动终态化）。`-32003 / -32005 / -32011` 保留不发射（allowlist v2 移除——stdio v1 经 `--repo-root` 命中时仍发射、v2 起不再；终态 cancel 幂等；running cancel 可用）；`-32006 / -32007` 不作为方法级业务错误发射（401/403 在 HTTP 层返回，响应体为 `id: null` 的 JSON-RPC error envelope，错误码即二者——调用方单一路径解析）。`error.data` 只含安全细节（`jobId` / `caseId` / `limit` / `retryAfterMs`），不放路径、key、内部堆栈。
10. **范围与拆票**：P1 + P2 + P3 全量 + **stdio v2 统一随线**；契约先行（当前无外部调用方，无兼容冻结负担）；交付 typed `ReviewHttpClient` + `scripts/` demo（capabilities → submit → SSE → get → cancel → artifact 全链路）。落地拆票：#27（统一 `ReviewRequest` + P1 service 核心 + stdio v2）/ #28（P2a HTTP 核心 + 鉴权 + 幂等 + client）/ #29（P2b SSE + artifact + demo）/ #30（P3a SQLite + 重启恢复 + 跨重启 replay）/ #31（P3b worker 池 + drain/超时 + soak）。明确不做：`/metrics`、per-tenant `maxInFlight`、JSON-RPC batch、WebSocket、同步阻塞式 `review.run`、mTLS 与企业网关头鉴权（后续）、MR source provider 与 pi-protocol v8 兼容适配器（P4 视需求）、多实例共享执行（lease / fence / sticky routing，另立 ADR）。

## Options（为什么不是别的）

- **vendor pi server 栈 / pi-protocol v8**：CBOR + Unix socket + Chord + Session attachment 是本地多端会话框架——无 HTTP listener、无鉴权、无 job 语义；强行 vendor 得到「还要再写 listener、鉴权、job 状态机」的负资产（HTTP 方案 §1/§2 对锚定 `6671c604` 的三方核验结论）。
- **`review-pi-server` 独立包（原 §3.2；10-23 折中为「内部实现包」）**：三形态共享 `ReviewService` 后，stdio 与 HTTP 之间的包边界只剩成本——要么依赖环（server 线要用 stdio 线已建的 service / contracts / executor 端口），要么组合根外移（service 再抽第三个共享包）。同包 `src/server/` 子树 + 边界测试拿到的内核隔离等价，成本更低。
- **repo 判别联合 `{kind:"path"} | {kind:"id"}`（stdio 拍板 20/21，10-23）**：为「未来可能的 repo registry」预埋的形，而 registry 本身已否（企业内部平台直接准备绝对路径，`--repo-root`/allowlist 一并移除）；联合形让三形态 CLI flags 映射、参数校验器、幂等内容哈希全部多一层判别——删掉，扁平 `repoPath`。
- **legacy alias 过渡窗口（stdio 拍板 22，10-23）**：stdio v1 零外部调用方（唯一宿主是本仓评测驱动器与测试），没有兼容负担；alias 只留双解析路径与双测试面。`protocolVersion` 2 即切换信号。
- **SSE 跨重启 replay 留 v2（2026-10-21 拍板）**：该拍板前提是「事件日志不持久」；#30 SQLite 落地后 `job_events` 表天然支持跨重启重放，提前开不新增实现面——原拍板随 P3 范围失效，随本文修订。
- **同步阻塞式 `review.run`**：检视分钟级，HTTP 超时不可控；submit + poll/SSE 的异步 job 模型才是平台集成形态。

## Consequences

- **正**：三形态一套参数模型与状态机语义（宿主代码一套模型、两种传输）；企业平台获得远程触发面（提交/跟踪/取消/产物）；决策单源化——本文之后两份方案文档的修订段与 #27–#31 全部对齐本文；server 只经 executor 端口碰内核，未来 pi 内核升级不连带重构 server。
- **负/风险**：review-pi 包内新增 `server/` 子树，包体变大——以边界测试（server 子树 import 面）守住内核隔离；stdio v2 是破坏性协议变更（参数形切换、`--repo-root` 移除换 `--cwd`）——靠 `protocolVersion` 2 与宿主客户端同票升级消化；Windows 无 SIGTERM——drain 测试用显式 close / 可移植信号；`node:sqlite` 在 Node 22 仍打 ExperimentalWarning（预期，不按错误处理）；v1 单实例部署（多实例另立 ADR）。
- **中性**：`ReviewService` 升级为 `CallContext`（Principal）贯穿所有方法（stdio 面合成 local principal）；事件升级 per-job seq；`ReviewRunSummary` 升 review-pi 公开面导出（补完 P0 半成品）；capabilities `features` 按形态声明差异（HTTP：idempotency=true、listFilters 全量、sse=true、artifactDownload=true、submitHttpStatus=202；stdio v2：idempotency=false 待 S4、listFilters=["status"]）；协议面 findings 恒英文原始源（ADR-0010 投影不进机对机协议）；Zone A / Zone B 与六阶段指令字节零触碰，t1–t5 字节门零漂移是全线硬验收。

跨仓限定语纪律：本 ADR 为本仓序列 0013；引用 DSH 兄弟仓决策须写全限定语「DSH 线 ADR-XXXX」。
