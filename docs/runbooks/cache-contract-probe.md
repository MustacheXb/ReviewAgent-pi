# 网关缓存合同探针（手动 runbook）

> 适用于 #58 / ADR-0018 §6。**手动专用**：不进 CI、不进产品 bin、不进 `review-pi` CLI。
> 每次探针会产生少量真实费用（约 12 次非流式 chat completion，`max_tokens=8`）。

## 目的

被动采集只能告诉我们本次 run 的 usage 字段族与模型回显；warmup、块对齐、
路由亲和这些**缓存行为**需要主动探针观察。本探针只输出观测（observed /
unknown），不声称缓存能力，也不把命中率直接当成本结论。

## 前置

- 构建 review-pi dist（探针经公开面复用 usage 分类器）：
  ```bash
  pnpm --filter review-pi build
  ```
- 环境变量（与生产一致，密钥不落盘）：
  ```bash
  export REVIEWER_URL='https://<gateway>/v1'     # 缺省官方接入点
  export REVIEWER_API_KEY='<key>'                # 必填；只进 Authorization 头
  ```
  `DEEPSEEK_URL` / `DEEPSEEK_API_KEY` 作为旧别名仍可用。

## 运行

```bash
pnpm probe:gateway-cache
```

输出为单份 JSON（stdout）。退出码：0 = health 可达；1 = 不可达 / 配置缺失。
JSON 不含任何密钥；`authorization` 头不会进入输出。

## 观测项

| 字段 | 含义 |
|---|---|
| `health` | `GET /models` 可达性与状态码（不判鉴权 / 模型） |
| `usageFieldFamily` | `deepseek-native` / `openai-cached-tokens` / `unknown` |
| `cacheMetering` | 响应是否上报缓存计量字段（`unknown` = 未见 usage） |
| `requestedModel` / `respondedModel` | 请求模型与响应回显模型（跨族不一致 = 静默错路由线索） |
| `warmup` | 同一稳定前缀连续 3 次的 cacheHit 轨迹；`warmupObserved` 只表示后一次更高 |
| `blockAlignment` | 1k / 2k / 4k / 8k 字符前缀各自的二次命中轨迹 |
| `affinity` | 同一请求重复 3 次的命中抖动（`observedVariance`） |
| `cacheBlockTokens` / `cacheWarmupMs` / `providerAffinityRequired` | 被动 / 主动观测都不足以断言的字段，恒 `unknown` |

## 解读纪律

- `unknown` 不是 0。没有命中字段就不要推断「未命中」，没有价目就不要推断折扣。
- `warmupObserved=true` 只说明同一前缀的第二次调用命中更高；网关可能随时段 /
  路由变化，跨时段比较前重跑本探针。
- `respondedModel` 与 `requestedModel` 跨族不一致时，先检查 `REVIEWER_URL` 是否
  带 `/v1`（缺 `/v1` 的历史实测会静默路由到其他模型族）。
- 不把探针结果写回产品代码或 CI 配置；它是诊断记录，不参与生产判定。

## 价目表（离线分析用）

`analyze-token --pricing <file>` 读取静态 JSON；缺失时 `currency` /
`currencyCost` 为 `null`（N/A）。示例（每 token 单价，币种任意）：

```json
{
  "currency": "USD",
  "priceValidFrom": "2026-11-01T00:00:00Z",
  "cacheHitPrice": 0.00000014,
  "cacheMissPrice": 0.00000028,
  "cacheWritePrice": 0.00000028,
  "outputPrice": 0.00000042
}
```

- 三种缓存价格（hit / miss / write）+ 输出价格均按 **token 单价**。
- `cacheWritePrice` 可省；若 `cacheWriteTokens > 0` 而价目缺失，报告
  `currencyCost=null`（不按固定折扣假设）。
- 价目生效时间进入报告 `priceValidFrom`，跨价目窗比较时标注混杂。
- 分析报告在提供 `--pricing` 时把价目三元组 / 币种 / 生效时间附加到每条
  `cacheContract` 上（审计侧不读价目文件，合同按缺省省键）。
- 不要提交真实密钥；价目表本身不含密钥，可入库或作为 run 产物留存。

## 回滚

探针纯观测：删除 `scripts/probe-gateway-cache.ts`、本 runbook 与
`package.json` 的 `probe:gateway-cache` 条目即可，不影响主链。
