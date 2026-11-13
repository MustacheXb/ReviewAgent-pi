# 0017. Token 优化判据——L1/L2/L3 三层门

**状态**：已接受（2026-11-10，盘问收口；L2 阈值 provisional，2026-11-12 P1 空对照校准后已补记——仅有界性安全上界按实测更新，成本 / 质量 / 分解守卫保留）
**决策基线**：`main`（生产主线）+ 长期 `eval/bench`（评测面，ADR-0016）
**关联**：ADR-0004（S 级判据）、ADR-0008（模型可替换与指标）、ADR-0011（上线门口径）、ADR-0014（分支策略）、ADR-0015（协议 v3）、ADR-0016（评测面隔离）、[ReviewAgent Token 优化评测基准方案](<../design/05-evaluation/ReviewAgent Token 优化评测基准方案——三层对照体系与 Claude Code 外部参照.md>)
**适用范围**：本仓主线 `MustacheXb/ReviewAgent-pi`

## Context

- ADR-0004 / ADR-0011 的 S/A/B 判据以历史配置 C 为锚，属于 A–E 矩阵时期的实验口径；C 已随 E-only 生产化从 `main` 退役（ADR-0014 §2 / ADR-0015）。
- 历史 pi 矩阵中，E 的 `totalTokens` 为 C 的约 34.6%，但 `CARC` 为 C 的约 87.5%；C 的全仓注入形成巨大稳定前缀，大部分输入按缓存价计费。把 C 的 `totalTokens` 当主成本门，会奖励「扩大稳定前缀、让缓存吃掉总 token」的假优化。
- 历史 C 数据 provenance 不完整（缺少模型部署版本、时间窗、网关缓存配置、judge 完整版本），不能作为「今天同条件重跑」的活基线；Demo 线的 E 与 `main` 的 E 已分叉，跨线比较不可归因。
- 因此 token 优化需要一个可复跑、可归因、可治理的判据体系；judge 链与 CARC / RIE 等指标只作为评测面能力存在，不恢复为生产运行时组件。

## Decision

### 1. 三层判据

| 层 | 作用 | 效力 |
|---|---|---|
| **L1 绝对质量门** | 质量有没有掉？ | 质量约束；不依赖 C |
| **L2 配对回归门** | 这次优化真的省了吗？省在哪？ | **token 相关改动的硬合并门** |
| **L3 定位报告 / 宣称门** | 相对信息参照 / 通用 Agent 处于什么位置？ | 只作对外宣称 / 发布定位，不作日常合并门 |

### 2. L1：绝对质量门

- 主指标：同一 judge 版本的 judge line Recall / Precision；rule screening 双列；零 finding 率、阴性对照 FP、证据闸拒绝分布、coverage 为辅助。
- 人工接受率是生产 KPI，不作为每次 token 改动的前置门。
- 绝对下限待首次基线跑后由产品设定；在此之前用「相对 E 基线快照的配对非劣」作为临时替代。
- 建议初始非劣边界：judge Recall / Precision 配对 95% CI 下界 ≥ −3pp；零 finding 率不高于 baseline + 2pp；阴性对照 FP 不高于 baseline + 1σ；coverage ≥ 95%。

### 3. L2：配对回归门

- 对照：**E 基线快照（冻结 tag / commit）vs E@candidate**，同代码谱系、同数据集、同模型、同 provider、同 judge、同 prompt / tool schema、同 reps、同一 ≤48h 窗口，按 case 交错执行，按 case 配对统计。
- **适用范围**：只覆盖同模型 / 同 provider 的运行时改动（上下文组装、工具、提示词、计费口径）。模型升级、网关切换走「迁移门 + L3」，不套 L2。
- 成本主指标：`CARC = uncachedInput + cacheWrite + output + toolCost`；`uncachedInput` / `output` 为分解；`totalTokens`、`cacheHitRate`、`attemptedToolCalls`、`requests` 必须报告，但 `totalTokens` 不得单独作为结论，`cacheHitRate` 只作解释变量。
- 建议初始门：`CARC_candidate / CARC_baseline` 几何均值 ≤ 0.90，且配对 95% CI 上界 < 1.00；`uncachedInput` 比率 ≤ 1.00；`output` 比率 ≤ 1.05；`attemptedToolCalls` / `requests` 比率 ≤ 1.00；有界性与可复现门按评测方案 §6.4。
- 例外：仅成本门可经产品书面签字 + 过期日 + 回滚计划豁免；质量非劣门不可豁免。

### 4. L3：定位报告 / 宣称门

- 三列报告：**E + C_ref（同模型全仓参照）+ Claude Code（跨模型外部参照）**；单列报告，不进 S/A/B 主判定。
- 同一数据集、同一真值、同一 judge、同一时间窗；Claude Code 记录 CLI 版本、实际模型、`max-turns 5`、`total_cost_usd`、`num_turns`、`permission_denials`；对外宣称至少 3 reps，冒烟 1 rep。
- 成本口径：对外以 USD / 统一价目表为主；token 语义跨模型不作等价。
- `C_ref` 的 `totalTokens` 可作 **参考分母**：只在 L3 报告 `E/C_ref` 名义比例，不进入 L2 主门，不单独构成结论，不作真实账单。
- 目标线（数值由产品确认）：E judge Recall ≥ Claude Code × 90%；E judge Precision ≥ Claude Code × 100%；E 计费成本 ≤ Claude Code × 30%；E cacheHitRate ≥ 85%（同窗口、带环境留痕）；三列 coverage ≥ 90%。
- 对外宣称必须同时具备 L3 报告 + `environment.json` + 产品签字；L3 未通过时只能写单列事实，不能写相对结论。

### 5. 校准与节奏

- P1 先跑一次**空对照校准**（baseline vs baseline，同代码、双 arm、同窗口，30 case × 3 reps × 2 arms）测噪声底；校准结果用于确认 / 调整 L2 阈值，不用于判定优化收益。
- 模型 / provider / judge / 提示词 / 工具 schema 任一变更后重做校准；L3 在季度、大版本、对外宣称前及上述变更时触发，不随每个 patch 跑。
- L2 阈值在 ADR 中先记为 provisional；P1 校准后以补记方式固化。

### 6. 数据集与版本

- 首版：Vul4J 30 案 + clean-MR 阴性对照；Defects4J / Multi-SWE-bench Java 留到 L3 或后续扩充。
- Claude Code 记录 CLI 版本与实际模型；模型优先完整 `claude-*` id，不可得时用别名并记录实际模型；CLI / 模型更新后强制重跑 L3。
- 历史 `runs/phase2-pi` 只作最小 provenance 补录与 `NOT_REPRODUCIBLE` 标记，不重建网关 / 部署环境。

### 7. 与历史判据的关系

- ADR-0004 的 S/A/B 判据保留为 **历史 A–E 矩阵实验口径**，不再作为 `main` 的 token 优化门。
- ADR-0011 上线门与人工接受率 KPI 保留为生产运营口径；L1 的人工接受率只作辅助 / 生产 KPI，不替代 L2 的自动化质量非劣门。

## Options

- **继续把 C 的 `totalTokens` 当主成本分母**：否——C 的缓存结构导致名义 token 与 CARC 脱节（34.6% vs 87.5%），会奖励假优化。
- **以 `totalTokens` 为主指标**：否——可被「扩大稳定前缀、提高缓存」游戏化；CARC 更接近真实成本。
- **以人工接受率作为每次改动的质量门**：否——太慢、样本稀疏，适合生产 KPI 而非 L2 自动化门。
- **L3 每次合并都跑**：否——E + C_ref + Claude Code + judge 的成本与波动过高；L3 只作宣称 / 发布门。
- **删除 C_ref，只留 Claude Code**：否——C_ref 回答同模型「信息给满」的参照问题，Claude Code 回答跨模型通用 Agent 问题；二者不可互替。
- **把 Claude Code 纳入 S/A/B 主判定**：否——跨模型，且 ADR-0002 / ADR-0009 已将其定位为外部参照、单列报告。
- **只保留历史 C 数字，不建活对照**：否——历史数据 provenance 不完整、不可复跑，无法归因未来优化。

## Consequences

- **正**：token 优化有可复跑的配对对照；CARC 主指标防止缓存游戏；L1/L2/L3 分离，日常合并与对外宣称各有明确门；C_ref / Claude Code 角色不混；例外与签字让战略取舍可追溯。
- **负/风险**：judge 依赖跨模型裁定，版本漂移必须 pin；配对统计与交错执行需要纪律；阈值 provisional，首轮校准前不能当硬结论；评测成本（30×3×2 + judge）不可忽略；30 案统计功效有限，需要 holdout / 扩充；模型 / 网关变更走 L3，不能复用 L2 结论。
- **中性**：ADR-0004 的 S/A/B 保留为历史实验口径；L2 只覆盖 token 相关改动，不阻塞无关修复；L3 是独立报告，不混入生产判级。

## 补记（2026-11-11）：P0-1 / P0-3 落地

- **E 基线快照**：`eval-e-baseline-2026-11-11`（commit `e724958`，与 `reviewagent-v1.0.0` 同一提交；Config E / 协议 v3 / vendored pi 0.85.1）。重建步骤与机读 manifest 见 `docs/report/token-eval/e-baseline.md` 与 `e-baseline.json`。
- **历史数据**：`runs/phase2-pi` 已补录来源 commit（`b94e461`）、可考时间窗（2026-09-23 → 09-25）、模型（`deepseek-v4-flash`）与 judge（`glm-5-3-260814`），标 `NOT_REPRODUCIBLE`，只作证据；见 `docs/report/token-eval/phase2-pi-provenance.md` 与同名 `.json`。未重建缺失的网关 / 部署环境。
- L2 阈值仍为 provisional，待 P1 空对照校准后按 §5 补记。

跨线限定语纪律：本 ADR 为主线序列 0017；Demo 线 ADR 独立编号，引用须写「Demo 线 ADR-XXXX」。

## 补记（2026-11-12）：P1 空对照校准与 provisional 阈值更新

**校准 campaign**：`p1-calibration-2026-11-12`（`calibrationRef = p1-calibration-2026-11-12`）
· baseline / candidate 同为 `eval-e-baseline-2026-11-11` · 30 case × 3 reps ×
2 arms = 180 单元 · 数据集 `data/vul4j/target-cases.json`（sha256
`fd752f5…315d36`）· `deepseek-v4-flash` @ volcengine · judge `glm-5.2`
（prompt `mcr-bench-llm-hit-judge-2026-09-03+poc1-ext-1`，temperature 0.2 /
top_p 0.95）· 时间窗 2026-11-11T23:42:45Z → 2026-11-12T12:26:12Z
（Asia/Shanghai；两次主机睡眠中断后以 `--resume` 续跑）· 180/180 executed、
179/180 judged（1 条 `VUL4J-75/baseline/rep-1` judge 非法 JSON）· coverage 0.994
· bootstrap 10,000 次 / seed 20261111 / 95% CI。**运行代码等价性**：
`e724958`（基线 tag）→ `c4e5e5f`（本次 checkout）的 `packages/` +
`src/gate` + `src/instrument` 仅 `THIRD-PARTY-NOTICES.md` 1 行差异，pi 内核
运行时字节一致；空对照两臂使用同一 checkout。报告与机读快照见
[`docs/report/token-eval/p1-calibration-2026-11-12/`](../report/token-eval/p1-calibration-2026-11-12/REPORT.md)。

**噪声底（warm = rep2+，按 case 配对）**：CARC ratio **1.045**，ci95
**[0.937, 1.174]**（半宽 11.8pp）；uncached 1.063 [0.951, 1.199]；output
1.001 [0.888, 1.136]；attempts 1.026 [0.957, 1.105]；requests 1.052
[0.993, 1.129]；judge Recall diff **−3.6pp [−11.8, +5.0]**；judge Precision
diff **−7.6pp [−15.8, +0.4]**；zero-finding +1.7pp [−6.7, +10.0]；cacheHit
+0.8pp。观测上界：attemptedToolCalls 21 / requests 41 / outputTokens 59,491。
空对照中心在本轮偏向 candidate（CARC +4.5%、judge 略低）；两臂同代码，
方向一致性提示臂序 / 时段漂移，计入噪声底，不作为收益。

**阈值决定（`DEFAULT_L2_GATE_THRESHOLDS`）**：只更新有确凿数据支撑、且不削弱
政策门的有界性安全上界；成本 / 质量 / 分解守卫保留，因为空对照说明的是
**样本功效不足**，不是阈值定错：

| 阈值 | 校准前 | 校准后 | 决定 |
|---|---:|---:|---|
| `maxCarcRatio` / `maxCarcRatioCiUpper` | 0.90 / 1.00 | 0.90 / 1.00 | **保留**；半宽 11.8pp，需约 43 案 |
| `maxUncachedRatio` | 1.00 | 1.00 | 保留（噪声包线建议 1.20，不采纳：会削弱缓存游戏防护） |
| `maxOutputRatio` | 1.05 | 1.05 | 保留（建议 1.12，不采纳） |
| `maxAttemptsRatio` | 1.00 | 1.00 | 保留（建议 1.10，不采纳） |
| `maxRequestsRatio` | 1.00 | 1.00 | 保留（建议 1.13，不采纳） |
| `qualityNonInferiorityPp` | 0.03 | 0.03 | **保留**（建议 0.16，不采纳：§3 质量非劣不可豁免；3pp 需约 220 案） |
| `maxZeroFindingRateIncreasePp` | 0.02 | 0.02 | 保留（门按均值判定，空对照 +1.7pp） |
| `maxNegativeControlFpSigma` | 1 | 1 | 保留（本次 N/A：数据集无 clean MR） |
| `minCoverage` | 0.95 | 0.95 | 保留（实测 0.994） |
| `maxAttemptedToolCalls` / `maxRequests` / `maxOutputTokens` | 12 / 24 / 48,000 | **24 / 46 / 65,441** | 按实测最大 + ~10% 余量更新 |

**样本功效**：CARC 0.90 + CI 上界 <1.00 需约 **43 案**；质量 3pp 非劣需约
**220 案**（precision 半宽 8.1pp；recall 约 235 案）。因此 **30 案不是 L2
硬门的可用样本量**——扩样与臂序随机化之前，L2 成本 / 质量门只能作为
「已知功效不足」的诊断，不能作为合并放行依据。

**更新后空对照复核**：以最终代码 `--report-only` 重建，
`cost=FAIL quality=FAIL boundedness=PASS reproducibility=PASS`
（coverage 180/180 executed、179/180 judged = 0.994；`claimsAllowed=false`）。
成本 / 质量仍失败是校准应有的结论：空对照没有优化收益，且 30 案无法支撑
3pp 质量非劣 / 10pp CARC 目标；有界性上界修正后不再误杀基线。连续两次重建
`l2-report.json` / `noise-floor.json` / `NOISE-FLOOR.md` 字节一致；报告中的
`outputDir` / `dataset.casesFile` 由代码投影为仓库相对路径。

**限制**：30 案统计功效不足（CARC 约需 43 案、质量 3pp 约需 220 案）；
固定臂序 baseline→candidate 可能引入顺序偏差（本次空对照 CARC +4.5%、
Precision −7.6pp 方向一致），后续校准 / L2 主跑应随机化臂序；ADR-0017 §6
要求首版含 clean-MR 阴性对照，本次数据集没有，`maxNegativeControlFpSigma`
记 N/A，属显式偏差，需补数后重校准；1/180 judge 持久非法 JSON
（`VUL4J-75/baseline/rep-1`），不插补；judge 版本变更后按 §5 重做校准。
空对照结果只用于阈值复核，不用于判定优化收益；对外宣称仍按 §4 执行。

**Claude Code 口径澄清（2026-11-13）**：Claude Code 外部列用于 **Agent
harness 同模型对照**——CLI 以 `--model` 使用与 E 相同的评测模型（`modelUsage`
硬校验，不一致 fail fast），不是「Claude 模型」跨模型参照；报告中不得写
「跨模型」或据此宣称通用 Agent。若需跨模型定位，必须另行配置真实 Claude
模型并单独报告。同模型 5 轮上界下 harness 可能先截断（2026-11-13 三案
3/3 `error_max_turns`、findings 0），质量对照需先定义公平输出预算。

**补记复核（2026-11-12，臂序随机 10×3×2）**：campaign
`p1-armorder-recheck-2026-11-12`（10 案 × 3 reps × 2 arms，`armOrder =
randomized`，seed `20261112`；60/60 executed、59/60 judged）。warm 结果：
CARC ratio **1.058 [0.845, 1.305]**；judge Recall **+14.8pp [+1.3, +29.0]**、
Precision +9.6pp [−8.8, +25.8]；零 finding −5.0pp。固定臂序下 candidate
质量略低的方向**未复现**，更可能是固定臂序 / 时段漂移或 30 案噪声；10 案
功效不足（CARC CI 半宽约 23pp），**不据此修改任何阈值**。方法学结论：后续
L2 主跑 / 校准应使用随机臂序；下一次正式校准仍为 30×3（并按噪声底建议扩到
≥43 案），不得用 10 案下结论。报告见
[`docs/report/token-eval/p1-armorder-recheck-2026-11-12/`](../report/token-eval/p1-armorder-recheck-2026-11-12/REPORT.md)。

