# main 分支开发评测使用指南——L1 / L2 / L3 操作手册

> 状态：2026-11-13。适用于生产 `main` 线开发后的评测使用。
>
> 依据：[Token 优化评测基准方案](<./ReviewAgent Token 优化评测基准方案——三层对照体系与 Claude Code 外部参照.md>)、
> [ADR-0016 评测面隔离](../../adr/0016-evaluation-plane-isolation.md)、
> [ADR-0017 Token 优化判据](../../adr/0017-token-optimization-gates.md)、
> [治理 runbook](../../report/token-eval/GOVERNANCE.md)。
>
> **重要边界**：本文按当前已落地的评测能力写。L1 与空对照校准可直接执行；
> L2 的真实跨 commit 配对通过 `--baseline-repo <baseline-worktree>` 装配
> baseline 子进程内核（该 worktree 检出冻结 ref 并已构建 `review-pi`）；
> 未提供 `--baseline-repo` 时两臂共用当前 checkout，只能作同代码诊断。

## 0. 分支与评测面拓扑

| 位置 | 用途 |
|---|---|
| `main`（PR-only） | 生产运行时 / 开发分支；从 `main` 拉 feature 分支，不直接 commit |
| `eval/bench`（长期分支） | campaign runner、L2 配对 / bootstrap、C_ref、Claude Code 参照、L3 报告、校准与测试 |
| `main` 的 `src/eval/analysis` | 只读分析器（零网络 / 零 LLM / 零文件系统），进默认 CI |
| `runs/eval/` | campaign 原始记录（gitignored，外置） |
| `docs/report/token-eval/` | 摘要报告、environment、baseline manifest、治理文档 |

纪律：**评测 harness 不合并回 `main`**（ADR-0016）；生产入口不得 import `src/eval/**`。

## 1. 前置条件

1. **密钥**：评测 worktree 根部 `.env.local`（`REVIEWER_API_KEY` / `REVIEWER_URL`、
   `JUDGE_API_KEY` / `JUDGE_URL`）；显式环境变量优先，key 不回显、不落盘。
2. **真实运行门控**：所有真实网关 / judge / Claude Code 调用必须
   `CAMPAIGN_REAL=1`；默认 CI 零网络。
3. **冻结基线**：`eval-e-baseline-2026-11-11`（commit `e724958`）；
   当前校准：`p1-calibration-2026-11-12`；judge 缺省 `glm-5.2`。
4. **长跑**：主机保持唤醒；中断后用 `--resume`；真实主跑前复核 `progress.log`。
5. **数据**：L2 / L3 主跑数据集 `data/vul4j/target-cases.json`（30 案）；冒烟可用
   `data/vul4j/p1-smoke-cases.json`（10 案）。当前无 clean-MR 阴性对照。

## 2. 一页决策：改动走哪条门

| 改动类型 | 必过 | 现在怎么跑 |
|---|---|---|
| 文档 / 无关修复 / 纯测试 | 确定性 CI | `pnpm typecheck` + `pnpm test`（+ `pnpm --filter review-pi test`） |
| **token 相关运行时**：上下文、工具 / 工具 schema、提示词、计费、缓存、token 记账 | **L1 + L2 硬门** | 先跑 L1；L2 真实配对需双 kernel 装配（见 §4） |
| 模型 / provider / 网关 / judge / 提示词 / 工具 schema 变更 | **迁移门 + L3** | 重做空对照校准；按 L3 报告 |
| 对外宣称 / 发布定位 | **L3 + environment + 产品签字** | §6 |

> 当前 30 案功效不足：CARC 主门约需 **43 案**，3pp 质量非劣约需 **≈220 案**。
> 未扩样前 L2 报告标 `underpowered/diagnostic`，不得作为合并通过证据；
> 质量非劣不可豁免，不能用产品签字绕过。

## 3. 第 0 步：确定性 CI（每次开发）

在**生产开发 worktree**（`main` / feature 分支）执行：

```bash
pnpm typecheck
pnpm test
pnpm --filter review-pi test      # 改动 review-pi / kernel 时必跑
```

快速看单次成本：

```bash
pnpm analyze:token -- --record <run-record.json> --out <dir>
# 或 --experiment <dir> / --runs-root <runs> --experiment-id <id>
```

输出 cached / uncached / output / CARC 四行 + requests / attempts / executed /
skipped；缺失字段为 `null`（N/A），不写 0。此命令零网络、零密钥、确定性。

## 4. L1：绝对质量 + 账本（candidate 单臂）

### 4.1 准备 eval candidate worktree

`eval/bench` 只有 harness；candidate 代码在 `main`。用独立 worktree 合并：

```bash
cd D:\xubao\code\AI4SE\ReviewAgent-pi\ReviewAgent-pi        # eval/bench 主检出
git worktree add ..\ReviewAgent-pi-eval-<sha> eval/bench
cd ..\ReviewAgent-pi-eval-<sha>
git merge <candidate-sha>       # 或 cherry-pick；冲突需解决，不反向合回 main
pnpm install
```

### 4.2 跑 L1

```bash
CAMPAIGN_REAL=1 pnpm campaign -- \
  --campaign-id p1-l1-<date> \
  --baseline-ref <candidate-sha> \
  --candidate-ref <candidate-sha> \
  --cases data/vul4j/target-cases.json \
  --model deepseek-v4-flash \
  --reps 3 --arms baseline \
  --judge-model glm-5.2
```

单臂：L2 配对指标为空，**不要**把 `l2-report.json` 当 L2 门。L1 读取：

- `runs/eval/p1-l1-<date>/report.json` → `arms.baseline.l1`：
  - judge Recall / Precision / F1（主列）、rule 确定性双列；
  - 零 finding 率；
  - clean-MR 阴性对照 FP（当前数据集 N/A）；
  - 证据闸拒绝分布；coverage。
- `runs/eval/p1-l1-<date>/l2-report.json` → coverage / failures（judge 失败逐项留痕）。
- 成本：`pnpm analyze:token -- --experiment runs/eval/p1-l1-<date>`。

**L1 判定**：绝对下限尚未由产品设定；临时用「相对冻结 E 基线快照的非劣」。
单臂 candidate 结果与 baseline 快照对比仍属人工对照，不是 L2 配对门。

## 5. L2：baseline vs candidate 配对

### 5.1 同代码诊断（现在可跑，仅诊断）

在 eval candidate worktree 中，两臂同 ref：

```bash
CAMPAIGN_REAL=1 pnpm campaign -- \
  --campaign-id p1-l2-diag-<date> \
  --baseline-ref <candidate-sha> \
  --candidate-ref <candidate-sha> \
  --cases data/vul4j/target-cases.json \
  --model deepseek-v4-flash --reps 3 --arms baseline,candidate \
  --randomize-arms --judge-model glm-5.2
```

同 ref 双 arm 会被识别为空对照校准；用于检查 harness、随机臂序、coverage /
failures 与噪声底。**不能据此宣称优化收益。**

### 5.2 真实 paired L2（`--baseline-repo` 跨 commit 装配）

#### 5.2.1 准备 baseline worktree

```bash
cd D:\xubao\code\AI4SE\ReviewAgent-pi\ReviewAgent-pi       # eval/bench 主检出
git worktree add ..\ReviewAgent-pi-baseline eval-e-baseline-2026-11-11
cd ..\ReviewAgent-pi-baseline

pnpm install
pnpm build:pi
pnpm --filter review-llm build
pnpm --filter review-pi build
```

- HEAD 必须正好是 `eval-e-baseline-2026-11-11`；`--baseline-repo` 会校验。
- baseline worktree 不需要 `.env.local`；reviewer key 经 stdin 传给子进程。
- 该 worktree 只需能 `import review-pi`（dist 已构建）。

#### 5.2.2 准备 candidate worktree

candidate 臂 = **包含 main 最新代码的 eval/bench checkout**：

```bash
cd D:\xubao\code\AI4SE\ReviewAgent-pi\ReviewAgent-pi
git worktree add -b eval/candidate-<sha> ..\ReviewAgent-pi-eval-<sha> eval/bench
cd ..\ReviewAgent-pi-eval-<sha>
git merge <main-sha>       # 或 cherry-pick；解决冲突，不反向合回 main
pnpm install
```

- 复用主检出的 `.cache/datasets`（复制或 junction），否则 cases 的相对
  `repoPath` 无法解析。
- `.env.local` 放在 candidate worktree（reviewer + judge key）。

#### 5.2.3 跑真实 L2

```bash
CAMPAIGN_REAL=1 pnpm campaign -- \
  --campaign-id p1-l2-<date> \
  --baseline-ref eval-e-baseline-2026-11-11 \
  --candidate-ref <main-sha> \
  --baseline-repo D:\xubao\code\AI4SE\ReviewAgent-pi\ReviewAgent-pi-baseline \
  --cases data/vul4j/target-cases.json \
  --model deepseek-v4-flash --reps 3 --arms baseline,candidate \
  --randomize-arms --calibration-ref p1-calibration-2026-11-12 \
  --judge-model glm-5.2
```

- `--baseline-repo` 存在时，真实装配注入 `armKernels`：
  `baseline` = baseline worktree 的 `review-pi` 子进程；`candidate` = 当前
  candidate checkout 的 `review-pi`。
- 两臂按 case × rep 交错，随机臂序；同模型 / 同 provider / 同 judge。
- 未提供 `--baseline-repo` 时两臂共用当前 checkout，只作同代码诊断。

#### 5.2.4 限制

- baseline 与 candidate 的工具面 / 预算可能不同（如 extended-7 → core-5），
  这是本次 treatment；报告必须显式记录，不能把差异归因到单一机制。
- 30 案功效不足时报告为 `underpowered/diagnostic`；CARC 约需 ≥43 案、
  3pp 质量约需 ≈220 案。

### 5.3 L2 读什么

`runs/eval/<id>/l2-report.json`：

- `metrics.paired.warm.carcRatio`（主成本）、uncached / output / attempts / requests；
- `metrics.paired.warm.judgeRecallDiff` / `judgePrecisionDiff`；
- `gates.cost / quality / boundedness / reproducibility`、`claimsAllowed`、`coverage`；
- `bootstrap`（10,000 次、固定 seed）、warm(rep2+) 主口径、cold(rep1) 单列；
- `failures.json`：judge 截断 / 超时逐项，不静默丢样。

门/阈值见 ADR-0017 §3 与 `src/eval/l2/contracts.ts`；30 案功效不足时报告为
`underpowered/diagnostic`。

## 6. 空对照校准（模型 / 网关 / judge / 提示词 / tools 变更后）

```bash
CAMPAIGN_REAL=1 pnpm campaign -- \
  --campaign-id p1-calibration-<date> \
  --baseline-ref <ref> \
  --candidate-ref <ref> \
  --cases data/vul4j/target-cases.json \
  --model deepseek-v4-flash --reps 3 --arms baseline,candidate \
  --calibration --randomize-arms --judge-model glm-5.2
```

- 校准只用于确认 / 调整 L2 阈值，不判收益；
- 产物：`l2-report.json` / `noise-floor.json` / `NOISE-FLOOR.md`；
- 当前校准 `p1-calibration-2026-11-12`（30×3×2）；阈值更新见 ADR-0017 补记；
- 校准后按功效扩样，30 案不是 L2 硬门可用样本量。

## 7. L3：三列定位 / 对外宣称

### 7.1 外部列冒烟

```bash
# C_ref（eval-only 全仓参照）
CAMPAIGN_REAL=1 pnpm reference-smoke -- --kind c-ref \
  --case-count 30 --reps 3 --out runs/eval/c-ref-<date>

# Claude Code（同模型 harness；不是 Claude 模型跨模型参照）
CAMPAIGN_REAL=1 pnpm reference-smoke -- --kind claude-code \
  --case-count 30 --reps 3 --claude-mode ceiling \
  --model deepseek-v4-flash --out runs/eval/cc-<date>
```

### 7.2 生成三列报告

三列输入 `input.json` 目前需人工聚合（E / C_ref / Claude Code + environment +
signOff）；然后：

```bash
pnpm l3-report -- --input docs/report/token-eval/<id>/input.json \
  --out docs/report/token-eval/<id>
```

`claimsAllowed=true` 需要：三列报告 + 完整 `environment.json` + 产品签字 +
comparability / quality / cost / cache / coverage / environment / signOff 全过。
未通过只能写单列事实，不得写相对结论 / 「通用 Agent 20~30%」。

## 8. 产物、保留与治理

- 原始 `runs/` / `audit/` / `wireBody`：gitignored，外置保留（至少到最后一次
  引用该数据的 L3 / 宣称之后 12 个月）；报告不得含 key。
- 摘要 / environment / L2 / L3 JSON：`docs/report/token-eval/` 入库。
- 历史 `runs/phase2-pi`：`NOT_REPRODUCIBLE`，只作证据，不作活基线。
- L2 仅成本门可签字例外；质量非劣不可豁免；需过期日 + 回滚计划（模板见
  `docs/report/token-eval/templates/l2-cost-exception.md`）。
- 治理与审批清单见 [`GOVERNANCE.md`](../../report/token-eval/GOVERNANCE.md)。

## 9. 常见故障

- **主机睡眠**：看门狗按墙钟判定，睡眠恢复可能直接中止；保持唤醒，中断后
  `--resume`。
- **judge 漂移**：`glm-5-3-260814` 已下线；当前缺省 `glm-5.2`，变更后重做校准。
- **judge 失败**：`failures.json` 逐项留痕；例如 `VUL4J-75` 非法 JSON / max_tokens
  截断，不静默丢样。
- **样本量不足**：30 案 L2 只作诊断；扩样或由产品 ADR 修订目标线，不能用
  签字/例外绕过质量门。
- **跨 commit 双 arm**：必须提供 `--baseline-repo <baseline-worktree>` 且该
  worktree 已构建 `review-pi`；否则两臂共用当前 checkout，只能作同代码诊断。

## 10. 相关文档

- [测评基准方案](<./ReviewAgent Token 优化评测基准方案——三层对照体系与 Claude Code 外部参照.md>)
- [评测 RUNBOOK（eval/bench）](https://github.com/MustacheXb/ReviewAgent-pi/blob/eval/bench/docs/report/token-eval/RUNBOOK.md)
- [治理 runbook（eval/bench）](https://github.com/MustacheXb/ReviewAgent-pi/blob/eval/bench/docs/report/token-eval/GOVERNANCE.md)
- [ADR-0016 评测面隔离](../../adr/0016-evaluation-plane-isolation.md)
- [ADR-0017 Token 优化判据](../../adr/0017-token-optimization-gates.md)
- ADR-0018 Token 控制面语义（在 `main` 线；`docs/adr/0018-token-control-plane-semantics.md`）
