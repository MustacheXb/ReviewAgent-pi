# Pi 内核 vendor 价值分析——为什么 vendor 而非 npm 或自写

> **文首说明**（2026-10-23）：本文回答「本仓 vendor pi 四包（`packages/{ai,agent,chord,telemetry}`，
> 约 5.6 万行源码）的意义是什么、是否可以不用」。起因：RPC/HTTP server 方案评审时追问
> 「上游 1.x 会移除 harness，那我们 vendor 这些包的意义何在、似乎可以不用」。
> 方法：一手材料三方交叉——《[Pi 内核定制基线方案](Pi 内核定制基线方案.md)》（fork 拍板与分歧清单）、
> [ADR-0009](../adr/0009-pi-kernel-from-scratch-rewrites-review-runtime.md)（对照实验定位）、
> 《[Pi 内核上游更新影响分析](Pi 内核上游更新影响分析（vendor v0.85.1+11d × upstream v1.3.0）.md)》
> （使用面盘点 + 1.x 事实）+ 本地参照树（`reference_project/pi`，HEAD `73f8de80b`）逐项核实。
>
> **一句话结论**：vendor 的意义 = **研究定位**（内核是对照实验的被比较量，不是工程便利）+
> **确定性基建**（锚定精确 commit / 数据快照入库 / fork 能力——npm 全部给不了）+ **成熟的 LLM
> 兼容面**（pi-ai 的 provider/流式/模型目录/wire 捕获）。「可以不用」的直觉对一半：vendor 集
> 确有负重（chord 整包、agent 的 84 个 harness 文件，均零直接使用），但处置路径是升级窗口
> R1 换树 1.3.0 时自动减负，不是现在去 vendor 化。
>
> **拍板**（2026-10-23）：**维持现状**——不提前 R1 换树、不去 vendor 化、不改 npm 消费。
> 维持 2026-10-20 已拍板的「升级推迟到上线后」决策。

---

## 0. 决策摘要

| 决策点 | 结论 |
|---|---|
| vendor 形态维持与否 | **维持**（源码 vendor fork，非 npm、非自写） |
| 是否提前 R1 换树 1.3.0 减负 | **否**（维持推迟到上线后；理由：上线优先、1.3.0 未必是稳定停靠点、Unreleased 又在 breaking） |
| chord / agent harness 负重 | 接受为历史锚点产物，随 R1 换树自动消失（agent 92→6 文件、chord 退出 vendor 集） |
| 再评估触发条件 | 见 §6 |

---

## 1. 意义第一层（最根本）：内核是对照实验的被测量

本仓的立项理由（CLAUDE.md 姊妹仓定位）是与 DSH 内核线兄弟仓在**同一评测集与冻结判定链**
上做**内核无关性对照**。ADR-0009 把实验设计写死：

> 「pi 负责把 ReviewAgent 做出来，DSH 数据作为 Runtime Benchmark 对照」；测量常量面
> （提示词/上下文组装/判定链）byte 一致，**内核变量面（Agent 状态/工具调用协议/wire 序列化/
> 会话）是被比较量**。

即：**pi 内核本身就是实验的自变量**。「不用它」在这个框架下不成立——不用它，对照实验没有
变量，本仓退化为一个普通 review 工具仓。两个具体绑定点：

1. **字节门**：A/B 请求字节对照 DSH 审计真源逐字节一致，而 wire 序列化（openai-completions
   形态、工具 schema 方言）由 pi-ai 完成。换任何自写/第三方客户端 = 序列化变 = t1–t5 与
   `runs/phase2-dsh` 450 单元对照失去意义。ADR-0009 Considered Options 已精确画线：「工具
   schema 的 wire 序列化是内核面，不同 SDK 构造上不可字节一致」（故分层为 A/B 字节门 +
   C/D/E 语义门）。
2. **变量隔离**：judge 刻意留 review-llm 不切 pi-ai，保证唯一变量 = 内核；cache 命中率差异
   属内核效应、报告单列（ADR-0009 Consequences）。

## 2. 意义第二层（工程资产）：实际消费的是 pi-ai + pi-agent 稳定面

使用面盘点（《上游更新影响分析》§1.2）：**11 个具名 import + Agent/provider 对象面约 25 个
具体触点**，全部落在两个包的稳定面上：

| 包 | 提供的东西 | 谁在用 |
|---|---|---|
| `pi-ai` | OpenAI 兼容 provider（`deepseekProvider().stream()`）、模型目录（`reviewModelOf` 模板展开 + `Model.baseUrl` 覆写）、SSE 流式归一化、usage 口径（`Usage{input, output, cacheRead, cacheWrite}`）、`FetchFunction` 注入抽象、**`onPayload` wire 捕获** | 全部配置 A–E；FetchFunction 是四个注入面（fake-fetch / gateway-probe / recording-fetch / review-run）的基建，**实验可复现性直接建在它上面** |
| `pi-agent` | `Agent` 回合机、`followUp` 队列、`shouldStopAfterTurn` 钩子、sequential 工具批执行 | 仅 C/D/E（A/B 直驱连 `Agent` 都不用，`review-loop.ts` 直接 `provider.stream()`） |
| `chord` / `telemetry` | **零直接使用**——chord 仅 vendored agent 内 3 个 harness 文件的 import（使用面上 type-only）；telemetry 经 ai/agent 传递 | 纯负重 |

关键观察：**「内核」实际被消费的面远小于 vendor 的 5.6 万行**——这是「似乎可以不用」直觉的
最强支撑；但正确处置是换树减负（§4 解读③），不是去 vendor 化。

## 3. 意义第三层（确定性基建）：源码在手，机制即事实

vendor 决策原话（《定制基线方案》§1，2026-09-17 用户拍板）：

> 「npm 消费线对内核形态的约束（**版本节奏、发布物缺口、机制偏差**）在 DSH 线已付过一次
> 学费；**源码在手则机制即事实**」。

**DSH 线的学费具体形态**：DSH 线消费 `@deepseek-ai/dsh@0.1.2-rc.1`（npm tarball），reference
源码已到 0.1.5-alpha.1。为确认「npm tarball 的机制与设计一致吗」，专门花一整个 Spike
（票 #18：《[DSH 内核机制偏差清单](DSH 内核机制偏差清单（npm 0.1.2-rc.1 × reference 0.1.5-alpha.1）.md)》，
逐项实测五类机制：行集名称、session-projection、agentPresets、followup/inject 语义、唤醒窗口
竞态）才敢下「无需 fork」结论。**每换一次版本、每起一次机制疑问，都要重付这种核对成本**。

vendor fork 换来的具体能力（《定制基线方案》§4 分歧清单；源码本体零改动，仅 1 处测试修复）：

| fork 能力 | npm 依赖做不到的原因 |
|---|---|
| **锚定精确 commit `6671c604`** | 它是 v0.85.1 之后 11 天的 main 修复，npm 上**不存在此状态的发布物**（只有 0.85.1） |
| **模型目录数据入库 + `check:model-data` 守门**（39 provider / 688K） | 上游 gitignore 不入库（git clone 无法编译）、CI 每日联网再生成；本仓锁定发布快照，**数据字节不随抓取日期漂移**——字节门可复现的前提 |
| 源码消费形态（`exports` 的 `types`/`source` 指 `src/*.ts`） | npm 包只有 dist + d.ts，typecheck/测试吃不到源码 |
| 构建链 tsgo → tsc 5.9.3 统一（与 review-llm 同版本） | 上游构建工具链无法从消费侧改 |
| Windows `path.sep` 修复（chord boundary 测试的越界误判） | 得等上游发版 |
| 传递依赖显性化（`@smithy/types` 等声明） | 上游靠 npm 扁平提升才能跑，pnpm 严格隔离下必须声明 |

隐性收益：**审计口径的出处**。`onPayload` 的 wire 形状、usage 字段映射——这些契约的最终
解释权在源码。对照实验的报告要经得起「你确定模型看到的是这些字节吗」的质询，源码在手
就是答案本身。

## 4. 「可以不用」的三种解读逐一评估

### 4.1 解读①：改用 npm 依赖（`@earendil-works/pi-ai` + `pi-agent-core`）

**不成立**——重付 DSH 学费且拿不到现状：

- 拿不到锚定 commit（npm 只有 0.85.1，缺 11 天 main 修复）；
- 数据快照问题无解：要么吃 dist 形态（失去源码消费），要么自行补 data；
- §3 表格六项 fork 能力全部失去；
- 上游节奏（5 周 639 commits、两个大 breaking、Unreleased 仍在 breaking）意味着 npm latest
  永远在漂；「发布物缺口」正是 DSH 学费三成分之一。

### 4.2 解读②：自写最小内核（「B 路径不就是几百行 SSE 客户端吗」）

**功能上可行，定位上自杀**：

- 功能面：B 直驱确实只需 OpenAI 兼容流式客户端；C/D/E 再加一个回合机（工具批执行、
  followUp、stop 钩子、重试）——把 pi 稳定面的几千行重写一遍，**能做到**。
- 但自写内核 = 创造**第三个内核变量**：与 DSH 的对照变成「两个自研实现的对照」，变量不再
  受控；wire 序列化方言变成「自己的实现选择」而非「内核效应」，cache 命中率差异（ADR-0009
  明确单列的内核效应指标）失去归因基础；字节门直接碎。
- 一句话：**自写内核省下的代码量，恰好是本仓立项要研究的东西**。

### 4.3 解读③：vendor 集里有用不到的东西，应该减掉

**直觉正确，且处置路径已拍板**——但正确动作是「升级窗口换树」而非「去 vendor 化」：

- chord 整包（零直接使用）→ 升级 1.x 时**退出 vendor 集**（影响分析 A6/R1）；
- agent 的 84 个 harness 文件（review-pi 不用，属 0.85.1 锚点时代产物）→ 升级 1.x 时 agent
  源码 **92 → 6 个文件**，自动消失（已在 `reference_project/pi` 参照树核实：`packages/agent/src`
  仅剩 `agent/agent-loop/proxy/stream-fn/types/index`，无 `harness/`）；
- telemetry → 仍是传递依赖但极小；
- 时点：维持 2026-10-20 拍板（升级推迟到上线后，R1–R5 步骤见影响分析 §5）。

## 5. 成本侧如实盘点（vendor 的真实负担形态）

「似乎可以不用」隐含「vendor 是日常负担」——实际不是：

- **日常 CI 零成本**：上游包测试**不进 CI 门**（《定制基线方案》§4.5，POSIX 路径假设），
  CI 只跑根 + review-llm + review-pi；
- **同步面刻意压到极小**：源码本体零改动，全部分歧落在 package.json ×4 / 2 个 vitest 配置 /
  1 处测试修复 / data 入库（§9：以锚定 commit 为基线 `git diff` 上游树 → 挑拣 cherry-pick）；
- 真实成本只有两个：**仓库体积**（5.6 万行 + 688K data）与**升级时刻的一次性换树工程**
  （R1–R5，约 3–4 天 + 真跑成本，大头是 R4 质量门重跑）。

## 6. 结论与再评估触发条件

**结论**：vendor 的意义 = 研究定位 + 确定性基建 + LLM 兼容面（§1–§3）；负重存在但随 R1
换树自动消失（§4.3）；日常负担近零（§5）。**维持现状**。

再评估本文结论的触发条件（任一满足时重开）：

| # | 触发条件 | 重评方向 |
|---|---|---|
| 1 | R1 换树完成（1.3.0 落地、chord 退出、agent 6 文件） | 重审剩余携带量是否仍有减负空间 |
| 2 | 上游出现稳定停靠点（如 LTS 或 breaking 停歇 ≥ 一个季度） | 重审 vendor vs npm 的版本节奏论据是否仍成立 |
| 3 | 本仓定位变化（放弃对照实验、转向纯产品化） | §1 研究定位论据失效，npm/自写重新可议 |
| 4 | review-pi 对内核的使用面显著扩大（越过 Agent/agent-loop 稳定面） | 升级适配成本重估，R1–R5 工作量重排 |

---

## 附：相关文档地图

| 文档 | 角色 |
|---|---|
| 《Pi 内核定制基线方案》 | vendor fork 拍板、接线改造、分歧清单、同步约定（本文 §3 事实源） |
| ADR-0009 | 从 0 重写决策、对照实验设计、变量隔离（本文 §1 事实源） |
| 《Pi 内核上游更新影响分析》 | 0.85.1 × 1.3.0 delta、使用面盘点、R1–R5 升级步骤（本文 §2/§4.3 事实源） |
| 《DSH 内核机制偏差清单》 | npm 消费线学费的实证记录（本文 §3 论据） |
| 《ReviewAgent RPC-HTTP-JSON-RPC Server 实现方案》 | 本文起因（server 依赖边界选 `runReview`，不依赖 harness/session） |
