# L2 诊断报告：Token 控制面候选（p0-l2-diagnostic2-2026-11-14）

> **状态：underpowered / diagnostic · claimsAllowed = false**
>
> 本报告只作诊断事实与门判定记录，不构成 L2 合并通过证据，也不构成对外收益/质量宣称。
> 主要原因：30 案 × 3 reps 样本功效不足（ADR-0017 §5：CARC 约需 43 案、3pp 质量约需 220 案）；
> 工具 schema 已变化（7→5），尚未按治理要求重做空对照校准。

## 1. 结论

- **成本门 FAIL**：warm CARC ratio **1.072**，95% CI [0.974, 1.176]；uncached ratio 1.092；requests ratio 1.009。
- **质量门 FAIL**：judge Recall 配对差 **−3.0pp**（CI [−9.7, +3.8]），judge Precision **−6.2pp**（CI [−13.6, +1.5]）——Recall / Precision 的 CI 下界均越过 −3pp 非劣线。
- **有界性 / 可复现门 PASS**；coverage 175/180 = **0.972**（PASS）。
- 唯一明确改善：attemptedToolCalls ratio **0.860**（11.33 → 9.75，约 −14%）。
- 结论：该诊断**没有显示成本收益，且质量非劣未成立**；不满足任何“通过”条件。

## 2. 口径与 provenance

| 项 | 值 |
|---|---|
| campaign | `p0-l2-diagnostic2-2026-11-14` |
| baseline | `eval-e-baseline-2026-11-11`（`e724958`，等价 `reviewagent-v1.0.0`） |
| candidate | `e61e43c`（PR #61 的 merge commit；运行时内容 = `1d6a228`） |
| 评测工作树 commit | `98658ce`（eval/bench + main 的候选合并；environment.json 记录） |
| 数据集 | `data/vul4j/target-cases.json`，30 案，sha256 `6586cd2d8db478f4d24729e91a6f068aa9042b3068c79a7a4876b20531b881d9` |
| 模型 / judge | `deepseek-v4-flash`（volcengine）/ `glm-5.2`，judge prompt `mcr-bench-llm-hit-judge-2026-09-03+poc1-ext-1` |
| reps / arms | 3 / baseline + candidate；**randomized arms**，seed `20261114` |
| 窗口 | 2026-11-14T05:27:01Z → 2026-11-15T03:59:37Z（Asia/Shanghai） |
| 校准 | `calibrationRef = null`（工具 schema 变化后**尚未重校准**） |

**前一版 `p0-l2-diagnostic-2026-11-14` 作废**：该次 candidate worktree 缺少 `.cache/datasets/vul4j-repos`，30 案 repo 全部不可读，两臂工具均报 `failed to list Java files ...`；不得引用其数字。本报告只使用修复 repo 后的 `diagnostic2`。

## 3. 门判定

| 门 | 结果 | 关键证据 |
|---|---|---|
| cost | **FAIL** | CARC ratio 1.072 > 0.900；CI upper 1.176 ≥ 1.000；uncached 1.092 > 1.000；requests 1.009 > 1.000 |
| quality | **FAIL** | Recall CI lower −9.7pp < −3pp；Precision CI lower −13.6pp < −3pp |
| boundedness | PASS | 179 runs 在 24 attempts / 46 requests / 65,441 output 界内 |
| reproducibility | PASS | 179 records 均有 audit 引用；0 cache breaks |
| coverage | PASS | 175 judged / 180 planned = 0.972 ≥ 0.95 |

## 4. Warm（rep2+）主口径

| 指标 | baseline | candidate | 比率 / 差 |
|---|---:|---:|---:|
| CARC | 51,529.65 | 54,448.17 | **1.072** [0.974, 1.176] |
| cached input | 61,269.33 | 65,841.07 | 1.075 |
| uncached input | 35,129.15 | 37,816.32 | **1.092** [0.996, 1.198] |
| output | 16,400.50 | 16,631.85 | 1.023 |
| requests | 9.617 | 9.683 | 1.009 |
| attempted tool calls | 11.333 | 9.750 | **0.860** [0.813, 0.912] |
| executed tool calls | 6 | 5.983 | ~1.00 |
| judge Recall | 0.5570 | 0.5146 | **−3.0pp** [−9.7, +3.8] |
| judge Precision | 0.5560 | 0.4939 | **−6.2pp** [−13.6, +1.5] |
| zero-finding rate | 1.67% | 3.33% | +1.7pp [−3.3, +8.3] |

## 5. 失败与覆盖

- planned 180；executed 179；judged 175；failed 5；coverage 0.972。
- kernel 失败 1：`VUL4J-58/baseline/rep-1` — provider 返回 `terminated`（baseline 子进程 `review turn failed: terminated`）。
- judge 失败 4：`VUL4J-75`（baseline rep1/rep2/rep3、candidate rep2）——judge 返回非法 JSON（模板/`SpEL` 文本导致解析失败），按引擎纪律留痕不插补。
- **Windows 0xC0000142 段**：首轮 diagnostic2 在 shell 被停止后出现 35 个 baseline 子进程 DLL 初始化失败；已用 `--resume` 从新进程补齐，最终 failures 只剩上述 5 个。

## 6. 诊断线索（供下一步消融）

- candidate 全部 90 个审计 run 的 `toolProfile = core-5`，`toolProfileSource = derived`。
- candidate 有 **10 个 warm run 触发新预算边界**（`MAX_REQUESTS_REACHED` / `TOOL_ATTEMPTS_EXHAUSTED` / `OUTPUT_BUDGET_EXHAUSTED`），其 warm CARC 均值约 65,156；未触发这些边界的 50 个 run 均值约 52,307（baseline 51,530）。**candidate 的整体 CARC 抬升主要来自这 10 个预算收口 run**。
- candidate 的 Ledger 审计统计：hits ≈ 0 / misses ≈ 6.0 / savedCharsEstimate = 0——本批 run 中 Ledger 未产生去重收益。
- 因此下一轮优先做三项分项消融：`core-5 vs extended-7`、预算边界（新预算 vs 旧式无限尝试/宽松请求）、截断/Ledger 行为；确认来源后再决定修复或窄回滚。

## 7. 产物

本目录：
- `l2-report.json`（机读门判定与全部指标）
- `environment.json`（模型 / judge / 窗口 / 数据集 hash）
- `plan.json`（campaign 输入与随机臂序 seed）
- `failures.json`（5 个失败单元的逐条留痕）

原始 `runs/`、`audit/`、`wireBody` 与 judge 原始响应按 ADR-0016 §6 外置，不入库。
