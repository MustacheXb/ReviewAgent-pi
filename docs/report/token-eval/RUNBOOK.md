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
2. **环境探针**：运行前跑 `probe-gateway-cache`，记录模型 / 网关 / judge / 机器 / 时间窗；运行后复测（网关策略随时段漂移，跨窗口不可归因）。
3. **冒烟**：10 case × 2 reps，baseline / candidate 交错，失败隔离；修 runbook，不修数据。
4. **主跑**：30 case × 3 reps（Vul4J 30 案），同 case × rep 两臂相邻或按 case 随机化臂顺序；同一 ≤48h 窗口。
5. **判定**：L1 质量门（judge Recall / Precision 非劣、零 finding 率、阴性对照 FP、coverage）+ L2 成本门（CARC 主门、uncached / output 分解、attemptedToolCalls / requests 有界性、可复现）。阈值 provisional，先跑空对照校准（ADR-0017 §5）。
6. **归档**：报表写本目录（`docs/report/token-eval/<campaign-id>/`），原始 `runs/` / `audit/` / `wireBody` 外置；报告不得含 key。
7. **复测**：运行后再跑一次缓存探针；窗口内网关策略变化必须在报告标注，必要时重跑。

## 3. 产物与职责边界

| 位置 | 内容 |
|---|---|
| `main` `docs/report/token-eval/` | baseline manifest、历史 provenance、L2 / L3 摘要报告、复算入口 |
| `main` `src/eval/analysis/` | 只读 `RunRecord → cached / uncached / output / CARC` 分析器（零网络、零 LLM） |
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
