# L2 成本门例外申请（仅成本门可豁免）

> 规则（ADR-0017 §3）：**仅成本门可豁免；质量非劣、coverage、有界性、可复现门
> 不可豁免。** 本模板只用于成本门；质量门失败一律不得合并。
> 模板版本：2026-11-13（#46）。

## 1. 变更与证据

- PR / issue：
- 变更 / candidate commit：
- baseline ref（完整 tag / commit）：
- `l2-report.json` / 报告路径：
- 失败的成本指标（CARC 比率 / CI / uncached / output / attempts / requests）：
- 质量门结果（必须 pass）：judge Recall / Precision CI、zero-finding、
  coverage、failures：
- 有界性 / 可复现门（必须 pass）：

## 2. 申请内容

- 请求豁免的成本阈值 / 偏差：
- 业务理由（为什么不能先修到门内）：
- **不适用声明**：本例外不适用于质量非劣 / coverage / 有界性 / 可复现 /
  样本功效不足（`underpowered/diagnostic`）；上述任一失败不得用本模板。
- 影响面（仅本 commit / 本 release；不可累积、不可转授）：
- **过期日**（不得晚于下一个 release 或 30 天，取较早者）：
- **回滚计划**（触发条件 / 回滚步骤 / 责任人 / 验证）：
- 监控指标与观察期：

## 3. 审批

- 产品 owner **签字**：
- 签字日期：
- 评测 owner 会签：
- 代码评审会签：
- 备注 / 拒绝理由（如有）：

## 4. 失效

- 到期未续期自动失效；失效后该变更必须回到 L2 门内或回滚。
- 续期需重新提交本模板并附最新 L2 证据。
