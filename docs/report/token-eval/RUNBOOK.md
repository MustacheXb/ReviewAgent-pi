# 评测 runbook（L1 / L2 / L3，eval-only）

> 评测面（ADR-0016）：本目录只承载**只读分析器产出、基线冻结记录与摘要报告**；完整 campaign harness、judge 链与 `C_ref` 在长期分支 `eval/bench`，不在生产 `main` 的运行面，也不进生产协议 / CLI / `ConfigId`。

## 1. 基线引用（唯一活基线）

| 项 | 值 |
|---|---|
| baseline ref | **`eval-e-baseline-2026-11-11`** |
| commit | `e724958232e930698489b71440bb61d413592d77` |
| 等价发行 tag | `reviewagent-v1.0.0`（同一提交） |
| 机读 manifest | [`e-baseline.json`](e-baseline.json) |
| 冻结记录 / 重建说明 | [`e-baseline.md`](e-baseline.md) |

L2 配对回归的对照定义（ADR-0017 §3）：

```text
baseline  = eval-e-baseline-2026-11-11（E @ 冻结 tag）
candidate = E @ 本次优化 commit
```

报告、issue、PR 引用 baseline 时写完整 ref，不只写发行号：

```text
baseline: eval-e-baseline-2026-11-11 (e724958)
candidate: <commit>
```

**历史 `runs/phase2-pi` 只作证据，不作活基线**：已标 `NOT_REPRODUCIBLE`（见 [`phase2-pi-provenance.md`](phase2-pi-provenance.md)）。任何「相对信息参照」量级以该数据解释时，必须同时给出来源 commit、时间窗、模型、judge，且不得把历史 C 数字代入 L2 成本门。

## 2. L2 评测战役流程

1. **冻结 baseline**：确认 baseline ref 不变；在 `eval/bench` checkout candidate，确认除目标提交外运行时与 baseline 一致（同代码谱系）。
2. **环境探针**：记录模型 / 网关 / judge / 机器 / 时间窗；运行后复测（网关策略随时段漂移，跨窗口不可归因）。缓存探针脚本随研究装置删除（#32），`environment.gateway.cacheProbe*` 当前记 `null`（N/A）；跨窗口缓存对比前需先恢复探针。
3. **冒烟**：10 case × 2 reps，baseline / candidate 交错，失败隔离；修 runbook，不修数据。

   P1 冒烟（#40）数据集与命令：

   ```bash
   # 数据集：冻结 30 案 target 列表的前 10 案（确定性切片，字节入 campaign hash）
   CAMPAIGN_REAL=1 pnpm campaign -- \
     --campaign-id p1-smoke-2026-11-11 \
     --baseline-ref eval-e-baseline-2026-11-11 \
     --candidate-ref <commit> \
     --cases data/vul4j/p1-smoke-cases.json \
     --model deepseek-v4-flash --reps 2 --arms baseline \
     [--judge-model glm-5.2]
   ```

   真实调用由 `CAMPAIGN_REAL=1` 门控（默认关闭，不进 CI）；产物在
   `runs/eval/<campaign-id>/`：`plan.json` / `cases.json` / `environment.json` /
   `failures.json` / `report.json` / `l2-report.json` / `runs/` / `judge/` /
   `audit/`。`pnpm campaign -- --report-only --out <dir>` 可只读重建两份报告
   （字节稳定）。

   L2 双 arm 配对冒烟（#41）：

   ```bash
   CAMPAIGN_REAL=1 pnpm campaign -- \
     --campaign-id p1-l2-<date> \
     --baseline-ref eval-e-baseline-2026-11-11 \
     --candidate-ref <commit> \
     --cases data/vul4j/p1-smoke-cases.json \
     --model deepseek-v4-flash --reps 2 --arms baseline,candidate \
     [--judge-model glm-5.2]
   ```

   `l2-report.json`（kind `l2-token-bench`）给出：warm（rep2+）主口径与
   cold（rep1）单列、按 case 配对 bootstrap 95% CI（10,000 次、固定种子）、
   CARC / uncached / output / totalTokens / cacheHit / attempts / requests，
   以及 cost / quality / boundedness / reproducibility 四门 pass/fail 与
   `claimsAllowed`。阈值 provisional；同 ref 的空对照校准即使偶然出现成本
   下降也 `claimsAllowed = false`，不得据此宣称收益。

   - 退出码：单元失败 → 1；双 arm 且 baseline/candidate ref 不同、L2 门未
     通过 → 1（硬合并门）；单臂冒烟、空对照校准、`--report-only` → 0。
   - `coverage.ratio = judged / planned`（有 judge 结果的成功评测单元）；
     judge 失败计入 `coverage.failed` 并在质量门 fail，不静默丢样本。
   - 跨 commit 双 arm：runner 支持按 arm 注入内核（`armKernels`）；真实
     assembly 默认两臂共用当前 checkout 的 pi 内核，因此非空对照的真实跑
     需调用方提供 baseline 运行器，否则只作同代码校准。

   ### 2.1 空对照校准（#42，P1-0）

   校准 = baseline vs baseline（同代码、双 arm、同一 ≤48h 窗口）：

   ```bash
   CAMPAIGN_REAL=1 pnpm campaign -- \
     --campaign-id p1-calibration-2026-11-12 \
     --baseline-ref eval-e-baseline-2026-11-11 \
     --candidate-ref eval-e-baseline-2026-11-11 \
     --cases data/vul4j/target-cases.json \
     --model deepseek-v4-flash --reps 3 --arms baseline,candidate \
     --calibration [--judge-model glm-5.2]
   ```

   - `--calibration` 校验 `--baseline-ref == --candidate-ref` 且双臂齐全，
     并自动把 `environment.json.evaluation.calibrationRef` 写成本 campaign
     id；`l2-report.json` 的 `campaignType = "calibration"`。
   - 校准目录额外落 `noise-floor.json` + `NOISE-FLOOR.md`：CARC / uncached /
     output / attempts / requests 比率、judge Recall / Precision 与零 finding
     配对差（warm 主口径 + cold 单列）、样本量 / reps / 窗口 / judge / 数据集
     hash，以及逐阈值「保留 / 调整 / 补样」建议。建议**不自动生效**；阈值
     变更须按 ADR-0017 §5 以补记固化。
   - 校准结论 `claimsAllowed` 恒 false：只测噪声底，不判定优化收益。
   - `--report-only` 会重建 `l2-report.json`、`noise-floor.json` 与
     `NOISE-FLOOR.md`（字节稳定）；正式 campaign 目录不会残留噪声底文件。
   - 正式 campaign 引用已完成的校准时写 `--calibration-ref <calibration-id>`；
     该 id 进入 `l2-report.json.calibrationRef`，`campaignType = "formal"`。
   - 数据集：`data/vul4j/target-cases.json`（冻结 30 案；与 10 案冒烟集
     同序，冒烟集 = 前 10 案）。当前数据集无 clean MR 阴性对照，阴性对照
     阈值在噪声底报告中记 N/A。
   - **中断续跑**：长跑（180 单元，约 8–10 小时）若进程中断 / 看门狗中止，
     在原命令追加 `--resume` 即可：保留 `runs/` / `judge/` / `audit/`，跳过
     「记录 + judge 均完成」的单元，有记录但 judge 缺失的只补判；plan /
     cases hash 变化会 fail fast。`environment.json.window.start` 取原批次
     起点（或最早记录 `completedAt`），不丢时间窗留痕。
   - **主机睡眠会中止长跑**：看门狗按墙钟计算无进度时间，系统睡眠后恢复会
     直接触发 40m 中止（单元超时定时器同样被挂起）。长跑期间须保持主机唤醒
     （例如 Windows `SetThreadExecutionState` 保活），中断后按上条 `--resume` 续跑。

   > judge 模型 id 漂移（2026-11-11 实测）：历史 `glm-5-3-260814` 已从网关
   > 下线（HTTP 404）；`glm-5.3` 在该网关上单次裁定超 10 分钟（触发 300s
   > 超时重试），`glm-5.3-flash` 返回非法 JSON。当前缺省用 `glm-5.2`
   > （同 glm family，61s 完成且计数与 qwen3.7-max / doubao-seed-2.1-pro
   > 一致，异构约束不变）。实际 judge 模型以 `environment.json.judge.model`
   > 为准（网关不回显实际部署版本，`model.actualDeployment` 记 `null`）；
   > judge 版本变更后按 ADR-0017 §5 重做空对照校准。

   > 事故复盘（2026-11-11）：首跑在 kernel 审计后、记录落盘阶段无界挂起约 90 分钟
   > （record / judge 文件均未产生）。已修复：kernel 20m / judge 30m / 写盘 60s
   > 全阶段有界，`progress.log` 记录阶段事件，CLI 40m 无进度看门狗兜底；失败留痕
   > 逐单元落盘。真实主跑前复核 `progress.log`，事故与续跑细节见
   > [p1-smoke-2026-11-11/REPORT.md](p1-smoke-2026-11-11/REPORT.md)。
4. **主跑**：30 case × 3 reps（Vul4J 30 案），同 case × rep 两臂相邻或按 case 随机化臂顺序；同一 ≤48h 窗口。
5. **判定**：L1 质量门（judge Recall / Precision 非劣、零 finding 率、阴性对照 FP、coverage）+ L2 成本门（CARC 主门、uncached / output 分解、attemptedToolCalls / requests 有界性、可复现）。判定结果读取 `l2-report.json` 的 `gates` / `claimsAllowed`；阈值 provisional，先跑空对照校准（ADR-0017 §5）。
6. **归档**：报表写本目录（`docs/report/token-eval/<campaign-id>/`），原始 `runs/` / `audit/` / `wireBody` 外置；报告不得含 key。
7. **复测**：运行后再跑一次缓存探针；窗口内网关策略变化必须在报告标注，必要时重跑。

## 3. 产物与职责边界

| 位置 | 内容 |
|---|---|
| `main` `docs/report/token-eval/` | baseline manifest、历史 provenance、L2 / L3 摘要报告、复算入口 |
| `main` `src/eval/analysis/` | 只读 `RunRecord → cached / uncached / output / CARC` 分析器（零网络、零 LLM） |
| `eval/bench` `src/eval/campaign/` | campaign harness（plan / 单元执行 / 记录 / 报告；零网络，依赖注入） |
| `eval/bench` `src/eval/l2/` | L2 配对统计 + bootstrap + 四门判定 + `l2-report.json` 装配（纯函数） |
| `eval/bench` `src/eval/judge/` | LLM-as-judge 链（prompt / parse / resolve / HTTP 客户端；离线可测） |
| `eval/bench` `src/eval/assembly/` | 真实装配（pi 内核 + judge + `environment.json` provenance；`CAMPAIGN_REAL=1` 门控） |
| `eval/bench` | campaign harness、judge 链、`C_ref`、Claude Code 参照、空对照校准、配对统计 |
| 本机 / 外置存储 | 原始 `runs/`、`audit/`、`wireBody`（gitignored，不入库） |

生产入口（`src/cli` / `src/rpc` / `src/server` / `src/run`）不得 import 评测面（ADR-0016 §4，测试守卫）。

## 4. 何时重新冻结基线 / 重做校准

- **重新冻结 baseline**：生产运行时、协议代数或 vendored pi 版本变化（如 pi 0.85.1 → 1.3.0）时，新打一个 `eval-e-baseline-<date>` tag，并更新本目录 manifest；旧 tag 保留不动，保证历史报告可回指。
- **重做空对照校准**：模型 / provider / judge / 提示词 / 工具 schema 任一变更后（ADR-0017 §5）。
- **模型升级 / 网关切换**：走「迁移门 + L3」，不套 L2（ADR-0017 §3）。

## 5. 相关文档

- [ADR-0016 评测面隔离](../../adr/0016-evaluation-plane-isolation.md)
- [ADR-0017 Token 优化判据](../../adr/0017-token-optimization-gates.md)
- [评测基准方案](<../../design/05-evaluation/ReviewAgent Token 优化评测基准方案——三层对照体系与 Claude Code 外部参照.md>)
- 词条：`E 基线快照` / `L2 配对回归门` / `历史锚`（见根 `GLOSSARY.md` 评测面节）
