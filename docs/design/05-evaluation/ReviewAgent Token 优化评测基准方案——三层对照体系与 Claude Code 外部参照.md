# ReviewAgent Token 优化评测基准方案——三层对照体系与 Claude Code 外部参照

> **文档状态**：2026-11-10 新建；2026-11-10 盘问收口。评测面工程方案，适用长期 `eval/bench` 分支与按 campaign 的评测运行；`main` 只保留只读分析与报告消费，`demo/config-matrix` 仅作历史证据。
>
> **一句话结论**：全仓注入配置 C 从生产主线退役是 ADR-0014 / ADR-0015 的预期结果，不是遗漏；C 也不能充当未来 token 优化的主成本门。评测面需要把「一个 C 组」拆成三层：**L1 绝对质量门、L2 配对回归门、L3 定位报告 / 宣称门**。L3 的通用外部 Agent 参照选定 **Claude Code**；C 以 **eval-only 全仓参照（C_ref）** 形态保留为同模型信息参照，其 `totalTokens` 只作 L3 参考分母，不复活生产配置选择面。
>
> **本文回答三个问题**：
>
> 1. 为什么当前项目「没有全仓注入对照组」不是单纯少了一个配置，而是评测能力缺口；
> 2. 为什么历史 C 数字与 Demo 线的 C 都不能直接充当未来 token 优化的评判标准；
> 3. 主线应以什么对照、什么指标、什么门槛、什么落位来评判 token 优化，以及 Claude Code 基线怎么接。
>
> **边界**：本文定义「如何评判 token 优化」，不重新引入生产配置选择面，不把 A–D 可执行配置带回 `main`，也不改变协议 v3。本文涉及的历史数字只用于解释口径，不冒充当前生产实测结论。

**关联文档**：

- [ADR-0004 S 级判定纳入 Precision](../../adr/0004-s-grade-includes-precision-not-tool-calls.md)
- [ADR-0008 检视模型可替换与按能力限定指标](../../adr/0008-reviewer-model-swappable-with-capability-scoped-metrics.md)
- [ADR-0011 上线门口径与 config E 切流](../../adr/0011-launch-gate-quality-first-and-config-e-cutover.md)
- [ADR-0014 分支策略——生产 main 与 Demo 分离](../../adr/0014-branch-strategy-production-main-and-demo-split.md)
- [ADR-0015 协议 v3——配置选择根除](../../adr/0015-protocol-v3-no-config-selection.md)
- [ReviewAgent Token 优化方案](<../02-agent-design/ReviewAgent Token 优化方案——以 20~30% Token 成本达到通用 Agent 检视效果.md>)
- [Config B 生产化方案](<../02-agent-design/Config B 生产化方案——差距分析、推荐路线与修改建议.md>)
- [VUL4J 评测方案与数据复制指南](<./VUL4J 评测方案与数据复制指南.md>)

---

## 0. 术语与证据标签

| 术语 | 含义 |
|---|---|
| **E** | 当前生产唯一配置：七工具 + 稳定前缀 + Context Ledger + append-only，协议 v3 服务端派生 `"E"` |
| **C** | 历史实验矩阵的全仓注入配置：工具 + 全仓 Java 源文件注入（80k chars 预算守卫），无稳定前缀 / Ledger |
| **锚 / anchor** | 判定链里作为分母的历史配置。ADR-0004 的 S/A/B 以 C 为锚；本文把该用法限定为历史实验口径 |
| **CARC** | Cache-adjusted Review Cost = `uncachedInputTokens + cacheWriteTokens + outputTokens + toolCostTokens`；缓存命中不计入 |
| **RIE** | Review Intelligence Efficiency = `lineRecall × linePrecision / (totalTokens / 1K)` |
| **L1 / L2 / L3** | 本文定义的三层评测面：绝对质量门 / 配对回归门 / 定位报告·宣称门 |
| **E 基线快照（E baseline snapshot）** | L2 的冻结 E 运行时（tag / commit），作为配对回归的 baseline 臂 |
| **全仓参照（C_ref）** | eval-only 的全仓注入参照；只在 L3 运行，不复活生产配置选择 |
| **外部参照（external reference）** | Claude Code：跨模型、同仓 / 同 diff / 同 judge 的通用 Agent 参照；单列报告，不进 S/A/B |
| **参考分母（reference denominator）** | C_ref 的 `totalTokens` 在 L3 作 E/C_ref 名义比例参照；不进 L2 门、不单独构成结论 |
| **配对（paired）** | 同一 case、同一 rep、同一环境的 baseline 与 candidate 成对比较，而不是两组独立均值比较 |
| **同窗口** | baseline 与 candidate 在同一 provider 时段、同一模型部署、同一网关路由条件下运行，通常约束在 ≤48h 窗口内交错执行 |
| **eval-only** | 只存在于评测分支 / 评测入口、生产协议与生产 CLI 不可达的代码形态 |

证据标签沿用 Token 优化方案：

| 标记 | 含义 |
|---|---|
| **已实现** | 当前 `main` 代码可验证 |
| **已退役** | 曾在主线或历史配置中存在，现已被 ADR 决策移除 |
| **历史实测** | 有本地 / Demo 线运行数据，但不在主线可复跑指标链内 |
| **未实现** | 当前主线不存在，需要后续补 |
| **已决** | 2026-11-10 盘问收口；阈值 provisional 的项在 ADR-0017 中保留校准补记路径 |

---

## 1. 问题陈述

### 1.1 观察

当前主线没有全仓注入对照组：配置 C 只存在于 `demo/config-matrix`，`main` 的配置值域已塌缩为 `"E"`。如果后续对项目做 token 优化，看起来没有一个可比的评判标准。

这个观察成立，但需要把缺口说准：

> **缺的不是「一个 C 组」，而是「与当前 E 同代码基线的活对照」和「能复跑对照的评测装置」。C 只是这个缺口里最显眼的一格。**

### 1.2 事实核验

| 项 | `main`（生产主线） | `demo/config-matrix`（研究线） |
|---|---|---|
| 配置值域 | `ConfigId = "E"` 单值（`packages/review-pi/src/contracts/config.ts:10`） | A–E 全矩阵（demo 的 `packages/review-pi/src/contracts/config.ts`） |
| C 全仓注入 | **已退役**：`src/zoneb/full-repo-injection.ts` 不存在 | 在位：`zoneb/full-repo-injection.ts`，`DEFAULT_FULL_REPO_BUDGET_CHARS = 80_000` |
| C 审计字段 | `FullRepoRecord` / `fullRepo` 已根除（`audit/audit-writer.ts:21` 注释） | 在位（demo 的 `contracts/run.ts`） |
| 评测装置 | 无 `metrics` / `judge` / `experiment` runner；根 `scripts/` 仅 `demo-http-server.ts`、`run-migration-gate.ts` | `src/metrics/`、`src/judge/`、`src/experiment/`、`src/reference/`、`scripts/run-experiment.ts` 全在 |
| 运行数据 | `runs/` 在 `main` 未跟踪（`git ls-tree main -- runs` 为 0）；本机 `runs/phase2-pi` 有 1598 个未跟踪文件 | Demo 线仅跟踪 `runs/phase2-pi/REPORT.md` 等报告，完整 records 仍为本机未跟踪数据 |
| 协议 | v3：`configId` 根除，携带即 `-32019` | v2：`configId` 仍是请求参数 |
| 外部参照 | 未实现 | Claude Code 参照实现完整：`src/reference/` + `scripts/run-claude-code-reference.ts` |

这说明 C 缺席不是疏忽，而是 ADR-0014 §2（`main` 不包含 A–D 可执行配置与 A–E 对照实验计划）和 ADR-0015（`configId` 根除）的直接后果。

问题在于：**决策只回答了「生产不需要 C」，没有同时回答「生产 token 优化拿什么做对照」。**

### 1.3 准确诊断

未来 token 优化至少需要回答四个不同问题，而当前项目对四个问题的准备程度不同：

| 问题 | 当前状态 | 缺口 |
|---|---|---|
| 质量有没有掉？ | 有历史 C 锚与人工处置 KPI，但主线无活对照 | L1 绝对质量门与质量非劣检验 |
| 这次优化真的省了吗？省在哪？ | 只有历史 C 快照与本地未跟踪数据 | L2 配对回归门 |
| 相对信息上限 / 通用 Agent 处于什么位置？ | C 只在 Demo 线可执行；Claude Code 参照只在 Demo 线 | L3 eval-only C_ref + Claude Code 外部参照 |
| 换模型 / 换网关 / 换内核后结论还成立吗？ | 无 capability-scoped 评测流程 | L3 周期性重跑与环境 provenance |

因此，正确动作不是「把 C 搬回 main」，而是建立三层评测体系，并把 C 降级为 L3 的一个参照列。

---

## 2. C 的四重角色与错配

### 2.1 四个角色

| C 的角色 | 出处 / 用途 | 是否适合当 token 优化标准 |
|---|---|---|
| **效果参照**：全仓注入，看「信息给满」能到什么质量 | 总体架构方案第 7 章；VUL4J 评测方案 §3 | 适合做 L3 的信息参照；不是绝对上限 |
| **判级锚**：S/A/B 判据的分母 | ADR-0004、ADR-0011；Demo 的 `metrics/verdict.ts` | 只适合冻结历史实验复算，不适合未来实验 |
| **成本分母（历史用法）**：`E.totalTokens ≤ C.totalTokens × 30%` | Token 优化方案 §1.3、§8.2 | **不适合作主门**：C 的成本结构与 E 不可比；仅可作 L3 参考分母 |
| **参考分母（推荐用法）**：L3 报告 `E/C_ref totalTokens` 比例 | 本文 | 适合展示量级；不进 L2 门、不作真实账单 |
| **增量对照组**：优化前 vs 优化后 | 隐含需求 | **不适合**：C 与 E 是机制差异，不是版本差异 |

### 2.2 C 作为主成本分母为何失真（参考分母仍可用）

历史 pi 矩阵（`runs/phase2-pi`）中的数字：

| 指标 | C | E | E/C |
|---|---:|---:|---:|
| `totalTokens` | 373,900.4 | 129,516.9 | **34.6%** |
| `CARC` | 65,420 | 57,278 | **87.5%** |
| `cacheHitRate` | 85.6% | 60.6% | — |
| rule line Recall | 24.7% | 22.0% | 89.0% |
| rule line Precision | 30.1% | 22.3% | 74.0% |
| judge Recall | 53.9% | 59.6% | 110.6% |
| 当前判级 | BELOW_B | B | — |

三个关键事实：

1. **C 的名义 token 约为 E 的 2.9 倍，但 CARC 只差 12.5%。** C 的巨大全仓注入形成了极稳定的前缀，大部分输入按缓存价计费；`totalTokens` 的 34.6% 是名义口径，不是真实账单差距。用 `E ≤ C×30%` 做成本门，会奖励「把稳定前缀做大、让缓存吃掉更多」的做法，而 CARC 可能不降。
2. **C 的「全仓」本身带预算守卫。** `full-repo-injection.ts` 只装 80k chars（约 20k tokens），大仓按排序路径前缀截断并显式留痕。C 不是无限全仓，也不是信息论上限。
3. **C 不是严格质量上限。** 历史数据显示 E 的 judge Recall（59.6%）高于 C（53.9%）。C 应称为「同模型、同数据集的信息参照」，不是「效果天花板」。把 C 写成上限会误导优化方向。

因此本文保留 `C_ref` 的 `totalTokens` 作 L3 **参考分母**，但不让它进入 L2 主门；L2 主成本仍是 CARC。

另外，C 自身在 ADR-0004 判据下是 `BELOW_B`：`Token ≤ C×30%` 对 C 自己恒不成立。这进一步说明 C 是**测量锚**，不是**目标配置**。

### 2.3 历史数据的 provenance 缺口

本机 `runs/phase2-pi/plan.json` 记录了模型 id、judge 模型、网关 base URL、case 列表与 reps；但没有记录：

- 模型部署版本 / 快照（`deepseek-v4-flash` 是滚动别名还是固定版本）；
- 运行时间窗（起止时间、冷热分层时段）；
- 网关前缀缓存配置、路由亲和、块对齐参数；
- judge 的完整版本与提示词模板版本（只记了 `glm-5-3-260814`）；
- CLI / 运行环境 / 机器指纹。

因此，历史 C 数据只能作为 **历史证据复算**，不能作为「今天同条件重跑」的基线。任何引用都必须带 `NOT_REPRODUCIBLE` 注记与来源锚点。

---

## 3. 为什么 Demo 线的 C 不能当未来标准

一个直觉方案是「既然 Demo 线有 C，未来优化就去 Demo 线跑 C+E」。这也不行：

1. **Demo 的 E 不是 main 的 E。** 冻结基线之后，`main` 对 `packages/review-pi/src` 改了 101 个文件、删除约 7.0k 行（新增 720 行；E-only 重构、协议 v3、工具与账本调整）。Demo 的 E 是旧 E，不能代表主线当前行为。
2. **跨代码基线比较不可归因。** C 在 Demo、新 E 在 main，两次运行之间同时变了代码、协议、模型快照、网关路由和缓存时段，token 变化无法归因给优化本身。
3. **网关时段效应是实测存在的。** ADR-0011 记录了 221 小时窗口漂移污染 `cacheHitRate`；Token 优化方案 §3.4 也指出 60.6% 命中率不足以证明缓存目标兑现。跨窗口比较会把环境漂移误读成优化收益或损失。
4. **判级链也会漂移。** judge 模型 / 版本 / 提示词变化会改变 finding↔truth 匹配率；ADR-0008 明确「模型可换，但指标须 capability-scoped」。拿冻结 C 的 recall/precision 当质量门，会把 judge 漂移算进质量变化。

**结论**：Demo 的 C 只适合做历史证据复算与移植参考，不能做未来优化的评判标准。未来比较必须在同一代码基线、同一数据集、同一模型、同一 provider 窗口、同一 judge 版本下进行。

---

## 4. 三层评测体系总览

| 层 | 回答的问题 | 对照 | 频率 | 主要门槛 | 落位 |
|---|---|---|---|---|---|
| **L1 绝对质量门** | 质量有没有掉？ | 不依赖 C：绝对下限 + 人工接受率 + 阴性对照 | 每次评测 | 配对非劣 / 绝对下限 | 只读分析器 + 评测报告 |
| **L2 配对回归门** | 这次优化真的省了吗？省在哪？ | **E 基线快照 vs E@candidate**，同基线、同窗口、配对 | 每次 token 相关改动（同模型 / 同 provider） | CARC 下降 + 质量非劣 + 有界性 | `eval/bench`（`main` 只读消费） |
| **L3 定位报告 / 宣称门** | 相对信息参照 / 通用 Agent 处于什么位置？ | **C_ref（eval-only 全仓参照）+ Claude Code 外部参照** | 季度 / 大版本 / 对外宣称前 | 质量目标线 + 成本目标线 + 环境留痕 | `eval/bench` + 独立报告 |

### 4.1 判据分层原则

1. **目标函数与约束分离**：L2 的目标函数是 CARC（必要时同时看 uncached / output）；质量是约束，不是目标。不能用「少报」换 token。
2. **绝对与相对分离**：L1 用绝对质量下限；L2 用同基线配对；L3 才用相对 C_ref / Claude Code 的比例。
3. **同条件优先**：任何跨代码、跨窗口、跨模型的比较都必须显式标注混杂，不得直接当因果。
4. **四行记账**：任何测试至少输出 `cachedInput / uncachedInput / output / CARC`；`totalTokens` 只作辅助，`cacheHitRate` 只作解释变量。
5. **零静默**：未知字段记 `N/A`，不记 0；失败、截断、权限拒绝、超时全部留痕，不静默剔除。
6. **可复跑**：同一输入、同一配置、同一环境应能重放审计并复算指标；不能复跑的历史数据必须标记。
7. **硬门与例外分离**：L2 是 token 相关改动的硬门；仅成本门可经产品书面签字 + 过期日 + 回滚计划豁免，质量非劣门不可豁免；L3 只作对外宣称门。
8. **参考分母不进门**：`C_ref.totalTokens` 只在 L3 展示 `E/C_ref` 名义比例，不参与 L2 的 pass/fail。

---

## 5. L1 绝对质量门

### 5.1 指标

L1 从每次 run 的记录直接计算，不需要额外 LLM 调用：

| 指标 | 口径 | 用途 |
|---|---|---|
| judge line Recall / Precision / F1 | LLM-as-judge 裁定后的行级匹配 | 主质量指标 |
| rule line Recall / Precision / F1 | 确定性行级筛查 | 与 judge 双列，解释分歧 |
| zero-finding rate | 无 finding 的 run 占比 | 防「少报换低成本」 |
| negative-control FP per case | clean MR 每案假阳性数 | 防「主动检索推高无中生有」 |
| evidence-gate rejection distribution | `SCHEMA_INVALID` / `NON_ENGLISH` / `NO_EVIDENCE` / `VERIFICATION_FAILED` / `DUPLICATE_ID` | 解释质量变化来源 |
| human acceptance rate | 人工处置接受 finding 的比例 | 生产主 KPI（绝对口径） |
| coverage | 成功评测的 case / 计划 case | 防静默丢样 |

### 5.2 建议门槛

**已决 D2（2026-11-10 盘问）**：L1 的绝对下限待首次基线跑后由产品拍板；在此之前，用「相对 E 基线快照的配对非劣」作为临时替代，避免拍脑袋数字。

初始建议（待 ADR 固化）：

| 指标 | 建议门槛 | 说明 |
|---|---|---|
| judge line Recall | candidate − baseline 的配对 95% CI 下界 ≥ −3pp | 质量非劣；绝对下限另行设定 |
| judge line Precision | candidate − baseline 的配对 95% CI 下界 ≥ −3pp | 防止滥报换检出 |
| zero-finding rate | 不高于 baseline + 2pp | 防止少报冲 token |
| negative-control FP per case | 不高于 baseline + 1σ | 防止主动检索推高 FP |
| evidence-gate rejection | `NO_EVIDENCE` / `VERIFICATION_FAILED` 不显著上升 | 失败阶段分布必须报告 |
| human acceptance | 不低于 baseline − 2pp（有数据时） | 生产主 KPI |
| coverage | ≥ 95%，失败逐案留痕 | 不许静默丢样 |

### 5.3 评估方法

- 只使用已产出的 run records 与 judge 结果，纯读、可复算。
- 主口径取 rep2+（热稳定）均值；rep1（冷）单列，不混入主口径。
- 跨 case 聚合每案等权：先 case 内跨 rep 均值，再跨 case 均值 ± 样本标准差。
- 同时报告 judge 与 rule 双列；两者分歧单列，不互相替代。

### 5.4 失败处理

- 单 case 失败：留痕，不拖垮整批；报告中计入 coverage。
- judge 失败：按现有协议回落 rule 值并标记；重判后恢复。
- 差分失败（candidate 失败率显著高于 baseline）：视为质量风险，不得用「失败样本被排除」美化结果。

---

## 6. L2 配对回归门（主战场）

### 6.1 对照定义

L2 的对照组不是 C_ref，而是 **同一代码谱系的 E 前后快照**：

```text
baseline  = E 基线快照 @ 冻结 tag / commit（例如 reviewagent-v1.0.0）
candidate = E @ 本次优化 commit
```

**适用范围**：L2 只覆盖同模型 / 同 provider 的运行时改动（上下文组装、工具、提示词、计费口径）。模型升级、网关切换走「迁移门 + L3」，不套 L2。

冻结要求：

| 维度 | 要求 |
|---|---|
| 代码基线 | baseline 与 candidate 只差本次优化涉及的提交；其他运行时代码一致 |
| 数据集 | 同一 `target-cases.json`（当前 Vul4J 30 案）+ 同一 clean-MR 阴性对照 |
| 模型 | 同一模型 id；记录实际部署版本；不得中途切换 |
| provider / 网关 | 同一网关类别、同一路由策略；运行前跑 `probe-gateway-cache.ts`，运行后复测 |
| judge | 同一 judge 模型、同一提示词模板、同一阈值 |
| prompt / tool schema | 同一 Zone A 模板版本与工具 schema 字节；变更必须作为显式变量单列 |
| reps | baseline 与 candidate 使用相同 reps；主口径 rep2+ |
| 时间窗 | 同一 ≤48h 窗口内交错执行；记录起止时间 |

**交错执行**：同一 case × rep 的 baseline 与 candidate 相邻运行，或按 case 随机化 arm 顺序，避免把所有 baseline 放在上午、所有 candidate 放在下午。

### 6.2 指标体系

| 类别 | 指标 | 角色 |
|---|---|---|
| 成本主指标 | `CARC` | 主目标；缓存调整后的真实成本 |
| 成本分解 | `uncachedInputTokens`、`outputTokens`、`cacheWriteTokens` | 解释省在哪 |
| 名义成本 | `totalTokens` | 辅助；不得单独作为结论 |
| 缓存 | `cachedInputTokens`、`cacheHitRate` | 解释变量；同窗口比较 |
| 循环 | `requests`、`rounds`、`executedToolCalls`、`attemptedToolCalls` | 防止 attempts 膨胀 |
| 截断/停止 | `truncationReasons`、stop reason | 区分「模型收敛」与「预算截断」 |
| 效率 | `RIE` | 质量 × 成本综合辅助 |
| 参考分母 | `E/C_ref totalTokens` 比例 | 仅 L3 展示；不进 L2 门 |
| 质量 | L1 全部指标 | 约束 |

**报告四行固定**：

```text
cachedInputTokens
uncachedInputTokens
outputTokens
CARC
```

没有这四行，不允许宣称「省了 token」。同时必须报告 `totalTokens`、`cacheHitRate`、`attemptedToolCalls`、`requests`；但 `totalTokens` 不得单独作为结论，`cacheHitRate` 只作解释变量。

### 6.3 配对统计

- **分析单位**：case（先 case 内跨 rep 平均），避免把 rep 当独立样本造成伪重复。
- **配对差值**：对每个 case 计算 candidate − baseline；报告均值、中位数、样本标准差。
- **区间估计**：配对 bootstrap（10,000 次，固定种子）95% CI；成本比率建议用几何均值或比率均值，并同时报告绝对差。
- **质量非劣**：配对差值 CI 下界与预先声明的非劣边界比较；不做事后改边界。
- **多重比较**：预先声明主指标（CARC、judge Recall、judge Precision）；其他指标为次要，报告中标注，不用次要指标翻盘。
- **样本量**：主实验 ≥30 case × 3 reps；冒烟 10 case × 2 reps。小样本只报告效应量与 CI，不夸大显著性。
- **冷热分离**：rep1 单列；L2 主口径用 rep2+。Claude Code 无等价缓存预热语义，L3 单独处理（见 §7）。

### 6.4 建议验收门

以下为**建议初始门**（provisional）；P1 先跑空对照校准，再由 ADR-0017 固化（已决 D3）：

| 门 | 建议判据 |
|---|---|
| 成本主门 | `CARC_candidate / CARC_baseline` 几何均值 ≤ 0.90，且配对 95% CI 上界 < 1.00 |
| 成本分解 | `uncachedInputTokens` 比率 ≤ 1.00；`outputTokens` 比率 ≤ 1.05；任一超限需单独解释 |
| 名义 token | `totalTokens` 报告；**不单独设门**；若 total 降但 CARC 不降，宣判无效 |
| 工具纪律 | `attemptedToolCalls` 比率 ≤ 1.00；`requests` 比率 ≤ 1.00；任何上升需论证 |
| 有界性 | `attemptedToolCalls ≤ MAX_TOOL_ATTEMPTS`；`requests ≤ MAX_REQUESTS`；`outputTokens ≤ OUTPUT_BUDGET`；截断原因显式 |
| 质量非劣 | L1 全部质量门通过（§5.2） |
| 缓存 | `cacheHitRate` 报告并带环境；L2 不设 ≥85% 硬门（跨窗口不可控），L3 再设 |
| 可复现 | 同输入审计可重放；无变更时 Cache Break 为 0；golden bytes 稳定 |
| 例外 | 仅成本门可产品书面签字 + 过期日 + 回滚计划豁免；质量非劣门不可豁免 |
| 参考分母 | `C_ref.totalTokens` 只在 L3 展示；不进入本表任何门 |

### 6.5 评测战役流程

```text
1. 冻结 baseline
   tag / commit + 可执行构建产物 + environment.json

2. 准备 candidate
   eval 分支 cherry-pick 本次优化提交（或 checkout candidate commit）
   确认除目标提交外，运行时与 baseline 一致

3. 环境探针
   probe-gateway-cache（运行前）
   记录模型、网关、judge、CLI、机器、时间窗

4. 冒烟
   10 case × 2 reps，baseline/candidate 交错
   失败隔离，修 runbook，不修数据

5. 主跑
   30 case × 3 reps（或预先声明的样本量），交错执行
   单单元失败留痕，不静默剔除

6. 判定
   L1 质量门 + L2 成本门 + 有界性门
   生成 L2 report + dashboard + environment.json

7. 归档
   报告随 commit / tag / issue 固定引用
   只有全门通过才允许合并到 main

8. 复测
   probe-gateway-cache（运行后）
   若窗口内网关策略变化，报告中标注并考虑重跑
```

**空对照校准**：首次建立 L2，或模型 / provider / judge / 提示词 / 工具 schema 任一变更后，先跑一次 baseline vs baseline（同代码、双 arm、同窗口）测噪声底；校准结果用于确认 / 调整 §6.4 阈值，不用于判定优化收益。

### 6.6 产物布局

```text
runs/eval/<campaign-id>/
  plan.json                 # baseline / candidate / 数据集 / 模型 / reps / 环境
  cases.json                # 实际使用的 case 集（与数据集守卫一致）
  environment.json          # 版本、网关、judge、时间窗、机器
  runs/<source>/<case>/<arm>/rep-<n>.json
  audit/...
  judge/...
  report.json               # 指标 + 配对统计 + 门判定
  dashboard.md              # 人读
  failures.json             # 单元级失败留痕
```

`environment.json` 字段见附录 B.3。

---

## 7. L3 定位报告 / 宣称门

### 7.1 C_ref 的 eval-only 定位

`C_ref` 在 L3 的角色是「同模型、同数据集的信息参照」，不是主成本分母，也不是严格质量上限；其 `totalTokens` 可作 **参考分母**，但不进 L2 门。

**eval-only 约束**：

1. **不进协议**：`review.submit` 仍无 `configId`；不接受 `"C"`；生产 server 不暴露 C_ref。
2. **不进生产 CLI**：无 `--config`；C_ref 只经 `eval/bench` 的评测入口可达。
3. **不进 `ConfigId` 写面**：生产 `ConfigId` 仍为 `"E"` 单值；C_ref 只作为评测记录标签 / `HistoricalConfigId` 读面使用。
4. **审计隔离**：`fullRepo` 记录进评测侧旁路（如 `evalAudit.fullRepo`），不复活生产 `RunAudit.fullRepo` 契约。若必须复用历史记录形状，需新 ADR 明确「eval-only 字段」。
5. **入口隔离**：`src/eval/**` 不得被 `src/cli`、`src/rpc`、`src/server`、`src/run` 生产入口 import；用依赖规则或测试扫描强制。
6. **预算版本化**：C_ref 的 80k chars 预算是测量常量；若调整，版本化为 `full-repo-budget-v2`，旧报告不与新报告混跑。

**C_ref 的测量口径**：

- 全仓注入按排序路径序装填；装不下整文件时行级截断并显式标记；不得静默丢弃。
- 记录 `budgetChars`、`contentChars`、`truncated`、`totalFiles`、`shownFiles`、省略文件清单。
- 报告必须同时给 `C_ref` 的 `totalTokens` 与 `CARC`；`E/C_ref totalTokens` 只作参考分母，并注明「全仓前缀缓存占比高，名义 token 不等于账单」。
- C_ref 的质量只作参照：E 低于 C_ref 时调查信息覆盖；E 高于 C_ref 时说明「更多信息不等于更好检视」，不得把 C_ref 写成硬上限。

### 7.2 Claude Code 外部参照

#### 7.2.1 为什么选 Claude Code

- **已有完整实现**：Demo 线 `src/reference/` + `scripts/run-claude-code-reference.ts` 已实现同仓、同 diff、同目标的无头参照，提示词模板冻结为 `claude-code-reference-1`，输出归一化为统一 Finding Schema。
- **代表性**：Claude Code 是通用 Coding Agent 的典型形态，适合回答「相对通用 Agent 的检视效果与成本」。
- **工具面公平**：参照只允许 `Read` / `Grep` / `Glob`（只读、词法级），与零构建的 ReviewAgent 工具精度同层；不授予写 / Bash 权限。
- **判定链复用**：归一化后的 finding 走同一 metrics / judge 管线，单列 `claude-code`，与 A–E 可横向对照。

**备选与不选理由**：

| 备选 | 不选理由 |
|---|---|
| OpenCode | 无现成 harness；模型路由、提示词、工具权限需另建，首版公平性难保证 |
| prime-agent / whale-pod | 是参考设计 / 研究项目，不是可直接运行的通用 Agent 基线 |
| Baseline LLM（无工具） | 已在 A/B 配置中；不能代表「通用 Agent」 |

保留 `ReviewKernel` / 外部参照 seam，未来可替换参照，不把 Claude Code 写死。

#### 7.2.2 调用契约（沿用现有实现）

```text
claude -p --output-format json \
  --model <claude-family-id> \
  --max-turns <n> \
  --allowedTools Read,Grep,Glob
```

| 项 | 现有默认 / 纪律 |
|---|---|
| 提示词注入 | stdin（diff 可达 2K 行，不走命令行参数） |
| cwd | 被检仓库快照（同仓约束） |
| 模型 | Claude 系 id 或 `sonnet` / `opus` / `haiku` 别名；实际模型以 CLI `modelUsage` 为准 |
| 轮数 | `--max-turns`，默认 5；成本有界 |
| 工具 | `Read` / `Grep` / `Glob`；禁止写 / 执行 |
| 超时 | 默认 600s；超时留痕，不静默成功 |
| 认证 | 沿用 `claude` CLI 自身配置；harness 不经手凭据 |
| 提示词版本 | `claude-code-reference-1`；冻结，不随内核演进漂移 |
| 输出 | `{"findings":[...]}`；归一化到统一 Finding Schema |
| 留痕 | CLI 版本、请求/实际模型、usage、`num_turns`、`total_cost_usd`、`permission_denials`、stdout/stderr |

**公平性纪律**：

- **同仓库、同 diff、同目标**：case 集与 truth 完全一致。
- **同 judge**：与 E 使用同一 judge 模型、温度、top_p、匹配阈值；judge 与被测模型异构（Claude Code 与 judge 不同源）。
- **同指标管线**：归一化 finding 走同一 `evaluateRun` / `buildMetricsReport`。
- **不同循环骨架**：Claude Code 以自身 agent 形态运行，不复刻六阶段；参照测的是「Claude Code 本来的样子」，不是「像 E 一样跑」。
- **不做 token 语义等价**：Claude Code 的 `input_tokens` / `output_tokens` 是 Anthropic 语义，不能与 DeepSeek 的 cached/uncached 字段逐项对齐。跨模型比较以 **`total_cost_usd`（或统一价目表折算成本）为主**，token 数只作辅助并注明语义。
- **版本固定**：记录 `claude --version`、实际模型 id、运行日期；CLI 或模型更新后必须重跑基线，不得混用历史结果。

#### 7.2.3 指标与报告

Claude Code 单列报告，`verdicts: null`、`excludedFromMainVerdict: true`，不进 S/A/B。报告包含：

| 类别 | 指标 |
|---|---|
| 质量 | judge line Recall / Precision / F1、rule line P/R/F1、零 finding 率、阴性对照 FP |
| 成本 | `total_cost_usd`、input/output tokens（auxiliary）、`num_turns` |
| 覆盖 | 成功 / 失败 / 超时 / max-turns 截断 / permission denials |
| 环境 | CLI 版本、请求/实际模型、运行时间、网关类别 |
| 归一化 | `CLI_OUTPUT_UNPARSABLE` / `FINDINGS_FIELD_INVALID` / `ENTRY_SCHEMA_INVALID` / `DUPLICATE_ID` 计数 |

**reps**：现有 Claude Code 参照只采集 input/output tokens，不采集与 E 等价的 cached/uncached 冷热语义；建议 2–3 reps 估计模型方差，但报告时不要把 E 的 rep2+ 热口径直接套到 Claude Code 上。对外宣称至少 3 reps 或明确标注单次结果。

### 7.3 C_ref 与 Claude Code 的分工

| 参照 | 回答的问题 | 比较边界 |
|---|---|---|
| **C_ref** | 同模型、同数据下，「信息给满」能到什么质量？成本结构如何？ | 同模型内；CARC / totalTokens 可比性较高，但 C_ref 的缓存结构不同 |
| **Claude Code（外部参照）** | 相对通用 Agent，质量与成本处于什么位置？ | 跨模型；以美元成本 / 统一价目为主，token 语义不同 |

两者都**不进 S/A/B 主判定**；L3 是独立报告，不是生产判级。

### 7.4 L3 目标线与宣称口径

**已决 D5（2026-11-10 盘问）**：以下为对外目标线，不是统计判定门；数值由产品确认。参考历史文档口径：

| 目标 | 建议 |
|---|---|
| 质量 | E judge Recall ≥ Claude Code × 90%；E judge Precision ≥ Claude Code × 100% |
| 成本 | E 计费成本（USD 或统一价目）≤ Claude Code × 30% |
| 参考分母 | `E/C_ref totalTokens` 只在 L3 展示，不进门 |
| 缓存 | E cacheHitRate ≥ 85%（同窗口、带环境留痕） |
| 阴性对照 | E 的 clean-MR FP per case 不高于 Claude Code + 1σ |
| 覆盖 | 三列 coverage ≥ 90%，失败逐案留痕 |

**宣称模板**（只在 L3 报告通过后使用）：

> 在 Vul4J 30 案、同一真值、同一 judge、同一 ≤48h 窗口下，ReviewAgent E 的 judge Recall 为 Claude Code 的 X%，judge Precision 为 Y%，计费成本为 Z%；C_ref 列作为同模型全仓信息参照单列报告。token 口径为各自 provider 语义，跨模型不作等价比较。

禁止写法：

- 只写「达到通用 Agent 的 20~30%」而不给质量、成本、样本量、时间窗、模型版本；
- 用 `totalTokens` 跨 provider 直接相除；
- 用单次 Claude Code 运行结果做统计宣称；
- 把 `C_ref` 的 `totalTokens` 当主成本门，或把 `C_ref` 写成严格质量上限；参考分母只在 L3 展示。

### 7.5 L3 报告结构

```text
L3 Report
├── environment.json
├── coverage
├── E column
│     quality (judge + rule)
│     cost (cached / uncached / output / CARC)
│     requests / attempts / truncation
├── C_ref column (eval-only)
│     quality
│     cost (totalTokens + CARC + cacheHit)
│     reference denominator (E/C_ref totalTokens, display only)
│     fullRepo record (budget / truncated / files)
├── claude-code column
│     quality
│     cost (total_cost_usd + tokens auxiliary)
│     turns / failures / denials
├── paired comparisons
│     E vs C_ref (same model)
│     E vs Claude Code (cross-model, cost basis)
└── claim-ready summary
```

---

## 8. 评测装置落位与架构

### 8.1 分支落位（关键决策 D4）

ADR-0014 §2 明确 `main` 不包含 A–E 可执行配置、对照实验计划、采样和判定链。因此**不建议把完整评测装置与 C_ref 直接放回 `main`**。推荐三层落位：

| 位置 | 内容 | 理由 |
|---|---|---|
| **`main`** | 只读分析器（RunRecord → 四行指标 / L1 报告）、报告 schema、environment schema、确定性 CI 门 | 不执行配置、不引入 A–D，符合 ADR-0014；让生产侧能复算与审计 |
| **长期 `eval/bench`**（从 `main` 拉出，不反向合并） | 完整 metrics / judge / experiment / reference runner、eval-only C_ref、配对统计、空对照校准 | 与生产运行时物理隔离；每轮 campaign 打 tag / commit；harness 不漂移 |
| **`demo/config-matrix`** | 历史 A–E 矩阵、`runs/phase2-pi/REPORT.md` 等报告、旧判定链 | 历史证据与移植参考；不作为未来 main 的活对照 |

**同步纪律**：

- `eval/bench` 从 `main` cherry-pick 运行时改动（ADR-0014 §7），只用于构造 baseline/candidate；不整分支合并。
- 评测分支的实验设施不进入 `main`；`main` 只接收只读分析器、报告模板、ADR 与结论。
- ADR-0016 需把 `eval/bench` 纳入分支拓扑，并明确「不合并、生产入口不可 import」。
- 若团队决定把完整 harness 放进 `main`，必须新立 ADR 修订 ADR-0014 §2；本文不推荐。

### 8.2 需要恢复 / 移植的组件

| 组件 | 现状 | 动作 |
|---|---|---|
| `src/metrics/`（tokens / efficiency / quality / aggregate / stats / verdict） | Demo 线 | 移植到评测分支；L2 用 `tokens/efficiency/quality/aggregate/stats`，`verdict` 保留历史口径 |
| `src/judge/` | Demo 线 | 移植；固定 judge 模型、温度、top_p、提示词版本 |
| `src/instrument/` | Demo 线 / main 部分 | 评估记录、run-result 映射、case 契约 |
| `src/experiment/`（runner / plan / datasets / report / dashboard / review-kernel / pi-kernel） | Demo 线 | 移植并适配 main 的 `runReview`（无 `configId`） |
| `src/reference/`（Claude Code） | Demo 线 | 移植；保留 prompt 模板版本与单列报告纪律 |
| `src/zoneb/full-repo-injection.ts` | Demo 线 | 只移植到评测分支的 eval-only 目录；不进生产 `zoneb/` |
| `scripts/run-experiment.ts`、`scripts/run-claude-code-reference.ts`、`scripts/probe-gateway-cache.ts` | Demo 线 | 移植；重命名/参数化以支持 baseline/candidate 双 arm |
| `runs/phase2-pi` | 本机未跟踪（1598 文件）；Demo 仅 `REPORT.md` | 作为历史证据冻结；补 provenance 后标记 `NOT_REPRODUCIBLE` |
| 只读分析器 | 未实现（Token 方案 §4.2） | 在 `main` 新增，纯读 RunRecord |

### 8.3 eval-only C_ref 的隔离设计

```text
评测分支
  src/eval/
    context/full-repo.ts        # 从 Demo 的 zoneb/full-repo-injection.ts 移植
    context/context-mode.ts     # "lazy" | "full-repo"（仅评测入口可见）
    runner/eval-review.ts       # 包装 runReview；C_ref 走全仓注入，E 走生产路径
    audit/eval-audit.ts         # fullRepo 侧路记录，不碰生产 RunAudit
```

隔离要求：

1. `src/eval/**` 不被生产入口 import；用依赖规则或测试扫描强制。
2. `contextMode` 不是 `ConfigId`，不出现在协议、CLI、生产 `runReview` 输入。
3. `fullRepo` 记录只进评测 audit / 报告；不复活生产 `RunAudit.fullRepo`。
4. C 的预算、排序、截断提示有 golden bytes 测试；变更需版本化。
5. `C_ref` 的结果 `configId` 可标历史标签 `"C"`，但记录必须带 `evalOnly: true` 与 `campaignId`，避免与历史 A–D 生产记录混淆。

### 8.4 契约与审计

- **生产契约不变**：`ConfigId = "E"`，`RunAudit` 不含 `fullRepo`；`HistoricalConfigId` 仍可读 A–E 历史记录。
- **评测记录**：建议独立 `EvalRunRecord` / sidecar，字段至少包含 `campaignId`、`arm`（baseline / candidate）、`configId`（E / `C_ref` 的历史标签 `"C"`）、`evalOnly`、`environmentRef`。
- **审计重放**：评测报告必须能从 records + audit 复算；`requests[]` / `wireBody` 以审计文件为真源。
- **零静默**：C 的截断、Claude Code 的 max-turns / permission denials / 解析失败全部留痕。

### 8.5 环境 provenance

每次 L2 / L3 必须记录（详见附录 B.3）：

- git commit / tag / 分支；
- 包版本、Node 版本、OS / 机器；
- 被测模型 id + 实际部署版本（可得时）；
- provider / 网关类别、base URL 类别（不落 key）、路由 / 亲和策略；
- gateway cache probe 结果；
- judge 模型 / 版本 / 提示词模板 / 温度 / top_p；
- Zone A 模板版本、工具 schema 版本；
- Claude Code CLI 版本、请求 / 实际模型、max-turns；
- 运行起止时间、冷热分层；
- 数据集合 hash / case 清单。

### 8.6 CI 与手动评测边界

| 类型 | 跑什么 | 频率 |
|---|---|---|
| CI 确定性门 | 类型检查、单元测试、golden bytes、审计重放、schema 校验、依赖隔离测试 | 每次提交 |
| 只读分析器 | `RunRecord → 四行指标 / L1 报告`；纯读、无 LLM、离线、确定性 | `main` 每次提交 |
| 空对照校准 | baseline vs baseline，30 case × 3 reps × 2 arms | P1 一次 + 模型 / provider / judge / 提示词 / 工具变更时 |
| L2 配对回归 | 真实模型 + judge + 30 case × 3 reps × 2 arms | 每次 token 相关改动 / 发布前 |
| L3 定位报告 | E + C_ref + Claude Code 全列 | 季度 / 大版本 / 对外宣称前 |
| 历史复算 | `runs/phase2-pi` 等只读复算 | 按需 |

**不要**把全量 LLM 评测放进每次 PR CI：成本、时长和 provider 波动会让门不可用；CI 只做确定性检查，评测由 campaign 触发。

**报告落位**：L2/L3 摘要报告写 `main` 的 `docs/report/token-eval/`（结论、`environment.json`、复算入口）；原始 `runs/`、`audit/`、`wireBody` 外置；`eval/bench` 只放 harness 与 campaign 记录。

---

## 9. 实施路线

### P0：先让成本可解释、可复算（1–2 周量级）

| 编号 | 事项 | 产出 | 验收 |
|---|---|---|---|
| P0-1 | 冻结 E 基线快照 | tag / commit + 可执行构建 | 能在 `eval/bench` 重建同一 E |
| P0-2 | 在 `main` 新增只读分析器 | `RunRecord → cached/uncached/output/CARC/attempts/requests` 单命令 | 对 `runs/phase2-pi` 复算结果与文档数字一致 |
| P0-3 | 历史 `runs/phase2-pi` 最小 provenance 补录 | 来源 commit、可考时间窗、模型、judge；`NOT_REPRODUCIBLE` 标记；不重建网关 / 部署版本 | 任何历史引用都能追到锚点，且不冒充活基线 |
| P0-4 | 冻结指标字典与报告 schema | 附录 A / B 落为代码或 JSON Schema | L2 / L3 报告可机读 |

### P1：建立 L2 配对成本门（2–4 周量级）

| 编号 | 事项 | 产出 | 验收 |
|---|---|---|---|
| P1-0 | 空对照校准（baseline vs baseline，30×3×2） | 噪声底报告 + provisional 阈值复核 | 校准报告可复算；阈值有数据依据 |
| P1-1 | 移植 metrics / instrument / judge / experiment | 评测分支可运行 | 单元测试 + 离线 fixture 全绿 |
| P1-2 | 适配 main 的 `runReview`（无 `configId`） | 评测 kernel adapter | E 走生产路径，行为不变 |
| P1-3 | 双 arm 运行（baseline / candidate） | `pnpm eval` 类入口 | 交错执行、环境留痕、失败隔离 |
| P1-4 | 配对统计与门判定 | 报告 + CI | 附录 B.1 模板可生成 |
| P1-5 | 网关探针与同窗口纪律 | `probe-gateway-cache` 接入 | 运行前后各一次，报告留痕 |
| P1-6 | 冒烟 + 主跑 | 10×2 冒烟、30×3 主跑 | 全门可执行 |

### P2：建立 L3 定位门（3–5 周量级）

| 编号 | 事项 | 产出 | 验收 |
|---|---|---|---|
| P2-1 | 按 ADR-0016 落地评测面隔离 | `eval/bench` harness + C_ref eval-only | 生产入口不可达 C_ref；依赖规则生效 |
| P2-2 | 移植 eval-only 全仓注入 | `src/eval/context/full-repo.ts` | golden bytes + 截断留痕 |
| P2-3 | 移植 Claude Code 参照 | `src/reference/` + runner | 同 case / 同 judge / 单列报告 |
| P2-4 | L3 全列报告 | E / C / Claude Code 三列 | 附录 B.2 模板；环境完整 |
| P2-5 | 公告口径与基线版本 pin | 报告 + runbook | CLI / 模型更新可重跑 |

### P3：治理与长期运行

| 编号 | 事项 | 产出 |
|---|---|---|
| P3-1 | 按 ADR-0017 固化判据与阈值 | 判据单源；ADR-0004 S/A/B 保留为历史实验口径 |
| P3-2 | 合并纪律与例外 | 无 L2 报告不合并 token 优化；无 L3 报告不对外宣称；仅成本门可签字豁免，质量门不可 |
| P3-3 | 季度 + 事件驱动的 L3 重跑 | 模型 / provider / judge / 提示词 / 工具变更即重跑；定位报告归档；版本漂移可追溯 |
| P3-4 | 评测集生命周期 | Vul4J 30 案 + clean-MR；定期 holdout / 扩充，防过拟合 |
| P3-5 | 报告与数据保留 | 摘要报告入库；原始 runs / audit / wireBody 外置并按期清理 |

---

## 10. 已决事项与 ADR

| 决策 | 结论 | 影响 |
|---|---|---|
| **D1** C_ref 的 `totalTokens` 是否作成本分母 | **仅 L3 参考分母**；不进 L2 门；L2 主成本 CARC，对外 USD | 防止「缓存吃掉总 token」的假优化 |
| **D2** L1 绝对质量下限 | 首次基线跑后由产品设定；在此之前用配对非劣 | 决定「质量不掉」的可执行门槛 |
| **D3** L2 门阈值 | §6.4 先作 provisional；空对照校准后由 ADR-0017 固化 | 决定优化能否合并 |
| **D4** 评测装置落位 | **`main` 只读 + 长期 `eval/bench` 全量**；不放完整 harness 进 `main` | 避免违反 ADR-0014 §2；若放 main 需新 ADR |
| **D5** L3 目标线与成本口径 | 质量 90% / 100%，成本 USD ≤ 30%；C_ref totalTokens 仅参考分母 | 决定对外宣称的合法性 |
| **D6** Claude Code 版本 pin | 记录 CLI + 实际模型；full id 优先；max-turns 5；对外 3 reps；更新即重跑 | 决定跨期可比性 |
| **D7** L2 适用变更 | 仅同模型 / 同 provider；模型升级、网关切换走迁移门 + L3 | 防止把模型收益算成代码收益 |
| **D8** L2 例外 | 仅成本门可签字豁免；质量非劣门不可 | 防止「少报换 token」 |
| **D9** 校准与 L3 节奏 | 事件驱动 + 季度；空对照校准在 P1 一次 | 控制成本与噪声底漂移 |
| **D10** 数据保留 | 摘要报告入库；原始 runs / audit / wireBody 外置 | 控制敏感数据与仓库体积 |
| **D11** 历史 provenance | 最小补录 + `NOT_REPRODUCIBLE`；不重建环境 | 历史数据只作证据，不作活基线 |
| **D12** 只读分析器 | 纳入 `main` CI（纯读、无 LLM、离线、确定性） | 每次提交拦指标 / schema 漂移 |
| **D13** 摘要报告落位 | `main` `docs/report/token-eval/`；原始外置；`eval/bench` 放 harness / campaign | 证据可追溯、仓库不膨胀 |
| **D14** 对外宣称审批 | 无 L3 报告 + `environment.json` + 产品签字，不得用「通用 Agent 20~30%」口径 | 防止单次采样当结论 |

**本轮盘问（2026-11-10）固化**：评测面 eval-only；E baseline / C_ref / external reference 命名分离；L2 配对回归为 token 相关改动的硬门；CARC 主成本 + USD 对外 + `totalTokens` / `cacheHitRate` 全报告；judge 主质量门；L3 只作宣称门；C_ref 保留 L3；长期 `eval/bench`；L2 仅同模型 / 同 provider；Claude Code pin 与 3 reps；空对照校准先于阈值；Vul4J 30 + clean-MR 首版；仅成本门可豁免；摘要入库 / 原始外置；历史 provenance 最小补录。收口补充：只读分析器进 `main` CI；摘要报告落 `docs/report/token-eval/`；对外宣称需 L3 + environment + 签字；ADR-0016/0017 即时起草。

**已决：新立两个 ADR**：

- [ADR-0016 评测面隔离](../../adr/0016-evaluation-plane-isolation.md)：长期 `eval/bench` 分支、`C_ref` eval-only、生产入口不可 import；生产配置选择面不复活。
- [ADR-0017 Token 优化判据](../../adr/0017-token-optimization-gates.md)：L1/L2/L3 三层门；C_ref `totalTokens` 仅 L3 参考分母；Claude Code 为外部参照；ADR-0004 的 S/A/B 限定为历史实验口径。

> 编号以立项时主线 ADR 序列为准；跨线引用仍遵守「主线 ADR-XXXX / Demo 线 ADR-XXXX」限定语纪律。

---

## 11. 风险与反模式

| 反模式 | 后果 | 对策 |
|---|---|---|
| 「恢复 C 就万事大吉」 | 把机制差异当版本对照，无法归因 | L2 用 E 前后快照；C 只进 L3 |
| 用历史 C 数字当活锚 | 环境漂移被误读为优化收益 / 损失 | 同窗口、同 judge、同模型；历史数据标 `NOT_REPRODUCIBLE` |
| 只比 `totalTokens` | CARC 不降，假优化 | 四行报告；CARC 主指标 |
| 把 C_ref `totalTokens` 当 L2 主门 | 参考分母重新变成游戏化目标 | 只在 L3 展示；L2 用 CARC |
| 例外无期限 / 无回滚 | 质量或成本门被静默绕过 | 签字 + 过期日 + 回滚计划；质量门不可豁免 |
| 原始 `wireBody` 入库 | 源码 / 敏感信息泄漏、仓库膨胀 | 摘要入库，原始外置 |
| 只在项目启动校准一次 | 噪声底漂移，阈值失效 | 事件驱动 + 季度重校准 |
| 把模型 / 网关变更套进 L2 | 代码收益与模型收益混为一谈 | 走迁移门 + L3 |
| 跨 provider 直接比 token | 语义不同，结论无效 | 以 USD / 统一价目为主；token 辅助并注明 |
| 把 C 写成严格质量上限 | E 已高于 C 的 judge Recall，叙事自相矛盾 | 称「信息参照」；同时报告双向差异 |
| eval-only 开关泄进生产 | 配置选择面借尸还魂 | 依赖规则 + 入口隔离 + ADR |
| judge / 模型漂移不记录 | 质量变化归因错误 | environment.json + 固定 judge 版本 |
| 冷热混用 | 缓存效应污染质量与成本 | rep1 单列，rep2+ 主口径 |
| CI 跑全量 LLM 评测 | 成本高、波动大、门不可用 | CI 只做确定性门；评测按 campaign |
| 用单次 Claude Code 结果做宣称 | 方差大，不可复现 | ≥3 reps 或标注单次；配对统计 |
| 无 L3 证据对外宣称 | 单次采样被当结论，误导外部判断 | L3 报告 + environment.json + 产品签字 |
| 在 30 案上反复调参 | 过拟合 | 预先声明主指标；保留 holdout / 定期换集 |
| 静默丢失败样本 | 覆盖率虚高 | failures.json + coverage 门 |
| C 的 80k 预算被改而不留痕 | 历史与未来不可比 | 预算版本化 + golden bytes |

---

## 12. 结论

1. C 从 `main` 退役是 ADR-0014 / ADR-0015 的正确结果；问题不是「C 不在主线」，而是「主线没有同基线的活对照与可复跑评测装置」。
2. C 是信息参照，不是成本分母，也不是严格质量上限；历史 C 数字是冻结证据，不是未来标准。
3. 未来 token 优化以 **L2：E 基线快照 vs E@candidate 同窗口配对**为主战场；L1 管质量，L3 管定位；L2 是 token 相关改动的硬门。
4. L3 的通用外部 Agent 参照选 **Claude Code**，复用 Demo 线已有的同仓、同 diff、同 judge、单列报告实现；跨模型比较以成本（USD / 统一价目）为主，token 语义不作等价。
5. C 以 **eval-only 全仓参照（C_ref）** 保留在长期 `eval/bench` 分支；`main` 只保留只读分析器，不复活配置选择面；C_ref 的 `totalTokens` 只在 L3 作参考分母。
6. 判据落地需要 ADR-0016（评测面隔离）与 ADR-0017（判据与阈值）固化；阈值先作 provisional，空对照校准后再定稿。
7. 例外仅限成本门，质量非劣不可豁免；摘要报告入库，原始 runs / audit / wireBody 外置。
8. 只读分析器进 `main` CI；L2/L3 摘要报告落 `docs/report/token-eval/`；对外宣称必须 L3 报告 + 环境 + 产品签字。

---

## 附录 A：指标字典

| 指标 | 公式 / 口径 | 单位 | 角色 | N/A 语义 |
|---|---|---|---|---|
| `uncachedInputTokens` | usage 中未命中缓存的输入 | token | 成本分解 | 缺失记 0（保守上界） |
| `cachedInputTokens` | usage 中命中缓存的输入 | token | 解释变量 | 无缓存计量记 `null`，不记 0 |
| `cacheWriteTokens` | 缓存写入输入 | token | 成本分解 | DeepSeek 通常 0 |
| `outputTokens` | 模型输出 | token | 成本分解 | 缺失即校验失败 |
| `totalInputTokens` | 三者之和 | token | 辅助 | — |
| `totalTokens` | `totalInputTokens + outputTokens` | token | 辅助；不作唯一成本门 | — |
| `E/C_ref totalTokens` | L3 参考比例 | 比率 | 仅 L3 展示；不进 L2 门 | 无 C_ref → `null` |
| `cacheHitRate` | `cachedInput / totalInput` | 比率 | 解释变量 | 分母 0 / 无缓存计量 → `null` |
| `CARC` | `uncachedInput + cacheWrite + output + toolCost` | token | **L2 主目标** | 无缓存计量时按全输入计 |
| `RIE` | `recall × precision / (totalTokens / 1K)` | 比率 | 辅助 | recall/precision/total 任一 null → `null` |
| `attemptedToolCalls` | 模型发起的工具调用数（含预算拒绝） | 次 | L2 有界性 | 必须记录 |
| `executedToolCalls` | 实际执行的工具调用数 | 次 | 有界性 | 必须记录 |
| `requests` | wire 请求数 | 次 | 有界性 | 必须记录 |
| `rounds` | 循环轮数 | 轮 | 解释 | — |
| `truncationReasons` | `TOOL_BUDGET_EXHAUSTED` 等 | 列表 | 解释停止原因 | 空数组 = 未截断 |
| `lineRecall` / `linePrecision` / `lineF1` | rule 或 judge 行级匹配 | 比率 | L1 质量 | 分母 0 → `null` |
| judge Recall / Precision | judge 裁定后行级匹配 | 比率 | L1 质量主指标 | 无 truth → 阴性对照 |
| zero-finding rate | 无 finding run / 总 run | 比率 | L1 质量 | — |
| negative-control FP per case | clean MR 每案假阳性数 | 个 | L1 质量 | 无 clean MR → `null` |
| human acceptance rate | 人工接受 finding / 总 finding | 比率 | 生产 KPI | 无处置数据 → `null` |
| `total_cost_usd` | Claude Code CLI 回报 | USD | L3 成本主指标 | 缺失 → `null`，不记 0 |
| `num_turns` | Claude Code 轮数 | 轮 | L3 解释 | 缺失 → `null` |
| `permission_denials` | 被拒工具调用数 | 次 | L3 公平性 | 必须记录 |
| latency | 端到端墙钟 | ms | 辅助 | — |

---

## 附录 B：报告模板

### B.1 L2 报告（JSON 形状示意）

数字为形状占位，不代表真实结果；`null` 表示 N/A，不写 0。`totalTokens` / `cacheHitRate` 必须报告；`C_ref` 参考分母只在 L3 报告，不进 L2 门。

```json
{
  "kind": "l2-token-bench",
  "campaignId": "<id>",
  "baseline": {"ref": "<tag|commit>", "model": "<id>"},
  "candidate": {"ref": "<commit>", "model": "<id>"},
  "dataset": {"cases": 30, "negativeControl": 50, "hash": "<sha>"},
  "environmentRef": "environment.json",
  "coverage": {"planned": 180, "executed": 180, "failed": 0, "note": "30 cases × 3 reps × 2 arms"},
  "metrics": {
    "baseline": {
      "cachedInputTokens": {"mean": 0, "std": 0},
      "uncachedInputTokens": {"mean": 0, "std": 0},
      "outputTokens": {"mean": 0, "std": 0},
      "totalTokens": {"mean": 0, "std": 0},
      "cacheHitRate": {"mean": 0, "std": 0},
      "carc": {"mean": 0, "std": 0},
      "judgeRecall": {"mean": 0, "std": 0},
      "judgePrecision": {"mean": 0, "std": 0},
      "attemptedToolCalls": {"mean": 0, "std": 0},
      "requests": {"mean": 0, "std": 0}
    },
    "candidate": {},
    "paired": {
      "carcRatio": {"mean": 0, "ci95": [0, 0]},
      "uncachedRatio": {"mean": 0, "ci95": [0, 0]},
      "outputRatio": {"mean": 0, "ci95": [0, 0]},
      "judgeRecallDiff": {"mean": 0, "ci95": [0, 0]},
      "judgePrecisionDiff": {"mean": 0, "ci95": [0, 0]}
    }
  },
  "gates": {
    "cost": {"pass": false, "rule": "carcRatio <= 0.90 && ci95[1] < 1.00"},
    "quality": {"pass": false, "rule": "paired non-inferiority"},
    "boundedness": {"pass": false, "rule": "attempts/requests/output within budget"},
    "reproducibility": {"pass": false, "rule": "audit replay + golden bytes"}
  },
  "claimsAllowed": false
}
```

### B.2 L3 报告（Markdown 骨架）

```markdown
# L3 定位报告 <campaign-id>

## 环境
- 数据集 / case 数 / 真值 hash
- 模型 / 部署版本 / provider 类别
- judge 模型 / 提示词版本 / 温度 / top_p
- Claude Code CLI 版本 / 实际模型 / max-turns
- 时间窗 / gateway probe

## 覆盖
- E / C / Claude Code 的成功、失败、超时、截断、权限拒绝

## 三列指标
| 指标 | E | C_ref（eval-only） | Claude Code |
|---|---:|---:|---:|
| judge Recall | | | |
| judge Precision | | | |
| totalTokens | | | |
| CARC / USD | | | |
| cacheHitRate | | | N/A |
| turns | | | |

## 配对比较
- E vs C（同模型）：质量 / CARC / totalTokens
- E vs Claude Code（跨模型）：质量 / 成本（USD 或统一价目）

## 结论与宣称
- 是否允许使用「通用 Agent 20~30%」口径
- 禁止项与限定语
```

### B.3 `environment.json` 模板

```json
{
  "campaignId": "<id>",
  "evaluation": {"branch": "eval/bench", "campaign": "<id>", "calibrationRef": "<id|null>"},
  "git": {"branch": "<branch>", "commit": "<sha>", "tag": "<tag|null>"},
  "runtime": {"node": "<version>", "os": "<os>", "machine": "<id>"},
  "model": {
    "requestedId": "<id>",
    "actualDeployment": "<version|null>",
    "providerClass": "<official|gateway>",
    "baseUrlClass": "<class>"
  },
  "gateway": {
    "cacheProbeBefore": {"hitRate": null, "blockAligned": null},
    "cacheProbeAfter": {"hitRate": null, "blockAligned": null}
  },
  "judge": {"model": "<id>", "promptVersion": "<id>", "temperature": 0.2, "topP": 0.95},
  "prompts": {"zoneA": "<version>", "toolsSchema": "<version>"},
  "claudeCode": {"cliVersion": "<version>", "requestedModel": "<id>", "actualModels": [], "maxTurns": 5},
  "window": {"start": "<ISO-8601>", "end": "<ISO-8601>", "timezone": "<tz>"},
  "dataset": {"casesFile": "<path>", "caseCount": 30, "hash": "<sha>"}
}
```

未知字段一律 `null`，不写 0；key 不落盘。

### B.4 宣称模板

```text
在 <数据集 / case 数>、同一真值、同一 judge（<模型/版本>）、同一 <窗口> 下：
- ReviewAgent E 的 judge Recall = X%（Claude Code 的 A%）
- judge Precision = Y%（Claude Code 的 B%）
- 计费成本 = Z（Claude Code 的 C%）
- C_ref 列（同模型全仓信息参照）单列报告：Recall = U%，CARC = V；E/C_ref totalTokens = W（仅参考分母）
限定：跨模型 token 语义不同，成本以 <USD / 统一价目> 为准；CLI / 模型版本见 environment.json。
```

---

## 附录 C：现有资产映射

| 资产 | 位置 | 状态 | 动作 |
|---|---|---|---|
| C_ref 全仓注入 | Demo `packages/review-pi/src/zoneb/full-repo-injection.ts` | 已退役（main）/ 历史实测（demo） | 移植到 `eval/bench` 的 `src/eval/context/`，eval-only |
| C_ref 审计字段 | Demo `contracts/run.ts` `FullRepoRecord` | 已退役（main） | 评测侧 sidecar，不复活生产契约 |
| A–E 矩阵配置 | Demo `contracts/config.ts` | 历史 | 仅作移植参考；不进 main |
| metrics | Demo `src/metrics/` | 未实现（main） | 移植到评测分支 |
| judge | Demo `src/judge/` | 未实现（main） | 移植；固定版本 |
| experiment runner | Demo `src/experiment/` | 未实现（main） | 移植并适配 `runReview` 无 `configId` |
| 空对照校准 runner | 未实现 | 未实现（main） | P1-0 新增；baseline vs baseline 双 arm |
| Claude Code 参照 | Demo `src/reference/` + `scripts/run-claude-code-reference.ts` | 未实现（main） | 移植；单列报告 |
| 网关探针 | Demo `scripts/probe-gateway-cache.ts` | 未实现（main） | 移植；L2/L3 运行前后各一次 |
| 只读分析器 | Token 方案 §4.2 列为主线缺失 | 未实现 | 在 main 新增；纯读 |
| 历史 `runs/phase2-pi` | 本机未跟踪（1598 文件）；Demo 仅 `REPORT.md` | 历史实测 | 冻结证据；补 provenance；标 `NOT_REPRODUCIBLE` |
| VUL4J 评测方案 | `docs/design/05-evaluation/` | 已实现（文档） | 数据集与判定链参考 |
| ADR-0004 / 0011 | 主线 ADR | 已接受 | S/A/B 限定为历史实验口径；新判据另立 ADR |

---

## 附录 D：历史数据解读示例

以 `runs/phase2-pi` 的 E / C_ref 历史数字为例，说明为什么不能直接用 `E ≤ C×30%` 做主成本门：

```text
totalTokens: E 129,516.9 / C 373,900.4 = 34.6%   → 名义上未达标
CARC:        E  57,278  / C  65,420  = 87.5%   → 真实成本差距很小
```

若把 `E ≤ C×30%` 当唯一成本门：

- 结论会是「E 未达标」，但 CARC 表明 E 相对 C 的真实账单差距只有 12.5%；
- 若通过「扩大稳定前缀、提高缓存命中」把 totalTokens 压到 30% 以下，CARC 可能几乎不变，属于假优化；
- 反过来，一个只降低 uncached / output 的真实优化，可能对 totalTokens/C 比例影响很小，被误判为无效。

因此：

1. **L2** 用 CARC 作为主目标，uncached / output 分解，totalTokens 辅助；
2. **L3** 才报告 `E/C_ref` 参考比例，且同时报告 CARC 与 C_ref 的缓存结构；
3. 任何「20~30%」宣称必须说明是对 C_ref、对 Claude Code，还是对同基线，三者不可混用。

---

## 附录 E：待决问题清单

| 编号 | 问题 | 建议 | 负责人 |
|---|---|---|---|
| Q1 | L1 绝对质量下限具体数值 | 已决 D2：首次基线跑后由产品设定；临时用配对非劣 | 产品 / 主线 owner |
| Q2 | L2 样本量与 reps | 已决：30 case × 3 reps；冒烟 10 × 2 | 评测 owner |
| Q3 | L2 门阈值是否按优化类型分档 | 已决 D3：先统一 CARC ≤ 0.90；空对照校准后按机制分档 | 架构 / 产品 |
| Q4 | 评测分支长期维护还是按战役创建 | 已决 D4：长期 `eval/bench` + campaign tag | 工程 owner |
| Q5 | Claude Code 版本 pin 策略 | 已决 D6：CLI + 实际模型；full id 优先；更新即重跑 L3 | 评测 owner |
| Q6 | 是否把只读分析器纳入 main CI | 已决 D12：是；纯读、无 LLM、可离线 | 工程 owner |
| Q7 | 评测集是否扩充 / holdout | 已决：首版 Vul4J 30 + clean-MR；扩充 / holdout 待定 | 研究 owner |
| Q8 | 对外宣称的审批流程 | 已决 D14：L3 报告 + environment.json + 产品签字；未过只能写单列事实 | 产品 / 市场 |

---

## 结语

「没有 C 组」是一个真实缺口，但它指向的不是「把 C 搬回主线」，而是「把评测从一次性的历史实验变成可持续的工程能力」。C 是信息参照，Claude Code 是外部定位，E 的前后配对才是 token 优化的日常裁判。三层分开之后，C 的缺席不再阻塞优化；恢复 C 也不必以复活配置选择面为代价。
