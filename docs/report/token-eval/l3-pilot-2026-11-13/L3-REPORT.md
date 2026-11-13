# L3 三列定位报告 l3-pilot-2026-11-13

> generatedAt: 2026-11-13T19:30:00.000Z · kind: `l3-three-column-report` · claimsAllowed = false
> claimsAllowed = false：本报告只作单列事实与门判定审计明细，不构成对外相对结论。

## 1. 环境完整性

- complete: **true**
- model: `deepseek-v4-flash`（volcengine）
- judge: `glm-5.2` · prompt `mcr-bench-llm-hit-judge-2026-09-03+poc1-ext-1`
- window: 2026-11-11T23:42:45.782Z → 2026-11-13T18:23:56.047Z (Asia/Shanghai)
- dataset: `data/vul4j/p1-smoke-cases.json` · 10 案 · sha256 `31a326bd1722042a1790d4bffbc05c02086098a212bedd785e6f51dbb4fcd8ba`
- Claude Code CLI: `2.1.241` · actual deepseek-v4-flash · maxTurns ceiling

## 2. 三列对比

| 指标 | E | C_ref | Claude Code |
|---|---:|---:|---:|
| model | deepseek-v4-flash | deepseek-v4-flash | deepseek-v4-flash |
| cases | 10 | 1 | 10 |
| runs | 20 | 1 | 20 |
| coverage | 1.000 | 1.000 | 0.950 |
| harness budget | bounded | bounded | ceiling |
| judge Recall | 0.463 | 1.000 | 0.318 |
| judge Precision | 0.454 | 0.333 | 0.492 |
| judge F1 | 0.387 | 0.500 | 0.317 |
| CARC mean | 47,393 | 81,989 | 118,796 |
| totalTokens mean | 100,346 | 290,501 | 772,927 |
| cacheHitRate | 0.607 | 0.753 | 0.836 |
| billed USD | N/A | N/A | $34.724 |
| turns mean | N/A | N/A | 22.150 |
| duration mean (s) | N/A | N/A | 436.8 |
| permission denials | N/A | N/A | 0 |
| failures | 0 | 0 | 1 |

### coverage / failures 明细

- **E** coverage: planned 20 / executed 20 / judged 20 / failed 0 = 1.000
  - failures: none
- **C_ref** coverage: planned 1 / executed 1 / judged 1 / failed 0 = 1.000
  - failures: none
- **Claude Code** coverage: planned 20 / executed 20 / judged 19 / failed 1 = 0.950
  - failure: VUL4J-25/rep-2: judge max_tokens 截断（留痕，不插补）

## 3. C_ref 参考分母

- E / C_ref totalTokens = **0.345**
- C_ref totalTokens 仅作 L3 参考分母；不进入任何门，不单独构成结论。

## 4. 门判定

| 门 | pass | rule | detail |
|---|---|---|---|
| comparability | false | same cases >= 30 / reps >= 3 / models / E-vs-Claude harness budget | cases differ (10 / 1 / 10); cases below minCases 30 (10 / 1 / 10); reps/run ratio differ (2.000 / 1.000 / 2.000); reps below minReps 3 (2.000 / 1.000 / 2.000); harness budget differs (bounded vs ceiling) |
| quality | false | E recall >= Claude x0.9 && precision >= Claude x1 | recall ratio 1.457 (0.463 vs 0.318), precision ratio 0.924 (0.454 vs 0.492) |
| cost | false | E billed USD <= Claude x0.3 | USD N/A（E N/A / Claude $34.724）；不能以 totalTokens 代替成本结论 |
| cache | false | E cacheHitRate >= 0.85 | E cacheHitRate 0.607 |
| coverage | true | all columns coverage >= 0.9 | E 1.000, C_ref 1.000, Claude Code 0.950 |
| environment | true | environment.json complete | all required fields present |
| signOff | false | product sign-off present | no sign-off |

## 5. 宣称

- claimsAllowed = **false**
- allowed claim: N/A（未满足报告 + environment + 产品签字 + 全门）

### 限制
- 三列只作 L3 定位 / 宣称，不进入 S/A/B 主判定。
- C_ref totalTokens 仅参考分母，不进入任何门。
- E 与 Claude Code 使用同一模型，token 口径可对照；不得外推跨模型结论。
- 原始 runs / audit / wireBody 外置；摘要报告才入库。
- 三列样本量不一致（E 10 / C_ref 1 / Claude Code 10），不作严格配对结论。
- 存在列级 failures，逐项见 coverage / failures；不静默丢弃。

## 6. 归档

- 摘要报告入库；原始 runs / audit / wireBody 外置（gitignored）。
- 三列不进 S/A/B；C_ref totalTokens 仅参考分母。

