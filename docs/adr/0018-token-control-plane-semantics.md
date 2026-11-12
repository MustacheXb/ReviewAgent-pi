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
- 轮次预算沿用既有语义：一轮六阶段完整一遍，超出写截断原因。

#### 2.3 输出预算 → 只在阶段边界事后判定

- 累计输出超过 `maxOutputTokens` 时，只在阶段边界停止后续请求；**不**在 wire 上新增 `max_tokens`（会改变请求字节并击穿缓存合同与 golden）。
- 每阶段结束后检查累计输出；超限即不再发起任何后续请求——请求预算的 5/6 阶段保底（§2.2）**不豁免**输出预算。已完成阶段的内容保留。

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

- 除 `get_file` 外不给带参数的 `nextCall`（schema 无分页 / 过滤参数）；扩 schema 另行立项，不在本 ADR。

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

### 7. 边界、治理与回滚

- **协议不新增旋钮**：不加协议字段、CLI 参数、环境变量或用户面预算旋钮（ADR-0015）；`ReviewBudget` 与 `toolProfileOverride` 只开在内核内部输入。
- **wire 不新增预算手段**：不在 wire 上新增 `max_tokens` 或其他改变请求字节的预算手段。
- **质量验证归评测线**：主线只设非行为门；L1/L2 判定与阈值按 ADR-0016 / ADR-0017 在 `eval/bench` 执行。ADR-0004 的 S/A/B 判据保留为历史 A–E 矩阵实验口径，本 ADR 不恢复 C 锚；ADR-0011 的上线门与人工接受率 KPI 仍是生产运营口径，质量非劣与收益判定只在评测线执行。
- **回滚路径**：只有 `ReviewBudget` 与 `toolProfileOverride` 两个内核内部旋钮；其余机制默认开启，回滚 = revert 对应批次 PR，不引入双实现与开关组合。

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
