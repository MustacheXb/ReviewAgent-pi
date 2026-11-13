# L3 试点报告数据来源 / 复算说明

> 本目录的 `L3-REPORT.md` / `l3-report.json` 由 `pnpm l3-report` 从
> `input.json` 生成；本文件说明三列数据来源与口径。**这是试点拼装，不是同一
> 批次、同窗口的正式 L3 主跑**；`claimsAllowed=false`。

## 1. 三列来源

| 列 | 来源 | 说明 |
|---|---|---|
| E | `runs/eval/p1-calibration-2026-11-12/report.json` baseline warm（rep≥2） | 10 案子集（p1-smoke 前 10 案）× 2 warm reps；judge Recall/Precision/F1 按 run 等权，CARC / totalTokens 按 run 均值 |
| C_ref | `runs/eval/c-ref-smoke-2026-11-13/` VUL4J-1 record + judge | 单案；CARC = input + cacheWrite + output，totalTokens = input + cacheRead + output；cacheHit = cacheRead/(input+cacheRead) |
| Claude Code | `runs/eval/claude-code-ceiling-10x2-2026-11-13/` records + judges | 10 案 × 2 reps，ceiling（无 `--max-turns`）；case 等权 Recall / Precision / F1；CARC / totalTokens / cacheHit 按 run 均值；CLI cost 用 CLI `total_cost_usd` |

## 2. environment

- 基础：`runs/eval/p1-calibration-2026-11-12/environment.json`（git / runtime /
  model / judge / window / dataset）。
- `prompts.zoneA` = `sha256(packages/review-pi/src/zonea/system-prompt.ts)`；
  `prompts.toolsSchema` = `sha256(packages/review-pi/src/tools/toolkit.ts)`。
- `claudeCode`：`2.1.241` / requested `deepseek-v4-flash` / actual
  `["deepseek-v4-flash"]` / `maxTurns: null`（ceiling）。
- `window` 取 E 起点到 Claude 末次完成（跨 E 30×3 与 Claude 10×2 两批）。
- `dataset` = `data/vul4j/p1-smoke-cases.json`（10 案，hash 见 input）。

## 3. 门判定（为什么 claimsAllowed=false）

| 门 | 结果 | 原因 |
|---|---|---|
| comparability | FAIL | 三列样本不一致（E 10 / C_ref 1 / Claude 10）；E 与 Claude 均 2 reps（< minReps 3）；E 为 bounded、Claude 为 ceiling（harness 预算不同） |
| quality | FAIL | precision ratio = 0.454 / 0.492 = **0.924 < 1.00**（recall 1.457 通过） |
| cost | FAIL | E 无 USD；Claude USD 为 CLI 报告值。按 ADR USD 口径判 FAIL；**不以 totalTokens 代替成本结论** |
| cache | FAIL | E cacheHitRate **0.607 < 0.85** |
| coverage | PASS | E 1.000 / C_ref 1.000 / Claude 0.950 |
| environment | PASS | 必填字段齐全（git / runtime / prompts hash / claudeCode / window / dataset） |
| signOff | FAIL | 无产品签字 |

> 产品签字在本模块是**行政管理字段**（signedBy / signedAt / scope），不是
> 密码学签名；真实对外宣称仍要求签字工件与发布流程留痕。

## 4. 已知限制

- 三列并非同一批同窗口运行：E 来自 30×3 校准的 10 案子集（2 warm reps），
  C_ref 仅 VUL4J-1，Claude 为 10×2 ceiling；样本量不一致，不做严格配对。
- Claude `VUL4J-25/rep-2` judge `max_tokens` 截断，coverage 19/20；不插补。
- CLI `total_cost_usd` 为 Claude Code 价目，不必然等于网关账单；USD 只在
  Claude 列出现 → cost 门 FAIL（USD N/A，不以 token 代替）。
- 网关缓存探针 `cacheProbeBefore/After` 为 N/A（探针随 #32 删除）；正式 L3
  对外宣称前需恢复探针并复测。
- 原始 runs / audit / wireBody 均在 gitignored 目录，不入库。

## 5. 复算命令

```bash
pnpm l3-report -- \
  --input docs/report/token-eval/l3-pilot-2026-11-13/input.json \
  --out docs/report/token-eval/l3-pilot-2026-11-13
```

`l3-report.json` / `L3-REPORT.md` 是纯函数确定性产物（输入相同 → 字节相同）。
