# pi 内核 S1 小批量真跑（45 单元全链 + judge，#10）

- **实验 ID**: `phase2-pi-s1`
- **日期**: 2026-09-22
- **规模**: VUL4J 3 案（VUL4J-29 / 30 / 33）× 配置 A–E × 3 reps = **45 单元，全部完成**（executed=45 / resumed=0 / failed=0）
- **协议**: 与 DSH `phase2-main-s1` 逐字段一致——`deepseek-v4-flash` @ REVIEWER_URL 网关 / verifier off / judge `glm-5-3-260814` 经 review-llm / humanReviewRate 0.1 / seed `poc1-human-review-2026` / kernel=pi
- **运行时**: **pi 内核**（`packages/review-pi`，ADR-0009 从 0 重写；经 #8 P4a 执行缝由实验 runner 驱动）——本实验即 pi 线首个 45 单元级真跑
- **对照基线**: DSH 仓 `runs/phase2-main-s1/`（45 单元；实测与 DSH 全量 `phase2-main` 同 3 案子集逐字一致——dsh-s1 即 DSH 主实验的切样）

## 结论（advisory only——45 单元配对符号检验功效不足，不进 S/A/B 正式判级）

**无红旗**。pi 内核在 DSH 同案同协议上产出同构可比数据，且质量-成本形态占优：

| 维度（rep2+ hot，规则筛口径） | pi-s1 | dsh-s1 |
|---|---|---|
| 判定形态 | **45/45 judged，零零-finding 单元** | 25 judged + 20 skipped-no-findings（44% 单元零 finding） |
| C（anchor）line recall | **32.5%** | 0%（三案全灭，anchor 失效） |
| E line recall | **32.5%**（= anchor） | 7.9%（> 其 0% anchor） |
| E total tokens | **81,837** | 148,920 |
| C total tokens | 318,713 | 614,209（pi 全仓注入约 DSH 一半） |
| B cache hit | 81.0% | 89.6% |
| 判级（anchor C） | E=B，余 BELOW_B | B=A，A/C/D/E 形态受 0% anchor 失真 |

关键读法：

1. **DSH s1 的判级基线当时形同虚设**（C anchor 三案全灭，A 级判给 B 配置是对比 0% 的产物）；pi 侧 C 是真实正 anchor（32.5%），E 以 anchor 26% 的 token 达到持平 recall——判级有效。
2. **finding 产出密度差异显著**：pi 侧 45 单元全部有 findings（DSH 侧 44% 零 finding）。单侧小样不下结论，但与「pi 全仓注入 token 仅 DSH 一半」合并看，pi 内核在该 3 案上无系统性劣化迹象。
3. **缓存命中 A 配置显著低**（A: 8.1% vs 44%；B: 81% vs 89.6%）——#18 排查收口：非 pi 序列化缺陷（单元内请求间前缀逐字节连续、跨 rep 首请求逐字节相同），根因是火山网关 prefix cache 最小前缀门（~2k token，三时点探针实测）× A 六阶段小请求（0.85–3.1k token/请求）骑门；DSH s1 的 44% 属 09-13 时段同端点的低门行为，同形态 09-23 复刻不复现（网关策略时段变更）。cacheReadTokens 单列呈现口径不变（ADR-0009 R3）。
4. **正式判级与对齐门**（POC1↔DSH↔pi 三轮协议第三轮应用）留给 #17 全量 + #11 P5b；本实验数据即全量的前 3 案切片，全量新 id `phase2-pi`（case set 一致性守卫防混批）。

## 预算

45 单元被测侧实际总账 **5,425,778 token**（未命中输入 1,324,051 / 命中输入 3,469,824 / cacheWrite 0 / 输出 631,903）= DSH s1 同口径（8,732,930）的 **0.62×**。judge 链（glm-5.3 经 review-llm）为仪器成本未入被测账（与 DSH 报告口径一致）。

## 中断与恢复

- **单元执行零中断**：45/45 一次通过，无 resume。
- **judge 链网关超时 × 9**：第一轮判定 36 judged + 9 error（`VUL4J-30`×8、`VUL4J-33/E/rep-3`×1，均为 OpenAI 兼容网关 300s 超时，判定链失败隔离按设计回落规则筛口径留痕）。处置：删除 9 份 error 判定文件后原命令重跑一轮——45 单元全 resumed（零模型成本）、36 判定复用、9 判定重跑**全部成功**，最终 **45/45 judged / 0 error**。DSH 侧同案判定零超时，属时段性网关事件而非案级特征。
- 时间线（本地）：13:28 启动 → 15:24 单元完成（1h56m）→ ~19:55 第一轮判定结束（约 4.5h，judge 深推理单次 1–5 分钟）→ 21:28 补跑轮收口。

---

*产物索引：`report.json`（全量数据）/ `dashboard.md`（自动看板：判级、rep 冷热分层、warm-up 曲线、dedup、cache-break 归因、judge 双口径、人工抽检 5 份表单）/ `runs/**/rep-*.json`（45 份 run 记录，usage 含 cacheReadTokens 单列）/ `judge/**`（45 份判定）/ `audit/**`（45 份审计）/ `human-review/`（seed 抽检表单）。全量（#17）将以此 3 案为切片扩展至 30 案新 id `phase2-pi`。#18 排查的网关前缀门探针已入库为 `scripts/probe-gateway-cache.ts`（#17 全量跑前复核门参数用）。*
