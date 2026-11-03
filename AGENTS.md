# AGENTS.md

Guidance for Codex when working in this repository.

## Repo identity（姊妹仓定位）

本仓（`MustacheXb/ReviewAgent-pi`）是 **pi 内核线**：Review Runtime 在 pi 内核（vendored `packages/{ai,agent,chord,telemetry}`）上从 0 重写（ADR-0009），与 **DSH 内核线兄弟仓** [`MustacheXb/ReviewAgent`](https://github.com/MustacheXb/ReviewAgent) 在同一评测集与冻结判定链上做内核无关性对照。

**跨仓 ADR 限定语纪律**：两仓 ADR 各自独立编号（本仓 0001–0009 为 pi 线序列）。引用 DSH 兄弟仓的决策必须写全限定语「DSH 线 ADR-XXXX」；裸写「ADR-XXXX」一律指本仓 ADR。双 0009 尤其如此（本仓 0009 = pi 内核从 0 重写；DSH 线 0009 = 大 MR 切分）。

**跨分支 ADR 限定语纪律（ADR-0014）**：本仓自冻结基线（`demo-config-matrix-baseline-2026-11-03`）起双线分叉——生产 `main` 与本分支 `demo/config-matrix` 共同继承 ADR-0001–0014，此后各自独立编号（0015 起同号不同文）。本分支为 **Demo 线**：裸写「ADR-XXXX」一律指 Demo 线序列；跨线引用必须写全限定语「主线 ADR-XXXX」。协议版本同理分叉：主线 v3（无配置选择）、Demo 线 v2（A–E 配置矩阵）。

## Agent skills

### Issue tracker

GitHub Issues: issues and specs live in this repo's GitHub Issues (`MustacheXb/ReviewAgent-pi`), managed via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five canonical roles, label string equal to role name (`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` at the repo root plus `docs/adr/`. See `docs/agents/domain.md`.
