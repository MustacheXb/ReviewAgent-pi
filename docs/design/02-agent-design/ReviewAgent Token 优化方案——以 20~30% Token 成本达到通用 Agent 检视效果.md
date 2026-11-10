# ReviewAgent Token 优化主线方案（E-only）——以 20~30% Token 成本为目标

> **文档状态**：2026-11-10 重写。主线工程方案，适用分支 `main` / `production/e-only`。
>
> **定位说明**：本文描述当前生产主线唯一的 Config E：pi 内核、七工具自主拉取、Context Ledger、六阶段检视循环与稳定前缀。A–E 配置矩阵、判定链实现、Phase 2 复现 runner 和原始报告属于 Demo 线 `demo/config-matrix`（冻结标签 `demo-config-matrix-baseline-2026-11-03`），不在本主线。
>
> **结论先说**：20~30% 是本文的成本目标，不是当前 E 已经达成的结果。当前本地 pi 矩阵中，E 的 `totalTokens` 为 C 的约 34.6%，`CARC` 为 C 的约 87.5%，缓存命中率为 60.6%。当前 E 的质量方向成立，但成本目标仍有差距，且“相对通用 Agent 20~30%”尚无同模型通用 Agent 对照可直接证明。
>
> 术语以根目录 `GLOSSARY.md` 与主线 ADR（尤其是 ADR-0004、ADR-0009、ADR-0011、ADR-0014、ADR-0015）为准。引用 Demo 线决策时使用“Demo 线 ADR-XXXX”全限定语。

---

## 0. 文档边界与证据等级

本文把事实分成四类，避免把历史实验、当前实现和后续目标混写：

| 标记 | 含义 | 本文处理方式 |
|---|---|---|
| **主线已实现** | 当前 `main` 代码可验证 | 给出实现锚点与当前行为 |
| **当前证据有限** | 有样本或本地运行，但主线不能直接复现 | 给数字并注明数据来源和限制 |
| **目标/候选机制** | 为达到 20~30% 成本目标而需要验证 | 只写验收条件，不写成已实现 |
| **Demo/历史** | 属于 A–E 研究矩阵或 DSH 对照 | 只作背景，不冒充当前主线 |

当前主线代码入口：

- 运行组装：`packages/review-pi/src/run/review-run.ts`
- 六阶段循环：`packages/review-pi/src/loop/agent-review-loop.ts`
- 固定阶段与常量：`packages/review-pi/src/loop/phases.ts`、`packages/review-pi/src/loop/constants.ts`
- Zone A 提示词：`packages/review-pi/src/zonea/system-prompt.ts`
- 七工具与执行面：`packages/review-pi/src/tools/registry.ts`、`packages/review-pi/src/tools/toolkit.ts`
- 工具结果预算与账本：`packages/review-pi/src/tools/result-budget.ts`、`packages/review-pi/src/tools/ledger.ts`
- 缓存分歧观测：`packages/review-pi/src/loop/cache-break.ts`
- usage 映射：`packages/review-pi/src/provider/usage-map.ts`
- 审计与记录：`packages/review-pi/src/audit/audit-writer.ts`、`packages/review-pi/src/experiment/run-record.ts`

历史设计引用 `src/loop/*`、`src/zoneb/*`、`src/metrics/*`、`src/reference/*`、`packages/review-dsh/*` 时，必须明确写“Demo 线历史锚点”或“DSH 兄弟仓历史锚点”，不能标成当前主线实现。

---

## 1. 问题定义

通用 Coding Agent 围绕完整开发任务设计，检视只是其中一个使用场景。其 Token 成本通常由四个乘性因素放大：

| 成本因子 | 通用 Agent 的典型行为 | 对 ReviewAgent 的启示 |
|---|---|---|
| 上下文基数 | 自由探索、读取整文件、检索整个仓库 | 检视只需要 Diff 加少量证据上下文 |
| 轮数放大器 | 每轮重发历史消息，轮数由模型自行决定 | 需要显式阶段骨架和轮次上界 |
| 计价因子 | 动态改写前缀会让缓存频繁失效 | 稳定前缀与 append-only 应成为纪律 |
| 输出与探索浪费 | 自由推理、无效工具路径、重复读取 | 需要结构化回复、工具预算和去重 |

ReviewAgent 的目标不是让模型“看得更少”，而是让每单位 Token 获得更多可验证的检视证据：

```text
目标效率 = 质量（Recall / Precision）
         / 成本（总 Token 或真实计费成本）
```

因此成本优化必须同时满足：

1. 不通过少报降低 Recall；
2. 不通过滥报降低 Precision；
3. 不把缓存 token 当作已消失的名义 token；
4. 不把本地样本或历史 B 配置的结论套到当前 E。

---

## 2. 成本口径与 20~30% 目标

### 2.1 Token 口径

当前主线接收 pi-ai usage，并映射为审计口径：

```text
uncachedInputTokens = usage.inputTokens
cachedInputTokens   = usage.cacheReadTokens
cacheWriteTokens    = usage.cacheWriteTokens（DeepSeek 通常为 0）
totalInputTokens    = uncachedInputTokens + cachedInputTokens + cacheWriteTokens
totalTokens         = totalInputTokens + outputTokens
cacheHitRate        = cachedInputTokens / totalInputTokens
```

实现见 `packages/review-pi/src/provider/usage-map.ts` 与 `src/instrument/contracts/llm-client.ts`。

必须同时报告以下指标，禁止只报一个“Token”：

- `totalTokens`：含缓存命中的总输入加输出；
- `uncachedInputTokens`：真正未命中输入的 token；
- `cachedInputTokens`：服务端报告命中的输入 token；
- `outputTokens`：模型输出，包含 reasoning token 时按 provider 口径处理；
- `cacheHitRate`：未知应记 N/A，不能冒充 0；
- `CARC`：缓存调整后的成本指标，必须另列；
- 工具调用次数、尝试次数、轮数和请求数。

### 2.2 20~30% 的主口径

本文沿用 ADR-0004 的 S 级 Token 主口径：

```text
target.totalTokens <= anchor(C).totalTokens × 30%
```

这里的 C 是历史实验矩阵中的效果锚，不是通用 Agent。通用 Agent 只能作为独立外部基线，且必须同模型、同数据集、同真值、同判定协议。

ADR-0004 的 S 级还要求：

```text
Recall >= C × 90%
Precision >= C × 100%
Token <= C × 30%
Cache Hit >= 85%
```

`CARC` 不在 ADR-0004 的档位判据内，但必须作为计费成本解释变量单独报告。只达到名义 `totalTokens` 而 `CARC` 很高，不能称为“真实成本优化”。

### 2.3 当前证据

本地 `runs/phase2-pi` 是用 pi 内核产出的 A–E 矩阵数据。该数据可辅助判断当前形态，但复现 runner 与指标链不在主线，因此属于“当前证据有限”。

| 指标 | E | C 锚 | E/C |
|---|---:|---:|---:|
| `totalTokens` | 129,516.9 | 373,900.4 | **34.6%** |
| `CARC` | 57,278 | 65,420 | **87.5%** |
| `cacheHitRate` | 60.6% | 85.6% | 不适用 |
| rule line Recall | 22.0% | 24.7% | 89.0% |
| rule line Precision | 22.3% | 30.1% | 74.0% |
| judge Recall | 59.6% | 53.9% | 110.6% |
| 当前判级 | B | BELOW_B | 不适用 |

结论：

1. 当前 E 的 judge Recall 高于 C，质量方向成立。
2. E 的 `totalTokens` 为 C 的 34.6%，尚未达到严格的 30% 上限。
3. E 的 `CARC` 为 C 的 87.5%，按计费成本解释远未达到 20~30%。
4. E 的缓存命中率 60.6%，未达到 S 级 85% 门槛。
5. 历史 B 配置约 15.6% 或旧 Phase 2 main 的 7.1% 不能替代当前生产 E 的证据。

数据来源：本地 `runs/phase2-pi/dashboard.md`（gitignored，2026-09-23 至 2026-09-25）。发布或论文引用前必须把数据来源、提交锚点、provider、时间窗和复算脚本固化到可追踪产物。

---

## 3. 当前 E-only 主链

当前主线的实际执行链：

```text
ReviewRequest
  → 服务端派生 configId = "E"
  → Zone A system prompt
  → 初始 MR user message（caseId + issueDescription + unified diff）
  → pi Agent + 七工具
  → 六阶段循环
  → Candidate Gate / Evidence Gate
  → RunRecord + 全量 wire 审计
```

关键事实：

- 配置不由调用方选择。v3 协议没有 `configId`，内核单源派生 `"E"`。
- 初始上下文只有一条 MR user 消息，不在循环前注入 Zone B、预取层或全仓内容。
- 七个 `review.*` 工具从首轮起全部可见，模型按需调用。
- RepoContext 在首次仓库工具调用时懒加载，模型不调用仓库工具时不会扫描仓库。
- 所有请求消息保持 append-only，当前没有上下文改写、压缩或历史重排路径。
- Context Ledger 对相同规范化工具请求返回 `Already loaded: ctx#NNN` 引用。

实现锚点：

- `packages/review-pi/src/run/review-run.ts`：E 派生、初始 MR 消息、toolkit 组装。
- `packages/review-pi/src/loop/agent-review-loop.ts`：pi Agent、七工具桥接、阶段推进。
- `packages/review-pi/src/tools/toolkit.ts`：RepoContext 懒加载与工具执行。

---

## 4. Context 优化：当前是 Diff-first + Lazy Pull

### 4.1 已实现

当前 E 不是 B 配置的“确定性预取”，而是：

```text
初始必加载：Diff
按需拉取：Symbol / File / References / Call Chain / Rule / History
```

七个工具：

```text
review.get_diff
review.get_symbol
review.get_file
review.find_references
review.get_call_chain
review.search_rule
review.search_history
```

工具注册表固定名称、顺序和 schema，目的是让 Zone A 工具面稳定。工具执行只读仓库快照，不编译、不修改目标仓库。

### 4.2 已实现的预算

- 单次工具结果默认上限 8,000 字符。
- 截断只发生在行边界，并追加确定性提示行。
- 截断结果进入 `toolCallLog`，不静默丢弃。
- 文件读取支持行区间，模型可缩小读取范围。

### 4.3 当前限制

1. **没有按 Risk Class 自动加载 C0–C3。** 阶段 2 的 `riskClass` 只作为模型文本输出，不被运行时解析成上下文策略。
2. **没有循环前 Zone B / Symbol / Reference / Call Chain 固定预取。** `zoneb/*` 当前是为工具服务的按需静态解析层。
3. **没有全仓注入对照组。** 配置 C 只存在于 Demo 研究线。
4. **`review.search_rule` 与 `review.search_history` 在生产入口没有知识语料。** 两者默认返回空语料，却仍占用工具 schema 和调用预算。
5. **重复读取去重收益可能很低。** 当前账本只对完全相同的规范化请求命中，不同行区间不会合并。

因此，本文不得把“四级上下文预算”“确定性预取”或“Risk Class 自动加载”写成当前 E 主链。它们若要进入主线，必须作为候选机制重新立项并单独验证。

---

## 5. Loop 优化：六阶段骨架与有界工具面

### 5.1 已实现

每个检视 run 由六阶段组成：

```text
Change Understanding
→ Risk Classification
→ Context Decision
→ Context Retrieval
→ Deep Reasoning
→ Evidence Verification
```

阶段指令固定在 `phases.ts`，由 harness 逐条注入。模型不能自行跳过或重排阶段。

冻结常量：

```ts
MAX_ROUNDS = 5
MAX_TOOL_CALLS = 6
TOOL_RESULT_BUDGET_CHARS = 8_000
```

阶段 5 产出 candidates，阶段 6 产出 verdicts 和 `complete`。Candidate Gate 再执行：

```text
Schema → English → Evidence → Verification → Duplicate ID
```

最终 Finding 必须通过证据闸。S 级质量判据同时检查 Recall 与 Precision，防止通过少报冲成本。

### 5.2 当前成本上界不完整

`MAX_TOOL_CALLS = 6` 限制的是实际执行次数。超过预算的工具调用仍会：

1. 生成一次模型工具调用；
2. 返回 `Error: tool call budget exhausted`；
3. 继续下一回合，允许模型再次尝试。

现有 pi 数据中已出现单个 run 执行 6 次工具但尝试 10~22 次的样本。也就是说：

- 工具执行成本有上界；
- 模型请求数、输出 token 和工具尝试次数没有同等硬上界；
- “单次检视成本有界”目前只能有条件成立。

要支撑 20~30% 成本承诺，必须新增独立的：

- 最大请求数或最大回合数；
- 超预算后的终止/强制阶段收尾；
- 异常重试上限；
- 输出 token 预算或成本熔断。

---

## 6. Cache 优化：稳定前缀与 append-only

### 6.1 已实现

当前请求组织：

```text
[Zone A: system prompt + 七工具 schema]
→ [Initial MR user message: caseId + issue + diff]
→ [Phase 1 user instruction]
→ [Tool calls / tool results / assistant replies]
→ [Phase 2 instruction]
→ ...
```

主要稳定面：

- system prompt 在一次 harness 版本内字节稳定；
- 七工具名称、顺序和 schema 字节稳定；
- 初始 MR 消息之后，运行期消息只追加；
- 不修改历史消息，不重排上下文；
- `classifyCacheBreaks()` 对相邻请求做纯观测前缀分歧分类。

Cache Break 分类：

```text
MODEL_CHANGED
SYSTEM_PROMPT_CHANGED
TOOL_SCHEMA_CHANGED
CONTEXT_REORDERED
```

### 6.2 Context Ledger

当前 E 启用 Context Ledger：

- 相同工具请求第一次返回原文；
- 后续相同请求返回 `Already loaded: ctx#NNN (...)`；
- 读取失败不登记；
- Ledger 快照进入审计。

但 pi 侧矩阵中，E 的 ledger dedup ratio 为 0%。这说明当前实现没有被工具调用模式实际触发，或统计口径没有拾取命中。无论原因是哪一种，Ledger 当前不能被列为已兑现的成本收益。

### 6.3 缓存不能按固定 1/30 价承诺

缓存命中受 provider 和网关实现影响：

- 官方 API 与 OpenAI 兼容网关可能使用不同 usage 字段；
- 网关可能存在异步预热窗口；
- 网关可能按 token 块对齐才报命中；
- 部分模型不提供缓存计量，此时 `cacheHitRate` 必须是 N/A；
- 缓存命中价格是 provider 计费合同，不是 runtime 常量。

因此：

1. 不能把“命中价约 1/30”写成跨 provider 不变量；
2. 不能把 85% 命中率当作所有网关都应达到的工程保证；
3. CARC 必须明确是 token 口径还是货币口径；
4. 真实账单需要 provider 单价、缓存价、输出价和工具成本参数。

---

## 7. 当前指标与复现能力

### 7.1 主线已有

- 请求 wireBody 全量审计；
- usage 映射与累计；
- Cache Break 分类；
- 工具调用、阶段、候选拒绝和截断留痕；
- RunRecord 与审计文件落盘；
- 人工处置与 disposition KPI。

### 7.2 主线缺少

主线当前没有直接携带：

- `src/metrics/tokens.ts`；
- `src/metrics/efficiency.ts`；
- `src/metrics/verdict.ts`；
- Phase 2 runner；
- judge 链；
- A–E 矩阵报告重建；
- 通用 Agent 外部参照 runner。

这些资产属于 Demo 线或历史归档。任何引用 RIE、CARC、S/A/B 或 450 单元结论的文档，都必须明确标注 Demo 线来源，并给出可执行的复算路径。

当前可用的最低复算路径是：

```text
RunRecord.usage
  → totalTokens / uncached / cached / output
  → 按 case × config × rep 聚合
  → 冷 rep1 / 热 rep2+ 分层
```

但在指标实现回到主线或形成冻结脚本之前，主线不能声称“报告无一键复算”。

---

## 8. 与 20~30% 目标的差距

| 差距 | 当前状态 | 需要的动作 | 验收证据 |
|---|---|---|---|
| 总 Token 比例 | E/C 约 34.6% | 降低请求基数或轮数 | E ≤ C×30%，同 provider 同时间窗 |
| CARC | E/C 约 87.5% | 提高缓存收益并压低 uncached/output | CARC 单列且可解释 |
| 缓存命中 | E 约 60.6% | 按目标网关测预热、块对齐和前缀复用 | 命中率与 provider 合同同时留存 |
| 工具硬上界 | 只限实际执行，不限尝试 | 增加请求/回合/输出预算与强制收尾 | 极端样本不越过上限 |
| 空知识工具 | 两个工具默认空语料 | 接入语料或从生产工具面移除 | 工具调用有效产出率 |
| Ledger | 观测去重率为 0 | 补身份键、命中计数和 D/E 消融 | uncached 降且 Recall 不降 |
| 指标复现 | 主线缺 metrics/runner | 恢复冻结分析脚本或跨线引用 | 单命令复算 |
| 通用 Agent 基线 | 主线无对照 | 同模型、同协议、同真值实测 | 不以 C 代替通用 Agent |

达到 20~30% 目标不是再写一段成本公式，而是让 E 的当前生产形态在上述硬约束下重新测出来。

---

## 9. 建议路线

### P0：先把口径和硬上界补正确

1. 在文档、报告和 README 中统一“主线 E-only / Demo A–E”边界。
2. 增加请求数、回合数、输出 token 和工具尝试次数的独立上限。
3. 超预算时强制终止当前工具批或进入阶段收尾，禁止模型无限重试。
4. 为 `search_rule` / `search_history` 决定真实语料来源，或在生产工具面删除。
5. 恢复一个只读分析脚本，从 RunRecord/Audit 复算 token 和冷热分层。
6. 对每个目标网关记录缓存字段、预热窗、块对齐和计费单价。

### P1：验证当前 E 的真实成本收益

1. 同 provider、同模型、同时间窗重跑 E 与 C 锚。
2. 加入真正的通用 Agent 外部基线，不拿 C 冒充通用 Agent。
3. 对 Ledger 做 D/E 或开/关消融，至少报告 uncached、output、CARC、Recall。
4. 报告工具有效产出率、预算耗尽率、放弃读取率和重复读取率。
5. 若 E 仍高于 30%，优先处理预算耗尽和空工具，而不是直接复活 B 的预取管线。

### P2：再决定是否恢复上下文预取

B 配置的确定性预取曾在旧数据中达到更低名义 Token，但当前主线没有该执行面。若要恢复，需要新 ADR 和独立消融：

```text
E current
vs
E + risk-conditioned prefetch
vs
E + bounded repo map
```

不得把历史 B 的 7.1% 或 15.6% 直接写成当前 E 的成果。

---

## 10. 适用边界

当前结论的有效域：

- Java 单语言；
- 静态源码快照，零构建；
- 中小 MR，默认边界由 `mr-boundary-guard` 显式标注降级；
- 单模型主检视链；
- 单 provider/网关配置；
- 单缺陷引入类评测集；
- 未启用二遍 Verifier；
- 未验证多租户并发下的成本稳定性。

结论不得外推到：

- 无缓存计量的模型；
- 异步缓存或块对齐未知的企业网关；
- 大 MR、多语言仓库；
- 通用 Agent 的完整开发任务；
- 未记录 provider、模型部署版本和时间窗的历史数据。

---

## 附：机制到当前实现索引

| 机制 | 主线实现 | 状态 | 主要观测 |
|---|---|---|---|
| E-only 配置派生 | `contracts/config.ts` / `run/review-run.ts` | 已实现 | RunRecord `configId = "E"` |
| Zone A 稳定提示 | `zonea/system-prompt.ts` | 已实现 | Cache Break `SYSTEM_PROMPT_CHANGED` |
| 七工具固定 schema | `tools/registry.ts` | 已实现 | Wire tools 字节与顺序 |
| Diff-first 初始上下文 | `loop/messages.ts` / `run/review-run.ts` | 已实现 | 初始 message 数 |
| RepoContext 懒加载 | `tools/toolkit.ts` / `zoneb/repo-context.ts` | 已实现 | 工具调用前无仓库扫描 |
| 工具结果预算 | `tools/result-budget.ts` | 已实现 | 截断提示与 toolCallLog |
| 六阶段循环 | `loop/phases.ts` / `loop/agent-review-loop.ts` | 已实现 | phaseLog / requestCount |
| 轮次上界 | `loop/constants.ts` | 已实现 | rounds / truncationReasons |
| 工具执行上界 | `loop/constants.ts` | 部分实现 | toolCalls 只计实际执行 |
| 尝试次数硬上界 | 无 | 未实现 | attempts 可超过 6 |
| Context Ledger | `tools/ledger.ts` | 已实现但收益未证明 | Ledger snapshot / dedup ratio |
| Cache Break 观测 | `loop/cache-break.ts` | 已实现 | cacheBreaks |
| usage 映射 | `provider/usage-map.ts` | 已实现 | input / cacheRead / output |
| RIE / CARC / 判定链 | Demo 线 | 主线不在场 | 需冻结脚本或跨线引用 |
| 确定性预取 | Demo 线历史配置 B | 主线不在场 | 不得写成当前实现 |
| 通用 Agent 外部基线 | 未接入主线 | 未实现 | 需独立 runner 与对照报告 |
