# Claude Code 外部参照真实冒烟：**环境阻断记录**

> 状态：**未完成真实 Claude 参照**。本机 Claude Code CLI 的模型被环境变量 /
> 本地配置固定到 **GLM 网关**（`glm-5.3`），不是 Claude 模型；因此本次冒烟
> **不能**作为 #44 的「真实 Claude Code 1–3 案」验收证据，也不得对外引用。
>
> 确定性部分（client / 归一化 / fake / 同一 judge / 单列报告）已完成并提交
> `f30c35f`；真实冒烟待真实 Anthropic 模型可用后重跑。

## 1. 环境发现

| 项 | 值 |
|---|---|
| Claude Code CLI | `2.1.241` |
| `claude auth status` | `loggedIn: true`，`oauth_token` / firstParty |
| `ANTHROPIC_BASE_URL` | volcengine gateway（`…volceapi.com/compatible`） |
| `ANTHROPIC_MODEL` / `ANTHROPIC_DEFAULT_*` | `glm-5.3` / `zhipu/glm-5.3` / `glm-5.3-flash` |
| 冒烟实际 modelUsage | **`glm-5.3`**（与 judge `glm-5.2` 同 family） |

## 2. 干净 OAuth 探测

清除 `ANTHROPIC_*` / `CLAUDE_CODE_*` 后尝试真实 Anthropic 模型：

- `--model claude-sonnet-5-0` → `api_error_status: 404`（模型不存在 / 无权限）；
- `--model sonnet` / `haiku` / `opus` → 仍解析到 `glm-5.3` / `glm-5.3-flash` /
  `zhipu/glm-5.3`（本地 wrapper / 配置映射），不是 Claude 模型。

结论：本机当前**无法**通过 Claude Code CLI 取得真实 Claude 跨模型参照；
需要真实 Anthropic API key / 官方端点，或修改本地 CLI 配置。

## 3. 已发生的冒烟（无效，仅留痕）

首案 `VUL4J-1`（GLM-5.3-backed Claude Code CLI）：

| 项 | 值 |
|---|---|
| findings | 0 |
| num_turns | 6 |
| stop / error | `error_max_turns`（`truncated: true`） |
| total_cost_usd | 0.867362（CLI 按网关模型计，非 Claude 价目） |
| permission_denials | 0 |
| anomalies | `CLI reported error (subtype "error_max_turns")` |

发现实际模型为 `glm-5.3` 后已停止剩余 case，避免继续产生无效费用。该记录
**不进入 L3 三列报告**。

## 4. 结论与下一步

- #44 的**确定性实现已完成**：CLI 调用 / `--tools` + `--allowedTools`
  Read,Grep,Glob / max-turns 5 / JSON 归一化 / 非法与截断留痕 / 同一 judge /
  单列报告。
- #44 的 **AC1（真实 Claude Code 1–3 案）被环境阻断**，issue 保持 open。
- 可选路径：
  1. 提供真实 Anthropic API key / 官方端点，重跑 1–3 案；
  2. 若产品接受「Claude Code CLI + GLM-5.3」作为**工具参照**（非跨模型
     Claude 参照），需新 ADR / 报告限定语明确，不能写「Claude Code 外部参照」；
  3. 暂不跑，等 L3 (#45) 前处理。

原始（无效）工件：`runs/eval/claude-code-smoke-2026-11-13/`（gitignored）。
本目录 `record-VUL4J-1-glm-5.3.json` / `judge-VUL4J-1.json` 仅作审计留痕。
