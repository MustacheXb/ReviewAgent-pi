# Config E 生产化方案——选型依据、生产基线与演进路线

> **文档状态**：2026-11-12 更新。本文替代 2026-09-17 形成的旧 Config B 生产化结论，内容以当前生产主线 `main`（由 `production/e-only` 收口）为准。
>
> **文件名说明**：文件名已同步更新为 `Config E 生产化方案——选型依据、生产基线与演进路线.md`；所有仓内引用已改为新路径。
>
> **一句话结论**：E 是 pi 内核线上唯一生产配置——`Diff-first + 七工具按需检索 + Context Ledger + 稳定前缀 + 有界循环 + Evidence Gate`。它之所以胜出，不是因为工具调用越多越好，而是因为在同一模型、同一冻结判定链下，E 取得了五配置最高的 judge recall，同时处于最低 token 档，并保留了按证据扩展上下文的能力。后续工作的重点不是重新选配置，而是把 E 的质量、成本、缓存和运行边界做成可持续运营的生产系统。

---

## 1. 为什么选择 Config E

### 1.1 选型不是从 B 平滑升级，而是 pi 内核线上的质量门重判

旧文档中的 B 结论来自早期 A–E 矩阵和 DSH 侧数据。pi 内核从零重写后，运行时、判定链、上下文时序和审计口径都发生了变化，不能把旧 B 的 precision/F1 数字直接迁移为 pi 线的生产结论。

当前决策链如下：

| 时间 | 决策 / 事件 | 结果 |
|---|---|---|
| 2026-09-17 | 早期 Config B 生产化方案 | 研究阶段推荐零工具 + 确定性预取 |
| 2026-10-20 | ADR-0011 上线门重判 | 质量门主判通过，生产入口切流 Config E |
| 2026-11-03 | ADR-0014 / ADR-0015 | 生产线与 Demo 线分离；协议 v3 根除配置选择 |
| 2026-11-11 | `eval-e-baseline-2026-11-11` | 冻结 E-only 生产基线，与 `reviewagent-v1.0.0` 同一提交 |

因此，B 是历史研究方案；E 是当前生产方案。这个切换由质量门和契约代数共同固定，不是临时性能调优。

### 1.2 五配置对照中的 E

| 配置 | 上下文获取方式 | 主要优点 | 主要问题 | 当前定位 |
|---|---|---|---|---|
| **A** | 零工具、仅 MR 上下文 | 成本最低、行为最简单 | 无法按证据补上下文，覆盖面依赖初始输入 | 历史对照 |
| **B** | 零工具 + 固定管线预取 | 成本可预算、请求时序确定 | 预取深度不随 MR 风险与证据需求变化 | 历史方案 |
| **C** | 全仓注入 + 工具 | 信息面大、稳定前缀强 | 上下文昂贵，易把“缓存后的总 token”误当效率 | 已退出生产，仅评测侧参考 |
| **D** | 工具自主检索 | 可按需扩展上下文 | 缺少 E 的账本与生产化收口 | 历史对照 |
| **E** | 七工具按需检索 + Context Ledger | 质量证据最好、上下文按需、可审计、可预算 | 仍有工具尝试、空知识工具、截断与缓存归因问题待优化 | **唯一生产配置** |

### 1.3 选 E 的核心证据

ADR-0011 在 pi 线锚活条件下给出以下生产选型证据：

| 指标 | E 的结果 | 判读 |
|---|---:|---|
| judge recall | **0.5962** | 五配置最高，质量门主判通过 |
| `totalTokens` | **125.2k** | 处于最低 token 档 |
| 零 finding 率 | **5.3%** | 明显低于 DSH 侧 35.3% |
| billed 总账 | **21.32M** | 四侧最低 |

这组数据回答的是“哪个配置更适合作为当前生产入口”，不是“E 已经在所有维度完成优化”。E 当前 judge 判级为 B，且 recall 对门线的余量很窄，所以生产运营必须以人工接受率和持续回归为主要质量反馈面，不能把一次上线门通过当作永久质量保证。

### 1.4 为什么不是回到 Config B

1. **B 的质量优势没有在 pi 线当前判定链上复现为生产选型优势。** B 的旧数字主要来自早期矩阵和不同锚活条件，不能替代 E 在 pi 线上的同类对照。
2. **生产 MR 的证据需求不均匀。** 固定预取对低风险 MR 可能过度，对高风险 MR 又可能不足；E 可以根据 diff、符号、引用和调用链的实际线索决定下一步读取什么。
3. **E 的成本问题可以用预算治理解决。** 请求数、工具尝试、输出和结果截断都可以成为显式预算；为了控制成本退回零工具固定预取，会同时牺牲上下文适配能力。
4. **E 的机制可以观测。** 七工具调用、Ledger 命中、截断原因、阶段请求数、usage 和 cache break 都进入审计，后续优化可以归因，而不需要重新猜配置。

### 1.5 选型原则

```text
质量优先于 token
证据优先于猜测
按需上下文优先于全仓注入
有界循环优先于无限工具调用
稳定前缀优先于动态重排
只读工具优先于执行型工具
可复跑基线优先于历史数字拼图
```

这七条原则共同决定了 E 的形态：以 diff 为起点，让模型只拉取支撑 Finding 所需的上下文，并用 Evidence Gate 阻止无证据结论进入最终结果。

---

## 2. Config E 的优势

### 2.1 按需上下文，不做一次性上下文赌博

E 的初始上下文只有系统提示、caseId、issue description 和 unified diff。仓库上下文由七工具在需要时读取：

```text
review.get_diff
review.get_symbol
review.get_file
review.find_references
review.get_call_chain
review.search_rule
review.search_history
```

这使 E 可以围绕真实证据逐步展开，而不是在首请求中一次性决定 Zone B、符号、引用和调用链的深度。对生产环境中的多类型 MR，这比固定预取更接近实际的检视过程。

### 2.2 质量与证据链绑定

候选 Finding 必须经过以下拦截链：

```text
Schema
→ English-only
→ Evidence present
→ Verification verdict
→ Duplicate ID
```

只有通过拦截链的 Finding 才进入最终结果。该机制直接服务于 `No Evidence, No Finding`，使 E 的质量不是“模型自由发挥”，而是可审计的候选筛选结果。

### 2.3 成本可以按机制解释

E 同时具备三类成本控制面：

| 控制面 | 当前机制 | 生产意义 |
|---|---|---|
| 循环上界 | `MAX_ROUNDS = 5` | 防止阶段无限重复 |
| 工具执行上界 | `MAX_TOOL_CALLS = 6` | 防止单 run 无限读取 |
| 工具结果预算 | 默认 8,000 字符 | 控制单次上下文注入规模 |
| 稳定前缀 | Zone A + 固定工具 schema + append-only | 提升 provider 前缀缓存复用 |
| 缓存观测 | `classifyCacheBreaks()` + wire audit | 把前缀分歧与请求成本联系起来 |

注意：当前 `MAX_TOOL_CALLS` 限制的是成功执行计数，模型仍可能发起超出预算的工具尝试。工具尝试硬上界属于后续 P0 演进项，不能把“已执行 6 次”误写成“尝试也不会超过 6 次”。

### 2.4 Context Ledger 提供去重与审计基础

E 的 Context Ledger 记录 run 内已读取的工具上下文。同一规范化请求再次出现时，工具返回：

```text
Already loaded: ctx#001 (review.get_file src/.../Foo.java:100-180)
```

它的价值不只是减少重复读取，还包括：

- 让模型知道某段上下文已经进入对话；
- 把工具调用与上下文引用关联起来；
- 为后续身份键、送达范围和完整性字段扩展留下稳定契约；
- 把 Ledger 快照写入审计，支持后续复算。

当前 Ledger 仍以 `kind + description` 为主要命中键，历史矩阵中的 dedup 收益也为 0；这证明它需要升级，不证明它应被删除。

### 2.5 协议简单，配置选择不可误用

协议 v3 起：

- `capabilities.protocolVersion = 3`；
- `review.submit` 不再接受 `configId`；
- 服务端派生 `CONFIG_E = "E"`；
- 请求携带 `configId`，即使值是 `"E"`，也返回 `-32019 CONFIG_ID_REJECTED`；
- CLI 不再提供 `--config` 旗标；
- RunRecord / disposition 的新记录恒输出 `configId: "E"`，历史 A–D 记录只读兼容。

这使“选错配置”在类型面、协议面和部署面同时消失。生产调用方不需要理解 A–E 矩阵，也不可能通过参数把服务端切到已验证范围外的形态。

### 2.6 三种调用形态共用同一内核

E 不只服务单一 CLI 场景，而是由同一 Review Runtime 支撑：

| 形态 | 用途 | 特点 |
|---|---|---|
| CLI `reviewagent review` | 单次检视、开发自测、流水线调用 | 单 JSON 输出，退出码稳定 |
| stdio `reviewagent rpc` | 长驻宿主集成 | JSONL、请求复用、进程内执行 |
| HTTP `reviewagent server` | 平台接入、异步任务 | Bearer 鉴权、幂等、SSE、artifact 下载、worker 池 |

三形态共享请求模型、校验器、E 配置派生和审计口径，避免“命令行一套行为、服务端另一套行为”的漂移。

---

## 3. Config E 生产方案

### 3.1 生产运行形态

```mermaid
flowchart LR
  R["ReviewRequest<br/>caseId + repoPath + diff"] --> P["协议 v3 校验<br/>无 configId"]
  P --> E["服务端派生 CONFIG_E"]
  E --> Z["Zone A 稳定系统提示"]
  Z --> U["初始 MR 用户消息<br/>issue + unified diff"]
  U --> L["pi Agent 六阶段循环"]
  L --> T["七工具按需读取<br/>只读 RepoContext"]
  T --> G["Candidate / Evidence Gate"]
  G --> O["Findings + Usage"]
  O --> A["RunRecord + 审计"]
  A --> K["人工处置 / KPI"]
```

生产运行时不包含：

- A–D 可执行配置；
- 固定 Zone B 预取管线；
- 全仓 Java 源码注入；
- 配置选择参数；
- 写工具、执行型 REPL 或自动修改仓库的路径。

### 3.2 运行参数与行为契约

| 维度 | 生产契约 |
|---|---|
| 配置 | `CONFIG_E`，服务端与 CLI 单源派生 |
| 初始上下文 | caseId、issue description、unified diff |
| 仓库访问 | 七工具按需懒加载，全部只读 |
| 阶段 | Change Understanding → Risk Classification → Context Decision → Context Retrieval → Deep Reasoning → Evidence Verification |
| 循环上界 | `MAX_ROUNDS = 5` |
| 工具执行上界 | `MAX_TOOL_CALLS = 6`，跨轮累计 |
| 单工具结果预算 | 8,000 字符，按行边界保留前缀并写截断提示 |
| Context Ledger | 启用以描述键去重，快照进入审计 |
| 输出语言 | Finding 恒英文；中文由核外呈现投影生成 |
| MR 边界 | 验证域 ≤10 文件、diff ≤2,000 变更行；超界照常执行并写 `domainWarning` |

### 3.3 上下文与缓存策略

E 的上下文时序遵守 append-only：

```text
[Zone A 稳定系统提示]
→ [初始 MR 用户消息]
→ [Phase 1]
→ [assistant / tool 往返]
→ [Phase 2 ... Phase 6]
→ [下一轮 phase-1 指令或终止]
```

生产纪律：

1. 系统提示和工具 schema 在一次 harness 版本内字节稳定；
2. 初始 MR 消息之后只追加，不重排、不动态改写历史；
3. 任何截断、上下文预算耗尽或缓存前缀分歧都必须留痕；
4. `cacheHitRate` 只作解释变量，不能单独证明成本优化；
5. 缓存结论必须带 provider、网关、模型部署版本、时间窗和计量字段族。

### 3.4 协议与接口

协议 v3 是生产接入的唯一代数：

| 能力 | 生产口径 |
|---|---|
| `capabilities.protocolVersion` | 恒为 3 |
| `review.submit` | 接收 `caseId` / `repoPath` / `diff`，不收 `configId` |
| 配置选择 | 无；携带即 `-32019` |
| 客户端版本 | typed client 对协议版本硬断言 |
| HTTP 提交 | 返回 queued job，执行与查询解耦 |
| job 查询 / 取消 | 支持幂等查询与协作取消 |
| 事件流 | SSE，支持 `Last-Event-ID` 断线续传 |
| artifact | audit / record 通过逻辑引用下载，分别授权 |

### 3.5 部署形态

生产产品包为 `reviewagent`，Node 要求 `>=22`，vendored pi 版本固定为 `0.85.1`。推荐部署形态：

```text
reviewagent server
  ├── HTTP JSON-RPC 接入面
  ├── Bearer 鉴权 + scope 校验
  ├── 幂等键 / ReviewJobStore
  ├── worker_threads 池（缺省生产执行器）
  ├── SSE 事件流
  ├── artifact 下载与保留窗口
  └── drain / restart / recovery
```

运行配置只通过环境变量和部署参数注入，不写入仓库：

- `REVIEWER_API_KEY`：模型网关密钥；
- `REVIEWER_URL`：企业网关接入点；
- `--concurrency`：worker 池并发；
- `--store` / `--artifact-retention-days`：任务持久化与产物保留；
- 呈现引擎通过 `REVIEW_PI_PRESENTATION_ENGINE` 在核外注入。

模型缺省为 `deepseek-v4-flash`。允许显式传 `modelId`，但换模型不自动继承原质量结论，必须走迁移门。

### 3.6 质量、成本与运行观测

生产观测分三层：

| 层 | 观测内容 | 用途 |
|---|---|---|
| 单 run | `RunRecord`、wire audit、phaseLog、toolCallLog、ledger、usage、cacheBreaks | 定位一次检视为什么慢、贵或漏 |
| 生产运营 | 人工处置 accept / reject / false-positive / defer、接受率、耗时、失败率 | 判断真实 MR 流中的可用性 |
| 评测面 | L1 质量门、L2 配对回归、L3 定位报告 | 判断优化是否真的有效 |

L1 / L2 / L3 的职责必须分开：

- **L1 质量门**：judge Recall / Precision 非劣、零 finding 率、阴性对照 FP、coverage；
- **L2 成本门**：`CARC` 主判，`uncachedInput`、`output`、`attemptedToolCalls`、`requests` 分解，同时要求可复现；
- **L3 定位报告**：E + `C_ref` + Claude Code 三列，面向发布和对外宣称，不作日常合并门。

所有 token 相关改动都相对活基线 `eval-e-baseline-2026-11-11` 做配对回归。历史 `runs/phase2-pi` 只作证据，不冒充当前基线。

### 3.7 上线与回滚

一次 E 运行时变更的生产流程：

1. 从 `main` 拉出 `codex/<topic>`；
2. 在不改变协议代数的前提下完成代码和测试；
3. 运行 `pnpm typecheck`、`review-pi` 测试、根测试和三形态 pack 冒烟；
4. 运行 E 全链测试，确认协议 v3、七工具、Ledger、审计与 RunRecord 契约；
5. 若改动涉及 token、上下文、工具或提示词，执行 L1 + L2；
6. 若改动涉及模型或 provider，执行迁移门，不套用 L2 结论；
7. 冻结候选提交，灰度部署，观察失败率、接受率、CARC 和缓存漂移；
8. 质量或成本门失败时回滚到上一生产 tag；协议破坏性变化按新代数处理。

当前可回滚基线为 `reviewagent-v1.0.0` / `eval-e-baseline-2026-11-11`。生产回滚不恢复配置选择，也不把 A–D 带回 `main`。

### 3.8 当前必须补齐的生产缺口

E 已可生产运行，但以下问题仍是生产化债务：

| 缺口 | 当前事实 | 风险 | 演进动作 |
|---|---|---|---|
| 工具尝试未硬封顶 | `MAX_TOOL_CALLS=6` 只计执行，尝试均值可高于执行数 | 预算耗尽后仍产生请求和 token | 增加 `MAX_TOOL_ATTEMPTS` 与超限终止原因 |
| 空知识工具仍可调用 | `search_rule` / `search_history` 在无语料时仍暴露 | 无效工具调用占用预算 | 引入 `core-5` / `extended-7` 动态 profile |
| Ledger 描述键不足 | 当前 dedup 收益为 0 | 无法证明去重有效，截断后可能误判已加载 | 增加身份键、送达范围、`complete`、命中计数 |
| 截断仅保留前缀 | 文件与检索结果统一 head-only | 可能丢失排序在后的关键证据 | 按工具实现 ranked-head、行区间续读和 next-call 提示 |
| 缓存不可解释 | 缺 provider 合同、块对齐、预热和路由留痕 | 无法区分冷缓存、服务端未命中与代码变化 | 建立 `CacheContract` 和网关探针 |
| 评测统计功效有限 | 单数据集、单模型、30 案 | 小改动也可能造成 case 间波动 | 扩充 holdout，按 case 配对，持续校准阈值 |

这些缺口是**后续生产优化项**，不构成重启 A–E 选型的理由。

---

## 4. 后续演进思路

### 4.1 演进总原则

1. **配置选择保持根除。** 任何新机制都作为 E 的内部能力或 eval-only candidate，不恢复生产 `configId`。
2. **先观测，再优化。** 没有四行成本报告、请求/工具计数和缓存合同，不做以 token 为目标的机制替换。
3. **质量门不可豁免。** token 优化必须通过 L1；成本收益不能抵消质量回退。
4. **小步消融。** 工具预算、Ledger、截断、动态 profile 分开验证，不把多个机制捆成一次大改。
5. **大 MR 能力单独立项。** compaction、repo map、分片、语义去重和子 agent 只在边界证据明确时进入生产。

### 4.2 P0：先把账算清，把边界收紧

| 事项 | 目标 | 验收 |
|---|---|---|
| Token 分析器 | 从 RunRecord / audit 单命令复算 cached、uncached、output、CARC、冷热口径 | 输出确定、零网络、结果可重复 |
| 四行成本报告 | 区分 cached / uncached / output / CARC | 不再用 `totalTokens` 单独下结论 |
| 请求 / 尝试 / 输出预算 | 给 `MAX_REQUESTS`、`MAX_TOOL_ATTEMPTS`、`MAX_OUTPUT_TOKENS` 明确上界 | 超限进入显式终止路径，不继续发请求 |
| 知识工具 profile | 空语料时只暴露 core-5，有语料时暴露 extended-7 | 两套 Zone A 字节和工具 schema 各自冻结 |
| Ledger v2 | 身份键、requested/delivered range、content hash、complete、hitCount | 重复读取下降，截断读取不冒充完整读取 |
| 截断 v2 | 文件续读、引用 ranked-head、调用链 hop-aware | 截断有 shown/total/budget，不增加盲重读 |
| CacheContract | provider、字段族、块大小、预热、路由亲和、价格和时窗 | 命中率可解释，缺失字段记 N/A |

### 4.3 P1：把生产反馈变成优化输入

1. **人工处置闭环**：持续写入 accept / reject / false-positive / defer，按 Risk Class、目录、模型和 harness 版本切片。
2. **知识源接入**：规则库和历史缺陷库有真实语料后，用动态 profile 接入，不空跑搜索工具。
3. **离线前缀预测**：把稳定前缀、工具 schema 和消息追加模式映射为可复用前缀预测，并与线上 cacheRead 对账。
4. **Artifact 引用**：大工具结果以 `artifact://` 引用替代反复注入，同时设计保留、权限和审计。
5. **首字节前薄重试**：只对连接失败和首包失败做可归账重试，不重做已完成模型请求。
6. **Reasoning echo 消融**：先观测 wire 形态，再比较 never / tool / always，不能默认某档更便宜。

### 4.4 P2：大 MR 与复杂仓库

以下能力不进入当前默认路径，只在大 MR 立项并通过质量门后启用：

- **MR 分片**：按文件组或语义边界切分，合并 Finding 后去重；
- **Compaction**：大历史触发结构化摘要，摘要成本计入 CARC；
- **Repo map**：按 token 预算生成稳定仓库摘要，排除 vendored / generated；
- **子 agent**：按文件组或语言分派，必须记录 ownUsage、childUsage 和整树成本；
- **Cache-aware 路由**：只产证据和推荐，不自动把生产流量切到未验证网关。

### 4.5 关键演进判定

| 触发条件 | 必须动作 |
|---|---|
| 模型或 provider 变化 | 跑迁移门 + L3，不沿用 E 原结论 |
| 提示词、工具 schema、上下文组装变化 | 重建 Zone A golden bytes，重做空对照校准 |
| token 相关运行时改动 | 相对冻结 E 基线跑 L1 + L2 |
| 生产接受率连续下降 | 暂停放量，按 Risk Class / 目录 / 模型切片定位 |
| cacheHit 异常下降 | 先查 provider 时段、路由和前缀变化，不直接归因内核 |
| 大 MR 超界比例上升 | 评估分片或 compaction，不通过扩大全仓注入解决 |
| 工具尝试持续超预算 | 优先修预算与 profile，不简单提高 `MAX_TOOL_CALLS` |

### 4.6 目标指标

生产 E 的目标不是“永远最便宜”，而是同时满足以下约束：

```text
Recall / Precision 不低于冻结 E 基线的允许噪声带
CARC 持续下降，且 uncached / output / attempts 可归因
cacheHitRate 提升可解释，不靠扩大廉价缓存前缀制造假优化
attemptedToolCalls / requests / outputTokens 均有硬上界
人工接受率随时间稳定或上升
任何大 MR 扩展都不降低小 MR 的既有质量与延迟
```

---

## 5. 与既有决策的关系

| 决策 / 文档 | 关系 |
|---|---|
| ADR-0011 | 质量门主判通过，生产入口切流 Config E |
| ADR-0014 | 生产 `main` 与 Demo 线分离，E-only 收口 |
| ADR-0015 | 协议 v3，配置选择根除，`configId` 内化为 `"E"` |
| ADR-0016 | 评测面与生产运行面隔离 |
| ADR-0017 | L1 / L2 / L3 三层判据，CARC 为 L2 主成本指标 |
| 《ReviewAgent Token 优化方案》 | E 的 token 优化总体设计；本文负责生产方案与演进边界 |
| 《ReviewAgent Token 优化评测基准方案》 | 定义如何评判优化，不重新开放配置选择 |
| `eval-e-baseline-2026-11-11` | 当前唯一活基线，与 `reviewagent-v1.0.0` 同一提交 |

---

## 6. 结论

Config E 已经是当前生产方案，且其选择有完整的质量门、协议和基线证据：

- 它在 pi 线质量门中取得五配置最高 judge recall；
- 它处于最低 token 档，同时保留了按证据扩展上下文的能力；
- 它通过七工具、Context Ledger、稳定前缀和有界循环形成了可观测的生产运行时；
- 协议 v3 已把配置选择从生产输入面彻底移除；
- 当前任务不是重新比较 A–E，而是把 E 的剩余成本、缓存、工具尝试和大 MR 边界持续收紧。

后续路线应坚持“质量优先、机制可归因、改动可回滚”：先用 P0 把账算清并把预算闭合，再用 P1 接入生产反馈和知识源，最后在明确的大 MR 证据下推进 compaction、分片和子 agent。任何时候都不以恢复配置选择或全仓注入作为优化捷径。
