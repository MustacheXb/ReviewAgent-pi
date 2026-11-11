# ReviewAgent-pi（生产主线）

低 Token、高质量 MR 代码检视 Agent：以**最小充分上下文**（Minimal Sufficient Context）与**缓存稳定循环**（Cache-Stable Review Loop）——七工具自主拉取 + Context Ledger 去重——用远低于全仓注入的 Token 成本获得接近全量上下文的检视质量。内核基座为 vendored pi 四包（ADR-0009），产品入口是自包含 npm 包 **`reviewagent`**（CLI 单次 / stdio 长驻 / HTTP server 三形态）。

> **本分支定位（ADR-0014）**：生产主线 `main`（由 `production/e-only` 收口而来）——固定 Config E（七工具 + Context Ledger），协议 v3（无配置选择，ADR-0015）。研究侧（A–E 配置矩阵、判定链、Phase 2 复现资产）冻结在 **Demo 线** [`demo/config-matrix`]，基线标签 `demo-config-matrix-baseline-2026-11-03`，见「[研究背景](#研究背景)」。
>
> **姊妹仓（DSH 内核线）**：[`MustacheXb/ReviewAgent`](https://github.com/MustacheXb/ReviewAgent)。跨仓/跨分支 ADR 限定语纪律：裸写「ADR-XXXX」一律指本仓主线序列；引用 DSH 兄弟仓须写「DSH 线 ADR-XXXX」，引用 Demo 线须写「Demo 线 ADR-XXXX」。
>
> **pi 内核基座**：以 [pi](https://github.com/earendil-works/pi) 代码仓为基础的全源码定制（vendor fork，锚定 commit `6671c604` / v0.85.1+11d），vendored `packages/{ai,agent,chord,telemetry}` 四个包；第三方声明见 [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md)。

## 安装

```bash
# 构建（vendored pi + review runtime + 自包含 bundle）→ 输出 .artifacts/
pnpm build:reviewagent

# 本地 npm 安装 tarball
npm install -g ./.artifacts/reviewagent/reviewagent-1.0.0.tgz

reviewagent --version
```

`reviewagent` 包自包含：vendored pi 运行时内联进 bundle，用户侧 npm 不再解析 `@earendil-works/pi-*`；`@vscode/ripgrep`、`web-tree-sitter`、`tree-sitter-java` 作为普通 npm 依赖随包安装。打包产物三形态冒烟（CLI / stdio / server）有 e2e 背书（`packages/review-pi/src/e2e/`，本地 `pnpm --filter review-pi test:e2e` 复跑）。

## 凭据配置（.env.local，绝不入库）

从仓库根（或进程 cwd）自动装载 `.env.local`（gitignored）：已有非空环境变量优先、不被覆盖；装载摘要只报键名与行号，**key 绝不回显**；key 缺失即启动报错并给清单。

```ini
REVIEWER_API_KEY=...     # 检视模型 key（推荐名，#43）
DEEPSEEK_API_KEY=...     # 兼容别名（旧名；与 REVIEWER_API_KEY 同设时新名优先）
REVIEWER_URL=...         # 可选：自定义 OpenAI 兼容网关端点
DEEPSEEK_URL=...         # 兼容别名（旧名）
```

被测模型缺省 `deepseek-v4-flash`，换模型加 `--model <id>`；wire 序列化按 provider 画像表分派（`deepseek-*` / `glm-*` 内建，未知模型保守默认，ADR-0008）。**换模型 / 换网关先过模型迁移门**（见「运维」）。key 只进请求头，绝不进 stdout / stderr / 日志 / 落盘产物（哨兵纪律，测试全量扫描背书）。

## 三形态

### 1. CLI 单次检视（`reviewagent review`）

```bash
cd /path/to/opened-repo
reviewagent review --mr <diff-file> [--issue <text>] [--out <dir>] [--model <id>]
```

`--repo` 可省（省略时默认 process.cwd()，ADR-0013）；**无 `--config` 旗标**——配置恒 E（服务端派生，ADR-0015），传入即用法错误。stdout 单 JSON 文档（findings / usage / 审计路径）；退出码：完成（含诚实截断）0 / 中止 1。检视产物恒英文；中文呈现经呈现投影（`REVIEW_PI_PRESENTATION_ENGINE` 注入核外引擎，ADR-0010——失败降级英文源，产物不丢）。

已知边界：内核面向 Java（角色提示词 + tree-sitter-java 符号索引，非 Java 仓可运行但质量不保证）；基线态语义——检视读的上下文以仓内现状为准（不 apply diff）。

### 2. stdio 长驻（`reviewagent rpc`，ADR-0012）

stdin 收 JSON-RPC 命令行（LF-only JSONL）、stdout 回 JSON 行、stderr 出诊断；单进程长驻可连续提交多个检视 job——面向宿主消费者（IDE 扩展 / MCP 网关 / 驱动器）。

```bash
reviewagent rpc --out reviewagent-output [--cwd <dir>] [--concurrency <n>]
```

```jsonc
{"jsonrpc":"2.0","id":1,"method":"server.capabilities"}  // 握手：protocolVersion=3 / 方法表 / limits
{"jsonrpc":"2.0","id":2,"method":"review.submit","params":{"caseId":"MR-42","repoPath":"<绝对路径>","diff":{"kind":"file","path":"<diff 文件>"}}}
{"jsonrpc":"2.0","id":3,"method":"review.get","params":{"jobId":"job-...-1"}}
{"jsonrpc":"2.0","id":9,"method":"shutdown"}             // drain 在跑 job 落定后自退
```

宿主编程消费：`packages/review-pi/src/rpc/client.ts` 的 `ReviewRpcClient`（typed 六方法 + `review.event` 订阅 + stop() 三级升级链）。Windows 优雅退出走 stdin EOF（无信号语义）。

### 3. HTTP server（`reviewagent server`，ADR-0013 拓扑 B）

```bash
reviewagent server --auth-token-file <file> --data-dir <dir> \
  [--store sqlite|memory] [--executor worker|inprocess] [--host <addr>] [--port <n>] \
  [--out <dir>] [--concurrency <n>] [--artifact-retention-days <n>]
```

HTTP JSON-RPC 长驻（`POST /rpc` + `GET /healthz|/readyz|/v1/capabilities`）：Bearer 鉴权（token→principal 映射文件，每请求 mtime 热轮换）+ 幂等（`clientRequestId`）+ SSE 事件流（`GET /v1/jobs/{id}/events`）+ artifact 下载（`GET /v1/jobs/{id}/artifacts/{audit|record}`）。缺省装配 sqlite store（`--data-dir`，重启恢复 + 跨重启 SSE replay）与 worker 池执行（`--concurrency` 缺省 2，每 job 独立 worker 线程）。

## 协议 v3 速览

| 面 | 契约 |
|---|---|
| 代数 | `capabilities.protocolVersion` = **3** 是唯一切换信号；客户端硬断言（错配人话报错，双向：v3 client 连 v2 server 断言抛错；v2 client 连 v3 server 由 `-32019` 兜住） |
| submit | `caseId` + `repoPath`（CLI/stdio 可省走 cwd，HTTP 必填）+ `diff` 判别联合 `{kind:"inline",text} \| {kind:"file",path}`——**无 `configId`**：携带即 `-32019` 显式拒绝（连 `"E"` 也拒，零静默） |
| configId | 服务端派生常量 `"E"`（单源）：RunRecord / 审计 / disposition / 幂等口径恒 E；历史 A–D RunRecord 只读兼容照旧 |
| 状态机 | `queued → running → succeeded / failed / cancelled`（running 取消经 `cancelling`）；终态单调不可逆 |
| 方法 | `server.capabilities` / `review.submit` / `review.get` / `review.list` / `review.cancel` / `shutdown` |
| 业务错误码 | -32001 job_not_found / -32002 queue_full / -32004 payload_too_large / -32010 server_draining / -32012 repo_not_found（stdio 在场发射）；-32008 gateway_unavailable / -32009 job_failed / -32013 rate_limited / -32014 job_timeout / -32015 server_restart / -32016 idempotency_conflict / -32017 artifact_expired / -32018 queue_timeout（HTTP 发射；401/403 在 HTTP 层）；**-32019 config_id_rejected（v3）**；-32003/-32005/-32011 保留不发射 |
| 退出码 | stdio：shutdown / stdin EOF → 0；SIGINT 130 / SIGTERM 143 / SIGHUP 129；启动失败 1 |

错误码表单源 = `packages/review-pi/src/rpc/protocol.ts`（`JSON_RPC_ERROR`），段位自 `-32019` 起登记防复用。完整决策记录见 ADR-0015。

## 运维

- **换模型 / 换网关**：先过模型迁移门自证再放行——`pnpm migration-gate -- --model <id> [--base-url <url>] [--confirm-high-risk-upgrade]`（双探针 + 单案 E 真跑，全绿 exit 0；每类失败一条人话诊断）。快速自检用 `reviewagent smoke [--model <id>]`（网关健康 + 模型可达双探针）。
- **优雅收口（drain）**：SIGTERM → 同步 draining，监听保持绑定直到排空——submit 面 503 + `-32010` + `Retry-After: 5`，读面（get / SSE / artifact）照常；running job 排空（60s 超时 → abort 剩余）后拆连接、关 store / 幂等表 / worker 池，进程 exitCode = 143（落定而非信号死）。
- **死单收口**：排队超时 30min → `failed(-32018)`；执行超时 60min → `failed(-32014)`；终态护栏吞迟到结算。
- **仓库准入**：submit 期规模闸 `maxRepoFiles` 20_000 / `maxRepoBytes` 512 MiB（超限 `-32004`，死大仓不进 worker 内存）；limits 面 capabilities 暴露。
- **artifact 保留窗**：succeeded 落定起算缺省 30 天（`--artifact-retention-days` 可配）；窗外 / 缺失 → 404 + `-32017`。
- **SSE 纪律**：per-job 单调 seq + `Last-Event-ID` 断线续传（保留窗覆盖不到发 `reset` 帧重建）、20s 心跳、订阅上限 8/job + 32/租户、慢消费者 1 MiB 写积压断开。
- **人工处置与 KPI**：`reviewagent disposition --run <record.json> --finding <id> --decision accept|reject|false-positive [--note <text>]`（append-only 落库，回溯锚与 RunRecord 对齐）；`--stats` 出人工接受率（accepted / totalDispositioned，空集 null 不冒充 0）。本地数据面：无网络、不解析凭据。
- **评测基线（eval-only，不进生产运行时）**：L2 配对回归活基线 `eval-e-baseline-2026-11-11`（= `reviewagent-v1.0.0`）与历史数据 `NOT_REPRODUCIBLE` 口径见 [`docs/report/token-eval/RUNBOOK.md`](docs/report/token-eval/RUNBOOK.md)（ADR-0016 / ADR-0017）。

## 开发

### 仓库结构

```
packages/{ai,agent,chord,telemetry}/   vendored pi 内核基座（@earendil-works/*，pnpm build:pi 拓扑构建）
packages/review-pi/                    Review Runtime（内核 + CLI + stdio/HTTP 传输 + server；不对外发布）
packages/reviewagent/                  自包含产品包（reviewagent CLI；唯一发布面）
packages/review-llm/                   LLM 接入共享缝（resolver / profile / reviewer）
src/{gate,instrument,presentation}/    根面：模型迁移门 / 仪器契约 / 中文呈现投影
scripts/                               迁移门与 demo 脚本入口（tsc 即编即跑，产物落 .tmp-gen/）
docs/                                  ADR（0001–0017）/ 设计方案（docs/design，#34 回填）/ agent 协作约定
GLOSSARY.md                            领域词汇表（术语唯一权威）
```

### 常用命令

| 命令 | 用途 |
|---|---|
| `pnpm install` | 安装（Node >= 22，pnpm 10.30.3） |
| `pnpm test` / `pnpm test:coverage` | 根面回归 / 覆盖率 |
| `pnpm --filter review-pi test` / `test:e2e` | 内核全套件 / 真跑冒烟 e2e（本地） |
| `pnpm typecheck` | 根包类型检查（消费 review-pi dist d.ts——先 build） |
| `pnpm build:pi` | pi 四包拓扑构建（telemetry → chord → ai → agent） |
| `pnpm --filter review-pi build` | review-pi dist 构建 |
| `pnpm build:reviewagent` | 产品包自包含 bundle + tarball（→ `.artifacts/`） |
| `pnpm migration-gate -- --model <id>` | 模型迁移门（换模型/网关安全前置） |
| `pnpm build:presentation` | 中文呈现引擎构建（改 `src/presentation` 后） |

CI（push / PR，零网络）：pi 四包 + review-llm + review-pi dist 前置构建 → 三面 typecheck → 三面测试。E 全链与协议 v3 契约在 CI 常开真跑；真实 E 产物闭环依赖 gitignored 本机快照（skipIf 守卫）；pack 冒烟与真网关探针走本地按需执行（`pnpm --filter review-pi test:e2e` / `reviewagent smoke`）。

### 入库约定

| 路径 | 入库 | 说明 |
|---|---|---|
| 源码 / 文档 / 测试金样 | ✅ | |
| `.env.local` | ❌ | 凭据（key 绝不回显、绝不入库） |
| `runs/**` / `.cache/` / `.tmp-gen/` | ❌ | 运行产物 / 快照 / 脚本编译产物 |
| `reference_project/` | ❌ | 外部参考仓（本地 clone，见「参考项目」） |

## 研究背景

本产品由 AI4SE 研究项目演化而来（2026-09 ~ 2026-11）。选型结论摘要：

- **上下文策略选型**：五种上下文策略配置（A 零工具 → E 自主拉取 + Context Ledger）在同一模型与冻结判定链上受控对照（VUL4J 单缺陷 MR 基准，30 case × 5 配置 × 3 rep），**E 以 recall 0.5962 冠五配置且 token 处最低档**——上线门质量门主判通过后切流为唯一生产形态（ADR-0011）。
- **内核选型**：Review Runtime 在 pi 内核上从 0 重写（ADR-0009），与 DSH 内核线兄弟仓在同一评测集上做内核无关性对照。
- **配置选择根除**：E-only 生产化（#32 / ADR-0014 / ADR-0015）删除 A–D 研究设施与协议 v2 的 `configId` 选择面。

A–E 矩阵、判定链、Phase 2 数据与复现入口**不在本分支**——完整研究线见 Demo 线 [`demo/config-matrix`]（冻结基线标签 `demo-config-matrix-baseline-2026-11-03`）：Demo README、全量 GLOSSARY 与主数据报告均在彼处，本分支不复制（口径不漂移）。**例外**：`docs/design/` 设计文档双线各持一份（#34 回填，ADR-0014 补记）——本分支持有回填时点的工程参考副本（19 份平移 + 分支策略底稿恢复件）。生产修复与 Demo 的同步规则见 ADR-0014 §7（cherry-pick 单提交通道，不整分支互合）。

## 参考项目（reference_project/，不入库）

协同开发时需要的机制参照源。本地目录已被 gitignore——在新机器上按下表 clone 并 checkout 到锚定 commit 即可复现当时的参照状态：

| 本地目录 | 上游 | 锚定 commit | 参照角色 |
|---|---|---|---|
| `pi` | <https://github.com/earendil-works/pi> | `6671c604`（2026-09-16，v0.85.1+11d） | Pi 内核 vendor 源与定制基座：`packages/{ai,agent,chord,telemetry}` 即出自此锚定（fork 接线与分歧清单见《Pi 内核定制基线方案》） |
| `deepseek-harness` | <https://github.com/deepseek-ai/deepseek-harness> | `5dda764`（2026-09-08，0.1.5-alpha.1） | DSH 线内核机制参照（ADR-0005/0006 的决策依据，已归档）；Phase 2 DSH 对照数据的解读背景 |
| `open-code-review` | <https://github.com/alibaba/open-code-review> | `82af2fb`（2026-09-02） | 同域开源检视 Agent：产品形态与公开评测对齐对象（AACR-Bench 已支持 reviewer 之一） |
| `prime-agent` | <https://github.com/PrimeIntellect-ai/prime-agent> | `c718bf3`（2026-08-31） | Agent harness 设计参照（self-improving RLM harness） |
| `whale-pod` | <https://github.com/Timothyhay/whale-pod> | `d76f522`（2026-08-13） | 轻上下文 + 前缀缓存设计参照：known world + 懒拉取 + 前缀稳定，与本项目 Minimal Sufficient Context / Stable Prefix 命题同源；其实测化 bench 方法论亦为本项目纪律参照 |
| `opencode` | <https://github.com/anomalyco/opencode> | `98e4b53`（2026-11-10） | 开源终端编码 Agent：agent loop / 工具调度 / provider 适配 / server–SDK 多形态接入的机制参照 |

```bash
# 恢复参考项目（在仓库根执行）
git clone https://github.com/earendil-works/pi.git                 reference_project/pi
git clone https://github.com/deepseek-ai/deepseek-harness.git      reference_project/deepseek-harness
git clone https://github.com/alibaba/open-code-review.git          reference_project/open-code-review
git clone https://github.com/PrimeIntellect-ai/prime-agent.git     reference_project/prime-agent
git clone https://github.com/Timothyhay/whale-pod.git              reference_project/whale-pod
git clone https://github.com/anomalyco/opencode.git                reference_project/opencode
cd reference_project/pi && git checkout 6671c604   # 其余同理
```

## 文档地图

| 文档 | 内容 |
|---|---|
| [`GLOSSARY.md`](GLOSSARY.md) | 领域词汇表（活代码词汇唯一权威；研究词条已修剪，全量见 Demo 线） |
| [`docs/adr/`](docs/adr/) | 架构决策记录 0001–0017（POC1 harness / 模型钉扎 / 零构建代码情报 / S 级判据 / DSH 迁移与内核形态 / 对齐门 v2 / 模型可换 / pi 内核从 0 重写 / 检视语言钉英文 / 切流 config E / stdio 长驻 / HTTP server 线 / 分支策略 / **协议 v3** / **评测面隔离** / **Token 优化判据**） |
| [`docs/design/`](docs/design/README.md) | 设计方案 22 份——按架构 / Agent 设计 / 内核 / 接入 / 评测 / 项目策略分类（#34 自 Demo 线回填的工程参考副本 + 分支策略底稿恢复件，ADR-0014 补记） |
| [`docs/agents/`](docs/agents/) | agent 协作约定（issue tracker / triage labels / domain docs） |

## 协作约定

- **Issue 即 spec**：需求与验收标准在 GitHub Issues（`MustacheXb/ReviewAgent-pi`）管理，经 `gh` CLI 读写；约定见 [`docs/agents/issue-tracker.md`](docs/agents/issue-tracker.md)。
- **Triage 标签**：`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`。
- **提交信息**：Conventional Commits（`feat` / `fix` / `refactor` / `docs` / `test` / `chore` / `perf` / `ci`）。
- **零网络纪律**：CI 恒离线；真网关调用（冒烟 / 迁移门 / e2e）走本地按需执行。
