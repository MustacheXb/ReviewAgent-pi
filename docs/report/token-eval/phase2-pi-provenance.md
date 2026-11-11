# `runs/phase2-pi` 历史 provenance（P0-3）

- **状态**：**`NOT_REPRODUCIBLE`**——只作证据，**不作活基线**
- **机读 manifest**：[`phase2-pi-provenance.json`](phase2-pi-provenance.json)
- **补录日期**：2026-11-11
- **替代活基线**：[`eval-e-baseline-2026-11-11`](e-baseline.md)（ADR-0017 §3）
- **数据位置**：本机 `runs/phase2-pi/`（gitignored，1598 文件）；Demo 线 `demo/config-matrix` 另跟踪 `runs/phase2-pi/REPORT.md` 报告副本

## 1. 来源锚点

| 项 | 值 |
|---|---|
| 来源 commit | `b94e4614a7fc99548cf66466916304edf8306eee`（2026-09-23 13:05:56 +0800） |
| 来源 branch | 未记录（`null`）。该提交是 `main` 与 `demo/config-matrix` 分叉前的共同历史 |
| 运行内核 | pi（`packages/review-pi`，ADR-0009 重写线） |
| 配置语义 | A–E 实验矩阵（**v3 前形态**：`configId` 可选）；不适用生产协议 v3 口径 |

**推定依据**：最早 RunRecord `completedAt` = 2026-09-23T06:52:42Z，晚于 `b94e461`（05:05:56Z）；最晚 = 2026-09-25T13:01:38Z，早于其唯一后继 `3d03cc5`（14:44:00Z）。窗口内无其他提交，故被测代码为 `b94e461` 的推定值。**工作树是否干净未记录**——这是本数据不可复现的原因之一，不当作已证事实。

## 2. 可考时间窗

| 项 | 值 |
|---|---|
| 起（UTC） | 2026-09-23T06:52:42.017Z（本地 09-23 14:52） |
| 止（UTC） | 2026-09-25T13:01:38.773Z（本地 09-25 21:01） |
| 依据 | 450 份 RunRecord 的 `completedAt` 最早 / 最晚值 |
| 尾巴 | judge 第三轮重试收口约在 2026-09-25T14:31Z（本地 22:31），晚于记录窗口 |

窗口约 54 小时（跨三个自然日）；网关前缀缓存策略在该窗口内已观测到时段漂移（#18 探针），因此缓存类指标不可跨时段复现或外推。

## 3. 模型与 judge

| 维度 | 值 |
|---|---|
| 被测模型 | `deepseek-v4-flash`（实际部署版本 **未记录**，`null`） |
| provider | OpenAI-compatible 企业内部网关；base URL 见本地 `plan.json`（不落 key） |
| judge | 启用；模型 `glm-5-3-260814` 经 `review-llm` |
| judge 版本细节 | 提示词模板 / 温度 / top_p **未记录**（`null`） |
| judge 覆盖 | 450/450（426 `judged` + 24 `skipped-no-findings`，0 error，三轮收口） |

## 4. 规模与产物

| 产物 | 数量 |
|---|---|
| RunRecord（`runs/**/rep-*.json`） | 450（30 案 × A–E × 3 reps） |
| judge 记录（`judge/**`） | 450 |
| audit（`audit/**`） | 692（含中断/恢复交错留痕） |
| 文件总数 | 1598 |
| 数据集 | Vul4J 30 案；**clean-MR 阴性对照 0 案**（计划内、未执行） |

运行期间发生外部停止、孤儿双进程并行、失败单元补跑与 judge 三轮重试；事件账见 Demo 线 `runs/phase2-pi/REPORT.md`。多份 audit 属正常留痕（record 以最后写入口径为准），判定与指标不受影响。

## 5. 数据锚点（可复算 hash）

```text
cases.json   sha256 = fd752f54082c87ad704d0463b18e7e8bf1a28ed2342138800b3289fba1315d36
plan.json    sha256 = 284f5d6f8da99bb89a7e81f2e20e5292a7947652486bdfdf523e10fa25534065
report.json  sha256 = 0275a609a94363fc6dbd36f5c065382182731ba14f8d9e898d2f1d441f930293
tree         sha256 = 5e2397a8f06c1728f0a800867bcb63cbf0164bb42923da16045d0f0d44c3a9c3
```

`tree` 口径（可执行）：路径取**仓库根相对路径**（含 `runs/phase2-pi/` 前缀、`/` 分隔）升序排序；每个文件取小写十六进制 sha256；按 `path + NUL + hexDigest + LF` 拼接后再取 sha256。

```bash
node - <<'EOF'
const fs=require('fs'),path=require('path'),crypto=require('crypto');
function walk(d,out=[]){for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);if(e.isDirectory())walk(p,out);else out.push(p)}return out}
const files=walk('runs/phase2-pi').map(p=>p.split(path.sep).join('/')).sort();
const h=crypto.createHash('sha256');
for(const p of files){h.update(p);h.update('\0');h.update(crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'));h.update('\n')}
console.log(files.length, h.digest('hex'));
EOF
```

输出应为 `1598 5e2397a8f06c1728f0a800867bcb63cbf0164bb42923da16045d0f0d44c3a9c3`。任何文件增删改都会改变该值——用它判断「手上这份数据是否就是被引用的那份」。

## 6. 复算锚点（只读分析器，#37）

用 `src/eval/analysis` 对 450 份 RunRecord 纯读复算，E rep2+（30 case × rep 2–3 = 60 条）：

| 指标 | 复算值 | `dashboard.md` rep2+ hot |
|---|---|---|
| cachedInputTokens | 72,238.93 | 72,239 |
| uncachedInputTokens | 40,876.08 | 40,876 |
| outputTokens | 16,401.88 | —（分解项） |
| totalTokens | 129,516.90 | 129,517 |
| CARC | 57,277.97 | 57,278 |
| cacheHitRate | 60.62% | 60.6% |
| 零 finding（60 条中） | 1 | — |

四行分解自洽：`72,238.93 + 40,876.08 + 16,401.88 = 129,516.90`（≈ totalTokens；0.01 为三位小数舍入）；`CARC = uncached + output = 57,277.97`（历史记录无 `cacheWriteTokens`，记 `null` 不记 0）。复算结果与报告数字一致，说明**数据本身可复算**；不可复现的是**运行条件**（部署版本、judge pin、网关策略、工作树），二者不要混为一谈。

## 7. 已知缺口（因此 `NOT_REPRODUCIBLE`）

1. 模型实际部署版本未记录（只有模型 id）。
2. judge 提示词模板版本、温度、top_p 未记录。
3. 网关缓存前缀门策略随时段漂移，缓存类指标不可跨时段复现。
4. 运行时工作树是否干净未记录；来源 commit 为时间窗推定。
5. clean-MR 阴性对照 0 案，无法用本数据做 FP 阴性对照结论。
6. 判级 anchor 是历史 C（A–E 矩阵实验口径，ADR-0004），**不是** L2 基线。

未重建网关 / 部署环境，也不重建：本补录只给锚点与标记，不修补历史条件。

## 8. 使用纪律

- 任何历史引用必须同时写：来源 commit `b94e461`、时间窗 2026-09-23 → 09-25、模型 `deepseek-v4-flash`、judge `glm-5-3-260814`、`NOT_REPRODUCIBLE`。
- **不得**把本数据代入 L2 成本门 / 质量门；L2 对照只能用活基线 `eval-e-baseline-2026-11-11` vs candidate（ADR-0017 §3）。
- 可作「历史实测证据」的用途：解释 E/C 的比例量级（设计附录 D）、说明为什么 `totalTokens` 不能单独当门、作为 Demo 线 A–E 矩阵的报告复算样本。
- 引用模板：

```text
runs/phase2-pi（NOT_REPRODUCIBLE；source b94e461；2026-09-23~25；deepseek-v4-flash；judge glm-5-3-260814）
```
