# 0017. Token 优化判据——L1/L2/L3 三层门

**状态**：已接受（2026-11-10，盘问收口；L2 阈值 provisional，待 P1 空对照校准后补记）
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
