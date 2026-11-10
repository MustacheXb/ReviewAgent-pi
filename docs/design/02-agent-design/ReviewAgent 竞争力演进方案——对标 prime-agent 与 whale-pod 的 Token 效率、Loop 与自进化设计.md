# ReviewAgent 竞争力演进方案——对标 prime-agent 与 whale-pod 的 Token 效率、Loop 与自进化设计

> **文首说明**：本文是对两个参考项目的源码级对标分析，并据此提出 ReviewAgent-pi（下称"本仓"）的竞争力演进建议。分析对象为本地只读检出：
> `reference_project/prime-agent`（PrimeIntellect-ai/prime-agent @ `c718bf3`）、
> `reference_project/whale-pod`（Timothyhay/whale-pod @ `d76f522`）。
> 两者均为浅拉取锚定快照（无完整 git 历史），文中每条判断均给出一手 `文件:行号`；标注 **✅ 已实现且有测试 / 🟡 已实现但证据有限 / 📝 仅文档或愿景**。
> 本文是**分析与路线建议，不是已批准的实施计划**；任何机制进入主线仍需按 ADR-0004/0008/0011 的消融与判定门单独立项。

> **一句话结论**：本仓的竞争力不来自"更像通用 Agent"，而来自"用可预算的专用管线把单位 Token 的检视智能（RIE）做到最高"。**prime-agent 给的是长任务与经验沉淀的成熟形态，whale-pod 给的是把前缀缓存约束贯彻到字节层的工程纪律与可证伪评测法**。因此只吸收三类机制：能进消融矩阵并算出 RIE/CARC 增量、不破坏有界性、不破坏只读与证据闸。路线是 **P0 补齐度量与正确性 → P1 把长上下文能力做成可预算扩展 → P2 引入带护栏的 review 经验沉淀**。

---

## 0. 研究口径与证据边界

### 0.1 两个样本的锚定状态

| 项目 | 锚定 commit | 上游 | 与 pi 的关系 | 语言/形态 |
|---|---|---|---|---|
| prime-agent | `c718bf3`（2026-08-31） | PrimeIntellect-ai/prime-agent | **fork 自 pi 0.8.x**（package 版本 0.8.1），新增 Python kernel / RLM / refinement / daemon | TypeScript + Python |
| whale-pod | `d76f522`（2026-08-13） | Timothyhay/whale-pod | 独立实现，非 pi fork | Python |

prime-agent 的 fork 关系很重要：它的 `packages/{agent,ai}` 主循环与工具截断大量继承自 pi（与本仓 vendored pi 同源），真正的增量在 `packages/coding-agent/src/core/{kernel,refinement,compaction,agent-session}.ts` 与 `prime-agent-runtime/src/rlm/`。判断"哪些是它的创新"时必须扣除 pi 继承部分。

### 0.2 成熟度与数字可信度

本文对两个项目的宣称做了产物级复核，发现其 README 与已提交实验产物存在**不完全一致**，这本身是一个值得吸取的教训：

- whale-pod README 宣称 reasoning 三档中位命中率 96.4%/97.1%、离线-在线 MAE 3.7–6.4 点；但已提交的 `bench/results/live_run.log` 显示该次运行为 **MAE 7.1 点、session hit rate 85.1%**（`bench/results/live_run.log` 末段），且 tool/always 两档的原始 JSON 未随仓提交。离线 `validation.json` 可复现 as-built 911,083 prompt tokens / reusable_frac 0.942；README 的三区变体称 31.5%，产物为 44.4%。
- prime-agent 的 "self-improving" 落地物是 **harness 状态编辑**（`/refine`），仓库内**没有** RL/训练信号回传代码；README 链接的 verifiers / PRIME-RL 是外部项目（📝 愿景，非本仓能力）。
- 本仓侧的生产基线：`runs/phase2-pi/dashboard.md`（rep2+ 热口径）E 配置 `lineRecall 22.0% / linePrecision 22.3% / lineF1 20.4% / totalTokens 129,517 / cacheHitRate 60.6% / CARC 57,278`；B 配置 `17.5% / 29.6% / 22.4% / 58,292 / 75.8% / 29,342`。

**结论**：参考项目的机制可以学，**数字不能直接引用**；凡进入本仓报告的指标，必须由本仓审计字节独立复算。

### 0.3 本仓现状基线（生产 v3）

- 唯一生产形态：`review.submit` 无 `configId`（协议 v3，ADR-0015），服务端派生常量 `CONFIG_E`（`packages/review-pi/src/contracts/config.ts`）。
- 主循环：`runReview` → `runAgentReviewLoop`，跑在 vendored pi `Agent` 上；三个钩子缝承载语义——`shouldStopAfterTurn`（六阶段状态机）、`onPayload`（wire 审计）、`transformContext` 恒等透传（`packages/review-pi/src/run/review-run.ts:82-119`、`loop/agent-review-loop.ts:92-260`）。
- 六阶段骨架 + 双硬上界：`MAX_ROUNDS=5`、`MAX_TOOL_CALLS=6`（`loop/constants.ts:4,10`）；七只读工具、数量/顺序/schema 三固定（`tools/registry.ts:17-25`）。
- 上下文：Zone A 稳定系统提示 + MR user 单条消息 + append-only 阶段指令；**Zone B 预取/全仓注入已随研究装置退役**（`loop/messages.ts:1-26`）。
- 成本机制：单工具结果 8,000 chars 行边界截断（`tools/result-budget.ts:11,25-53`）；Context Ledger 以 `kind + description` 为键返回引用（`tools/ledger.ts:22-47`）；Cache Break 四分类纯观测（`loop/cache-break.ts:28-42`）。
- **没有**：compaction、子 agent、模型分层、跨 run 记忆、结构化评测闭环（评测装置冻结在 Demo 线）。

---

## 1. 两个样本的哲学：上下文是变量 vs 前缀是物理约束

### 1.1 prime-agent：把上下文当变量，把经验当状态

prime-agent 的两个核心抽象（`README.md:12-18`）：

1. **Recursive Language Model（RLM）**：上下文不是消息数组，而是**持久 Python REPL 命名空间里的变量**。文件、命令输出、大段数据可以存进变量，只把需要的切片 `print` 进上下文；子 agent 通过 `rlm(...)` 像函数调用一样递归派生。REPL 协议把"执行、快照、恢复、变量列举"做成一等能力（`prime-agent-runtime/src/rlm/repl.md`，`repl.py` 的 `snapshot/restore/list_names`）。
2. **Continual Harness**：提示补充、记忆、技能、子 agent 规范作为**可编辑的持久状态**，由 `/refine` 做小步、带证据、可回滚的更新；基础系统提示不可变（`packages/coding-agent/src/core/refinement/refinement.ts:123-173`、`prime-agent-runtime/src/rlm/harness.py:19-24`）。

这套哲学的收益：长任务不靠"更大的窗口"，而靠"上下文外包 + 状态沉淀"；代价是重量级 Python 运行时、单会话 venv、Windows 特殊处理，以及一个 11,926 行的 `agent-session.ts`。

### 1.2 whale-pod：前缀缓存是物理约束，不是优化项

whale-pod 只有一个核心命题：**请求开头的字节必须与上次逐字节相同**，否则前缀缓存不命中（`README.md:37-38`）。全部设计围绕它展开：

- 两区上下文：稳定前缀（工具定义 + 系统提示 + repo map）+ append-only 历史（`whalepod/core/messages.py:5-15`）；
- 三区设计被删除，因为"history 之后追加的任何东西本质上就是 history 的尾巴"，两个尾巴等于文件内容每轮重发（`messages.py:17-21`）；
- 历史的改写（prune/compact）被刻意做成"罕见、一次性、报告代价"（`messages.py:23-27`）；
- 度量哲学：**命中率不是目标函数，fresh-billed token 才是**——no-ledger 变体命中率几乎相同（93.7% vs 94.2%）却多付 20.7% token（`README.md:46-49`；`bench/results/validation.json`：1,099,805 vs 911,083）。

### 1.3 对本仓的含义：三条取舍原则

本仓已经走出第三条路：**受控管线 + 证据闸 + 字节稳定**，用有界性换取成本确定性。因此对标不是"变得像它们"，而是补齐它们更强的那部分，同时不稀释自己的护城河。三条原则：

1. **可归因原则**：任何新机制必须能进入 A–E 式消融矩阵，算出 RIE/CARC 增量；算不出就不进主线。
2. **有界性原则**：长任务能力必须表现为"可预算的扩展"（更多轮次、更大窗口、更多子任务），而不是"放开自由循环"。
3. **只读与证据原则**：不引入写工具、REPL 执行、训练信号；所有产出仍过 Evidence Gate（No Evidence, No Finding）。

---

## 2. 三维机制对照总表

| 维度 | 机制 | 本仓 v3 | whale-pod | prime-agent | 判断 |
|---|---|---|---|---|---|
| Token | 前缀字节纪律 | ✅ Zone A 稳定 + golden bytes + CI | ✅ 两区 + 对象身份 + 字节测试 | 🟡 依赖 provider 缓存 API | **本仓领先，补细节** |
| Token | 重复读取去重 | 🟡 描述键账本 | ✅ 身份键 + 消息绑定 + complete | ❌ 无（靠压缩） | **改造后重测** |
| Token | 上下文压缩 | ❌ 无（有界循环不需要） | ✅ 结构化摘要 + prune 回退 | ✅ 结构化 checkpoint + 增量更新 + split-turn | **大 MR 时引入** |
| Token | Repo map | ❌ Zone B 已退役 | ✅ token 预算 + 公平分配 + 确定性排序 | ❌ 无（技能元数据瘦身） | **大 MR 时引入** |
| Token | 工具输出截断 | 🟡 仅 head 8K chars | ✅ head/tail/middle 三形态 + 续读提示 + 溢出落盘 | ✅ head/tail + kernel 64K + bash 环形缓冲 | **直接吸收** |
| Token | 工具规则 | ✅ Zone A 固定 | ✅ 规则随工具集派生 | ✅ 工具描述内聚 | **改造吸收** |
| Token | 计量 | ✅ usage 映射 + 审计 | ✅ measured/unknown 区分 + 多 provider 归一 | ✅ 子 usage 归账 + own/total 分离 | **补归账与 unknown 语义** |
| Token | 模型/路由 | 🟡 单模型锁档 | ✅ provider pin + reasoning 三档 | ✅ per-child 模型 + service tier | **部分吸收** |
| Loop | 循环形态 | ✅ 六阶段 + 双硬上界 | 🟡 12 步自由循环 | ✅ REPL + steering/followUp/continuation | **保持本仓形态** |
| Loop | 工具并发 | 🟡 未显式约束 | ✅ 读并发 4 / 写串行 / 保序回填 | ✅ 整批并行 + sequential 标记 | **吸收显式策略** |
| Loop | 断线修复 | ❌ 未处理 | ✅ append-only 补结果 | ✅ aborted 消息归一 | **吸收** |
| Loop | 重试 | 🟡 pi 0.85.1 将网关瞬时错误终局化 | ✅ 状态码分类 + 无输出才重试 | ✅ 9 类失败 + overflow 状态机 | **吸收** |
| Loop | 子 agent | ❌ 无 | ❌ 无 | ✅ admission-only + 深度限制 + 归账 | **大 MR 时引入** |
| 自进化 | 经验沉淀 | ❌ 无 | ❌ 无 | ✅ /refine + auto-refine + 回滚 | **P2 带护栏引入** |
| 自进化 | 可证伪评测 | ✅ A–E 450 单元 + judge + disposition | ✅ 离线 wire + 在线 usage + MAE | ❌ 无统一评测（训练外置） | **本仓领先，补离线环** |

一句话读表：**Token 维度本仓已有骨架，缺的是细节与长上下文能力；Loop 维度本仓形态更优，缺的是长驻场景的鲁棒性；自进化维度本仓最弱，但 prime-agent 的成熟物是"状态编辑"而非"模型变聪明"，正好可以低风险移植。**

---

## 3. Token 效率：可平移的机制

### 3.1 度量哲学：先对齐"省的是什么钱"

whale-pod 最有价值的不是某个机制，而是**报告口径**：所有对照同时给 `prompt_tokens / reusable_tokens / fresh_tokens / cost`（`bench/validate.py:294-304`、`bench/results/validation.json`），并明确"高命中率 + 膨胀提示仍然是昂贵的"（`README.md:46-49`）。本仓已有 CARC/RIE（`docs/design/02-agent-design/ReviewAgent Token 优化方案…md:333-341`），但报告面仍以 `totalTokens + cacheHitRate` 为主。

**建议**：
- 主报告固定四行：`cachedInput / uncachedInput / output / CARC`；`cacheHitRate` 只做解释变量，不做目标函数。
- 缓存折价率必须**带价目表与时段**：本仓 Token 方案按 DeepSeek"命中≈未命中 1/30"计；whale-pod `validation.json` 的样本价目是 9e-08 vs 1.8e-08（1/5）。两者不矛盾，但说明**折价率随模型/网关/时段变化**，报告若不带价目表就无法横向比较。
- 网关未返回缓存字段时记 `N/A` 而不是 0（whale-pod `endpoints/base.py:105-109` 的 `measured=False` 语义；本仓 ADR-0008 已有同类原则，需在报告层落实）。

**验收门**：任一新机制的报告必须能回答"省的是 cached 还是 uncached"；无法回答的指标不进结论。

### 3.2 前缀字节纪律的四个补强（低成本、直接吸收）

本仓 Zone A 的 CI 字节门已经强于两个样本，但 whale-pod 有四个细节值得补：

1. **单一 system 消息**：whale-pod 把系统提示与 repo map 拼成一条 system 消息，理由是"provider 对重复 system turn 的合法性不一致"（`whalepod/core/messages.py:152-161`）。本仓当前系统提示 + MR user 两条消息，结构不同；若未来引入 Zone B，应保持"提示在前、易变内容在后"，让刷新只失效尾部（`messages.py:147-149`）。
2. **schema 对象身份复用**：whale-pod `ToolRegistry.schemas()` 返回构造时缓存的同一批对象，并有测试断言 `assertIs(reg.schemas(), reg.schemas())`（`tools/registry.py:182-194`；`tests/test_prompt.py:87-89`）。本仓已有 canonical 序列化字节稳定（`tools/registry.ts:3-8`），但可再加一条"同一 registry 两次取 schema 必须对象同一/字节同一"的测试，防止未来重构时悄悄重排。
3. **会话态变量禁入提示**：cwd/mode/time 不得进系统提示，并有测试钉死（`whalepod/core/prompt.py:8-10`；`tests/test_prompt.py:91-95`）。本仓 Zone A 已做到无 run 特定数据，建议把这条写成显式不变量测试（不只是 golden bytes 比对）。
4. **append-only 修复**：被中断的 tool call 通过**追加**结果消息修补，而不是改写 assistant 消息（`whalepod/core/messages.py:223-233`）。本仓当前每次 submit 是独立 job，无跨请求会话复用，**暂无此失败面**；作为未来会话续跑的设计储备（见 §4.3）。

**验收门**：上述四条各一条测试；不改变任何现有 golden bytes。

### 3.3 工具规则随工具集派生

whale-pod 把每个工具的 `guidelines` 写在工具定义旁，由 `ToolRegistry.guidelines()` 去重后注入系统提示的 "Using the tools" 段（`whalepod/tools/registry.py:59-160,196-209`；`core/prompt.py:52-65`）。两个被修复的问题（`registry.py:13-21`）：

- 新工具不可能"有 schema 无规则"；
- readonly 会话不携带写工具的说明段（测试断言提示里不出现写工具规则，`tests/test_prompt.py:54-67`）。

本仓七工具全只读，暂时没有"按会话裁剪工具集"的需求；但规则与定义分离的现状意味着**改工具规则时不会被迫改工具定义，反之亦然**。建议把七工具的规则从 Zone A 提示词中抽出，与 `tools/registry.ts` 的定义同处，由注册表派生 Zone A 的工具规则段。收益是可维护性与"规则永不漏配"，同时保持 Zone A 字节稳定（派生顺序固定）。

**验收门**：Zone A golden bytes 不变（或只做一次有意的版本升级）；新增"规则集合 == 启用工具集合"断言。

### 3.4 截断三形态：head / tail / middle 各有适用面

whale-pod 的截断分类是本仓最该直接吸收的小机制（`whalepod/tools/base.py:8-19`）：

| 形态 | 保留 | 适用 | 理由 |
|---|---|---|---|
| `truncate_head` | 开头 | 文件读取 | 第 1 行是文件顶，模型可按行号要其余 |
| `truncate_tail` | 结尾 | 命令输出 | 退出码、traceback、汇总都在底部 |
| `truncate` | 两端 | 仅人看的 diff/预览 | 程序无法"要中间"，但不能给模型用 |

并明确警告：**不要对模型要行动的工具输出做中间截断**——模型无法"要中间"，中间洞没有地址（`base.py:67-79`）。另有两点工程细节：

- 截断后**写出下一次调用的完整命令**（`tools/read.py:93-102`），因为单独的 "output truncated" 会引发盲目重读或瞎猜；
- 命令输出超限时**全文溢写到沙箱目录并把路径交给模型去 grep**（`whalepod/tools/edit.py:78,115-165` 的 `run_command` 实现），而不是丢弃。

本仓现状：`applyLineBudget` 只做行前缀保留（`packages/review-pi/src/tools/result-budget.ts:25-53`），对 `get_diff/get_symbol/get_file` 是正确的；但检索类工具的结果是**排序列表**（如引用结果在 `packages/review-pi/src/tools/search-tools.ts:148` 排序后进入预算层），行前缀截断会丢掉排序靠后的命中。建议：

- 为检索类工具引入"按相关性排序 + 显式截断通知（含总数与可缩小查询的提示）"；
- 所有截断通知统一携带"下一次调用的参数建议"，与现有确定性提示行纪律合并；
- 不引入中间截断给模型。

**验收门**：截断通知金样；检索类工具在 30 案上"截断后二次检索成功率"可测，不因截断引入额外轮次。

### 3.5 Context Ledger：四条修正，以及对本仓负结果的重新解释

本仓 Token 方案如实记录了账本机制的**方向性负结果**（DSH 侧 E 的 recall 三侧一致低于 D；`docs/design/02-agent-design/ReviewAgent Token 优化方案…md:288,400`）。whale-pod 的账本提供了四条本仓没有的工程修正，值得先修再重测：

| # | 修正 | whale-pod 实现 | 本仓现状 | 为什么重要 |
|---|---|---|---|---|
| 1 | **身份键**：`(mtime_ns, size)` | `core/ledger.py:22-28,109-120` | 无；仅 `kind+description` | 文件在 run 内变化（未来若引入写/刷新）时不会对旧内容声称"已加载" |
| 2 | **记录实际送达范围**，而非请求范围 | `tools/read.py:8-14,84` | 由工具描述字符串承载，未区分截断 | 截断读取后对"整个文件已在上面"的声称是假的 |
| 3 | **complete 标志**：仅完整未截断读取才可回答"全文件已加载" | `ledger.py:44-47,53-58` | 无 | 与 #2 配套，防止把模型指向不存在的尾部 |
| 4 | **message_id 绑定 + prune 回撤** | `ledger.py:42,92-106`；`core/agent.py:227` | 无（有界循环不 prune，暂无触发面） | 未来引入 compaction 后，被压缩掉的内容必须撤销"还在窗口里"的声明 |

第 4 条的历史很说明问题：这个 bug 是 whale-pod 的离线 bench 发现的，并在 live 运行中复现两次（`agent.py:224-227` 注释）。本仓一旦引入 compaction，同样的坑必然出现。

**对本仓负结果的解释（诚实版）**：本仓是**有界六阶段循环**，工具调用上限 6 次，重复读取本就稀少；当模型再次读取某内容时，通常是因为**当前阶段的推理需要原文在场**，而账本返回的指针把原文换成了"往上翻"——在有界循环里，模型没有足够的剩余轮次去"翻"。whale-pod 的账本收益建立在 12–37 请求的长会话上，重复读取是真实浪费；两个场景不同，负结果不能直接归因于"账本机制无效"。

**建议动作**：
1. 先补 1–3 三条修正（第 4 条随 compaction 一起做）；
2. 在本仓 pi 侧重跑 D vs E 消融（注意：pi 侧 dashboard 的 E recall 22.0% 已高于 D 的 19.5%，与 DSH 侧方向相反——说明结果对运行内核/上下文形态敏感，必须用本仓当前形态复测）；
3. 若仍为负，**默认关闭并保留形态开关**；把"账本命中次数/节省 Token"作为遥测字段，而不是产品默认行为。

**验收门**：同 30 案、同模型、同 rep；消融表给出 `recall / precision / uncachedInput / CARC`；只有 `uncachedInput 下降 ≥5% 且 recall 不降` 才允许默认开启。

### 3.6 Compaction：面向大 MR 的窗口治理

本仓当前不需要压缩：有界循环最多 5 轮 × 6 工具调用，窗口压力主要来自 diff 本身。但**大 MR 切分**是已识别但未实施的改进点（`docs/design/02-agent-design/ReviewAgent 语义去重与大 MR 检视方案.md`），一旦引入多轮/多文件/子任务，压缩就是必需能力。两个样本给出了两套互补设计：

**whale-pod：简单、结构化、失败可退**

- 触发：`min(window × 0.90, window − 16,384)`，一次切到 `0.50 × window`——"一次昂贵 miss 好过多次"（`core/messages.py:249-254,280-315`；`config.py:111-121`）；
- 绝对 reserve 的原因：32k 窗口的 0.90 只留 3.2k，一条 reasoning 回复就会击穿（`messages.py:112-119`）；
- 摘要调用**独立请求**：无 tools、`thinking=False`、`reasoning_effort="low"`、`max_tokens=2000`、`no_cache_write=True`——不与主前缀竞争缓存写（`core/compaction.py:19-33,151-181`）；
- 摘要格式 `Goal / State / Files / Next`，Files 段强制 `path:lines — why it matters`，供压缩后精确重读（`compaction.py:42-74`）；
- 摘要以 **user 消息**注入，而不是 assistant 消息——避免模型把别人的总结当成自己说过的话并为之辩护（`compaction.py:184-195`）；
- 失败（超时/限流/空响应）一律回退到 prune，用户回合永不失败（`agent.py:206-231`）。

**prime-agent：增量、split-turn、与持久状态协同**

- 默认 `reserveTokens=16,384 / keepRecentTokens=20,000`，触发 `contextTokens > window − reserve`（`packages/coding-agent/src/core/compaction/compaction.ts:104-114,206-210`）；
- **切点永不落在 toolResult**（工具结果必须跟它的调用），必要时在一个 turn 内切并用"前缀摘要 + split-turn 摘要"两段生成（`compaction.ts:276-319,348-414`）；
- **增量更新**：新摘要以 `<previous-summary>` 为底，规则是 PRESERVE/ADD/UPDATE，而不是每次从头总结（`compaction.ts:453-490`）；
- **与 kernel 持久状态协同**：摘要提示明确告诉模型"Python 变量还在，记录值得复用的名字"（`compaction.ts:450-451`）——压缩不是全丢，而是把"哪些东西还在别处"写进摘要；
- 上下文估算 = 最近一次 assistant usage + 尾部消息估算，且**把 output 计入下一轮 prompt**（`compaction.ts:122-124,173-201`）。

**对本仓的迁移建议**（P1，不作为当前主线）：

1. 只在"大 MR 切分/多轮扩展"立项时引入，不要为了"通用能力"引入；
2. 采用 whale-pod 的"独立请求 + 结构化摘要 + user 消息 + 回退 prune"作为最小可用版本；
3. 采用 prime-agent 的"增量更新 + 切点不破 tool 消息对 + split-turn"作为第二版；
4. 摘要成本必须计入 CARC（它是一次真实计费调用），并单独报告 `summary_tokens / tokens_dropped / 压缩后 fresh tokens`；
5. **与 ledger 联动**：压缩丢弃的 tool 结果要回撤账本条目（§3.5 第 4 条）。

**验收门**：合成大 MR（>10 文件或 >2K 行 diff）上，`lineRecall` 不低于无压缩基线、`CARC` 下降、`truncationReasons` 不增加；压缩失败路径必须回退且不失败 run。

### 3.7 Repo map：预算要按 token 计价，并按组件公平分配

本仓 Zone B（Repo Map/Symbol Index）已随研究装置退役；若大 MR 阶段重启，whale-pod 的三条经验直接可用：

1. **预算单位是 token，不是符号数**：2,000 个符号在 TypeScript 与 Python 里体积完全不同；whale-pod 在本仓 2,000 符号曾渲染成 70k tokens，因此 `max_tokens` 是真预算，`max_symbols` 只是 backstop（`context/repo_map.py:18-22`）；默认 `max(4,000, min(16,000, window × 1.5%))`，并解释"1M 窗口的 1.5% 是 32k 窗口的 25%"（`config.py:150-159`）。
2. **按顶层组件做加权 max-min 公平分配**：取代"字母序截断让 vendored `reference/` 吃光预算"；tests/docs/reference 权重 0.35（`repo_map.py:386-423`）。本仓 `.gitignore` 式的排除（`whale-pod/.whalepod.json` 排除 vendored `reference`）同样适用。
3. **确定性排序 + 显式截断**：候选先收集再按浅路径优先排序，避免 `os.walk` 的文件系统顺序造成前缀漂移（`repo_map.py:253-262,307-317`）；截断必须写出来，因为"静默截断的地图读起来像全仓库"（`repo_map.py:464-475`）。

**对本仓**：若重启 Zone B，预算按"窗口比例 + 绝对上下限"，排序与截断纳入 golden bytes 测试；不做"按符号数截断"。

### 3.8 Provider affinity 与 reasoning echo：缓存的两个外部前提

**Provider affinity**：前缀缓存是**单机状态**；一个在多个 provider 间负载均衡的路由器会把缓存变成零。whale-pod 实测同一 11.2k token 前缀 unpinned ~0%、pinned 98%（`endpoints/base.py:251-259`），并把 `allow_fallbacks: false` 作为防止"静默改路由导致成本回归"的开关（`README.md:150-158`）。本仓走企业网关，路由未必可控，但原则适用：

- 网关探测脚本（`packages/review-pi/src/provider/gateway-probe.ts`）应把"是否固定到同一后端/同一缓存域"纳入探针；
- 若网关不支持 pin，报告必须显式标注"cacheHit 受路由影响"，不能与官方 API 数据直接横向比较（本仓 ADR-0011 已有"跨侧对比带时段限定"的纪律，可扩展为"带路由限定"）。

**Reasoning echo 三档**：whale-pod 将 `reasoning_content` 回传策略做成 `never / tool / always` 三档可切换（`endpoints/vllm.py:71-74`；`config.py:102`；`core/agent.py:137-149`），默认 `tool`，因为 DeepSeek 在带工具的轮次要求回放思维链（`vllm.py:17-23`）。其实测（README 表）显示：`always` 命中率最高但 prompt 膨胀到 2.2M；`never` prompt 最小但多轮带工具时可能违反 provider 契约；`tool` 是折中。

本仓 `review-pi` 当前只把 `reasoningEffort` 锁 high（`provider/pi-client.ts:17-29`），**没有显式的 reasoning 回传策略开关**，回传行为由 vendored pi 决定。建议：

- 先在审计里记录每个请求是否携带 `reasoning_content`（纯观测，不改字节）；
- 用 A/B 消融测三档对本仓的影响（尤其带工具的阶段 4/5）；
- 不预设 `always` 更好——它的正确性前提是 provider 契约，成本前提是缓存折价率。

**验收门**：wire 审计新增 `reasoningEchoMode` 字段；三档消融给出 `cacheHit / uncachedInput / CARC`，不改判定链。

### 3.9 上下文外包：变量、影子调用、子 agent

这是 prime-agent 最值得本仓在大 MR 阶段借鉴的思想，但需要裁剪：

1. **Context-as-variable**：REPL 里把大输出存变量、只打印切片（`prime-agent-runtime/src/rlm/repl.md` 的持久命名空间与 `snapshot/restore`）。本仓没有 REPL，也不应引入；但可以用**工具层的"引用句柄"**模拟——工具返回大结果时同时返回 `artifact://run-id/ref-id`，模型可用 `review.get_artifact(ref-id, range)` 精确取片段。这比"把全文塞进上下文"更省，也比账本的"往上翻"更可寻址。**这是本文提出的本仓原生改造，不是参考项目现成能力**。
2. **Side-question 影子调用**：prime-agent 用一个克隆主会话、无工具、thinking off 的影子 agent 回答旁路问题，答案不进主会话（`packages/coding-agent/src/core/side-question.ts:42-102`）。本仓可用于"这个符号是什么意思/这个规则在哪"的低风险查询，避免污染主证据链；但每次都是一次计费调用，必须计入 CARC。
3. **子 agent**：见 §4.6。

### 3.10 计量与归账：从"总数"到"可对账"

prime-agent 的子 agent usage 归账值得本仓在大 MR 阶段直接借鉴：子 agent 的花费**计入账单总额，但不膨胀父的上下文窗口测量**；`context-tree.ts` 在展示时把归账的子 usage 从 own 中减掉，保证树级 own 与 root 总额可对账（`packages/coding-agent/src/core/context-tree.ts:63-95`；`agent-session.ts:10553-10576`；`docs/rlm-runtime.md:191`）。

本仓当前所有调用都在一个 run 内，暂无归账需求；但若引入子 agent，必须同时引入：

- `ownUsage` 与 `totalUsage` 两个字段；
- `attributedChildUsage` 持久化条目；
- 报告同时给"父上下文峰值"与"整棵树 CARC"——否则"子 agent 很便宜"会变成账面幻觉。

---

## 4. Agent Loop：可平移的机制

### 4.1 双通道注入：steering vs followUp vs continuation

prime-agent 继承 pi 的三条消息注入通道，语义分明（`packages/agent/src/agent-loop.ts:304-449`）：

- **steering**：turn 边界注入，用于打断/调整方向（`:318-340`）；
- **followUp**：只在 run 空闲时拉取，用于后续任务（`:414-426`）；
- **continuation**：用于 goal/autonomous 续跑（`:429-443`）。

本仓六阶段用的是 `agent.followUp` 注入下一阶段指令（`loop/agent-review-loop.ts:202-204,282`），语义正确：阶段推进必须等当前轮结束。**不需要改**；但可以借鉴"三通道分离"的思想，把未来的"人工中途纠偏（steering）"与"阶段推进（followUp）"在审计里分开记录，避免把用户干预误记为阶段推进。

### 4.2 工具并发：读并发、写串行、结果按调用序回填

whale-pod：连续只读工具并发（上限 4），写工具严格串行；**结果按调用序 append**，因为 provider 按位置与 id 匹配（`core/agent.py:358-385`）。prime-agent：整批默认并行，任一工具声明 `executionMode:"sequential"` 则整批串行；ipython 因单线程 kernel 显式标 sequential（`agent-loop.ts:585-600,667-719`）。

本仓七工具全只读，理论上可并发；但**当前 review 层没有显式并发策略**，行为由 pi 内核工具执行面决定。建议：

- 在 toolkit 契约里显式声明每个工具的执行模式（即使全读也写清楚），避免未来加入"规则库写入/反馈回传"时意外并发；
- 若启用并发，审计记录"批次大小/并发度"，并保持结果按调用序回填的字节约束；
- 不为并发而并发：本仓工具调用上限 6 次，并发收益有限，**优先级低于正确性与可审计性**。

### 4.3 悬挂 tool call 的 append-only 修复（设计储备，当前无失败面）

whale-pod 在每个新用户轮开始**之前**修复悬挂 tool call：扫描最后一条 assistant 的工具调用，对没有结果的调用**追加**一条中断结果，而不是改写历史（`core/messages.py:205-233`）。顺序很关键——如果先 append 新用户消息，`open_tool_calls()` 只回扫到最近 user 轮就会漏掉（`agent.py:170-177`）。

**本仓当前不需要做**：RPC 的每个 `submit` 都是独立 job（`packages/review-pi/src/rpc/service.ts` 不变量："同一 job 至多一个执行实例；断连不取消 job；running 重启 → failed，不假装续跑"），`runReview` 每次从空会话开始，不存在"下一次请求携带上一条悬挂 tool call"的路径。取消/断连直接终态化，内核会话随 job 结束丢弃。

**只有当未来引入"会话续跑 / 断点恢复 / 多轮追问同一 MR"时才需要**，届时按上述三条实现：run 边界 append-only 修复、修复进审计、不重写 assistant 消息。**不纳入 P0**，列为此类功能的准入前置项。

### 4.4 失败分类与溢出恢复：不要把所有错误都重试

whale-pod 的重试纪律（`core/agent.py:285-302`）：

- 按**状态码**判定可重试（408/409/429/5xx），不靠错误文本子串；
- 只在**尚未向用户展示任何输出**时重试（`e.before_output`），否则会重复输出；
- 指数退避。

prime-agent 更进一步：`stream-failure.ts` 把 provider 错误分 9 类（refusal/safety/overloaded/rate_limit/auth/…）并写入 assistant 诊断（`packages/ai/src/utils/stream-failure.ts:66-88,206-232`）；overflow 单独走状态机——溢出 → 剥掉错误消息 → 压缩 → 重试一次 → 再失败转 "reported" 终态（`agent-session.ts:8497-8516`），并有陈旧消息/跨模型切换防抖（`:8474-8487`）。

本仓现状：vendored pi 停在 0.85.1，已识别的差距是**网关瞬时错误会被终局化为失败 run**（`docs/design/03-kernel/Pi 内核上游更新影响分析….md` §2.4/§4.1）。在"不升级内核"的前提下，可以在 review-pi 层补一层薄重试：

- 只对**首字节前**的 429/5xx/网络错误重试（1–2 次，指数退避）；
- 重试事件进审计，**不改 wire 字节**（同一请求重发）；
- 对 400（请求非法）与 401/403（认证）不重试；
- 若未来引入 compaction，加"溢出 → 压缩 → 重试一次"的窄状态机。

**验收门**：注入网关 429/503 与超时，run 成功率提升且无重复输出；审计重试次数与最终计费可对账。

### 4.5 停止条件显式化

whale-pod 到达步数上限时明确写 `[stopped after N tool steps…]`，而不是返回陈旧的半成品字符串（`core/agent.py:197-203`）。本仓已有 `truncated` + `truncationReasons`（`MAX_ROUNDS_REACHED / TOOL_BUDGET_EXHAUSTED`），这是本仓更强的地方；建议保持，并把"阶段未完成但被预算截断"与"模型明确终止"在报告层分开呈现，避免把截断误读成模型判断。

### 4.6 子 agent：admission-only + 深度限制 + 归账

prime-agent 的 RLM 子 agent 是本文认为**对大 MR 最有价值、但最不该现在做**的机制：

- `rlm(...)` 在准入后立即返回句柄（`rlm_child_id/name/session_dir/model`），**绝不返回子答案**；结果只能经 `agent_message.send` 或文件回流（`prime-agent-runtime/src/rlm/__init__.py:92-102,233-253`；`docs/rlm.md:64-76`）；
- 递归深度默认 2，超限拒绝（`agent-session.ts:10406-10410,1584-1602`）；
- 子上下文完全隔离：新建空 system prompt、空工具的 Agent（`agent-session.ts:9506-9513`）；
- 子 usage 异步归账（`:10553-10576`）；
- 子注册表跨 compaction/重启存活（`rlm.list_subagents()`）。

对 ReviewAgent 的裁剪版"并发检视员"设想：

```text
主评审（六阶段）
  ├─ 变更理解后，按文件/子域切分（大 MR）
  ├─ spawn 子检视员（深度 1，隔离上下文，各自只读工具子集）
  │    结果不是散文，而是 Finding 候选 + 证据（结构化）
  ├─ 主评审合并候选，统一走 Evidence Gate
  └─ 子 usage 归账，父上下文只保留候选摘要
```

**为什么现在不做**：本仓的单轮成本已经很低，子 agent 的收益只在大 MR/多语言场景出现；而它会引入并发、结果合并、去重、归账、故障隔离一整套复杂度。等大 MR 切分立项时一起做，并复用 §5 的"结构化编辑"思想——**子 agent 的产出必须是候选而非结论**，否则证据闸会被绕过。

### 4.7 不学的 Loop 形态

- **自由循环**（whale-pod 12 步 / prime-agent REPL 无限 cell）：本仓的六阶段 + 双硬上界是成本护城河，不能放开；
- **Python REPL 内核**：安全面、冷启动、Windows 兼容、单会话 venv 成本高，且本仓不需要"模型执行代码"；
- **daemon/cron/goal/autonomous**：长跑自主 agent 能力，与 MR 检视的请求-响应形态不匹配。

---

## 5. 自进化：带护栏的状态编辑，而不是"模型自己变聪明"

### 5.1 prime-agent `/refine` 的完整拆解

这是本文认为最值得本仓在 P2 阶段移植的机制，因为它的形态与"检视经验沉淀"高度同构：**不是让模型 freely remember，而是让模型提出结构化、带证据、可回滚的编辑**。

**状态层**（`prime-agent-runtime/src/rlm/harness.py`）：

- 四类可编辑状态：`prompt / memory / skill / subagent`（`:19-24`）；
- 每条 entry 有 `id/title/content/path/scope/reference/arguments/metadata/source/version/created_at/updated_at`（`:94-110`）；
- local（会话内）/ global（跨会话）双 scope，默认 local（`:78-91`）；
- mtime 跨进程同步，防止 host `/refine` 与 kernel 写互相覆盖（`:187-197`）；
- 损坏文件降级为空，不崩溃（`:204-211`）。

**两段式**（`packages/coding-agent/src/core/refinement/refinement.ts`）：

1. **Review gate**（`:963-1012`）：先花 ~4k 输出预算问"这个轨迹里有没有值得沉淀的证据"，拒绝一次性噪声、无证据假设；只有 `shouldRefine=true` 才进入下一步。
2. **Planner**（`:880-948`）：取轨迹最后 80,000 字符（`:906`），拼当前 harness 概览 + 历史 + scope 政策，**强制非 reasoning 模式**（`:922-926`，把预算全给 JSON），输出结构化提案：
   ```json
   {"summary": "...", "rationale": "...", "expectedOutcome": "...", "edits": [
     {"action":"create|update|delete","kind":"prompt|memory|skill|subagent",
      "id":"...","title":"...","content":"...","reference":{...},"arguments":{...},"reason":"..."}
   ]}
   ```
3. **Apply**（`:716-811`）：逐条校验 → 重读文件做 baseline 冲突检测（`:736-749`，"entry changed during refinement planning"）→ 应用并记录 before/after。

**硬护栏**（这是它比"自由记忆"强的地方）：

- **基础系统提示不可编辑**：`if (edit.kind === "prompt" && (edit.id === "base_system_prompt" ...)) return "base system prompt is not editable"`（`:680-681`）；
- skill 编辑必须带 Python reference + arguments 契约（`:689-712`）；
- 截断 JSON 诊断（括号/字符串深度扫描）区分"预算耗尽"与"格式坏"（`:570-589`）；
- **回滚**：每次 refinement 记录 before/after，`rollbackProposal` 逆序生成反向编辑（`:813-845`）；
- **scope 纪律**：默认 local；global 必须是跨会话稳定教训，且 local refinement 期间 global entries 只读（`:140-148`）。

**定时触发**（auto-refine）：`turn_interval`（N 个 assistant turn）与 `compact`（压缩时）两种（`:110`）；serialized 模式下 planning 在主模型流结束、工具还在跑时**后台并行启动**，到 turn 边界才 await 并 apply（`agent-session.ts:3630-3638`），避免与主模型请求竞争。

### 5.2 whale-pod 的"可证伪评测闭环"（虽无自进化，但这是自进化的地基）

whale-pod 产品内**没有**自我改进机制（全仓无记忆/学习/提示自优化）。但它有一套完整的"假设 → 离线预测 → 在线实测 → 归因"闭环，正好补上本仓自进化最缺的一环：

- **离线环**（`bench/validate.py`）：无网络、无 key；继承真实端点、用**官方 chat-template 编码器**把请求渲染成服务器实际快分词字节（`:12-15,180-221,241-249`）；按 64-token 块计算"相邻请求最长公共前缀"，并明确命名为 **reusable prefix 而不是命中率**（`:268-283`）；四变体对照（as-built / no-ledger / rolling-summary / 被删的三区设计），每个机制都能单独归因。
- **在线环**（`bench/live_acceptance.py`）：真值来自服务器 `usage.cached_tokens`；同时用离线预测对同一 payload 计算，报告 MAE（`:557-558`）；`--repeat 10` 给中位数/P10/P90（`:625-659`）；把命中率塌陷归因为"自家前缀变了（prune）"还是"服务端 KV 逐出（idle）"（`:566-583`）；pin A/B 用唯一前缀 + nonce 置顶防止两臂互相污染（`:439-465`）。
- **诚实标注**：离线只叫 reusable prefix，绝不冒充命中率（`:12-15`）；provider 不报 usage 时显示 "unmeasured" 而不是编一个数（`endpoints/base.py:105-109`）。

**对本仓的启示**：本仓已有 A–E 450 单元的主评测与三侧判定链，这是比 whale-pod 更强的在线环；缺的是**离线、秒级、无 key 的前缀可复现环**。建议：

- 用本仓 wire 审计里的 `parametersJson/wireBody` 做"离线重算 reusable prefix"，与线上 `cacheReadTokens` 对账，报告 MAE；
- 每个新机制先跑离线变体矩阵，再决定是否上在线评测；
- 把"离线预测 vs 线上实测"的偏差作为**计量器自身的健康指标**——偏差突然变大，说明网关/编码器/审计有一处变了。

### 5.3 ReviewAgent 的自进化三层设计

结合本仓现状（评测冻结在 Demo 线、生产有 `disposition` 人工接受率 KPI），建议分三层，**每层都必须有独立门**：

**第 1 层：规则记忆（最保守，先做）**

- 状态类型只保留 `rule`（缺陷模式/检查单）与 `memory`（仓库事实/历史结论），**不做可执行 skill、不做 subagent spec**；
- scope：`repo`（按仓库指纹）/ `global`（跨仓通用规则）；默认 `repo`；
- 每条规则必须带：`evidence`（来自哪些 run/finding）、`expectedOutcome`（预期改善哪个指标）、`version`、`createdAt`；
- 只允许追加/更新，删除走显式人工操作；
- 注入位置：Zone B（若大 MR 重启）或阶段 2 的 Risk Classification 提示，**不进 Zone A**，避免破坏字节稳定。

**第 2 层：refine 两段式（P2）**

- 复用 prime-agent 的 review gate + planner 结构，但触发不是"每 N turn"，而是**每批评测/每 N 个 disposition**；
- planner 的输入不是原始轨迹，而是**结构化 run record**（finding、证据、judge 结果、人工处置），避免把工具输出原文塞进提炼调用；
- 强制非 reasoning、独立请求、`no_cache_write`（同 compaction 纪律）；
- 应用前做 baseline 冲突检测；每次 refine 记录 before/after 与回滚 ID；
- **基础提示词、六阶段骨架、工具 schema、证据闸规则一律不可编辑**——只允许编辑"规则记忆"。

**第 3 层：路由策略（P2，与既有 Cache-aware Model Routing 合并）**

- 状态：`model × provider × cacheWarmth` 的决策表；
- 证据：在线 `CARC` 与 `cacheHit`；
- 约束：换模型必须过迁移门（ADR-0008）；换路由必须过网关探针（ADR-0011）；
- 不做自动切换，只产出"推荐配置 + 证据"，人工批准后生效。

### 5.4 与 disposition KPI 的关系：真实世界的 reward

本仓生产侧已有 `reviewagent disposition` 的人工接受率 KPI（`packages/review-pi/src/disposition/kpi.ts:21-58`），这是比 judge 更接近真实价值的信号。建议把它作为自进化的**唯一晋升依据**：

- 规则/路由的 `expectedOutcome` 必须指向一个可观测 KPI（接受率、误报率、人工修改率）；
- 单次 run 的证据不足以改规则——至少 N 个 disposition 样本 + 统计显著性；
- 规则上线后设观察期，KPI 下降自动回滚。

### 5.5 自进化红线

1. **不改基础系统提示**（prime-agent 的硬护栏，直接照搬）；
2. **不做 RL/训练信号回传**（prime-agent 仓库里也没有；这是外部愿景，不是产品能力）；
3. **不自动全局推广**：global 规则必须人工批准；
4. **不以单次会话证据改规则**（auto-refine 的 review gate 就是为这个存在的）；
5. **不让自进化影响判定链**：规则只能影响"看什么"，不能影响"证据是否成立"。

---

## 6. 与本仓现有约束的冲突与诚实边界

| 约束 | 与参考项目的冲突 | 处理 |
|---|---|---|
| **有界循环（5 轮/6 工具）** | whale-pod 12 步自由循环、prime-agent 无限 REPL | 保持有界；长任务能力用"可预算扩展"（大 MR 分片/子 agent）实现，不放开循环 |
| **单模型锁档（ADR-0008）** | prime-agent per-child 模型、service tier | 辅助调用（compaction/refine gate）可用更便宜的模型，但必须单独计量、单独门；主检视模型不变 |
| **企业网关缓存行为** | whale-pod 可 pin provider；本仓网关路由未必可控 | 先探针、再报告；不把官方 API 的命中率当基线；跨侧对比带"路由+时段"限定 |
| **账本负结果** | whale-pod 账本正收益 | 先补四条修正再重测；pi 侧 E 已高于 D，方向与 DSH 侧相反——必须用当前形态复测；仍负则默认关 |
| **C 锚塌缩（ADR-0004 caveat）** | whale-pod 用 "as-built vs no-ledger" 做同会话对照 | 学其"同会话变体对照"，但保留本仓的 30 案统计口径；不拿单会话替代 450 单元 |
| **浅仓无历史** | prime-agent 与 pi 的 diff 只能按文件对照 | 本文所有"继承 vs 新增"判断按同名文件与版本号推断；需要精确归因时再补 `git fetch --unshallow` |
| **参考项目数字不可复现** | README 与产物不一致（§0.2） | 只引用可由产物复核的数字；其余标"宣称" |

---

## 7. 演进路线：P0 / P1 / P2

> 优先级原则：先补"度量与正确性"（低风险、不改模型行为），再做"长上下文扩展"（需要独立门），最后做"自进化"（需要数据积累与人工审批）。

### P0：度量与正确性（建议 1–2 周，低风险）

| 编号 | 事项 | 参考 | 工作量 | 验收门 | 回滚 |
|---|---|---|---|---|---|
| P0-1 | 报告口径改为 fresh-billed 四行（cached/uncached/output/CARC），cacheHit 作解释变量；未测量记 N/A | whale-pod §3.1 | 0.5d | 任一 run 报告可回答"省的是 cached 还是 uncached" | 纯报告层 |
| P0-2 | Ledger 补身份键/送达范围/complete/命中计数；pi 侧重跑 D vs E 消融 | whale-pod §3.5 | 2d | `uncachedInput ↓≥5%` 且 `recall` 不降才默认开；否则默认关并留开关 | 开关关闭 |
| P0-3 | 截断三形态 + 续读提示（检索类排序/总数/缩小查询建议） | whale-pod §3.4 | 1d | 截断金样；30 案上不增加工具轮次 | 恢复 head-only |
| P0-4 | 工具规则与定义同处，由注册表派生 Zone A 工具规则段 | whale-pod §3.3 | 1d | Zone A golden bytes 不变；规则集合 == 启用工具集合 | 恢复内联提示 |
| P0-5 | review-pi 层薄重试（首字节前 429/5xx，1–2 次） | whale-pod §4.4 | 2d | 注入网关错误成功率提升、无重复输出、可对账 | 关闭重试 |
| P0-6 | 停止原因分层呈现（模型终止 vs 预算截断 vs 阶段未完成） | 本仓已有 | 0.5d | 报告无歧义 | 纯报告层 |

### P1：长上下文与并发检视（大 MR 立项后，4–8 周）

| 编号 | 事项 | 参考 | 验收门 | 依赖 |
|---|---|---|---|---|
| P1-1 | Compaction（独立请求 + 结构化摘要 + user 消息 + prune 回退） | whale-pod §3.6 / prime-agent §3.6 | 合成大 MR：recall 不降、CARC 降、失败可退 | P0-2（账本回撤） |
| P1-2 | Repo map 预算（token 计价、fair-share、exclude、确定性排序、显式截断） | whale-pod §3.7 | 字节稳定 + 预算越界可解释 | 大 MR 立项 |
| P1-3 | 并发检视子 agent（admission-only、深度 1、隔离、usage 归账、候选非结论） | prime-agent §4.6 | 父上下文不增长；质量不降；整树 CARC 可对账 | P1-1 |
| P1-4 | 引用句柄（artifact://）替代"往上翻"式账本应答 | 本文 §3.9（本仓原生） | 重读可寻址；uncached 降；实现不引入 REPL | P0-2 |
| P1-5 | reasoning echo 三档观测与消融 | whale-pod §3.8 | wire 审计可归因；三档 CARC 对比 | 无 |

### P2：自进化（有 6 个月以上数据后，3–6 个月）

| 编号 | 事项 | 参考 | 验收门 | 依赖 |
|---|---|---|---|---|
| P2-1 | 规则记忆层（repo/global、evidence/expectedOutcome/version、只追加） | prime-agent §5.1（裁剪） | 规则可检索、可回滚、不影响判定链 | P1 |
| P2-2 | refine 两段式（review gate + planner + baseline 冲突 + before/after） | prime-agent §5.1 | 每批 disposition 触发；人工审批 global；回滚可用 | P2-1 |
| P2-3 | 离线前缀可复现环（wire 字节重算 reusable prefix + 线上 MAE 对账） | whale-pod §5.2 | 离线秒级、无 key；MAE 作为计量器健康指标 | P0-1 |
| P2-4 | Cache-aware 路由推荐（只产证据不自动切换） | 本仓既有未来项 | 迁移门 + 网关探针全绿 | P2-3 |

---

## 8. 不采纳清单

| 不采纳 | 来源 | 理由 |
|---|---|---|
| 自由循环 / 无限 REPL | whale-pod / prime-agent | 破坏有界成本护城河；检视任务不需要开放探索 |
| Python REPL 内核 | prime-agent | 安全面、冷启动、venv 管理、Windows 兼容成本高；本仓不需要模型执行代码 |
| 写工具（edit/bash） | whale-pod / prime-agent | 检视是只读任务；写能力徒增 schema 字节与误用面 |
| RL / 训练信号回传 | prime-agent（仅外部愿景） | 仓库内无实现；与产品当前形态无关 |
| 每 N turn 自动 refine | prime-agent | 每次两次额外 LLM 调用；本仓应按"批评测/批处置"触发，而不是按会话轮次 |
| chars/4 估算中文 token | prime-agent | 中文 1 字符≈1 token，chars/4 会低估约 4 倍；本仓以字符预算作为跨平台确定性代理可以，但不能当计费真值 |
| 三区上下文（volatile working set） | whale-pod（已删除的设计） | 实测命中率崩到 44.4%；"两个尾巴"等于每轮重发文件内容 |
| daemon/cron/goal/autonomous | prime-agent | 长跑自主 agent 与 MR 请求-响应形态不匹配；长驻需求已由 RPC 覆盖 |
| 把 README 数字当结论 | 两者 | §0.2 已证 README 与产物不一致；只引用可复核数字 |

---

## 9. 结论

1. **本仓的 Token 骨架不落后，落后在"细节纪律"与"长上下文弹性"**。whale-pod 的账本身份键、截断三形态、repo map token 预算、provider pin、measured/unknown 语义，都是低成本可吸收的工程细节；prime-agent 的 compaction、子 agent、重试分类、usage 归账，是长任务阶段的必要能力。
2. **自进化不是让模型变聪明，而是让经验变成可编辑、可回滚、可证伪的状态**。prime-agent 的 `/refine` 两段式 + 硬护栏是本仓最值得移植的形态；whale-pod 的离线/在线评测闭环是它的地基。两者结合，才能避免"规则越积越多、效果越跑越差"。
3. **竞争力领先的定义不是"功能更多"，而是"每个机制都能被消融证明"**。本仓已经有 450 单元主评测、三侧判定链与 disposition KPI，这是两个参考项目都没有的资产；把 whale-pod 的离线环补上、把 prime-agent 的护栏借来，本仓就能在"专用检视 Agent"这条线上继续保持单位 Token 检视智能的领先。
4. **执行顺序必须是 P0 → P1 → P2**。先修度量与正确性（不改模型行为），再做大 MR/子 agent（独立门），最后做自进化（数据+人工审批）。任何跳过消融直接上主线的机制，都会把本仓最珍贵的"可解释成本"变成"故事成本"。

---

## 附录 A：证据索引

### A.1 whale-pod（`reference_project/whale-pod`）

| 主题 | 文件:行号 |
|---|---|
| 两区上下文 / 三区删除 | `whalepod/core/messages.py:5-27` |
| 上限公式 / 绝对 reserve | `whalepod/core/messages.py:112-119,249-254` |
| 单条 system 消息 | `whalepod/core/messages.py:152-161` |
| append-only 修复 | `whalepod/core/messages.py:205-233` |
| 切点与工具消息完整性 | `whalepod/core/messages.py:280-344` |
| 账本身份/送达/complete/回撤 | `whalepod/core/ledger.py:22-58,92-120` |
| 摘要格式与独立请求 | `whalepod/core/compaction.py:19-74,151-181,184-195` |
| 摘要输入削减 | `whalepod/core/compaction.py:99-138` |
| 静态提示 / guidelines 派生 | `whalepod/core/prompt.py:8-10,52-65` |
| 主循环 / 压缩回退 / 重试 | `whalepod/core/agent.py:168-231,285-302` |
| 工具批调度 | `whalepod/core/agent.py:358-385` |
| 账本命中 / 登记 | `whalepod/core/agent.py:523-564` |
| repo map 预算 / 公平分配 / 确定性 / 显式截断 | `whalepod/context/repo_map.py:18-22,253-262,307-317,398-423,464-475` |
| prune / map 配置 | `whalepod/config.py:111-121,150-159` |
| 截断三形态 | `whalepod/tools/base.py:8-19,67-79` |
| 送达范围 / 续读提示 | `whalepod/tools/read.py:8-14,84,93-102` |
| usage 归一 / measured | `whalepod/endpoints/base.py:84-121` |
| no_cache_write | `whalepod/endpoints/base.py:202-208` |
| provider affinity | `whalepod/endpoints/base.py:251-259` |
| reasoning 三档 | `whalepod/endpoints/vllm.py:71-74` |
| 离线环定义 | `bench/validate.py:12-15,85,180-221,241-283,294-304` |
| 在线环 MAE / 重复 / pin | `bench/live_acceptance.py:439-465,557-558,625-659` |
| 已提交数字 | `bench/results/validation.json`、`bench/results/live_acceptance.json`、`bench/results/live_run.log` |

### A.2 prime-agent（`reference_project/prime-agent`）

| 主题 | 文件:行号 |
|---|---|
| 主循环 / steering / followUp / continuation | `packages/agent/src/agent-loop.ts:304-449,318-340,414-443` |
| 工具并发 / sequential 标记 | `packages/agent/src/agent-loop.ts:585-600,667-719` |
| 工具前后钩子 | `packages/agent/src/agent-loop.ts:791-811` |
| compaction 设置 / 触发 | `packages/coding-agent/src/core/compaction/compaction.ts:104-114,206-210` |
| 切点 / split-turn | `packages/coding-agent/src/core/compaction/compaction.ts:276-319,348-414` |
| 摘要格式 / 增量更新 / kernel 提示 | `packages/coding-agent/src/core/compaction/compaction.ts:417-490` |
| 上下文估算计 output | `packages/coding-agent/src/core/compaction/compaction.ts:122-124,173-201` |
| /refine 系统提示 / 两段式 / 预算 | `packages/coding-agent/src/core/refinement/refinement.ts:123-205` |
| 编辑校验 / 基础提示不可变 | `packages/coding-agent/src/core/refinement/refinement.ts:673-712` |
| apply / baseline 冲突 | `packages/coding-agent/src/core/refinement/refinement.ts:716-749` |
| 回滚 | `packages/coding-agent/src/core/refinement/refinement.ts:813-845` |
| planner / 80k 切片 / 非 reasoning | `packages/coding-agent/src/core/refinement/refinement.ts:880-948` |
| review gate | `packages/coding-agent/src/core/refinement/refinement.ts:963-1012` |
| harness 四类状态 / CRUD / mtime | `prime-agent-runtime/src/rlm/harness.py:19-24,94-122,142-211` |
| refine 记录 / overview | `prime-agent-runtime/src/rlm/harness.py:677-769` |
| RLM 可调用对象 | `prime-agent-runtime/src/rlm/__init__.py:92-102,233-253` |
| REPL 协议 / 持久命名空间 / snapshot | `prime-agent-runtime/src/rlm/repl.md` |
| 子 agent 隔离 / 深度 / 归账 | `packages/coding-agent/src/core/agent-session.ts:9506-9513,10392-10460,10553-10576` |
| overflow 恢复 / 重试 | `packages/coding-agent/src/core/agent-session.ts:8497-8516,10941-10983` |
| serialized refine 时间重叠 | `packages/coding-agent/src/core/agent-session.ts:3630-3638` |
| 失败分类 | `packages/ai/src/utils/stream-failure.ts:66-88,206-232` |
| side-question 影子调用 | `packages/coding-agent/src/core/side-question.ts:42-102` |
| 子 usage own/total 对账 | `packages/coding-agent/src/core/context-tree.ts:63-95` |
| 工具截断 | `packages/coding-agent/src/core/tools/truncate.ts:11-13,249-257` |

### A.3 本仓（`ReviewAgent-pi`）

| 主题 | 文件:行号 |
|---|---|
| 生产入口 / 协议 v3 | `packages/review-pi/src/contracts/config.ts`；`docs/adr/0015` |
| 主循环 / 钩子 | `packages/review-pi/src/run/review-run.ts:82-119`；`loop/agent-review-loop.ts:92-260` |
| 六阶段 / 双上界 | `packages/review-pi/src/loop/phases.ts:9-46`；`loop/constants.ts:4,10` |
| 七工具 / schema 三固定 | `packages/review-pi/src/tools/registry.ts:17-25` |
| 账本 | `packages/review-pi/src/tools/ledger.ts:22-47` |
| 结果预算 | `packages/review-pi/src/tools/result-budget.ts:11,25-53` |
| 初始消息 / Zone B 退役 | `packages/review-pi/src/loop/messages.ts:1-26` |
| Cache Break | `packages/review-pi/src/loop/cache-break.ts:28-42` |
| usage 映射 | `packages/review-pi/src/provider/usage-map.ts:5-17` |
| 生产基线数字 | `runs/phase2-pi/dashboard.md`（rep2+ 热口径表） |
| 既有 Token 方案 | `docs/design/02-agent-design/ReviewAgent Token 优化方案——以 20~30% Token 成本达到通用 Agent 检视效果.md` |
| 大 MR / 语义去重（未实施） | `docs/design/02-agent-design/ReviewAgent 语义去重与大 MR 检视方案.md` |

---

## 附录 B：建议阅读顺序

1. 先读本仓 `docs/design/02-agent-design/ReviewAgent Token 优化方案…md` 第 1–5 章，建立成本模型；
2. 再读 `reference_project/whale-pod/whalepod/core/{messages,ledger,compaction}.py` 与 `bench/validate.py`，理解"前缀约束 + 可证伪"；
3. 然后读 `reference_project/prime-agent/packages/coding-agent/src/core/refinement/refinement.ts` 与 `prime-agent-runtime/src/rlm/harness.py`，理解"带护栏的状态编辑"；
4. 最后回到本文第 7 章，按 P0 → P1 → P2 立项，每项先写 ADR + 消融门。
