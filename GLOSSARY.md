# Review Agent

低 Token、高质量 MR 代码检视 Agent：用最小充分上下文与缓存稳定循环，以远低于全仓注入的 Token 成本获得接近全量上下文的检视质量。本分支是生产主线（固定 Config E，协议 v3；ADR-0014 / ADR-0015）；检视 Runtime 在 vendored pi 内核上实现（ADR-0009）。

> 研究期词条（C0–C3 分级、Zone B 预取、Repo Map、判定链、字节 / 语义等价门、评测度量 RIE / CARC、逆补丁基准等）已随 E-only 生产化退役（#32 / ADR-0014 §8）。全量词汇表见 **Demo 线**：分支 `demo/config-matrix`，冻结基线标签 `demo-config-matrix-baseline-2026-11-03`。
>
> 评测面（eval-only）词条单列于文末「评测面」节：只服务评测分支与定位报告，**不进生产运行时、协议、CLI 或 `ConfigId` 写面**。

## Language

### 上下文

**Minimal Sufficient Context**:
能支撑正确 Review 判断的最小上下文集，介于 Diff-only 与全仓之间。
_Avoid_: 精简上下文、恰好够用的上下文

**Diff-first**:
以 Diff 为检视入口、按需向符号层与影响层扩展的取上下文方式；明确区别于只看 Diff。
_Avoid_: Diff-only

**Context Ledger**:
本次检视会话已加载上下文（文件/区间/符号/证据）的登记账；重复请求返回引用而非原文。只有已被完整送达的范围才可被引用，引用须标明送达范围与完整性。
_Avoid_: 上下文缓存（与前缀缓存混淆）、把部分送达当已加载

**Stable Prefix（Zone A）**:
一次模型请求中字节级稳定不变的头部：检视角色、政策、按 Tool Profile 冻结的工具与输出 Schema。
_Avoid_: 系统提示词（过窄，仅指角色描述）、Immutable Prefix

**Tool Profile（工具画像）**:
一次检视 run 内固定暴露的只读工具集合，由可用知识语料推导（无语料为 core-5；仅有 rule 为 core-5+rule；仅有 history 为 core-5+history；两者皆有才为 extended-7）；profile 在 run 内不变化，选择与来源进入审计。
_Avoid_: 动态工具集（run 内增减工具会击穿前缀稳定）、空工具补位（暴露无语料的检索工具）

**Append-only Context（Zone C）**:
动态上下文只追加、不重排、不改写的构造纪律。
_Avoid_: 消息重写、上下文压缩（改写历史破坏前缀稳定）

**Cache-Stable Review Loop**:
消息构造始终维持前缀稳定的检视循环。

### 检视

**Review Runtime**:
运行检视循环的专用执行环境（检视提示词、工具策略、状态、事件），区别于通用 Coding Runtime。
_Avoid_: Coding Runtime 复用

**Finding**:
一条结构化检视结论，含严重级、类别、文件/行位置、描述、证据、规则与置信度。
_Avoid_: 评论、告警、issue（泛化）

**Evidence**:
支撑一条 Finding 的可验证材料：具体符号、行号与代码摘录。

**Evidence Gate**:
"No Evidence, No Finding"——没有证据的候选结论不得作为 Finding 产出。

**处置（Disposition）**:
人工对单条 Finding 的判定（accept / reject / false-positive），经 reviewagent CLI（`reviewagent disposition`）落库（append-only；回溯锚 = source/caseId/configId/rep/model + findingId，与 RunRecord 对齐）；同一 finding 重复处置按 notedAt latest-wins。
_Avoid_: 判级（judge 属评测链，已随研究线退役；处置是人工生产面）

**人工接受率（Acceptance Rate）**:
生产 KPI：accepted / totalDispositioned，绝对口径直接从处置库算出（total=0 → null，空集不冒充 0）；对历史 A–D 处置数据照常计算。
_Avoid_: 相对锚口径（不依赖评测结论）、把 reject/false-positive 计入接受

### 运行时边界

**Attempt Budget（尝试预算）**:
模型发起工具调用的总次数封顶，与真正执行的调用数是两个独立闸；尝试耗尽不终止检视，而是迫使当前阶段以文本收尾。
_Avoid_: 执行预算（那是执行上界）、把尝试耗尽当整轮终止

**Request Budget（请求预算）**:
发往 provider 的请求总数上界（缺省 24）；只在阶段边界判定（阶段内工具 recall 不设闸）。剩余请求不足以按常规序推进到裁决时，跳过尚未完成的前四阶段直入候选——候选与裁决保底 2 请求，候选一旦开始裁决允许完成。连保底都不足时按 `MAX_REQUESTS_REACHED` 收尾。
_Avoid_: 在工具轮中途掐断请求（判定只在阶段边界）、用请求预算替代尝试预算

**Output Budget（输出预算）**:
累计 output token 封顶（缺省 48,000）；只在阶段边界事后判定并停止后续请求，绝不在 wire 上新增 `max_tokens`、也不改写已完成阶段。超限按 `OUTPUT_BUDGET_EXHAUSTED` 收尾。
_Avoid_: wire `max_tokens`（改变请求字节并击穿缓存合同）、把输出预算当请求参数

**Forced Phase Finalization（强制阶段收尾）**:
工具尝试预算耗尽后的收口方式：本批工具调用终止，向模型注入「直接输出本阶段 JSON」指令（每阶段至多 2 次），保证候选与裁决阶段仍能产出结论；注入用尽仍只发工具调用按 `TOOL_ATTEMPTS_EXHAUSTED` 收尾，返回空文本才按 `PHASE_FORCED_INCOMPLETE` 收尾。
_Avoid_: 预算耗尽即终止整轮（会丢失 Finding）、静默跳过阶段

**核内（Review Runtime）**:
检视会话运行时的全部行为：loop 策略、`review.*` 工具、上下文决策、缓存纪律、检视政策与 Evidence Gate；在 pi 内核上实现（`packages/review-pi`，ADR-0009）。
_Avoid_: 通用 Coding Runtime 复用、把核内当插件树挂接点（DSH 线历史形态，已随内核移除）

**核外（呈现与运维工具）**:
服务于呈现与运维而非检视会话的层：翻译投影、模型迁移门、处置统计；普通库被 CLI 调用，不进内核。
_Avoid_: 实验插件（评测链已随研究线退役）、核外误入内核装配

**翻译投影（Translation Projection）**:
核外呈现工具：消费检视产出的英文文档做中文呈现，仅译自然语言字段（findings 叙述、resultSummary），结构化字段字节直通；投影自带留痕（呈现语言、术语表版本、源 finding 关联）。检视输出恒英文——测量面冻结，语言是呈现配置而非内核参数（ADR-0010）。消费端接线 = CLI 环境变量注入缝（`REVIEW_PI_PRESENTATION_ENGINE` 动态 import 核外引擎，未配置恒等直通、stdout 逐字节同现状）；引擎任何失败呈现降级英文源——检视产物绝不因呈现层失败丢失，退出码不受影响。
_Avoid_: 输出语言配置（暗示内核参数化缝）、双语内核（检视链整体留在已验证英文域）

**MR 边界护栏（Boundary Guard）**:
内核入口处的 MR 输入边界检查（≤10 文件 / diff ≤2K 变更行，配置无关、请求受理即生效）：界内路径零字节漂移（缺席省键）；超界或不可度量走显式降级——`domainWarning` 标注 + 审计 `mrBoundary` 留痕 + 照常执行，不拒检。
_Avoid_: 输入校验（过泛）、大 MR 切分（另立项）、静默截断（违背零静默纪律）

### 服务面

**ReviewJob（检视作业）**:
一次 MR 检视的异步执行单元：submit 受理即入队，状态机 `queued → running → 终态`（`succeeded` / `failed` / `cancelled`，running 取消经 `cancelling`），单调推进、终态不可逆；同一 job 至多一个执行实例。jobId 对外是不透明字符串，调用方不得解析格式；连接断开不等于取消——只有显式 `review.cancel` 或服务端 drain 才取消。
_Avoid_: 检视会话 / Session（pi durable Session 是多端会话模型；本线 job-oriented，见 ADR-0012/0013）

**ReviewRequest**:
三形态（CLI flags / stdio `review.submit` / HTTP `review.submit`）共享的统一提交参数模型：扁平 `repoPath`（绝对/相对；CLI/stdio 可省略走 cwd 默认，HTTP 必填显式）+ `diff` 判别联合 `{kind:"inline",text} | {kind:"file",path}` + `caseId`。**协议 v3 起无 `configId`**（配置选择根除，服务端派生恒 E；携带即 `-32019` 拒绝，连 `"E"` 也拒——ADR-0015）。不引入 repoId / repo-registry / repo-root / allowlist。`protocolVersion` 3 即切换信号；客户端对 capabilities 硬断言。
_Avoid_: repo 判别联合含 `kind:"id"`（2026-10-23 旧形，已废）、repoId、configId 当请求参数（v2 形，Demo 线）

**Principal（调用方主体）**:
server 面鉴权身份：`tenantId` / `subject` / `scopes`（`review:submit` / `review:read` / `review:cancel` / `artifact:read` / `admin`），由 HTTP `Authorization` 头经 `Authenticator` 解析派生（token→principal JSON 映射文件 + 每请求 mtime 热轮换，缺 token 文件 fail fast 拒启动），客户端不得在 params 自报 tenant；越权访问统一按 not found 处理（不泄漏资源存在性）。
_Avoid_: 用户（server 面无自然人语义）、自报 tenant

**SSE 事件流**:
`GET /v1/jobs/{jobId}/events` 长连接推送面（#29，ADR-0013 决策 7）：per-job 单调 seq（首事件 = 1，submit 入队不发事件）、帧 = `event: job|error|reset` + `id: <seq>` + 扁平 data、`Last-Event-ID` 断线续传（保留窗覆盖不到 → `reset` 帧携最新快照重建）、20s 静默心跳、订阅上限 8/job + 32/租户（429）、慢消费者 1 MiB 写积压即断开（凭 seq 重连或转 get 轮询恢复）；drain 收口 closeAll 先于 server.close（open stream 会卡死 close）。
_Avoid_: WebSocket（单向推送用不上双工）、逐 toolCall 发射（事件粒度 = 状态转移 / 相位·轮次边界）

**Artifact 逻辑引用**:
succeeded result 的 `auditRef` / `recordRef`（`artifact:audit|record/<runId>`，#29，ADR-0013 决策 8）：API 面不泄漏服务器路径；下载端点 `GET /v1/jobs/{jobId}/artifacts/{audit|record}` 把引用解析回落盘内容，audit/record 两端点各自独立过 `artifact:read` 执法（分开授权），保留窗口 succeeded 落定起算缺省 30 天（`--artifact-retention-days` 可配，capabilities limits 暴露），窗外/文件缺失 → 404 + -32017。
_Avoid_: 直接回传文件系统路径（投影纪律）、下载面复用 review:read（授权面分开）

**Worker 执行器（worker 池）**:
server 形态的检视执行面（#31，ADR-0013 P3b）：`--executor` 二选一——`worker` 缺省生产档（`--concurrency` 缺省 2）经 worker_threads 池执行，每 job 分派独立 worker 线程（lazy spawn、池满排队、取消走 abort 协作 → ~10s 宽限 → terminate 硬杀、完结归还池），per-worker 独立解析器状态互不串台；`inprocess` 逃生口保留（主线程执行、并发恒 1，池面缺陷的降级路径）。CLI / stdio 恒进程内单发执行。
_Avoid_: 每 job 一进程（进程池）、跨 job 共享解析器状态、取消直 terminate（不经协作宽限）

**Drain 窗口**:
服务收口的可观察中间态（#31，方案 §8.5/§8.6）：SIGTERM → 同步进入 draining、监听保持绑定直到排空完成——submit 面 503 + `-32010 server_draining` + `Retry-After: 5`、readyz 503、healthz 200、读面（get / SSE / artifact）照常；running job 排空（drain 超时 60s → abort 剩余 → `cancelled(SERVER_DRAIN)`）后才拆 SSE 连接与监听、关 store / 幂等表 / worker 池，进程 exitCode = 128+信号号（SIGTERM = 143，exitCode 落定而非信号死）。
_Avoid_: 收到信号即断读面（窗口内不可查）、排空无超时闸、进程死于信号默认处置（非优雅退出）

**超时终态化**:
死单自动收口闸（#31）：排队超时 `queueTimeout`（缺省 30min）——queued 滞留超时落 `failed(-32018)` 不再起跑；执行超时 `jobTimeout`（缺省 60min）——running 超时经 abort 协作链落 `failed(-32014)`。终态单调性由终态护栏兜底（迟到结算吞掉）。
_Avoid_: 无限排队 / 无限执行等调用方 cancel 兜底、超时后状态悬挂

**仓库准入**:
submit 期的仓库规模闸（#31，方案 §7.3 标定）：`maxRepoFiles`（缺省 20_000）/ `maxRepoBytes`（缺省 512 MiB）递归清点，超限即拒（`-32004`，死大仓不进队列不进 worker 内存）；口径与内核 rg 清单同源——点开头目录（`.git` 等）不计、symlink 不计不递归（环防御），capabilities limits 面暴露。
_Avoid_: 事后 OOM 才发现（病理仓爆在 worker 内存）、准入口径与 rg 读取面不一致（错杀 / 漏放）

**reviewagent**:
用户可见产品包：自包含 npm 包（bin `reviewagent`，bundle 双入口内联 vendored pi 运行时——`dist/cli.mjs` 主入口 + `dist/review-worker.mjs` worker 线程体，#31），唯一发布/安装面，运行时依赖不含 `@earendil-works/pi-*`；子命令 review / rpc / server / disposition / smoke（server = HTTP JSON-RPC 长驻 + Bearer 鉴权 + 幂等 + SSE 事件流 + artifact 下载 + 缺省 worker 池执行，#28/#29/#31 落地，ADR-0013 拓扑 B——`review-pi` 的 `src/server/` 子树，边界测试把口）。仓内实现包 `review-pi`（内核 + CLI + 传输）不对外发布。
_Avoid_: 用 review-pi 指产品（对外名恒 reviewagent）

### 知识

**CWD**:
项目私有缺陷模式语料：toolkit knowledge 注入面（rules / history）的检索对象，经 `review.search_rule` / `review.search_history` 工具按需检索（缺省空语料）。
_Avoid_: CWE（那是通用公共分类）、把语料当预取注入（研究线 Zone B 形态，已退役）

### 模型接入

**Cache Contract（缓存合同）**:
对一次检视所用 provider / 网关缓存能力的可验证声明：usage 字段族、模型回显、缓存计量、预热与块对齐、路由亲和、价目与时间窗；缺字段如实记 unknown / N/A。
_Avoid_: 按固定折扣率假设缓存价格、把缓存命中率当成本结论

**被测模型（reviewer）**:
检视执行的 LLM：model id 走请求参数（CLI `--model`，缺省 `deepseek-v4-flash`），无 model 环境变量；url / key 经角色命名环境变量（`REVIEWER_*` > 旧 `DEEPSEEK_*`，`.env.local` 自动装载——已有环境变量优先，#46）；进审计留痕（model + baseUrl，绝不记 key，ADR-0008）。自定义网关换端点/模型先过模型迁移门自证再放行。
_Avoid_: 检视模型与呈现引擎混淆、白名单模型（准入白名单已由画像表取代）、model 走环境变量（模型选择走请求，秘密才走环境）

**模型迁移门（Migration Gate）**:
换模型 / 换网关的安全前置自证（迁移 runbook 的机器化，`pnpm migration-gate`）：双探针（网关健康 + **目标**模型可达）→ 单案生产入口 config E 真跑，全绿才放行（exit 0）；每类失败路径一条人话诊断。flash→pro 同族高险升级不默认放行——须 `--confirm-high-risk-upgrade` 显式确认。
_Avoid_: 冒烟测试（过泛——探针只是门的第一步）、自动拦截（门是显式 runbook，不挂 CLI 启动路径）

**上线门（Launch Gate）**:
投产放行判定（ADR-0011，2026-10-20 已执行）：四必做全绿 + 质量门主判（锚活判级 ≥ B + 生产入口选型证据——E recall 冠五配置 0.5962 + token 最低档）。切流结果 = CLI 缺省 config E；v3 起配置不再是任何面的输入（ADR-0015）。
_Avoid_: 把对齐门 FAIL 读作劣化（方向盲门，已转形态记录）、双层缺省（缺省只在 CLI 用户面单义存在）

**参数画像（Provider Profile）**:
模型 id pattern → wire 序列化策略（thinking 字段 / completion 信封）+ usage 能力声明的单源查表（review-llm）；未知模型回落保守默认档（ADR-0008）。
_Avoid_: 画像当 endpoint 配置（「怎么说话」与「连到哪」两轴正交）

### 评测面（eval-only）

> 本节词条只服务评测分支与定位报告，不进生产运行时、协议、CLI 或 `ConfigId` 写面；生产主 KPI 仍是「人工接受率」。

**评测面（Evaluation Plane）**:
承载对照实验、指标、判定链与定位报告的独立面；生产 `main` 只保留只读分析与报告消费，不执行评测配置。
_Avoid_: 生产配置（评测面不是第二套生产配置）、研究线复活（评测面不是 A–D 矩阵的回归）

**E 基线快照（E Baseline Snapshot）**:
某一冻结 tag / commit 的 E 运行时，作为 L2 配对回归的 baseline 臂。
_Avoid_: 把 Claude Code 也叫 baseline、用历史 C 数字冒充 E 基线

**全仓参照（Full-Repo Reference，C_ref）**:
eval-only 的全仓注入参照，复现历史 C 的信息参照角色；只在 L3 运行，不进入生产配置选择。其 `totalTokens` 可作 **参考分母**（见该词条），不作主成本门。
_Avoid_: 配置 C（生产语境）、把 C_ref 的 `totalTokens` 当主成本门或真实账单

**参考分母（Reference Denominator）**:
L3 报告中用 C_ref 的 `totalTokens` 作 E/C_ref 名义成本比例的参照；只用于解释「相对信息参照」的量级，不作 L2 主门、不单独构成结论。主成本指标仍是 CARC，对外宣称用 USD / 价目表。
_Avoid_: 成本主门、跨 provider 直接相除、把参考比例当真实账单

**外部参照（External Reference，Claude Code）**:
跨模型、同仓 / 同 diff / 同 judge 的通用 Agent 参照；单列报告，不进 S/A/B 主判定。
_Avoid_: Claude Code 基线（与 E baseline 串义）、通用 Agent 上限（单次 / 单版本不构成上限）

**L1 绝对质量门（Quality Gate）**:
不依赖 C 的质量约束层：judge / rule 双列、零 finding 率、阴性对照 FP、人工接受率等。
_Avoid_: 把 L1 当 token 门、用人工接受率替代每次改动的自动化门

**L2 配对回归门（Paired Regression Gate）**:
同一代码谱系、同窗口、同 judge 的 E baseline vs candidate 配对回归；主指标 CARC，质量非劣为约束。
_Avoid_: 增量成本门（名字漏掉质量约束）、与历史 C 比较、只比 totalTokens

**L3 定位报告 / 宣称门（Positioning Report / Claim Gate）**:
低频的绝对定位层：E + C_ref + Claude Code 三列报告，只用于发布定位与对外宣称，不作日常合并门。
_Avoid_: 每次合并都跑、把 L3 三列混进 S/A/B、跨模型直接比 token

**同窗口（Same-Window）**:
baseline 与 candidate 在同一 provider / 模型 / judge 条件下交错运行并记录时间窗；跨窗口比较必须标注混杂。
_Avoid_: 跨时段直接比较、把网关漂移归因给代码

**配对（Paired）**:
同一 case / rep 的 baseline 与 candidate 成对比较，而不是两组独立均值比较。
_Avoid_: 把 rep 当独立样本、只比组均值不看差值分布

**空对照校准（Null-Control Calibration）**:
同代码 E 的两条 arm（baseline vs baseline）在同窗口交错运行，用于测噪声底；结果用于确认 / 调整 L2 阈值，不用于判定优化收益。
_Avoid_: 用空对照证明优化有效、把噪声底当质量变化

**CARC（评测面）**:
缓存调整后的成本近似：未命中输入 + 缓存写 + 输出 + 工具成本；同一 provider / 模型内的配对主指标，生产账单口径以 USD / 价目表为准。
_Avoid_: 当货币账单、忽略 cached 字段、跨 provider 直接比

**RIE（评测面）**:
质量 × 成本综合的辅助效率指标，只作解释变量。
_Avoid_: 当主判定、替代 CARC

**judge 链（评测面）**:
LLM-as-judge 的 finding↔truth 裁定链；版本 / 提示词 / 温度 / top_p 必须 pin 死并进环境留痕。
_Avoid_: 判级（生产语境）、跨 judge 版本混跑、把 judge 当生产运行时组件

**历史锚（Historical Anchor）**:
ADR-0004 / ADR-0011 中作为 S/A/B 分母的 C；只作历史实验复算，不是活对照。
_Avoid_: 活锚、把历史锚当未来评判标准

**历史证据（Historical Evidence，`NOT_REPRODUCIBLE`）**:
已补录来源 commit、可考时间窗、模型与 judge，但缺部署版本 / judge 提示词 pin / 缓存策略等可复现条件的历史运行数据；只作证据引用，不作活基线。
_Avoid_: 活基线（历史数据不参与 L2 门）、把「数据可复算」当成「运行可复现」
