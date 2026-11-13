# C_ref 真实单案冒烟（VUL4J-1）

> 状态：**单案冒烟，仅证明 C_ref eval-only 全仓参照链路可跑通**；不是 L3 定位报告，不用于阈值 / 收益判定，也不得对外宣称。

## 1. 配置

| 项 | 值 |
|---|---|
| case | `VUL4J-1` |
| campaign / output | `c-ref-smoke-2026-11-13` |
| baseline ref | `eval-e-baseline-2026-11-11` |
| 被测模型 | `deepseek-v4-flash` @ volcengine |
| judge | `glm-5.2`，prompt `mcr-bench-llm-hit-judge-2026-09-03+poc1-ext-1` |
| 全仓预算 | 80,000 chars（软预算；截断提示固定开销使 `contentChars` 可略超） |
| CLI 入口 | `CAMPAIGN_REAL=1 pnpm reference-smoke -- --kind c-ref --case-count 1` |

## 2. 全仓注入结果

| 项 | 值 |
|---|---:|
| totalFiles | 2,035 |
| shownFiles | 7 |
| contentChars | 81,322 |
| truncated | true |
| 行级截断文件 | `src/main/java/com/alibaba/fastjson/JSONPath.java` |
| 完全未注入文件 | 2,028（机读清单在 sidecar） |

注入按排序 POSIX 路径、整文件优先；装不下整文件时行级截断并写显式提示
（文件内 + 末尾总提示）。`fullRepo` 记账只写评测侧 sidecar：
`<out>/eval-sidecar/full-repo/VUL4J-1/C/rep-1.json`，生产
`RunAudit.fullRepo` 未复活（record 中已核验无该键）。

## 3. 检视与 judge（单案，仅链路验证）

| 项 | 值 |
|---|---|
| findings | 3 |
| judge counts | TP 1 / FP 2 / FN 0 |
| judge status | `judged`（无 anomalies） |
| 说明 | C_ref 是「同模型信息给满」参照；单案 R/P 不构成质量结论，L3 需 30 案 / 3 reps / 三列报告 |

## 4. 工件与复算

原始工件（gitignored）：`runs/eval/c-ref-smoke-2026-11-13/`

```text
summary.json
runs/vul4j/VUL4J-1/candidate/rep-1.json   # eval-only record（附 ref: C_ref）
judge/VUL4J-1.json
eval-sidecar/full-repo/VUL4J-1/C/rep-1.json
```

本目录副本：`summary.json`（compact，省略 2,028 条 omittedFiles 明细）、
`record-VUL4J-1.json`、`judge-VUL4J-1.json`。真实单案由
`scripts/run-reference-smokes.ts` 生成；`--report-only` 复算不适用于 C_ref
单案（kernel 真实执行）。

## 5. 口径限制

- C_ref kernel 以 eval-only 方式把全仓内容追加到 issue 上下文（pi E 内核只有
  一条初始 user 消息），不是历史 config C 的逐字节复刻；引用时写 C_ref，
  不写「config C」。
- 80k 是装填预算，截断提示不计入装填，`contentChars` 可略超；sidecar 同时
  记录 `shownFiles / omittedFiles / partialFile`，不静默丢弃。
- 单案结果不得用于 L3 宣称；L3 仍需 #45 的三列报告 + `environment.json` +
  产品签字。
