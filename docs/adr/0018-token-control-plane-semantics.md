# 0018. Token 控制面语义——预算、工具画像、Ledger、截断与缓存合同

**状态**：已接受（2026-11-12，spec #49 收口；批 2 动工前置契约）
**决策基线**：`main`（生产主线，E-only / 协议 v3）
**关联**：ADR-0004（S 级判据，历史实验口径）、ADR-0008（模型可替换与审计无密钥）、ADR-0011（上线门与 E 切流）、ADR-0014（分支策略）、ADR-0015（协议 v3）、ADR-0016（评测面隔离）、ADR-0017（Token 优化三层判据）、[ReviewAgent Token 优化方案](<../design/02-agent-design/ReviewAgent Token 优化方案——以 20~30% Token 成本达到通用 Agent 检视效果.md>)、[issue #49](https://github.com/MustacheXb/ReviewAgent-pi/issues/49)（伞 spec；本 ADR 为其 §8 批 2 前置契约）
**适用范围**：本仓主线 `MustacheXb/ReviewAgent-pi`；Demo 线不继承本 ADR（ADR-0014 §8）

## Context

- ADR-0017 定义的是「怎么判」——L1/L2/L3 三层门与 CARC 主指标；它不定义「运行时按什么语义执行」。spec #49 的 P0/P1 需要在批 2 改变生产默认路径（wire 工具 7→5、工具尝试封顶、预算收口），若每批行为 ticket 各自发明语义，预算、Ledger、截断与缓存记录会互相矛盾。
- 历史 60 个热口径单元显示控制面缺位而非缓存不足：请求历史持续膨胀（平均约 10 个请求，末请求 wireBody 约为首请求的 10 倍）；工具尝试未被封顶（60/60 个 run 触发工具预算耗尽，attempts 均值 11.52、最大 22，而实际执行恒为 6）；生产入口不注入知识语料却有 38/60 个 run 调用空知识工具（87 次）；截断 47 次（32/60 run）且检索结果只保留行前缀；Ledger 身份键只有 `kind + description`，去重率为 0%；缓存命中率 60.6% 无法归因。
- 上述数字来自 `runs/phase2-pi` rep2+ 热口径（源 commit `b94e461`，2026-09-23 → 09-25，`deepseek-v4-flash`），已标 `NOT_REPRODUCIBLE`；机读 provenance 见 [phase2-pi-provenance](../report/token-eval/phase2-pi-provenance.md) 与方案文档 §11。本 ADR 只引用其归因结论，不把历史数字当活基线（ADR-0017）。
- P0-1/P0-2 已交付只读分析器与四行主表，但缺单命令入口、冷热分层与成本字段的 N/A 纪律；批 2–4 的行为改动尚无共同契约。
- 本 ADR 只冻结**语义与缺省**，不改变运行时；实现分别落在批 1–4 的 PR。质量收益与劣化验证留在评测线（ADR-0016 / ADR-0017），主线只设非行为门。

## Decision

### 1. 五类独立预算：`ReviewBudget`

| 预算 | 缺省（安全上界） | 计数口径 | 越界时机 |
|---|---:|---|---|
| `maxRequests` | 24 | 每发往 provider 一次请求计 1（发送前计数） | 下一请求前 |
| `maxRounds` | 5 | 六阶段完整一遍为一轮（沿用 `MAX_ROUNDS`） | 轮次边界 |
| `maxExecutedToolCalls` | 6 | 实际进入工具执行计 1（失败也计入，由既有 `MAX_TOOL_CALLS` 更名；跨轮不重置） | 工具执行前 |
| `maxToolAttempts` | 12 | 模型每发出一个 toolCall 内容块计 1（**含被拒调用**） | 工具执行前 |
| `maxOutputTokens` | 48,000 | 每收到 assistant usage 后累计输出 | 阶段边界（事后） |

- **内部输入**：`ReviewBudget` 只存在于内核内部输入，**不进入协议字段、CLI 参数或环境变量**（延续 ADR-0015 §3 的思路：配置由服务端派生、用户面不新增选择面；本 ADR 进一步把预算限定为内核内部输入）。评测线的受控覆盖只走内核内部缝（§3）。
- **两个独立闸**：attempts 与 executed 是独立计数器。attempt 计数包含被拒调用；executed 只计真正进入执行的调用；超预算未执行计 skipped。术语对齐：`maxToolAttempts` 即 GLOSSARY 的 Attempt Budget（尝试预算），`maxExecutedToolCalls` 是执行预算，两者不可混用。
- **中性定义**：缺省值是安全上界，不是目标档。**未触发任何预算的 run，wire 请求字节、工具输出字节与审计既有形状逐字节不变**；预算与 profile 相关的新审计键只在事件发生时追加。`stopReason` 是唯一的恒写新增审计键（§2.4），它不改变 wire 字节。
- 分析器不落第二份计数器：requests / attempted / executed / skipped 继续从 `phaseLog` 与 `toolCallLog` 派生。

### 2. 预算耗尽的收口

#### 2.1 attempts 耗尽 → Forced Phase Finalization

- attempts 耗尽后本批工具结果全部携带 `terminate`，并向模型**追加一条 append-only 指令**：「工具预算已耗尽，请直接输出本阶段要求的 JSON」。不重写既有消息（Zone C 纪律）。
- 该收口每阶段至多触发 **2 次**；仍不产出文本 → 以 `PHASE_FORCED_INCOMPLETE` 收尾。
- **终止原因分流（#54 落地澄清，2026-11-12）**：收尾注入用尽后模型仍只发工具调用 → `TOOL_ATTEMPTS_EXHAUSTED`（尝试预算即终止因）；收尾后模型返回空文本 → `PHASE_FORCED_INCOMPLETE`（收尾未产出任何文本）。两者均 `truncated=true`。
- 收口不伪造 Finding、不把半成品当完整检视。工具预算耗尽本身**不翻转** `truncated`（见 2.4）。

#### 2.2 请求预算 → 阶段边界保底

- 请求预算只在**阶段边界**判定。剩余请求不足以完成候选（第 5 阶段）与裁决（第 6 阶段）时，跳过尚未完成的第 1–4 阶段，直接进入第 5 阶段。
- 第 5 / 6 阶段一旦开始，允许完成（**保底 2 请求**）——预算收紧不得把 run 切在没有 Finding 的阶段。
- **判定口径（#55 落地澄清，2026-11-12）**：以边界处的「下一阶段」为基准——下一阶段仍在第 1–4 阶段时，剩余请求（`maxRequests − 已发请求数`）少于「从下一阶段到裁决所需的阶段数」即跳过下一阶段…第 4 阶段，直入候选；被跳过阶段逐条写入 `phaseLog`（`requestCount = 0` + note），`truncationReasons` 记 `REQUEST_BUDGET_PHASES_SKIPPED`。剩余请求连 2 个保底都不足时不再开始候选，按 `MAX_REQUESTS_REACHED` 收尾（`truncated = true`）；进入候选前剩余 < 2 同样硬停。候选 → 裁决之间不设请求闸；轮次边界视同阶段边界，但剩余不足保底时直接终止，不为未开启的新一轮写阶段条目。请求预算是**阶段边界上的上界**，不是发送前硬闸——阶段内工具 recall 不触发请求截断。跳过本身不翻转 `truncated`（§2.4）。
- 轮次预算沿用既有语义：一轮六阶段完整一遍，超出写截断原因。

#### 2.3 输出预算 → 只在阶段边界事后判定

- 累计输出超过 `maxOutputTokens` 时，只在阶段边界停止后续请求；**不**在 wire 上新增 `max_tokens`（会改变请求字节并击穿缓存合同与 golden）。
- 每阶段结束后检查累计输出；超限即不再发起任何后续请求——请求预算的 5/6 阶段保底（§2.2）**不豁免**输出预算。已完成阶段的内容保留。
- **判定口径（#55 落地澄清，2026-11-12）**：阶段完成后累计输出（`usage.outputTokens`）严格大于上限才触发；停止发生在该阶段收尾之后（含候选 → 裁决之间），`truncationReasons` 记 `OUTPUT_BUDGET_EXHAUSTED` 且 `truncated = true`。若该边界同时是模型声明 complete 的裁决收尾，按 `MODEL_COMPLETE` 收尾（此时没有后续请求可停）。

#### 2.4 `StopReason` 与 `truncated`

新增审计顶层可选键 `stopReason`（RunRecord 的 `AuditLight` 同样可选）：

```text
MODEL_COMPLETE | MODEL_STOPPED | MAX_REQUESTS_REACHED | MAX_ROUNDS_REACHED |
TOOL_ATTEMPTS_EXHAUSTED | OUTPUT_BUDGET_EXHAUSTED | PHASE_FORCED_INCOMPLETE
```

- `stopReason` 在 schema 中为可选，只为历史记录读取兼容；**新 run 恒写**（`MODEL_COMPLETE` 也写），保证每个终止的 run 都有可区分的停止原因。分析器对缺键的历史记录解释为 `MODEL_COMPLETE`，不回填、不改写。
- **命名权威**：方案文档中的 provisional 名 `TOOL_BUDGET_EXHAUSTED` / `PHASE_INCOMPLETE` 以本 ADR 为准，分别记为 `TOOL_ATTEMPTS_EXHAUSTED` / `PHASE_FORCED_INCOMPLETE`；既有 `truncationReasons` 中的 `TOOL_BUDGET_EXHAUSTED` 是历史审计文案，不是 `StopReason`，历史记录不改写。
- `truncated` 语义收紧：仅当 run 未以模型声明的 complete 收尾**且**有阶段 / 轮次被跳过时翻转。单纯工具预算耗尽但阶段正常完成不翻转（保持现有测量语义）。

### 3. Tool Profile（工具画像）

- 由可用知识语料派生，**run 内固定**：

| 可用语料 | Profile | 暴露工具 |
|---|---|---|
| 无 | `core-5` | `get_diff` / `get_symbol` / `get_file` / `find_references` / `get_call_chain` |
| 仅 rule | `core-5+rule` | core-5 + `search_rule` |
| 仅 history | `core-5+history` | core-5 + `search_history` |
| rule + history | `extended-7` | core-5 + `search_rule` + `search_history` |

- 派生以本 ADR 的四档为准；方案文档 §5.2 的 `core-5` / `extended-7` 二档是摘要图示，`core-5+rule` / `core-5+history` 两个中间档不得并入 `extended-7`。
- 生产入口不注入知识语料，因此生产缺省为 `core-5`。这是**有意的 Zone A 变更**：PR 与方案文档必须显式标注，质量面在评测线复核。
- 评测专用内部输入 `toolProfileOverride`（与 `ReviewBudget` 同一内部缝）；审计记录实际生效的 `toolProfile` 与 `toolProfileSource: derived | override`，使消融可归因。
- 工具注册表是唯一真源：暴露集合、顺序与 schema 名 / 字节均由注册表投影；同一 run 内工具数组只构造一次、顺序恒为注册表序列的子序列。本轮不新增工具规则散文（system prompt 无工具规则章节，不发明）。
- Zone A golden 按 profile 分套：现有七工具真源保留为 `extended-7`，新增 `core-5` 真源；单工具字节不变。
- **落地口径（#52，2026-11-12）**：派生 / 投影单点在 `tools/registry.ts`——`deriveToolProfile(knowledge)` 按四档返回（空数组等同无语料），`toolNamesForProfile(profile)` 恒以 `REVIEW_TOOL_ORDER` 过滤得到子序列，`reviewToolSchemasForProfile(profile)` 从完整注册表投影（单工具字节与 extended-7 真源一致）。`buildReviewToolkit` 只把 profile 内的 schema / handler 挂到 toolkit（被裁掉的工具按 unknown tool 有界拒绝），并把 `profile` + `toolProfileSource` 带出；`toolProfileOverride` 为内部输入（`runReview` / `buildReviewToolkit`），不进入协议 / CLI / 环境变量，来源记 `override`。生产入口无语料 → 派生 `core-5`，**这是有意的 Zone A 变更**。审计与 `AuditLight` 追加可选尾键 `toolProfile` / `toolProfileSource`（在 `retry` 之后；新 run 恒写、历史缺键兼容）。Golden：保留现有 DSH 七工具真源为 extended-7，新增 `review-tools-core5.json` / `review-tools-wire-core5.json`；重复组装字节稳定、工具序恒为注册表子序列。生产入口不注入知识语料（产品侧语料来源属父 spec out-of-scope，另行立项），因此单语料档位只在 toolkit 装配缝可达；run 内固定性由 loop 级 core-5 / core-5+rule / core-5+history 测试锁定。

### 4. Context Ledger（送达感知）

- **身份键**：`kind + 规范化工具参数 + 内容哈希 + 请求范围`。规范化包含：仓库相对 POSIX 路径、1-based 闭区间、缺省区间归一（整文件）、工具名。
- **记录字段**：`key / runId / toolCallId / messageId / kind / requestedRange / deliveredRange / contentVersion / contentHash / complete / charCount / hitCount / lastHitAt`。
- **命中规则（核心决策）：只对已被完整覆盖的请求返回引用。**
  - 完全相同请求 → 返回引用；
  - 整文件已完整送达后请求其子区间 → 返回引用，并注明「已送达范围包含请求范围」；
  - 请求范围未被已送达范围完全覆盖 → 视为未命中，重新执行并登记新条目；
  - **不做「部分命中 + 只补缺口」的拼接**——不谎报「已加载」。
- **引用文本**必须包含：引用 id、请求范围、实际送达范围、`complete` 标记。
- Ledger 覆盖全部七个工具（现状即如此），不新增工具面。
- 审计增加 `ledgerHits / ledgerMisses / savedCharsEstimate`；正常未命中路径的 wire 输出不变。
- **落地口径（#56，2026-11-12）**：实现载体 `contracts/ledger.ts` + `tools/ledger.ts`。命中桶按 `resourceKey`（工具名 + 决定资源内容的参数，不含请求范围）分组——整读（`file`）与子区间读（`range`）必须在同一桶内做覆盖判定；`kind` 只进条目身份键与审计。覆盖判定为 `deliveredRange ⊇ requestedRange`（`endLine = null` 表示到文件 / 结果结尾），范围类工具另记 `totalLines`：请求起点或终点越过资源总行数一律不覆盖（越界 clamp 不算覆盖），只有覆盖才返回引用并累计 `hitCount / lastHitAt`；截断整文件等未覆盖请求一律未命中并登记新条目。条目记录 `key / kind / description / requestedRange / deliveredRange / complete / contentHash / contentVersion / charCount / totalLines / hitCount / lastHitAt`（#57 追加可选 `shownResultLines / totalResultLines`，整结果工具截断时登记送达行数与完整行数）；内容哈希与版本进入条目身份键但不参与预读查询（查询发生在读取前，且 run 内快照内容不变）；`runId / toolCallId / messageId` 暂不在内核缝落位（Agent 桥接后续可追加，缺席省键）。引用文本单行：`Already loaded: ctx#NNN (<请求回显>; delivered <送达范围> of requested <请求范围>; complete=<bool>)`，其中 `complete` 描述**条目自身送达**是否完整（截断 / clamp 即 false）——是否可引用由覆盖关系单独保证。审计新增可选尾键 `ledgerStats: { ledgerHits, ledgerMisses, savedCharsEstimate }`（有账本查询时在场，零工具 run 省键）；`savedCharsEstimate` 对精确重复取送达字符数，对覆盖子区间按请求 / 送达行数比例折算（`endLine = null` 时用 `totalLines` 折算，不按 100% 计）。正常未命中路径的渲染层未改动，工具输出逐字节不变。

### 5. 截断选择

- **选择只在超预算时发生**：未触发截断时，工具输出逐字节不变（含条目顺序与空白）。
- 超预算时按各工具的确定性排序挑选 top-K，选中条目**保持原有顺序**输出（稳定选择），并附 `TruncationNotice`：

```text
reason: "char_budget"
budgetChars / shown / total / complete
nextCall?  // 仅 get_file
```

- 各工具选择键：

| 工具 | 排序 / 选择 |
|---|---|
| `get_file` | 头部保留；建议下一段 `startLine/endLine` |
| `get_diff` | 头部保留；列出未展开文件，建议 `get_file(path)` 深入（不扩 schema） |
| `get_symbol` | 精确名命中 > 类型声明 > 成员；平局按文件 / 行 |
| `find_references` | 声明优先，其后按文件 / 行 |
| `get_call_chain` | hop 1 > hop 2 > callee；平局按限定名 / 文件 / 行 |
| `search_rule` / `search_history` | 标题命中 > 正文命中；平局按语料序 |

- 除 `get_file` 外不给带参数的 `nextCall`（schema 无分页 / 过滤参数）；`get_diff` 的续读建议指向另一工具 `review.get_file(path=...)`，不是自身参数化 `nextCall`。扩 schema 另行立项，不在本 ADR。
- **落地口径（#57，2026-11-12）**：实现载体 `tools/result-budget.ts` 的 `applyRankedBudget`。未超预算时直接返回完整行集（与既有输出逐字节一致，含条目顺序与空白）；超预算时按 `rank` 字典序贪心选取**完整条目**（不输出半条目）、输出保持原序，分组头（`get_symbol` 的文件头、`get_call_chain` 的块头 + 空行）只在该组有任一条目入选时输出一次。各工具 `rank`：`get_symbol` 精确名命中中 [类型声明 0 > 方法/构造器 1 > 字段 2]（平局按文件 / 行原序）；`find_references` [声明 0 > 使用 1]（平局原序）；`get_call_chain` [hop1 1 > hop2 2 > callee 3，块序为次键]；`search_rule` / `search_history` [标题命中 0 > 正文命中 1]（平局语料原序）；`get_file` 保留头部并把「下一段 `startLine/endLine`」写进提示（预算连一行正文都放不下时不给无效建议）；`get_diff` 保留头部并列出未完全展开的文件（`diff --git` b 侧路径，含截断边界所在文件，最多 5 个 + `(+N more)`，建议 `review.get_file(path=...)`）。所有截断提示统一含 `shown / total / budget / complete=false`。Ledger 对整结果工具的非连续送达不再伪造行区间：`deliveredRange = null`、`complete=false`，并以 `shownResultLines / totalResultLines` 如实登记；整结果请求只被 `complete=true` 的整结果送达覆盖。<br>`nextCall` 是提示文本，不触发额外工具轮次。

### 6. 缓存合同

新增 `CacheContract` 记录：

```text
provider / endpointKind / requestedModel / respondedModel? / deploymentVersion?
usageFieldFamily: "deepseek-native" | "openai-cached-tokens" | "unknown"
cacheMetering / cacheBlockTokens? / cacheWarmupMs? / providerAffinityRequired?
cacheHitPrice? / cacheMissPrice? / cacheWritePrice? / currency? / priceValidFrom?
measuredAt
```

- **被动采集范围**：只从实际响应提取 usage 字段族与模型回显；不从密钥、请求头或环境变量推导缓存能力。
- **unknown / N/A 纪律**：未知字段记 unknown，缺失的可选字段省键或显式 N/A；**不得按 0 或固定折扣率（如 1/30）假设**缓存价格。缺价目表时只输出 token-equivalent CARC，`currency` 为 `null`；`retryCostTokens` 在有重试机制后填充，否则 `null`；`summaryCostTokens` 在无 compaction 时恒 `null`。
- **无密钥**：缓存合同与重试留痕不含任何密钥（ADR-0008）；审计新增可选 `cacheContract` 键，缺省省键，可外发。
- 价目表为静态 JSON（`priceValidFrom`、`currency`、三种价格），由分析 CLI 的可选参数读取；不存在时按 N/A 处理。
- 主动探针（warmup / 块对齐 / 路由亲和）只作仓内手动脚本 + runbook，**不进产品 bin、不进 CI**，避免非预期费用。
- **落地口径（#58，2026-11-12）**：契约 `contracts/cache-contract.ts` + 采集器 `provider/cache-contract.ts`。采集器包装注入的 FetchFunction，旁路读取响应副本（SSE 逐帧 / JSON 整体）提取响应模型回显与原始 usage 字段名；原 Response 原样返回，观测失败静默收口为 unknown，不击穿主链。字段族判定只看字段存在性：`prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` → `deepseek-native`；`prompt_tokens_details.cached_tokens` / 顶层 `cached_tokens` → `openai-cached-tokens`；有 usage 无缓存字段 → family unknown 且 `cacheMetering=false`；完全无 usage → `cacheMetering="unknown"`。`cacheBlockTokens / cacheWarmupMs / providerAffinityRequired` 被动不可得，恒 `"unknown"`；`deploymentVersion` 仅取非密钥响应头，否则 unknown。审计 `cacheContract` 为可选尾键（追加在既有 `stopReason` 之后，历史键序不变；新 run 恒写、历史缺键兼容），不含任何密钥；RunRecord `AuditLight` 同源投影。分析器把 `cacheContract` 原样带进报告（缺省省键，schema v3），提供静态价目表时在报告层附加价目三元组 / 币种 / 价目生效时间（ADR §6 字段），并按该价目表计算每 run 的 `currencyCost`：无价目表、`cacheReadTokens` 缺失、有写缓存量却无 `cacheWritePrice`、或有写价但写量未上报 → `null`（N/A，不按 0 / 固定折扣假设）；`report.currency` / `priceValidFrom` 仍随价目表缺省为 null。主动探针：`scripts/probe-gateway-cache.ts` + `docs/runbooks/cache-contract-probe.md`（`pnpm probe:gateway-cache`，手动、非 CI、非产品 bin）。
- **落地口径（#60，2026-11-12）**：纯函数 `src/eval/analysis/reusable-prefix.ts` 对相邻请求 wireBody 求最长公共前缀，按 `floor(LCP chars / 4)` 逐对求和得到 `predictedReusableTokens`；`actualCacheReadTokens = usage.cacheReadTokens ?? null`，`gap = actual − predicted`（actual 缺失 → null）。报告字段 `reusablePrefix: { estimated: true, estimateMethod: "chars/4", requestCount, pairCount, predictedReusableTokens, actualCacheReadTokens, gap }` 为可选键（无 wireBody 输入省键；schema v4），显式标注估算、不冒充真实计费。分析器保持纯只读、零网络、零密钥；wireBody 由 `analyze-token` 从 `record.baseline.auditPath` 的 `requests[].wireBody` 只读注入（相对路径以记录文件目录为基准），单记录 / experiment / runs-root 三种输入一致；审计缺失 / 不可读 / **任一 request 缺 wireBody** 按 N/A 省略且不阻塞报告——不得丢弃个别请求后把原本不相邻的两条当相邻比较。Markdown 单列「可复用前缀（估算）」段，注明 predicted 只覆盖请求 2..N 的相邻对、actual 为 run 级 cacheRead（含请求 1 与 provider 缓存门限 / 块对齐效应）、gap = actual − predicted。

### 7. 边界、治理与回滚

- **协议不新增旋钮**：不加协议字段、CLI 参数、环境变量或用户面预算旋钮（ADR-0015）；`ReviewBudget` 与 `toolProfileOverride` 只开在内核内部输入。
- **wire 不新增预算手段**：不在 wire 上新增 `max_tokens` 或其他改变请求字节的预算手段。
- **质量验证归评测线**：主线只设非行为门；L1/L2 判定与阈值按 ADR-0016 / ADR-0017 在 `eval/bench` 执行。ADR-0004 的 S/A/B 判据保留为历史 A–E 矩阵实验口径，本 ADR 不恢复 C 锚；ADR-0011 的上线门与人工接受率 KPI 仍是生产运营口径，质量非劣与收益判定只在评测线执行。
- **回滚路径**：只有 `ReviewBudget` 与 `toolProfileOverride` 两个内核内部旋钮；其余机制默认开启，回滚 = revert 对应批次 PR，不引入双实现与开关组合。
- **落地口径（#59，2026-11-12）**：实现载体 `provider/retrying-fetch.ts` + `contracts/retry.ts`。FetchFunction 包装只对网络错误 / 429 / 5xx 重试，最多 2 次（硬上限，不开放覆盖旋钮）；退避 500ms / 1500ms ±20%（随机源可注入，测试 fake timers），`Retry-After`（秒或 HTTP-date）按服务端值且不叠加抖动；退避等待可被 signal 中止（取消不必等退避结束）；AbortError / signal 中止不重试；2xx 原样返回（输出已开始）后不再重试。网络错误判定收窄为原生 fetch 的 TypeError（排除非法 URL 等编程错误）或 Node / undici 网络错误码。重试包装在缓存合同采集之内（合同只观测最终响应）；失败响应 usage 由重试层克隆解析，原响应体在重试前 cancel。审计 `retry` 为可选尾键（追加在 `cacheContract` 之后；无失败尝试省键），含 `retries / failedAttempts / exhausted / records[]`（每次失败的 `request / attempt` 归属、原因、状态码、实际退避、是否重试、失败 usage）；run 因重试耗尽失败且无法落盘时，同一留痕挂到错误 message / `cause.retry`（非耗尽错误原样透传，不张冠李戴）。分析器 `computeRetryCostTokens` 取失败尝试 usage 之和（无 retry 键或任一失败 usage 缺失 → null；显式输入优先），独立于 CARC。

## Options（为什么不是别的）

- **不先落契约、边实现边定语义**：否——批 2 改变生产默认路径，预算、Ledger、截断会各自发明口径；行为 ticket 之间无法互证。
- **用 wire `max_tokens` 做输出预算**：否——改变请求字节，击穿前缀缓存合同与 golden；且 provider 截断语义与阶段收口不一致。输出预算只做事后阶段边界判定。
- **attempts 耗尽即终止整轮**：否——会丢失 Finding；尝试预算是「别继续试」，不是「别看结论」。强制阶段收尾把控制权交回模型。
- **请求预算不留保底**：否——收紧预算是常态，不能把 run 切在没有候选 / 裁决的阶段。
- **Ledger 允许部分命中 + 补缺口**：否——拼接会制造「已加载」的假象；未完整覆盖一律重读，宁可多花一次读取。
- **每次截断都重新排序**：否——未超预算时改变字节会破坏前缀缓存与 golden；选择只在超预算时生效，且选中条目保持原序。
- **缓存按固定折扣率估算**：否——无法归因，且把命中率当成本结论；缺字段一律 unknown / N/A。
- **主动探针进 CI**：否——产生非预期费用，且可能触碰密钥；只作手动 runbook。

## Consequences

- **正**：批 2–4 有共同契约；预算成为控制面而非「继续试」；尝试耗尽仍能产出本阶段结论；Ledger 不谎报已加载；截断只在必要时改变输出且可行动；缓存成本可解释、可外发；回滚边界窄（revert PR）。
- **负/风险**：`core-5` 缺省是有意的 Zone A 变更，质量面未在主线验证，须评测线复核；强制收尾每阶段 2 次的上界在极端脚本下仍可能 `PHASE_FORCED_INCOMPLETE`；Ledger「未覆盖一律重读」会增加少量读取；缓存合同的价目与时间窗依赖人工维护，跨窗口比较必须标注混杂；历史 `TOOL_BUDGET_EXHAUSTED` 文案与新 `StopReason` 并存，分析器需按记录年代解释。
- **中性**：`truncationReasons` 保留为截断专用；`StopReason` 是新增可选项，不改写历史审计；分析器计数器仍从既有日志派生，不引入第二份真源。

跨线限定语纪律：本 ADR 为主线序列 0018；Demo 线 ADR 独立编号，引用须写「Demo 线 ADR-XXXX」。
