# pi 内核 P5a-full 全量真跑（450 单元全链 + judge，#17）

- **实验 ID**: `phase2-pi`
- **日期**: 2026-09-23 → 09-25
- **规模**: VUL4J 30 案 × 配置 A–E × 3 reps = **450 单元，全部落位**（judge 第三轮重试轮全量复用口径 executed=0 / resumed=450 / failed=0；逐轮账目见「中断与恢复」）
- **协议**: 与 DSH 线 `phase2-main` 逐字段一致——`deepseek-v4-flash` @ REVIEWER_URL 网关 / verifier off / judge `glm-5-3-260814` 经 review-llm / humanReviewRate 0.1 / seed `poc1-human-review-2026` / kernel=pi
- **运行时**: **pi 内核**（`packages/review-pi`，ADR-0009 从 0 重写）——pi 线首个 450 单元级全量真跑
- **对照基线**: DSH 线仓 `runs/phase2-main/`（450 单元，同 30 案同协议）；`phase2-pi-s1`（#10）为同协议前 3 案切片

## 结论（数据同构产出；正式判级对照属 #11 P5b）

**验收五项全过**：①450/450 RunRecord 完整落位（30 案 × 5 配置 × 3 rep 矩阵满格，结构与 pi-s1 同构）②judge 链 450/450（426 judged + 24 skipped-no-findings + **0 error**，经三轮收口）③`report.json`/`dashboard.md` 与 DSH 侧逐字段同构可对照④token 双口径落位（每单元 usage 三键 `inputTokens`/`cacheReadTokens`/`outputTokens` 单列 + rule/judge 双指标口径）⑤运行留痕即本报告。

### 判级（anchor: config C，rep2+ hot，规则筛口径）

| Config | Outcome | Recall | Total tokens | Cache hit |
|---|---|---|---|---|
| A | B | 19.7% | 25,613 | 7.7% |
| B | B | 17.5% | 58,292 | 75.8% |
| C（anchor） | BELOW_B* | 24.7% | 373,900 | 85.6% |
| D | B | 19.5% | 113,415 | 60.6% |
| E | B | 22.0% | 129,517 | 60.6% |

\* C 为 anchor 自比：recall/precision 与自身持平，total tokens 与自身相等导致 B-TOTAL_TOKENS 判负——机制性结果，非质量缺陷。

### issue #17 重点验证项读数

1. **C 反转守住**：pi 全量 C judge line recall **53.9%**（DSH `phase2-main` 13.4%；pi-s1 47.1% 同向延续——两引用均为 issue #17 验证项原文精度 0.1341/0.4709）。pi 侧 C 是真实正 anchor（rule 口径 24.1% 亦居五配置最高），DSH 侧 C 崩溃在 pi 线不复现——pi 内核全仓注入形态下 anchor 配置可用，判级基线有效。
2. **E−D 账本方向**：judge recall E 59.6% vs D 57.9%（+1.7pp），total tokens E 129,517 vs D 113,415（+14%）——E 以约 14% token 增量换小幅 recall 增益，方向与「E = D + 全仓注入」的配置语义一致。
3. **A 缓存命中 7.7%**（#18 结论延续）：全量复核确认 A 六阶段小请求（0.85–3.1k token）结构性骑网关前缀缓存门；B 75.8%/C 85.6% 正常。cacheReadTokens 单列口径不变（ADR-0009 Consequences：报告单列 cacheReadTokens，不与质量结论混排）。
4. **judge 双口径（全 rep mean ± std）**：

| Config | Rule recall | Judge recall |
|---|---|---|
| A | 20.8% ± 28.9% | 55.5% ± 34.8% |
| B | 21.0% ± 30.8% | 49.4% ± 35.2% |
| C | 24.1% ± 33.0% | 53.9% ± 35.0% |
| D | 21.3% ± 30.7% | 57.9% ± 35.8% |
| E | 19.4% ± 28.6% | 59.6% ± 34.1% |

5. **判定形态差异**（与 pi-s1 观察同向）：pi 侧 24/450 单元零 finding（5.3%）vs DSH 侧 187/450（41.6%）——pi 内核在该评测集上 finding 产出密度显著更高，正式判读留给 #11。

## 预算

- **被测侧总账 63,415,327 token**（未命中输入 13,525,811 / 命中输入 42,092,032 / 输出 7,797,484）= 线性预算参考（54M ≈ pi-s1 × 10）的 **1.17×**，同量级。
- **孤儿双跑浪费（未计入上述 record 总账）**：并行期 63 个单元被两进程各完整评审一次（见下），按五配置 token 均值（~140k/单元）估 **~9M token** 网关侧额外消耗。
- judge 链（glm-5.3 经 review-llm）为仪器成本未入被测账（与 DSH 报告口径一致）。

## 中断与恢复（全量运行事件账）

- **第一轮（9/23 14:51 启动，后台任务）**：9/23 晚被外部停止于 93/450——停止只杀了 bash 壳，`node run-experiment.js` 子进程（PID 27660）**幸存为孤儿持续运行**（Windows 进程树 kill 语义，已记入项目 memory）。用户确认继续后，9/24 08:26 重启恢复进程（PID 20212）同命令续跑，与未被察觉的孤儿**双进程并行写同一目录约 6 小时**，9/24 午后经 `wmic` 查证并 `taskkill` 孤儿收口。对账：63 个单元双跑浪费（双跑窗口 9/24 08:26–14:30 内 audit 双份以上）、177 个单元跨轮次多份 audit（停止/续跑时序交错的正常留痕，record 以最后写入口径为准）、2 个失败单元重跑各留新旧双份——多份 audit 单元合计 242（63+177+2，与 audit 总数 692 − 450 单份单元 = 242 闭合）。判定与指标不受影响（record 存在即复用幂等、judge 文件复用幂等、双跑双方协议同构）。第一轮收尾：executed=253 / resumed=195 / failed=2（`VUL4J-56/D/rep-3`、`VUL4J-72/A/rep-3`，网关单请求 terminated，record 为 baseline 完整 + effective 空的半成品形态——effective 空为 verifier=off 正常态，失败缺陷在变体评审 turn 中断）。
- **失败单元补跑（9/25 12:5x）**：删 2 个半成品 record 后同命令重跑——executed=2 / resumed=448 / failed=0，450/450 落位。
- **judge 链三轮收口**：第一轮判定 448/450、26 error（网关 300s 超时为主 + 响应 JSON 截断若干，失败隔离按设计回落规则筛口径留痕）→ 删 26 份 error 判定重跑一轮（9/25 12:5x–22:26，重判慢段单均约 20 分钟）：24 成功、2 再截断（`VUL4J-30/D/rep-1` 连续两轮、`VUL4J-72/A/rep-3` 首判）→ 删 2 份第三轮重试（9/25 22:26–22:31）**全部成功**，最终 **450/450（0 error）**。截断形态：judge 响应 JSON 在 match_reason 文本中间断流（网关流截断，非请求超时）。
- **网关前缀门探针（#18 复核，跑前留痕）**：1.0k/1.5k/4.5k token 前缀 miss、2.5k hit 2048、非单调——与 #18 baseline 相比门参数时段漂移，策略随时段变；A 预算口径按未命中计不变。
- 时间线（本地）：9/23 14:51 启动 → 9/23 晚外部停止（93/450）→ 9/24 08:26 恢复 → 9/24 午后杀孤儿单进程收口 → 9/25 上午单元阶段完成 + judge 第一轮 → 9/25 12:5x 补跑轮 → 9/25 22:26 补跑轮判定收尾 → 9/25 22:31 第三轮重试收口。

---

*产物索引：`report.json`（全量数据，顶层字段与 DSH 线 `phase2-main` 逐一同构）/ `dashboard.md`（自动看板：判级、rep 冷热分层、warm-up、dedup、cache-break 归因、judge 双口径、人工抽检表单）/ `runs/**/rep-*.json`（450 份 run 记录，usage 含 cacheReadTokens 单列）/ `judge/**`（450 份判定）/ `audit/**`（692 份，含双跑交错留痕）/ `human-review/forms.json`（单文件内 46 份抽检表单，seed `poc1-human-review-2026` 确定性抽样 10.2%）。正式 POC1↔DSH↔pi 三方判级对照报告属 #11 P5b。*
