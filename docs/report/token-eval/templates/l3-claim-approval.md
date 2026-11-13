# L3 对外宣称审批清单

> 规则（ADR-0017 §4）：对外宣称必须同时具备 **L3 报告 + environment.json +
> 产品签字**；`claimsAllowed = false` 时只能写**单列事实**，不得写相对结论。
> 模板版本：2026-11-13（#46）。

## 1. 前置条件

- [ ] **L3 报告**路径 / `claimsAllowed`（必须 true）：
- [ ] **environment.json** 路径；commit / 模型 / 网关 / judge / prompt /
      tool schema / 窗口 / 数据集 hash / Claude Code CLI 版本与实际模型：
- [ ] 三列 E / C_ref / Claude Code 齐全；单列；不进 S/A/B：
- [ ] **Claude Code 同模型 harness**（`--model` 与 E 一致 + modelUsage 校验）；
      harness budget 记录 bounded / ceiling：
- [ ] comparability：同 case 数（≥30）/ reps（≥3）/ 同模型 / 同 harness budget：
- [ ] quality：E Recall ≥ Claude×0.9；Precision ≥ Claude×1：
- [ ] cost：E billed USD ≤ Claude×**0.3**（USD / 统一价目；不得用 totalTokens
      代替成本结论）；C_ref `totalTokens` 仅参考分母：
- [ ] cache：E ≥ **0.85**；coverage：三列均 ≥ **0.9**；environment / signOff 全过：
- [ ] failures / coverage 逐项留痕；无静默丢样：

## 2. 宣称文本

- 数据集 / case 数 / 窗口：
- 宣称正文（同模型 harness 对照；不同模型 token 语义不作等价；
  不得写「通用 Agent 20~30%」）：
- C_ref 参考分母写法（只作参考；不进成本门）：
- 限定语 / 已知限制：
- 拟发布渠道 / 日期：

## 3. 产品签字

> 产品签字是**行政管理门**，不能替代 L3 报告、environment、三列 / 门判定
> 等前置条件；任一前置条件不满足时只能写单列事实。

- 产品 owner **签字**：
- 签字日期：
- 有效期 / 复核日期：
- 评测 owner 会签：
- 发布负责人放行：

## 4. 未通过时的降级写法

- 只写单列事实：E / C_ref / Claude Code 各自质量、成本、tokens、时延；
- 不写相对结论、不写不同模型成本等价、不引用过期 / `NOT_REPRODUCIBLE` 数字；
- 任何对外稿必须引用 L3 报告与 environment.json。
