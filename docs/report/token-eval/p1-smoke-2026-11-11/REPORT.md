# P1 真实 E 冒烟报告（10 case × 2 reps，E-only）

> 状态：**冒烟完成，仅证明评测链路可用**——单 arm（E baseline）、无 C_ref / Claude Code、无配对判定，**不是 L2 回归证据**，也不得用于对外宣称。
>
> campaign：`p1-smoke-2026-11-11` · 日期：2026-11-11 · 分支：`eval/bench`
> 被测代码：`90b72e1028062f97d4f7f0b05056dbbcc8c7c3fb`（#40 实现提交）

## 1. 环境留痕（environment.json 摘要）

| 项 | 值 |
|---|---|
| baseline ref | `eval-e-baseline-2026-11-11` |
| candidate / git commit | `90b72e1`（branch `eval/bench`，无精确 tag） |
| 被测模型 | `deepseek-v4-flash` |
| 网关类别 | `providerClass = volcengine`，`baseUrlClass = gateway-endpoint` |
| 实际部署版本 | N/A（网关不回显部署版本） |
| judge | `glm-5.2`；prompt `mcr-bench-llm-hit-judge-2026-09-03+poc1-ext-1`；temperature 0.2 / top_p 0.95 |
| 时间窗 | 2026-11-11T06:13:08.569Z → 2026-11-11T09:14:50.680Z（Asia/Shanghai） |
| 数据集 | `data/vul4j/p1-smoke-cases.json`，10 案，sha256 `31a326bd1722042a1790d4bffbc05c02086098a212bedd785e6f51dbb4fcd8ba` |
| runtime | Node v24.13.0 / win32-x64 |
| 缓存探针 | N/A（探针脚本随研究装置删除，#32） |

judge 模型说明：历史 `glm-5-3-260814` 已从网关下线（chat 返回 404）；`glm-5.3` 单次裁定超 10 分钟、`glm-5.3-flash` 返回非法 JSON；本次使用 `glm-5.2`（同 glm family，61s 量级完成，计数与 qwen3.7-max / doubao-seed-2.1-pro 一致）。judge 版本变更后按 ADR-0017 §5 重做空对照校准。

## 2. 执行结果

- **20/20 单元完成并判分**（10 case × 2 reps × 1 arm），`failures.json` 为空，coverage 10/10 = 1.0。
- judge 留痕：20/20 `status = judged`，0 条 `anomalies`（无越界 / 重复占用 / 畸形条目）。
- 审计落盘：20 份 audit（约 16.3 MiB），每单元一份，`requests[]` 可重放字节在位。
- 单 arm：`baseline`（E @ `90b72e1`）；candidate 未跑，无配对统计。

### 2.1 运行中断与续跑留痕（必须随报告引用）

单进程首跑在 `VUL4J-30 / baseline / rep-1` 的 judge 阶段挂起（kernel 审计已完成，judge 调用 ~90 分钟未返回；进程被终止）。已完成的 15 个单元产物保留；随后：

1. 单案诊断重跑 `VUL4J-30` 成功（kernel 3m02s + judge 29s），排除案件/仓库固有故障；
2. 剩余 3 案（`VUL4J-12` / `VUL4J-30` / `VUL4J-33`）× 2 reps 以 `p1-smoke-remainder` 补跑，6/6 成功、0 失败；
3. 最终工件由两个同 commit / 同模型 / 同 judge 的运行按单元组装（campaignId 归一），`environment.json` 时间窗覆盖首跑起点到补跑终点；`--report-only` 对 20 条记录 / 20 条 judge 留痕做完整性校验后重建 `report.json`。

首跑中断的副作用（诚实记录）：

- `VUL4J-12 / rep-1` 在首跑未产出记录/审计（kernel 阶段），补跑成功；中断时 `failures.json` 尚未落盘，该次 kernel 失败的具体错误文本丢失。
- `VUL4J-30 / rep-1` 首跑的 kernel 审计保留在 `p1-smoke-2026-11-11-interrupted/`，未进入最终工件；最终工件使用补跑的审计。
- **单单元超时在离线 fake 测试中生效（2s 超时 → judge 阶段失败留痕），但本次挂起时 20/30 分钟超时均未触发**；根因未定位（进程线程处于等待态，事件循环未阻塞）。#41 前需复查真实网络挂起路径。

## 3. L1 绝对质量（per-case 等权，mean ± sample std）

| 列 | Recall | Precision | F1 |
|---|---|---|---|
| judge（主列） | **0.411 ± 0.240** | **0.414 ± 0.208** | 0.368 ± 0.194 |
| rule（确定性粗筛） | 0.203 ± 0.198 | 0.172 ± 0.170 | 0.157 ± 0.131 |

- 零 finding 率：0/20（0.000）。
- 阴性对照 FP：N/A（本次 10 案均为 Vul4J 正例，无 clean MR）。
- 证据闸拒绝分布：SCHEMA_INVALID / NON_ENGLISH / NO_EVIDENCE / VERIFICATION_FAILED / DUPLICATE_ID 均为 0。
- 口径提示：rule 列只做文件 / 行区间 / 性质确定性匹配；judge 列为语义匹配，两者分歧是预期（judge R/P 明显高于 rule）。

## 4. 成本与有界性（E，per-case 均值）

| 指标 | 值 |
|---|---|
| CARC（主成本近似） | **48,654 ± 5,020** |
| cached input | 61,338 ± 26,963 |
| uncached input | 33,969 ± 3,832 |
| output | 14,685 ± 1,827 |
| total tokens（含缓存读，仅解释变量） | 109,992 ± 30,328 |
| cache hit rate | 0.620 ± 0.069 |
| requests / run | 9.65 ± 0.91 |
| rounds / run | 1.00 ± 0.00 |
| attempted tool calls | 10.90 ± 1.29 |
| executed tool calls | 6.00 ± 0.00 |

口径提示：20/20 单元的 `truncationReasons` 均为 `TOOL_BUDGET_EXHAUSTED`，但 `truncated = false`（无硬轮次截断）；即 E 在当前工具预算（6 次）下全部用满预算，模型的尝试次数高于执行次数。L1 数字应在此预算约束下解读。

## 5. 复算与工件

工件目录（gitignored）：`runs/eval/p1-smoke-2026-11-11/`

```text
plan.json / cases.json
environment.json
failures.json            # []
report.json              # 本目录同名文件为副本
runs/vul4j/<case>/baseline/rep-<n>.json      # 20
judge/vul4j/<case>/baseline/rep-<n>.json     # 20
audit/vul4j/<case>/E/rep-<n>/audit/*.json    # 20
```

复算命令（零网络）：

```bash
pnpm campaign -- --report-only --out runs/eval/p1-smoke-2026-11-11
```

本次验证：重建 `report.json` 与原文件 **sha256 逐字节一致**；报告副本见同目录 `report.json`。

## 6. 结论与限制

- ✅ 真实网关 E 检视、真实 judge 评分、审计落盘、失败隔离、`--report-only` 复算在 10×2 规模跑通。
- ⚠️ 单 arm、单 judge 版本、无 clean-MR 阴性对照、无 C_ref / Claude Code；结论只限链路可用。
- ⚠️ judge 由历史 `glm-5-3-260814` 漂移到 `glm-5.2`，与 `runs/phase2-pi` 的 L1 数字不可直接比较。
- ⚠️ 首跑的挂起与超时未触发是已知未决问题；#41 双 arm 主跑前必须复核（否则长跑可能再次卡死）。
- 下一步（#41）：空对照校准、双 arm 配对统计与 L2 门；真实主跑 30 案 × 3 reps。
