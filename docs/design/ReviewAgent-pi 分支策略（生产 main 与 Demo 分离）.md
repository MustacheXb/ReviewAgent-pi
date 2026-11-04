# ReviewAgent-pi 分支策略：生产 main 与 Demo 分离

**状态**：已决定
**决策日期**：2026-11-03
**决策基线**：`main@0319a41a253f`（2026-10-25）
**适用范围**：本仓 `MustacheXb/ReviewAgent-pi`

## 1. 结论

生产项目作为本仓后续的主力演进方向，最终占据 `main` 分支。现有 A-E 对照实验、Demo 和旧代码由长期分支 `demo/config-matrix` 承接。

迁移期使用 `production/e-only` 完成生产化重构。生产形态通过打包、协议和运行验收后，再执行分支收口：

- `production/e-only` 成为新的 `main`。
- 原 `main` 的 A-E 代码由 `demo/config-matrix` 保存。
- `archive/pi-kernel` 保持为不可变历史归档。

不在当前 `main` 上直接删除 A-D 和研究设施。生产迁移是一次结构性重构，应先在独立生产分支完成并通过验收，再切换默认分支。

## 2. 终态分支拓扑

| 分支 | 定位 | 生命周期 |
|---|---|---|
| `main` | 生产主线，固定 Config E，产品发布与日常演进 | 长期，默认分支 |
| `demo/config-matrix` | A-E 对照实验、Demo、历史评测链与复现资料 | 长期，展示与复现 |
| `archive/pi-kernel` | 既有内核历史归档 | 长期，只读 |
| `codex/<topic>` | 从 `main` 拉出的短期功能或修复分支 | 短期 |

`main` 是生产代码、发行标签、外部文档和默认克隆入口的唯一真源。Demo 实验代码不再占据默认分支。

## 3. 分支内容边界

### 3.1 生产 `main`

`main` 只承担生产运行时及其发布保障：

- 固定 Config E：七工具 + Context Ledger。
- 单次检视 CLI、stdio RPC、HTTP server、worker 池。
- 审计、RunRecord、人工处置 KPI 和运行观测。
- 网关、模型、凭据、部署和故障处置文档。
- 生产冒烟、历史记录只读兼容、打包和安装验证。
- 生产安全修复与发行标签。

`main` 不包含：

- A-D 可执行配置和配置选择接口。
- A-E 对照实验计划、采样和判定链。
- Config C 判级锚、alignment gate 等研究侧流程。
- Demo 专用的数据构造、论文分析脚本和历史实验说明。

### 3.2 Demo `demo/config-matrix`

`demo/config-matrix` 承担旧代码和研究复现：

- A-E 配置矩阵及其历史执行路径。
- Phase 2 数据、指标、judge、sampling、gate 和历史分析脚本。
- Demo 演示、论文复现和旧 RunRecord 读取能力。
- 研究导向 README、设计文档与历史报告。

Demo 分支可以继续维护复现能力，但不反向主导生产实现。生产运行时修复需要同步 Demo 时，使用单独提交和明确的 `cherry-pick`。

### 3.3 历史归档 `archive/pi-kernel`

该分支保持不可变，不承担 Demo 或生产的日常开发，也不复用为生产分支。

## 4. 迁移期拓扑

从决策基线同时建立 Demo 分支和生产过渡分支：

```text
main@0319a41
├── demo/config-matrix      A-E 旧代码长期保留
└── production/e-only       E-only 生产重构
                                      │
                                      └── 验收通过后接管 main
```

迁移期的 `main` 暂时仍是旧代码，只作为切换前的占位默认分支。生产功能开发、测试和发布候选均在 `production/e-only` 及其短期分支完成。

生产实现分支命名：

```text
production/e-only
  └── codex/production-e-only-runtime
  └── codex/production-e-only-protocol
  └── codex/production-e-only-release
```

## 5. 初始创建步骤

当前决策基线为 `main@0319a41a253f`。操作前确认工作区干净且本地 `main` 与远端一致。

### 5.1 冻结 Demo 基线

```bash
git switch main
git pull --ff-only
git tag -a demo-config-matrix-baseline-2026-11-03 \
  -m "Freeze A-E demo baseline before E-only production cutover"
git push origin main --tags
```

### 5.2 创建 Demo 长期分支

```bash
git switch -c demo/config-matrix
git push -u origin demo/config-matrix
```

### 5.3 创建生产过渡分支

```bash
git switch main
git switch -c production/e-only
git push -u origin production/e-only
```

### 5.4 使用独立工作树

生产与 Demo 并行开发时，建议使用独立工作树，避免频繁切换分支：

```bash
git worktree add ../ReviewAgent-pi-demo demo/config-matrix
git worktree add ../ReviewAgent-pi-production production/e-only
```

`.env.local`、`runs/`、`.cache/` 等本地产物不属于分支内容。实验数据和运行证据应通过标签、外部归档或固定提交引用保存，不能依赖分支切换保留。

## 6. 分支收口步骤

仅在 `production/e-only` 通过生产验收后执行。GitHub 上的默认分支切换和分支重命名涉及远端仓库状态，建议通过 GitHub 分支设置界面完成。

1. 确认 `demo/config-matrix` 已推送并完整保留旧 `main` 的基线内容。
2. 确认生产候选提交已推送，固定提交 SHA 并完成备份。
3. 将 `production/e-only` 临时设为 GitHub 默认分支。
4. 将旧 `main` 重命名为 `demo/legacy-main-transition`，或者确认 `demo/config-matrix` 完整后再删除旧 `main`。
5. 将 `production/e-only` 重命名为 `main`。
6. 将 `main` 设为默认分支并启用保护规则。
7. 本地执行 `git fetch --prune`，重新建立 `main` 与 `demo/config-matrix` 的跟踪关系。
8. 确认克隆默认分支、README、包入口和发行流程均指向生产 `main`。

收口完成后：

```text
main                 生产默认分支
demo/config-matrix   A-E Demo 与历史复现
archive/pi-kernel    不可变历史归档
codex/*              短期生产开发分支
```

## 7. CI 与分支保护

### 7.1 `main` 必过检查

- 根仓 `pnpm typecheck`。
- `review-pi` 包类型检查、单元测试和进程边界测试。
- E-only 配置契约测试。
- Ledger 审计与 RunRecord 输出测试。
- CLI、stdio RPC、HTTP 协议和向后兼容测试。
- `reviewagent` 打包、安装和双入口冒烟。
- 历史 A-D RunRecord 只读兼容测试。

### 7.2 Demo 必过检查

- A-E 矩阵与实验计划测试。
- metrics、judge、sampling、gate 测试。
- Phase 2 报告复算和离线 e2e。
- Demo README 与复现说明检查。

### 7.3 保护规则

- `main` 禁止直接推送和 force push。
- 所有生产改动必须通过 PR。
- 必需检查全部通过后才允许合并。
- 生产运行时代码修改必须附带对应测试或明确的不可测试理由。
- `main` 的发行标签只由生产发布流程创建。

## 8. 代码同步规则

生产与 Demo 在基线后独立演进，不执行整分支互合。

- `main` 是生产运行时修复和产品能力的唯一源头。
- 需要同步到 Demo 的生产修复使用 `git cherry-pick -x <commit>`。
- Demo 中确有生产价值的研究改动，先提炼为独立提交，再移植到 `main`。
- 不把 Demo 的实验矩阵、历史报告或 A-D 执行路径合入 `main`。
- 不把 `main` 的完整历史合入 Demo，避免把生产删除操作带回 Demo。
- 公共包修改应保持提交边界单一，避免同时携带生产与实验改动。

## 9. 文档与证据归属

- 生产 README、部署、协议和运维文档属于 `main`。
- A-E 实验方案、Phase 2 报告和研究脚本属于 `demo/config-matrix`。
- 生产 `main` 只保留选型结论、历史证据索引和固定提交或标签链接。
- 历史报告不复制成两份，避免口径漂移。
- 生产决策新增独立 ADR；引用历史实验时链接固定 Demo 提交或标签。
- 不可变归档仍由 `archive/pi-kernel` 承担。

## 10. 发布与版本

- 生产发行标签使用 `reviewagent-vX.Y.Z`。
- Demo 基线标签使用 `demo-config-matrix-<date>`。
- 生产版本号在 `main` 上递增，不跟随 Demo 实验版本。
- 每个生产发布应记录对应提交 SHA、包产物、协议版本和测试结论。
- Demo 分支的改动不自动触发生产发布。

## 11. 验收清单

分支收口前必须全部满足：

- [ ] `demo/config-matrix` 已存在并指向旧 A-E 基线。
- [ ] Demo 分支完整保留历史实验、报告和复现入口。
- [ ] `production/e-only` 只保留 Config E 生产运行时。
- [ ] 生产 CLI 不再提供 `--config A-D`。
- [ ] RPC/HTTP v3 不再允许选择配置，或只接受向后兼容的显式 E。
- [ ] 新 RunRecord 固定输出 `configId: "E"`。
- [ ] 历史 A-D RunRecord 仍可读取和处置。
- [ ] E 的七工具和 Ledger 行为通过测试。
- [ ] 生产包可从 tarball 安装并完成冒烟。
- [ ] `main` 已设为 GitHub 默认分支并启用保护。
- [ ] 生产 README 与 Demo README 各自描述正确分支。

## 12. 后续演进判断

现阶段采用“生产 `main` + Demo 长期分支”即可满足分离需求。

当生产与 Demo 的依赖、CI、权限、发布周期和文档继续明显分叉，或者整分支维护成本高于拆分成本时，再考虑独立仓库：

- 生产仓以当前 `main` 为源头，继续产品演进。
- Demo 仓固定从 `demo/config-matrix` 快照迁移。
- `archive/pi-kernel` 继续作为只读历史归档。

在此之前，不应为等待仓库拆分而阻塞 E-only 生产化。
