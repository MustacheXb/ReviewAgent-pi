# 0014. 分支策略——生产 main 与 Demo 分离

**状态**：已接受（2026-11-03，用户决策「Q3 走 b，其余全部走推荐」「按照推荐执行」）
**决策基线**：冻结标签 `demo-config-matrix-baseline-2026-11-03` 指向的提交（本 ADR 随基线提交落地，SHA 由标签固定：`git rev-parse demo-config-matrix-baseline-2026-11-03` 可考；此前 main@`0319a41`）
**关联**：ADR-0011（生产入口切流 config E）、ADR-0013（HTTP server 线统一契约与拓扑 B）、追踪 issue #32（E-only 生产化与分支收口）
**适用范围**：本仓 `MustacheXb/ReviewAgent-pi`

> 术语消歧：本文「**分支收口**」指生产分支接管默认分支的一次性切换动作；与「**服务收口**」（drain，SSE / 监听排空，见 GLOSSARY「Drain 窗口」）无关。

## Context

- ADR-0011 切流后，main 已是「A-E 全量评测装置 + 生产面（CLI 缺省 E / stdio v2 / HTTP server #28–#31）」混合态：生产形态与研究复现互相占据默认分支，外部克隆入口指向混合态。
- 研究侧（A-E 矩阵、判定链、Phase 2 报告）与生产侧（E-only 运行时、产品包、运维）在 CI、发布节奏、文档口径上持续分叉。
- 用户决策（2026-11-03 盘问收口）：生产占据 `main`、Demo 走长期分支、迁移经 `production/e-only`；协议面走 **v3 破坏性变更**（明确否掉「v2 收窄合法域」的兼容路线）。

## Decision

### 1. 终态分支拓扑

| 分支 | 定位 | 生命周期 |
|---|---|---|
| `main` | 生产主线，固定 Config E，产品发布与日常演进 | 长期，默认分支 |
| `demo/config-matrix` | A-E 对照实验、Demo、历史评测链与复现资料 | 长期，展示与复现 |
| `archive/pi-kernel` | 既有内核历史归档 | 长期，只读 |
| `codex/<topic>` | 从 `main` 拉出的短期功能或修复分支 | 短期 |

`main` 是生产代码、发行标签、外部文档和默认克隆入口的唯一真源；协议版本分叉为 **main v3 / demo v2**（见 §10）。

### 2. 分支内容边界

**生产 `main` 只承担**：固定 Config E（七工具 + Context Ledger）；单次检视 CLI、stdio RPC、HTTP server、worker 池；审计、RunRecord、人工处置 KPI 与运行观测；网关 / 模型 / 凭据 / 部署 / 故障处置文档；生产冒烟、历史记录只读兼容、打包与安装验证；生产安全修复与发行标签。

**`main` 不包含**：A-D 可执行配置与配置选择接口；A-E 对照实验计划、采样和判定链；Config C 判级锚、alignment gate 等研究侧流程；Demo 专用数据构造、论文分析脚本与历史实验说明。

**`demo/config-matrix` 承担**：A-E 配置矩阵及历史执行路径；Phase 2 数据、指标、judge、sampling、gate 与历史分析脚本；Demo 演示、论文复现与旧 RunRecord 读取；研究导向 README、设计文档与历史报告。Demo 可继续维护复现能力，但不反向主导生产实现。

**`archive/pi-kernel`**：不可变历史归档，不承担日常开发，不复用为生产分支。

### 3. 迁移期拓扑与冻结纪律

```text
冻结基线（标签 demo-config-matrix-baseline-2026-11-03）
├── demo/config-matrix      A-E 旧代码长期保留
└── production/e-only       E-only 生产重构（协议 v3 + 删除研究设施）
                                      │
                                      └── 收口清单全绿后接管 main
```

**冻结纪律**：冻结标签打点后、分支收口前，**main 不接收任何提交**（零提交占位）；全部生产工作在 `production/e-only` 及其 `codex/production-e-only-{runtime,protocol,release}` 短期分支完成。若迁移期 Demo 侧需要共享修复，走 §7 的 cherry-pick 通道，不碰冻结中的 main。

### 4. 初始创建步骤

操作前确认工作区干净、本地 main 与远端一致、测试全绿：

```bash
# 4.1 冻结 Demo 基线（标签即决策基线锚）
git tag -a demo-config-matrix-baseline-2026-11-03 \
  -m "Freeze A-E demo baseline before E-only production cutover"
git push origin main --tags
# 4.2 Demo 长期分支
git switch -c demo/config-matrix && git push -u origin demo/config-matrix
# 4.3 生产过渡分支（从冻结基线拉出）
git switch main && git switch -c production/e-only && git push -u origin production/e-only
# 4.4 独立工作树（生产与 Demo 并行开发）
git worktree add ../ReviewAgent-pi-demo demo/config-matrix
git worktree add ../ReviewAgent-pi-production production/e-only
```

各分支**创建后的第一个提交**：把自身加进本分支 `ci.yml` 的 push 触发面（直推也过 CI；PR 触发天然已有），并把 §8 的跨分支 ADR 限定语纪律写进本分支 CLAUDE.md。

`.env.local`、`runs/`、`.cache/` 等本地产物不属于分支内容，工作树各自携带；实验数据与运行证据经标签、外部归档或固定提交引用保存。

### 5. 分支收口步骤

仅在收口清单（§11，issue #32）全绿后执行；GitHub 默认分支切换与重命名经分支设置界面完成：

1. 确认 `demo/config-matrix` 已推送且完整保留旧 main 基线内容（冻结标签在位）。
2. 确认生产候选提交已推送、固定 SHA 并完成备份。
3. 将 `production/e-only` 临时设为 GitHub 默认分支。
4. **验证后直接删除旧 main**（与 `demo/config-matrix` 同 SHA + 冻结标签双保险；不留 `demo/legacy-main-transition` 过渡分支）。
5. 将 `production/e-only` 重命名为 `main`。
6. 将 `main` 设为默认分支并启用保护规则（§6.3）。
7. 本地 `git fetch --prune`，重建 `main` 与 `demo/config-matrix` 跟踪关系。
8. 确认克隆默认分支、README、包入口与发行流程均指向生产 `main`。

### 6. CI 与分支保护

**`main` 必过检查**：根仓 `pnpm typecheck`；`review-pi` 包类型检查、单元测试与进程边界测试；E-only 配置契约测试；Ledger 审计与 RunRecord 输出测试；CLI、stdio RPC、HTTP 协议与向后兼容测试；`reviewagent` 打包、安装与双入口冒烟；历史 A-D RunRecord 只读兼容测试。

**Demo 必过检查**：A-E 矩阵与实验计划测试；metrics / judge / sampling / gate 测试；Phase 2 报告复算与离线 e2e；Demo README 与复现说明检查。

**触发面**：两分支各自 `ci.yml` 的 push 触发含自身（分支自带工作流副本，按分支各自维护）；PR 触发保持全量。

**保护规则（收口后的 `main`）**：禁止直接推送与 force push；所有生产改动走 PR（单人仓 = CI 门 + issue 关联 + 自合并）；必需检查全绿才允许合并；生产运行时代码修改必须附带测试或明确不可测试理由；发行标签只由生产发布流程创建。

### 7. 代码同步规则

生产与 Demo 基线后独立演进，**不执行整分支互合**。`main` 是生产运行时修复与产品能力的唯一源头；同步到 Demo 用 `git cherry-pick -x <commit>`；Demo 中确有生产价值的研究改动先提炼为独立提交再移植 `main`。

**cherry-pick 判据**（每次同步在提交信息写明判定理由）：

- **同步**：Demo 分支实际执行路径会踩到的共享运行时修复（内核 / 七工具 / 审计契约 / 协议 bug）；**安全修复必同步**。
- **不同步**：纯产品面改动（server 部署参数、worker 池调优等）。
- 不把 Demo 的实验矩阵、历史报告或 A-D 执行路径合入 `main`；不把 `main` 完整历史合入 Demo（避免把生产删除操作带回 Demo）；公共包修改保持提交边界单一。

### 8. 文档、证据与 GLOSSARY 归属

- 生产 README、部署、协议与运维文档属于 `main`；A-E 实验方案、Phase 2 报告与研究脚本属于 `demo/config-matrix`。
- `main` 只保留选型结论、历史证据索引和固定提交 / 标签链接；历史报告不复制成两份（避免口径漂移）；生产决策新增独立 ADR，引用历史实验时链接固定 Demo 提交或标签；不可变归档仍由 `archive/pi-kernel` 承担。
- **GLOSSARY 修剪**：E-only 清理时同步修剪 `main` 的 GLOSSARY——研究词条删除、留一行链接指向 Demo 标签；`demo/config-matrix` 保留全量。词汇表是活代码的词汇表。
- **跨分支 ADR 限定语纪律**（两线共同继承 0001–0014，分叉后各自独立编号，0015 起同号不同文）：**裸写「ADR-XXXX」一律指本分支序列；跨线引用必须写全限定语「主线 ADR-XXXX」/「Demo 线 ADR-XXXX」**。本纪律随分支创建写进两分支各自 CLAUDE.md（与既有跨仓「DSH 线」限定语纪律同构）。

### 9. 发布与版本

- 生产发行标签 `reviewagent-vX.Y.Z`，在 `main` 上递增，不跟随 Demo 实验版本；**首个标签 `reviewagent-v1.0.0` 与分支收口同刻**（默认分支切换 = 产品 1.0；收口前的 tarball 安装冒烟不打标签）。
- 每个生产发布记录对应提交 SHA、包产物、协议版本与测试结论；Demo 分支改动不自动触发生产发布；Demo 基线标签沿用 `demo-config-matrix-<date>`。

### 10. 协议 v3（收口判定项；决策细节落「主线 ADR-0015」）

用户决策走 **v3 破坏性变更**（拒绝 v2 收窄合法域的兼容路线）：

- `protocolVersion` 3；`review.submit` 删除 `configId` 参数，**携带 `configId` 的请求显式拒绝**（专用错误码，不静默忽略——零静默纪律）。
- 客户端对 `capabilities.protocolVersion` **硬断言**：v2 客户端连 v3 server、v3 客户端连 v2 server（Demo 线）双向明确报错。
- CLI 移除 `--config` 旗标（连 `--config E` 也不提供）；`configId` 从请求面参数内化为服务端派生常量——RunRecord / disposition 恒输出 `"E"`，回溯锚不变，历史 A-D RunRecord 只读兼容照旧。
- 协议版本跨分支分叉（main v3 / demo v2）是预期态，不互通。
- v3 完整决策记录（取舍、错误码、版本断言语义）在 `production/e-only` 上另立 **ADR-0015**；demo 分支不持有 0015。

### 11. 收口清单（issue #32 逐项勾选）

- [ ] `demo/config-matrix` 已存在并指向冻结基线
- [ ] Demo 分支完整保留历史实验、报告和复现入口
- [ ] `production/e-only` 只保留 Config E 生产运行时
- [ ] 生产 CLI 无 `--config` 旗标
- [ ] RPC/HTTP v3：submit 无 `configId`、携带即显式拒绝；客户端硬断言 `protocolVersion`
- [ ] 新 RunRecord 恒输出 `configId: "E"`
- [ ] 历史 A-D RunRecord 仍可读取和处置
- [ ] E 七工具与 Ledger 行为通过测试
- [ ] 生产包可从 tarball 安装并完成冒烟
- [ ] CI 触发面两分支各自落位
- [ ] `main` 已设为 GitHub 默认分支并启用保护规则（PR-only）
- [ ] 生产 README 与 Demo README 各自描述正确分支
- [ ] GLOSSARY 在 main 修剪研究词条（留 Demo 标签链接）
- [ ] 跨分支 ADR 限定语纪律进两分支 CLAUDE.md
- [ ] 首个发行标签 `reviewagent-v1.0.0` 与收口同刻

### 12. 后续演进判断

现阶段「生产 `main` + Demo 长期分支」满足分离需求。当生产与 Demo 的依赖、CI、权限、发布周期和文档继续明显分叉，或整分支维护成本高于拆分成本时，再考虑独立仓库：生产仓以当前 `main` 为源头；Demo 仓从 `demo/config-matrix` 快照迁移；`archive/pi-kernel` 继续只读归档。在此之前，不为等待仓库拆分而阻塞 E-only 生产化。

## Options（为什么不是别的）

- **在当前 main 上直接删 A-D**：混合态直接动刀，删除中途任何失败都把研究复现链暴露在默认分支上；结构性重构应先在独立分支过验收再切换。
- **v2 收窄合法域（configId ∈ {E}，A-D 显式报错）**：零客户端改动的兼容路线，被否——用户选 v3 破坏性变更：契约代数单义，「无配置选择时代」不寄生在「配置选择时代」的参数形上，与 stdio v1 legacy alias 已废（ADR-0013）的先例同构。
- **旧 main 重命名为 `demo/legacy-main-transition` 长期保留**：与 `demo/config-matrix` 同 SHA 的重复分支只会腐烂；验证 + 冻结标签双保险后直接删除。
- **独立仓库拆分**：当前成本高于收益（§12 登记触发条件）；不为等拆仓阻塞 E-only 生产化。
- **整分支互合同步**：把 main 完整历史合入 Demo 会把生产删除操作带回 Demo（反向同理）；cherry-pick 单提交是唯一同步通道。

## Consequences

- **正**：默认分支单义（生产唯一真源）；研究复现链冻结在 `demo/config-matrix`（同 SHA 分支 + 冻结标签双保险）；协议契约代数单义（v3）；两线 CI / 发布 / 文档各自演进互不拖累；收口验收有唯一载体（issue #32 清单）。
- **负/风险**：跨分支同号 ADR（0015 起）须限定语引用，漏写即歧义（缓解：两分支 CLAUDE.md 纪律）；生产修复同步 Demo 是人工判断（缓解：§7 判据 + 提交信息留痕）；v3 断开 v2 客户端——主线与 Demo 线 server 不互通（预期态）；单人仓 PR-only 是节奏变化（摩擦实测后再议放宽）。
- **中性**：迁移期 main 零提交占位；`production/e-only` 收口后经重命名成为 `main`（分支历史连续，不 squash）；伞 issue #32 承载执行与验收全程。

## 补记（2026-11-04）：设计文档回填 main

应用户要求，`docs/design/` 设计文档全量回填 `main`（#34：19 份自 `demo/config-matrix@40eb92a` 字节平移 + 《ReviewAgent-pi 分支策略》底稿自会话转录恢复，共 20 份）。§8 文档归属口径据此调整：

- **设计文档**：由「demo 单侧持有」调整为**双线各持一份**——`main` 侧定位为工程参考副本（回填时点快照，不承诺逐修订跟进），后续跨线同步走 §7 cherry-pick 单提交通道。恢复件来源如实留痕：底稿从未入过 git（原以未跟踪状态随 production worktree 退役删除），恢复自会话转录 Read 快照（233 行完整、其后零 Edit）。
- **研究报告（`docs/report/`）与复现资产**：仍以 demo 为唯一持有处，「历史报告不复制成两份（避免口径漂移）」纪律不变。
