# E 基线快照冻结记录（P0-1）

- **baseline ref**：`eval-e-baseline-2026-11-11`
- **commit**：`e724958232e930698489b71440bb61d413592d77`（2026-11-03）
- **等价发行 tag**：`reviewagent-v1.0.0`——同一提交（`reviewagent-v1.0.0^{commit}` = 上述 sha）
- **机读 manifest**：[`e-baseline.json`](e-baseline.json)
- **冻结日期**：2026-11-11
- **效力**：L2 配对回归的 **baseline 臂**（ADR-0017 §3）；活基线，未标 `NOT_REPRODUCIBLE`

## 1. 为什么冻结这个提交

`reviewagent-v1.0.0` 是 E-only 生产化收口首刻（ADR-0014 §9 / ADR-0015）：协议 v3、Config E、七工具 + Context Ledger、vendored pi 0.85.1 全部就位，且已有三形态 pack 冒烟与 E 全链测试背书（tag 注记：review-pi 607 通过 / 0 失败；CI run 41629406386 全绿）。

自该提交到本次冻结时点，**运行时路径没有语义变化**。可复核：

```bash
git diff --stat reviewagent-v1.0.0..c30498e -- src/gate src/instrument src/presentation packages
# 唯一差异：packages/reviewagent/THIRD-PARTY-NOTICES.md（声明文件，非运行时行为）
```

其余差异是文档、`src/eval/analysis` 只读分析器、测试与 CI（#37），均不进入生产运行时。因此以 `reviewagent-v1.0.0` 的提交作为 baseline，与「当前 main 的 E」在行为上同一；后续候选只应差本次优化提交。

## 2. 运行时口径（冻结值）

| 维度 | 值 |
|---|---|
| 配置 | `Config E`（服务端派生；协议面**无 `configId`**，携带即 `-32019`） |
| 协议 | v3（`PROTOCOL_VERSION = 3`） |
| Node | `>= 22` |
| 包管理器 | `pnpm@12.14.0`（root `packageManager` 单源） |
| vendored pi | `@earendil-works/{pi-ai,pi-agent-core,chord,pi-telemetry}` @ `0.85.1` |
| Review Runtime | `review-pi@1.0.0` / `review-llm@0.1.0` |
| 产品包 | `reviewagent@1.0.0`（自包含 tarball） |
| 缺省被测模型 | `deepseek-v4-flash`（实际部署版本未记录，见 §5） |

依赖锁定：`pnpm-lock.yaml`。组件版本漂移（含 pi 升级、协议代数变化）意味着 baseline 已过期，须新打 `eval-e-baseline-<date>` tag 并更新 manifest，旧 tag 永久保留（[`RUNBOOK.md`](RUNBOOK.md) §4）。

## 3. 重建同一 E（可执行指令）

```bash
git fetch --tags
git checkout eval-e-baseline-2026-11-11

pnpm install --frozen-lockfile

# 构建：vendored pi → review-llm → review-pi → 中文呈现投影 → 自包含产品包
pnpm build:pi
pnpm --filter review-llm build
pnpm --filter review-pi build
pnpm build:presentation
pnpm build:reviewagent

# 验证（离线、零网络）
pnpm typecheck
pnpm --filter review-pi test
pnpm test
```

产物：

| 产物 | 路径 |
|---|---|
| 产品 tarball | `.artifacts/reviewagent/reviewagent-1.0.0.tgz` |
| CLI bundle | `packages/reviewagent/dist/cli.mjs`（+ `review-worker.mjs`） |
| 中文呈现引擎（可选，CLI 呈现投影） | `.tmp-gen/presentation/engine-zh.js` |

### 重建后的同一性检查

```bash
git rev-parse 'eval-e-baseline-2026-11-11^{commit}'   # e7249582…
git rev-parse 'reviewagent-v1.0.0^{commit}'            # 同上

npm install -g ./.artifacts/reviewagent/reviewagent-1.0.0.tgz
reviewagent --version                                  # 1.0.0

# 协议 v3 / 无配置选择：capabilities 报 protocolVersion=3；submit 携带 configId → -32019
reviewagent rpc --out reviewagent-output
```

真网关复跑需要本地 `.env.local`（`REVIEWER_API_KEY` / `REVIEWER_URL`；绝不入库）。凭据缺失时启动报错并给键清单，不静默降级。

## 4. 复现等级

- **源码同一**：tag + `pnpm-lock.yaml` + 组件版本锁定，任一台 Node ≥22 机器可重建同一运行时行为。
- **不保证字节同一**：esbuild bundle 与 tarball 含构建时间戳，不承诺逐字节一致；评测与审计以 RunRecord / usage 口径为准，不以制品 hash 为门。
- **环境不确定项**：模型实际部署版本、网关缓存策略不在代码内；L2 每次 campaign 必须用 `environment.json` 重新记录（设计 §8.5 / 附录 B.3），不能把本快照当作环境快照。

## 5. 已知边界

- 本快照只固定**生产 E 运行时**，不含评测 harness / judge 链 / `C_ref`（那些在 `eval/bench`，ADR-0016）。
- `actualDeployment` 记 `null`（未记录），不写 0；将来 campaign 若拿到部署版本，写入当次 `environment.json`，不回填本 manifest。
- 不复活协议 / CLI 的配置选择面；`C_ref` 的 `configId` 只作评测侧历史标签（ADR-0016 §3）。
- 历史 `runs/phase2-pi` 与本文无关：它标 `NOT_REPRODUCIBLE`，只作证据（[`phase2-pi-provenance.md`](phase2-pi-provenance.md)）。
