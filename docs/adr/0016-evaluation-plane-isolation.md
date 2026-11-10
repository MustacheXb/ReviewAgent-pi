# 0016. 评测面隔离——长期 eval/bench 分支与 C_ref eval-only

**状态**：已接受（2026-11-10，盘问收口）
**决策基线**：`main`（生产主线）；评测面自 `main` 拉出长期分支 `eval/bench`
**关联**：ADR-0014（分支策略）、ADR-0015（协议 v3）、ADR-0017（Token 优化判据）、[ReviewAgent Token 优化评测基准方案](<../design/05-evaluation/ReviewAgent Token 优化评测基准方案——三层对照体系与 Claude Code 外部参照.md>)
**适用范围**：本仓主线 `MustacheXb/ReviewAgent-pi`

## Context

- ADR-0014 §2 把 A–D 可执行配置、A–E 对照实验计划、采样与判定链排除在 `main` 之外；ADR-0015 进一步根除协议面的 `configId`。全仓注入 C 随研究装置退役，是这两条决策的预期结果。
- 但未来 token 优化仍需要「与当前 E 同代码基线的活对照」和「能复跑对照的评测装置」。`main` 没有 metrics / judge / experiment runner；`demo/config-matrix` 的 E 已与主线分叉，且其 C 只适合历史证据复算；历史 `runs/phase2-pi` 的 provenance 不完整。跨 Demo 线跑 C+E 不能回答「主线这次改动省了没有」。
- 把完整 harness 与 C 直接放回 `main` 会复活配置选择面，并把研究期词汇与生产面混在一起，违背 ADR-0014 §2 与 ADR-0015。
- 因此需要第三块位置：**评测面（evaluation plane）**——与生产运行时物理隔离，可长期维护 harness，只承载 eval-only 的 C_ref、外部参照与报告，不进入生产协议 / CLI / `ConfigId` 写面。

## Decision

1. **新增长期 `eval/bench` 分支**：从 `main` 拉出，不反向合并 `main`；每轮评测以 commit / tag 固定。这是对 ADR-0014 分支拓扑的有限扩展（多一条长期评测分支），不改变 `main` 的生产纯净性。
2. **`main` 只保留只读能力**：`RunRecord → cached / uncached / output / CARC / attempts / requests` 的只读分析器、L1 报告、报告 schema、`environment.json` schema、确定性 CI 门。不执行配置、不跑 LLM、不引入 A–D。
3. **`C_ref` 为 eval-only**：从 Demo 线移植全仓注入到 `eval/bench` 的 `src/eval/context/`；`configId` 只作评测记录的历史标签 `"C"`，不进协议、CLI、生产 `ConfigId`；`fullRepo` 记录走评测侧 sidecar，不复活生产 `RunAudit.fullRepo`。
4. **入口隔离**：`src/eval/**` 不得被 `src/cli`、`src/rpc`、`src/server`、`src/run` 等生产入口 import；用依赖规则或测试扫描强制。
5. **`eval/bench` 承载完整评测装置**：metrics / judge / experiment / reference runner、空对照校准、`C_ref`、配对统计、Claude Code 外部参照；通过 cherry-pick 引入 `main` 的运行时改动，构造 baseline / candidate 双 arm。
6. **报告与数据落位**：L2 / L3 摘要报告写 `main` 的 `docs/report/token-eval/`（结论、`environment.json`、复算入口）；原始 `runs/`、`audit/`、`wireBody` 外置；`eval/bench` 只放 harness 与 campaign 记录。
7. **外部参照单列**：`C_ref` 与 Claude Code 都不进 S/A/B 主判定；Claude Code 以跨模型外部参照单列报告（ADR-0002 / ADR-0009 先例）。
8. **`main` 永不接收**：A–D 可执行配置、A–E 对照实验计划、judge 链、`C_ref` 运行时、评测 runner；违反即视为评测面泄漏。

## Options

- **完整 harness + C 放回 `main`**：否——复活配置选择面，违背 ADR-0014 §2 / ADR-0015；生产包与评测设施无法在依赖面隔离。
- **每次战役拉 `codex/eval-*` 短期分支**：否——harness 体量大、需持续适配 `main`，每次重建会漂移；长期 `eval/bench` 更稳。
- **只在 `demo/config-matrix` 上跑评测**：否——Demo 的 E 是冻结旧 E，与 `main` 当前 E 已分叉；跨代码基线比较不可归因。
- **只在 `main` 保留只读分析器，不建评测分支**：否——只能复算已有记录，无法产生新的 baseline / candidate 对照。
- **长期 `eval/bench` + `main` 只读**：选此。生产纯度、活对照、harness 稳定性三者兼得。

## Consequences

- **正**：`main` 保持 E-only 生产形态；评测面有唯一长期载体；C_ref 与 Claude Code 可复跑；报告与原始数据分开，证据可追溯且仓库不膨胀。
- **负/风险**：多一条长期分支（拓扑复杂度）；`eval/bench` 与 `main` 的同步依赖人工 cherry-pick；入口隔离需要依赖规则或测试守卫，否则 eval-only 开关可能泄进生产；评测分支的 harness 仍会随 `main` 演进产生维护成本。
- **中性**：`main` 持有只读分析器与摘要报告，不持有评测执行设施；ADR-0014 的分支拓扑被本 ADR 有限扩展，不改变「生产 main / Demo 研究线」的基本分离。

跨线限定语纪律：本 ADR 为主线序列 0016；Demo 线 ADR 独立编号，引用须写「Demo 线 ADR-XXXX」。
