# ReviewAgent-pi

低 Token、高质量代码检视 Agent：用**最小充分上下文**（Minimal Sufficient Context）与**缓存稳定循环**（Cache-Stable Review Loop），以 20~30% 的 Token 成本获得接近全量上下文的检视质量。终点是落地到企业内部代码托管平台的 MR 检视。内核基座：pi 代码仓 fork（ADR-0009）。

本仓是 ReviewAgent 项目的 **pi 内核线**，同时是一个 AI4SE 研究项目：以 VUL4J 单缺陷 MR 为基准，对五种上下文策略配置做受控实验（真实网关、三侧数据、四层判定链），论文主数据与分析报告见 [`docs/report/`](docs/report/)。

> **姊妹仓（DSH 内核线）**：兄弟仓 [`MustacheXb/ReviewAgent`](https://github.com/MustacheXb/ReviewAgent) 承载 DeepSeek Harness（DSH）内核线，其架构结论（Config B 生产形态、Minimal Sufficient Context、缓存稳定循环）由 Phase 2 三侧 450 单元数据支撑——但该结论绑定特定内核。本仓以 pi 内核（`pi-agent-core + pi-ai`）从 0 重写 Review Runtime，在完全相同的评测集与冻结判定链上跑独立对照，回答**「架构有效」还是「内核有效」的内核无关性问题**。
>
> **跨仓 ADR 限定语纪律**：两仓 ADR 各自独立编号（本仓 0001–0009 为 pi 线序列）。引用 DSH 仓的决策必须写全限定语「DSH 线 ADR-XXXX」；裸写「ADR-XXXX」一律指本仓 ADR（双 0009 尤其如此：本仓 0009 = pi 内核从 0 重写，DSH 线 0009 = 大 MR 切分）。共享证据链（POC1→Phase 2）在本仓 `archive/pi-kernel` 存档分支与 DSH 仓双处可考。
>
> **pi 内核基座**：以 [pi](https://github.com/earendil-works/pi) 代码仓为基础的全源码定制（vendor fork，锚定 commit `6671c604` / v0.85.1+11d），vendored `packages/{ai,agent,chord,telemetry}` 四个包。方向拍板（2026-09-18，ADR-0009）：Review Runtime 在 pi fork 上从 0 重写（`packages/review-pi`，仪器冻结平移），最终评测与 DSH 内核数据（`runs/phase2-dsh`，450 单元）按同口径对照；DSH 内核（`packages/review-dsh`）已随之移除，全部评测数据/报告保留。方案见《[Pi 内核从零实现方案](docs/design/Pi 内核从零实现方案.md)》，fork 接线事实见《[Pi 内核定制基线方案](docs/design/Pi 内核定制基线方案.md)》，第三方声明见 [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md)。

## 研究设计一览

**受测配置**（A–E，同一模型同一判定链，只变上下文策略）：

| 配置 | 上下文策略 |
|---|---|
| A | 零工具，纯 MR 上下文 |
| B | A + 确定性预取（Diff → Symbol → Reference → Call Chain 固定管线） |
| C | 全仓注入（+ `review.*` 工具 7 个） |
| D | 自主拉取 + 稳定前缀 |
| E | D + Context Ledger（上下文登记账） |

**判定链四层**：原生真值（逆补丁法）→ 规则粗筛 → LLM-as-judge（异构 glm-5.3 @ 火山网关）→ 人工抽检（calibration）。
**判级**：S/A/B（ADR-0004）；**验收**：指标对齐门 v2——配对符号检验 + 对称带 + 时点 advisory（ADR-0007）。
**Phase 2 主数据**：30 case × 5 配置 × 3 rep = 450 单元 × 三侧（main / 噪声对照 / DSH 附录），结论见《[Phase 2 主数据分析报告](docs/report/Phase 2 主数据分析报告.md)》。

## 仓库结构

```
src/                    评测装置（experiment / judge / metrics / sampling / gate /
                        dataset / reference / instrument …；POC1 运行时模块已随
                        pi 线 P4b 退役，收口说明见 ADR-0009 补记）
packages/{ai,agent,chord,telemetry}/
                        Pi 内核 vendor 基座（@earendil-works/*，`pnpm build:pi` 拓扑构建，
                        见《Pi 内核定制基线方案》）
packages/review-pi/     Review Runtime（pi 内核从 0 重写：六阶段骨架 + 七工具 +
                        审计投影 + 字节纪律门本体，ADR-0009）
packages/reviewagent/   自包含产品包：reviewagent CLI + stdio 长驻（bundle pi 运行时）
packages/review-llm/    LLM 接入共享包（judge 仪器客户端 + 画像/退役清单单源）
scripts/                实验 / 门 / 分析 / 物化脚本入口（tsc 即编即跑，产物落 .tmp-gen/）
data/                   数据集清单与 MR 物化（vul4j / defects4j / msb-java / clean-mr）
runs/                   实验产物（不入库；*/REPORT.md 作为结论文档例外入库）
docs/                   ADR / 设计方案 / 评测方案 / 报告 / 计划书 / agent 协作约定
CONTEXT.md              领域词汇表（术语唯一权威，单一上下文）
reference_project/      外部参考项目（不入库，见下节）
```

## 快速开始

```bash
# 前置：Node >= 22，pnpm 10.30.3（corepack enable 即可）
pnpm install
pnpm test          # 全量回归（73 文件 / 963 项）
pnpm typecheck     # 根包类型检查
```

CI（push / PR）跑 `suites`（root + review-llm 两包 typecheck + 全量测试，零网络；DSH 线的 discipline-gate 作业已随内核移除，pi 线 P2 票以「对照 DSH 审计」形式重建，见 ADR-0009）。**真实网关调用不进 CI**（零网络纪律，#28），只走本地脚本按需执行。

## 常用命令

| 命令 | 用途 |
|---|---|
| `pnpm test` / `pnpm test:e2e` / `pnpm test:coverage` | 回归 / E2E / 覆盖率 |
| `pnpm typecheck` | 根包类型检查 |
| `pnpm build:pi` | Pi 四包拓扑构建（telemetry → chord → ai → agent） |
| `pnpm experiment -- --id <id> --cases-file <file> --configs A,B,C,D,E --reps 3 --judge --judge-model <model>` | 实验运行器（真实网关；产物落 `runs/<id>/`） |
| `pnpm alignment-gate` | 指标对齐门 v2 复算（gate JSON 留痕） |
| `pnpm analyze:phase2` | Phase 2 六面分析一键复算（读 `runs/phase2-*`） |
| `pnpm materialize:vul4j` | VUL4J 数据集物化（case → 本地仓库 + MR） |
| `pnpm reference -- --id <id> --cases-file <file>` | Claude Code 外部参照运行器（单列报告，不进 S/A/B 主判定） |

## npm 本地打包与安装

```bash
# 一条命令：构建 vendored pi + review runtime + 自包含 bundle，输出到 .artifacts/
pnpm build:reviewagent

# 本地 npm 安装 tarball
npm install -g ./.artifacts/reviewagent/reviewagent-0.1.0.tgz

# 用户可见命令统一为 reviewagent
reviewagent --version

# 在“当前打开文件夹”里直接检视（--repo 可省，省略时默认 process.cwd()，
# ADR-0013，#27 已落地）
cd /path/to/opened-repo
reviewagent review --mr <diff-file> --config E

reviewagent rpc --out reviewagent-output [--cwd <dir>]
```

`pnpm build:reviewagent` 会把 vendored pi 运行时内联进 bundle，用户侧 npm 不再解析
`@earendil-works/pi-*`；`@vscode/ripgrep`、`web-tree-sitter`、`tree-sitter-java`
作为普通 npm 依赖随包安装。

## 单次检视执行

单案检视 CLI 由 `packages/reviewagent` 打包为用户命令 `reviewagent`（内核实现仍在 `packages/review-pi`）：
`reviewagent review`，形态对齐原 `review-agent`（解析 → `.env.local` 装载 → 装配 → run → 导出 → 呈现；
stdout 单 JSON 文档；退出码：完成（含诚实截断）0 / 中止 1；被测模型缺省 `deepseek-v4-flash`，
换模型加 `--model <id>`）。DSH 内核 CLI（`packages/review-dsh/bin/review-agent.js`）已随内核移除（ADR-0009）。
届时回归的还有网关冒烟自检（双探针 + 人话诊断，探针走 pi-ai 生产序列化）。

在新 CLI 落地前，仍然有效的口径与注意（对评测复现与日常检视通用）：

- **评测口径三要素**：物化仓（base 态）+ 数据集原生 diff + 数据集原生英文 issue（30 案清单 `data/vul4j/target-cases.json`；物化 `pnpm materialize:vul4j`，仓落 `.cache/datasets/vul4j-repos/`）。issue 改用自编文本会引入口径污染。单次复现可对照 `runs/phase2-dsh/runs/vul4j/<案>/<配置>/rep-*.json` 的 `baseline.findings`——被测模型非确定，落在基线 rep 波动族内即属正常复现。
- **中文 MR 描述是内核已知边界，不是用户义务**：产出被 NON_ENGLISH 门要求纯英文，模型会把 `--issue` 中的中文自然引用进 evidence 导致整条 finding 被拒；正解在内核侧——输出语言配置化见《Config B 生产化方案》（`docs/design/`，§3.2）。
- **内核面向 Java**：角色提示词为 senior Java code reviewer、符号索引基于 tree-sitter-java；检视非 Java 仓可运行但质量不保证。
- **基线态语义**：检视读的上下文以仓内现状为准（CLI 不 apply diff）；评测约定仓停在 diff 的 base 侧。

## stdio 长驻模式（`reviewagent rpc`）

`reviewagent` CLI 的第三形态（ADR-0012，#21–#24）：**stdin 收 JSON-RPC 命令行（LF-only JSONL）、stdout 回 JSON 行、stderr 出诊断**。单进程长驻，可连续提交多个检视 job——面向宿主消费者（评测驱动器 / IDE 扩展 / MCP 网关），与单次执行 CLI（`reviewagent review`）互不替代。

### 逐步命令（开发态体验，真网关 + 测试数据）

前置：仓库根执行（凭据从 `.env.local` 自动装载，见下节）；源码改动后跑 `pnpm build:reviewagent` 重建自包含包。

```bash
# 启动长驻会话（--out 可选，缺省 reviewagent-output；--cwd 可选，
# 只覆盖 repoPath 省略时的缺省值，缺省 process.cwd()）
node packages/reviewagent/bin/reviewagent.js rpc --out reviewagent-output
```

进程停住等 stdin——每行一个 JSON-RPC 命令，回车即发，stdout 即时回响应：

```jsonc
{"jsonrpc":"2.0","id":1,"method":"server.capabilities"}  // 握手：协议版本 / 方法表 / features / limits
{"jsonrpc":"2.0","id":2,"method":"review.submit","params":{"caseId":"VUL4J-1","repoPath":"<绝对路径>","diff":{"kind":"inline","text":"<diff 全文>"},"configId":"B"}}
{"jsonrpc":"2.0","id":3,"method":"review.get","params":{"jobId":"job-...-1"}}  // jobId 从 submit 响应或事件里抄
{"jsonrpc":"2.0","id":4,"method":"review.list"}
{"jsonrpc":"2.0","id":9,"method":"shutdown"}             // 响应先回，drain 等在跑 job 落定后自退
```

当前 v2 参数面（ADR-0013，#27 已落地）：`repoPath` 可省（省略时默认 `--cwd <dir>`，
`--cwd` 缺省 `process.cwd()`——omit to discover, provide to override）+ `diff` 判别联合
`{kind:"inline",text} | {kind:"file",path}`；`protocolVersion` 升 2 即切换信号，不保留
v1 旧扁平 `diff` 字符串形（旧形 → -32602）。路径解析只做 realpath + 目录/文件存在性
校验，不可达 → `-32012 repo_not_found`。

`review.event` 通知与响应同缝流出（job 状态转移 + 六相位进度，seq 单 job 内单调）。submit 的 inline `diff.text` 是全文转义的 JSON 字符串，手敲不现实——从黄金夹具生成后粘贴（也可用 `diff:{kind:"file",path:<diff 文件路径>}` 让服务端读文件）：

```bash
node -e 'const fs=require("fs");const diff=fs.readFileSync("packages/review-pi/testdata/golden/vul4j-1.diff","utf8");console.log(JSON.stringify({jsonrpc:"2.0",id:2,method:"review.submit",params:{caseId:"VUL4J-1",repoPath:process.argv[1],diff:{kind:"inline",text:diff},configId:"B"}}))' "D:\\xubao\\code\\AI4SE\\ReviewAgent-pi\\ReviewAgent-pi\\packages\\review-pi\\testdata\\repos\\sample"
```

落盘与 review CLI 同根不同实验目录：`<out>/reviewagent-rpc/`（`audit/vul4j/<案>/<配置>/rep-1/audit/*.json` + `runs/vul4j/<案>/<配置>/rep-1.json`）。

### 协议速览

| 面 | 契约 |
|---|---|
| 帧 | LF-only 分行，每行恰好一个 JSON 文档；空行忽略；batch 拒绝 -32600 |
| 方法 | `server.capabilities` / `review.submit` / `review.get` / `review.list` / `review.cancel` / `shutdown` |
| 状态机 | `queued → running → succeeded / failed / cancelled`；cancel 对 running 走 `cancelling → cancelled`（abort 零落盘），对终态幂等 |
| 错误码 | -32001 job_not_found / -32002 queue_full / -32004 payload_too_large / -32010 server_draining / -32012 repo_not_found（-32003/-32005/-32011 保留不发射；全表见 ADR-0012 + ADR-0013 收口注） |
| 退出码 | `shutdown` / stdin EOF → 0；SIGINT → 130、SIGTERM → 143、SIGHUP（POSIX）→ 129——信号路径跳过 stdout flush；启动失败 → 1 |

### 使用注意

- **凭据**：启动期单次解析（`REVIEWER_*` > `DEEPSEEK_*` > `.env.local`，按 cwd 解析——与单次 CLI 同约定，从仓库根执行）；key 绝不回显。命令行前缀注入 key 有终端回显风险，走 `.env.local` 更稳。
- **configId**：submit 必填；`B` 是最小成本形态（六相位单轮零工具），生产入口是 `E`（自主拉取 + Context Ledger，ADR-0011，消耗大得多）。
- **仓库路径**：submit 的 `repoPath` 可省（绝对/相对均可），省略时走 `--cwd <dir>` →
  `process.cwd()` 缺省链；相对 `repoPath` 的解析基准恒为子进程 `process.cwd()`。统一
  契约不引入 `repo-id` / `repo-registry` / `repo-root`（ADR-0013）：v1 的 `--repo-root`
  旗标与 allowlist guard（-32003）已随 v2（#27）移除，路径解析只做 realpath + 存在性
  校验，失败 -32012。
- **`--concurrency <n>`**：>1 为实验性（安全前提未验证）。
- **Windows**：优雅退出走 stdin EOF（无信号语义，`Ctrl+Z` 回车；Git Bash `Ctrl+D`）；真 fetch 后的退出纪律是 exitCode + 事件循环自然排干（0xC0000409 竞态，有测试锚定）。
- **宿主编程消费**：`packages/review-pi/src/rpc/client.ts` 的 `ReviewRpcClient`——spawn 真 bin + typed 六方法 + `review.event` 订阅 + stop() 三级升级链（stdin EOF → POSIX 组 SIGTERM → SIGKILL / Windows `taskkill /T /F`）；进程边界消费者，不进包导出面。

## 凭据配置（.env.local，绝不入库）

实验运行器（仓库根执行）自动装载 `.env.local`（gitignored）：已有非空环境变量优先、不被覆盖；装载摘要只报键名与行号，key 值绝不回显。key 缺失即启动报错并给清单。注意 `.env.local` 按调用进程的 cwd 解析（pi 线 CLI 落地后同样约定从仓库根执行）：

```ini
# reviewer（被测模型）——恒需
REVIEWER_API_KEY=...     # 推荐名（#43）
DEEPSEEK_API_KEY=...     # 兼容别名（旧名；与 REVIEWER_API_KEY 同设时新名优先）
REVIEWER_URL=...         # 可选：自定义 OpenAI 兼容网关端点（推荐名；进 plan.json 留痕）
DEEPSEEK_URL=...         # 兼容别名（旧名）

# judge（判定链，--judge 时需要）
JUDGE_API_KEY=...        # 火山网关 glm 走此通道
JUDGE_URL=...            # 可选：自定义 OpenAI 兼容网关端点
OPENAI_API_KEY=...       # 兼容别名（旧名；与 JUDGE_API_KEY 同设时新名优先，#42）
OPENAI_URL=...           # 兼容别名（旧名）
```

被测模型经 `--model <id>` 自由指定（实验 CLI 的 `flash`/`pro` 别名保留）；wire 序列化与指标口径按 provider 画像表分派（`deepseek-*`/`glm-*` 内建，未知模型走保守默认）。judge 模型与被测可能同源时默认拒绝——任一侧自定义接入点设定则降级为 warning 放行（异构性转为实验者责任，#43）。

自定义网关（`REVIEWER_URL` 指向中转/自建端点）的可用性与兼容性由实验者自证：换端点或换模型后先跑冒烟自检。DSH 线的 `review-agent smoke`（对目标端点发 1 次最小补全 + 1 次最小工具调用探针，输出人话诊断与处置建议；通过退出码 0、失败 1；探针请求体走生产画像序列化——冒烟通过即代表该模型在该网关上的 wire 方言与工具调用面可用，#46）已随内核移除，同形态工具随 pi 线 P1/P3 票回归。

## 目录与入库约定

| 路径 | 入库 | 说明 |
|---|---|---|
| 源码 / 文档 / 数据集清单 | ✅ | |
| `runs/**/REPORT.md` | ✅ | 实验结论文档（唯一例外） |
| `.env.local` | ❌ | 凭据 |
| `reference_project/` | ❌ | 外部参考仓（见下节） |
| `runs/**`（除 REPORT.md） | ❌ | 实验记录与数据 |
| `.cache/` | ❌ | 数据集缓存 / 留痕 / 分析产物 |
| `.tmp-gen/` | ❌ | 脚本编译产物 |

**phase2 基线数据就位（P0 基线采纳）**：三侧 runs 数据（`phase2-main` / `phase2-noise` / `phase2-dsh`，各 450 记录）+ t 系 audit 真源（`phase2-dsh-t{1..5}`，P2 字节门对照物）+ `.cache/datasets` 物化仓（合计 ≈1.8G）已按《[Pi 内核从零实现方案](docs/design/Pi 内核从零实现方案.md)》§9 迁入本仓（robocopy，git 零影响——`runs/**` 与 `.cache/` 均 gitignored）。s* 噪声底系列不迁，留 DSH 仓只读参照。新机器按同节命令从 DSH 主工作仓补拷后，`pnpm analyze:phase2` 可一键复算验证。

## 参考项目（reference_project/，不入库）

协同开发时需要的机制参照源。本地目录已被 gitignore——在新机器上按下表 clone 并 checkout 到锚定 commit 即可复现当时的参照状态：

| 本地目录 | 上游 | 锚定 commit | 参照角色 |
|---|---|---|---|
| `pi` | <https://github.com/earendil-works/pi> | `6671c604`（2026-09-16，v0.85.1+11d） | Pi 内核 vendor 源与定制基座：`packages/{ai,agent,chord,telemetry}` 即出自此锚定（fork 接线与分歧清单见《Pi 内核定制基线方案》） |
| `deepseek-harness` | <https://github.com/deepseek-ai/deepseek-harness> | `5dda764`（2026-09-08，0.1.5-alpha.1） | DSH 线内核机制参照（ADR-0005/0006 的决策依据，已归档）；phase2-dsh 对照数据的解读背景 |
| `open-code-review` | <https://github.com/alibaba/open-code-review> | `82af2fb`（2026-09-02） | 同域开源检视 Agent：产品形态与公开评测对齐对象（AACR-Bench 已支持 reviewer 之一） |
| `prime-agent` | <https://github.com/PrimeIntellect-ai/prime-agent> | `c718bf3`（2026-08-31） | Agent harness 设计参照（self-improving RLM harness） |
| `whale-pod` | <https://github.com/Timothyhay/whale-pod> | `d76f522`（2026-08-13） | 轻上下文 + 前缀缓存设计参照：known world + 懒拉取 + 前缀稳定，与本项目 Minimal Sufficient Context / Stable Prefix 命题同源；其实测化 bench 方法论亦为本项目纪律参照 |

```bash
# 恢复参考项目（在仓库根执行）
git clone https://github.com/earendil-works/pi.git                 reference_project/pi
git clone https://github.com/deepseek-ai/deepseek-harness.git      reference_project/deepseek-harness
git clone https://github.com/alibaba/open-code-review.git          reference_project/open-code-review
git clone https://github.com/PrimeIntellect-ai/prime-agent.git     reference_project/prime-agent
git clone https://github.com/Timothyhay/whale-pod.git              reference_project/whale-pod
cd reference_project/pi  && git checkout 6671c604   # 其余同理
```

**DSH 线归档注记**：DSH 内核（`packages/review-dsh`）与 `@deepseek-ai/dsh-sdk-protocol` 依赖已按 ADR-0009 移除；其机制事实记录（《[DSH 内核机制偏差清单](docs/design/DSH 内核机制偏差清单（npm 0.1.2-rc.1 × reference 0.1.5-alpha.1）.md)》）、`runs/phase2-dsh` 评测数据与双门报告保留，作为 pi 线对照实验（DSH↔pi）的解读依据。

## 文档地图

| 文档 | 内容 |
|---|---|
| [`CONTEXT.md`](CONTEXT.md) | 领域词汇表（Minimal Sufficient Context / Zone A–C / Finding 等术语唯一权威） |
| [`docs/adr/`](docs/adr/) | 架构决策记录 0001–0013（POC1 独立 harness / 模型钉扎 / 零构建静态代码情报 / S 级判据 / DSH 迁移姿态 / DSH 内核形态 / 对齐门协议 v2 / 被测模型可换 + 指标按 provider 能力分口径 / 从 0 基于 pi 内核重写 / CLI 中文呈现投影 / 生产入口切流 config E / stdio JSONL 长驻模式 / HTTP server 线统一契约与拓扑 B） |
| [`docs/design/`](docs/design/) | 总体架构设计方案 / Pi 内核从零实现方案 / Pi 内核定制基线方案 / VUL4J 评测方案与数据复制指南 / DSH 偏差清单 |
| [`docs/report/`](docs/report/) | POC1 实现报告 / DSH 迁移实现报告 / DSH 指标对齐门报告（含噪声底）/ Phase 2 主数据分析报告 / Phase 2 pi-S1 五配置对照报告（advisory）/ 兄弟项目调查报告 |
| [`docs/plan/`](docs/plan/) | 项目分阶段实现计划书 |
| [`docs/agents/`](docs/agents/) | agent 协作约定（issue tracker / triage labels / domain docs） |
| [`docs/human-review-sampling-protocol.md`](docs/human-review-sampling-protocol.md) | 人工抽检协议（判定链第四级） |

## 协作约定

- **Issue 即 spec**：需求与验收标准在 GitHub Issues（`MustacheXb/ReviewAgent-pi`）管理，经 `gh` CLI 读写；约定见 [`docs/agents/issue-tracker.md`](docs/agents/issue-tracker.md)。
- **Triage 标签**：`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`。
- **提交信息**：Conventional Commits（`feat` / `fix` / `refactor` / `docs` / `test` / `chore` / `perf` / `ci`）。
- **零网络纪律**：真实网关实验只在本地脚本执行，CI 恒离线（#28）；验收复算产物（gate JSON / 分析输出）留 `.cache/` 或 `runs/`，结论入 `docs/report/`。
