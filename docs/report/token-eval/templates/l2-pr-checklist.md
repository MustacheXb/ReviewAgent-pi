# L2 硬合并门 PR 清单（token 相关改动）

> 复制到 PR 描述并逐项附证据。缺任一项不得合并；质量非劣不可豁免。
> 模板版本：2026-11-13（#46）。

## 1. 变更身份

- [ ] PR / issue：
- [ ] 变更摘要（明确是否 **token 相关**：上下文 / 工具 / 提示词 / 计费 / 缓存）：
- [ ] **baseline ref**（完整 tag / commit）：
- [ ] **candidate commit**：
- [ ] 同模型 / 同 provider / 同 judge / 同 prompt / 同 tool schema：
- [ ] **数据集**文件 + hash + case 数：
- [ ] **calibrationRef**（当前有效校准）：
- [ ] **随机臂序**（`--randomize-arms`，seed 入 plan.json；不得固定 baseline→candidate）：
- [ ] 同一 ≤48h 窗口；双 arm 按 case 交错；reps：
- [ ] L2 主口径 warm（rep2+）；cold 单列：
- [ ] 样本功效：CARC ≥43 案 / 3pp 质量 ≈220 案；不足则标 `underpowered/diagnostic`，不得作为合并通过证据：

## 2. 证据

- [ ] `environment.json` 路径 / 摘要（模型 / 网关 / judge / 窗口 / hash）：
- [ ] `l2-report.json` + 人读报告路径：
- [ ] **coverage**：planned / executed / judged / failed =：
- [ ] **failures** 逐项（judge 截断 / 超时 / 沙箱）：
- [ ] judge Recall / Precision 配对 CI：
- [ ] **零 finding 率**；**clean-MR 阴性对照 FP**（无 clean MR 记 N/A）：
- [ ] **coverage** ≥ 当前阈值；failures 逐项：
- [ ] CARC 比率 + 配对 CI；uncached / output 分解：
- [ ] attempted tool calls / requests 有界性；output / requests 上界：
- [ ] 可复现：auditPath、cacheBreaks=0、`--report-only` 字节稳定：

## 3. 门判定

- [ ] quality（质量非劣 + 零 finding + 阴性对照 + coverage）pass；**不可豁免**
- [ ] cost（CARC / 分解 / attemptedToolCalls / requests）pass，或已附成本门例外：
- [ ] boundedness pass
- [ ] reproducibility pass
- [ ] 样本功效足够（否则 `underpowered/diagnostic`，不得合并）
- [ ] comparability（同 case / reps / 模型 / harness budget）pass（如适用）
- [ ] 未把三列 / L2 结果混入 S/A/B；未通过时只写单列事实

## 4. 签字

- [ ] 评测 owner 确认：
- [ ] 代码评审确认：
- [ ] 产品 owner（仅成本例外时）：
- [ ] 日期 / 过期日（如有例外）：

## 5. 备注

- 样本量 / 功效说明（30 案是否足够；是否扩样）：
- 已知限制 / 后续重校准触发：
