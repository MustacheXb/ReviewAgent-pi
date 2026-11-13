# Token 优化治理 runbook（L2 合并门 / 例外 / L3 宣称审批）

> 状态：团队可执行 runbook（#46）。依据 ADR-0016（评测面隔离）与 ADR-0017
> （L1/L2/L3 判据）。本文件只规定**评测与合并治理**，不改变生产运行时、
> 协议、CLI、`ConfigId` 或 `RunAudit`。

## 1. 先判定走哪条门

| 改动类型 | 必过门 | 说明 |
|---|---|---|
| 文档 / 无关修复 / 纯测试 | 确定性 CI | 不跑真实 L2 / L3；不阻塞日常迭代 |
| **token 相关运行时**：上下文组装、工具集 / 工具 schema、提示词、计费口径、缓存行为、token 记账 | **L2 硬合并门** | 同模型 / 同 provider / 同 judge / 同 prompt；按 case 配对 |
| 模型升级、provider / 网关切换 | **迁移门 + L3** | 不套 L2；模型 / 网关收益不能算成代码收益 |
| 对外宣称 / 发布定位（含「通用 Agent 20~30%」口径） | **L3 + environment.json + 产品签字** | 未通过只能写单列事实 |
| 数据集 / judge / 提示词 / 工具 schema 变更 | **重做空对照校准**，再按 L2 / L3 | 校准结果只改阈值，不判收益 |

> 当前校准结论（ADR-0017 2026-11-12 补记）：30 案下 CARC 主门与 3pp 质量非劣
> 统计功效不足（CARC 约需 43 案、质量 3pp 约需 220 案）。因此 30 案 L2 处于
> **underpowered / diagnostic** 状态：**token 相关改动不得以「L2 通过」为由
> 合并**。要恢复合并资格，必须扩样并重跑 L2，或由产品通过 **ADR 修订目标线**
> （属于判据变更，不是单次合并例外）；不得用产品 / 评测 owner 口头决策绕过
> 质量门或样本功效。

### 1.1 迁移门 + L3（模型 / provider / 网关变更）

- 触发：模型 id、部署版本、provider / 网关类别、judge 模型或提示词任一变化。
- **不套 L2**：L2 只覆盖同模型 / 同 provider 的运行时改动；模型 / 网关收益
  不得算成代码收益。
- 必查：
  - [ ] 新模型 / 部署版本、provider / base URL 类别、时间窗；
  - [ ] 迁移门兼容性证据（协议 / 工具 schema / 审计形状不变）；
  - [ ] judge 异构约束与版本；必要时重做空对照校准；
  - [ ] L3 三列报告（E / C_ref / Claude Code）与 environment.json；
  - [ ] 质量 / 成本目标线重新确认；未过 L3 只能写单列事实。
- L3 的 Claude Code 列是**同模型 harness 对照**（`--model` 与 E 相同并校验
  `modelUsage`）；不是「Claude 模型」参照；不得据此写跨模型 / 通用 Agent 宣称。

## 2. L2 硬合并门（token 相关改动）

### 2.1 适用范围与冻结条件

- **同模型、同 provider、同 judge、同 prompt / tool schema、同数据集**；
- baseline = 冻结 E 基线快照（完整 ref，如 `eval-e-baseline-2026-11-11`），
  candidate = 本次优化 commit；其他运行时代码一致；
- 双 arm 在同一 ≤48h 窗口内按 case 交错执行；**必须使用随机臂序**
  （按 case×rep 确定性洗牌，seed 写入 plan.json），不得固定 baseline → candidate；
  同 reps；**L2 主口径 = rep2+（warm）**；
- 每个 case 先跨 rep 平均，再按 case 配对；CARC 为成本主指标，
  `uncachedInput` / `output` 为分解；`totalTokens` / `cacheHitRate` 必须报告但
  不单独作结论；
- 当前数据集无 clean-MR 时，阴性对照阈值只能记 N/A，不得视为通过。

### 2.2 合并前必查（PR checklist）

使用模板 [`templates/l2-pr-checklist.md`](templates/l2-pr-checklist.md)，逐项附证据：

- [ ] baseline ref 完整（tag / commit）；candidate commit 明确；
- [ ] 数据集文件 + hash + case 数；`calibrationRef` 指向当前有效校准；
- [ ] **臂序 randomized**（seed 入 plan.json）；同 case / reps / 同窗口；
- [ ] `environment.json`（模型 / 网关 / judge / 窗口 / 数据集 hash）在位；
- [ ] `l2-report.json` + 报告链接；coverage 与 failures 逐项留痕（不静默丢样）；
- [ ] **L2 质量约束（L1 指标）**：judge Recall / Precision 配对 CI、零 finding
      率、clean-MR 阴性对照 FP（无 clean MR 记 N/A）、coverage 满足当前阈值；
      质量非劣**不可豁免**；
- [ ] **L2 成本门**：CARC 比率与配对 CI、uncached / output 分解、attempted
      tool calls / requests 有界性、可复现门逐项 pass；
- [ ] **样本功效**：若低于 CARC 43 案 / 质量 220 案，报告标记
      `underpowered/diagnostic`，不得作为合并通过证据；
- [ ] 有界性与可复现（auditPath、cacheBreaks、report-only 字节稳定）；
- [ ] 三列 / L2 结果不混入 S/A/B；未通过时只在 PR 写单列事实；
- [ ] 复核 `progress.log` / `failures.json`，确认无无界超时或静默失败。

### 2.3 门失败处理

- 质量非劣失败：**不得合并**；修代码或回滚，不允许用成本收益论证。
- 成本门失败：默认不合并；仅可按 §3 申请书面例外。
- 有界性 / 可复现失败：先修复评测装置或运行环境，不得只改阈值。
- 样本量 / 功效不足：报告状态 `underpowered/diagnostic`，**不得合并**；
  按 ADR-0017 §5 扩样 / 重校准，或用 ADR 修订目标线（非合并例外）。

## 3. 成本门例外（仅成本门）

- **仅成本门可豁免；质量非劣、coverage、有界性、可复现门不可豁免。**
- 样本功效不足 / `underpowered/diagnostic` 不适用本例外；不得用成本例外
  绕过质量门或样本量要求。
- 例外必须使用模板 [`templates/l2-cost-exception.md`](templates/l2-cost-exception.md)，
  包含：变更 / commit、L2 报告、失败的成本指标、业务理由、**过期日**、
  **回滚计划**、监控指标、产品签字与日期。
- 过期日不得晚于下一个 release 或 30 天（取较早者）；到期未续期自动失效。
- 例外只覆盖单次变更，不可累积 / 转授；质量门仍需 pass。
- 评审 / 发布负责人有权拒绝任何例外；拒绝理由留痕在 PR。

## 4. L3 对外宣称审批

### 4.1 前置条件（缺一不可）

- **L3 报告**：E / C_ref / Claude Code 三列，单列报告，不进 S/A/B；
- **environment.json**：模型 / 网关 / judge / prompt / tool schema / 窗口 /
  数据集 hash / Claude Code CLI 版本与实际模型；
- **产品签字**：使用模板 [`templates/l3-claim-approval.md`](templates/l3-claim-approval.md)；
- L3 `claimsAllowed = true`（含 comparability / quality / cost / cache /
  coverage / environment / signOff 全门）。

### 4.2 未通过时的写法

- `claimsAllowed = false` 时只能写**单列事实**（E / C_ref / Claude Code 各自
  的质量、成本、tokens、时延），**不得写相对结论**、不得写「通用 Agent
  20~30%」、不得把 C_ref 的 `totalTokens` 当成本分母或等价比较。
- 不同模型的 token 语义不作等价；同模型 harness 对照才可对照 token；
  成本以 USD / 统一价目表为准。产品签字**不能**替代三列 / environment /
  门判定等前置条件。
- 任何对外稿必须引用 L3 报告与 environment；不得引用过期 / 不可复跑的
  历史数字（`runs/phase2-pi` 标 `NOT_REPRODUCIBLE`，只作证据）。

### 4.3 宣称模板（由产品签字确认后使用）

```text
在 <数据集 / case 数>、同一真值、同一 judge（<模型/版本>）、同一 <窗口> 下：
- ReviewAgent E 的 judge Recall = X%（Claude Code 的 A%）
- judge Precision = Y%（Claude Code 的 B%）
- 计费成本 = Z（Claude Code 的 C%）
- C_ref 列仅作同模型信息参照（totalTokens 仅参考分母）
限定：不同模型 token 语义不作等价；同模型 harness 对照；成本以 <USD / 统一价目> 为准；版本见 environment.json。
```

## 5. CI 与 campaign 节奏

| 类型 | 触发 | 执行内容 | 是否进默认 CI |
|---|---|---|---|
| **确定性 CI** | 每次提交 / PR | typecheck、单元测试、golden bytes、schema、审计重放、评测面隔离守卫、只读分析器 | 是 |
| **L2 冒烟** | token 相关改动早期 | 10 case × 2 reps，双 arm，交错，失败隔离 | 否（环境变量门控） |
| **L2 主跑** | token 相关改动合并前 / 发布前 | ≥43 案（CARC）/ ≈220 案（3pp 质量）或 ADR 修订目标线；30×3 仅诊断 | 否（campaign 触发） |
| **空对照校准** | 首次建立 L2；模型 / provider / judge / 提示词 / 工具 schema 变更 | baseline vs baseline，30×3×2（按功效扩样） | 否 |
| **L3** | 季度 / 大版本 / 对外宣称前 / 上述变更 | E + C_ref + Claude Code 三列 | 否 |

- 真实网关 / judge / Claude Code 调用**永不进默认 CI**；默认测试零网络。
- campaign 输出目录 gitignored；摘要报告入库；原始 runs / audit / wireBody 外置。

## 6. 数据保留

- **摘要报告 / environment / L2 / L3 JSON**：入 `docs/report/token-eval/`，随
  commit 永久保留；报告不得含 key。
- **原始 runs / audit / wireBody**：外置存储（本机 gitignored），至少保留到
  **最后一次引用该数据的 L3 / 宣称之后 12 个月**；过期删除需记录。
- 历史 `runs/phase2-pi` 只作证据，标 `NOT_REPRODUCIBLE`；不冒充活基线。
- 删除 / 迁移原始数据前，确认摘要报告与复算入口仍可独立解释结论。

## 7. 角色与升级

| 角色 | 职责 |
|---|---|
| 变更作者 | 判定是否 token 相关；准备 baseline/candidate、L2 证据、PR checklist |
| 评测 owner | 运行 campaign / 校准；确认 environment、coverage / failures、阈值版本 |
| 代码评审 | 检查门证据与实现；拒绝缺证据 / 混入 S/A/B 的结论 |
| 产品 owner | L2 成本例外签字；L3 宣称签字；阈值 / 目标线确认 |
| 发布负责人 | 对外文稿最终放行；抽查 L3 + environment + 签字 |

升级：质量门失败 / 数据缺失 / 阈值过期 → 不得合并或宣称；升级到评测 owner +
产品 owner 决策，必要时重做校准或扩样。

## 8. 相关文档

- [ADR-0016 评测面隔离](../../adr/0016-evaluation-plane-isolation.md)
- [ADR-0017 Token 优化判据](../../adr/0017-token-optimization-gates.md)
- [评测 RUNBOOK](RUNBOOK.md)
- [L2 PR 清单模板](templates/l2-pr-checklist.md)
- [L2 成本门例外模板](templates/l2-cost-exception.md)
- [L3 宣称审批模板](templates/l3-claim-approval.md)
- [评测基准方案](<../../design/05-evaluation/ReviewAgent Token 优化评测基准方案——三层对照体系与 Claude Code 外部参照.md>)
