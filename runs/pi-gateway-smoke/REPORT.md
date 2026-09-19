# pi 内核真实网关冒烟（P1b：网关 + usage 映射 + Windows）

- **实验 ID**: `pi-gateway-smoke`
- **日期**: 2026-09-19
- **规模**: 单单元 VUL4J-1 / B / rep-1——与离线黄金真源（t-series 审计，DSH 线 VUL4J-1/B/rep-1）同单元同配置，真跑（真网关真模型，非 canned 回复）
- **接入**: `REVIEWER_URL` + `REVIEWER_API_KEY` 环境变量（`REVIEWER_*` > 旧 `DEEPSEEK_*` 别名序，常量单源 review-llm）→ 火山引擎 API Gateway（cn-beijing，OpenAI 兼容，URL 需带 `/v1`）；网关把别名 `deepseek-v4-flash` 解析为版本化构建 `deepseek-v4-flash-ga-260731`
- **结果**: completed（1 finding / 1 rejection），rounds=1 / toolCalls=0 / 6 requests / 215.7s；usage input 13,242 / output 20,295 / cacheRead 20,480（billed 33,537，with cache 54,017）
- **与 t-series 同单元结构同构**: findings=1 / rejections=1 / phaseLog=6 / rounds=1 / toolCalls=0 全一致，usage 同量级（t-series：input 9,579 / output 14,484 / cacheRead 24,064）——差异属真跑响应侧正常波动（与 DSH 线 `runs/dsh-gateway-smoke-r3/REPORT.md` 对 POC1 的同法对照一致）
- **R2 usage 口径关闭**: `RunRecord.baseline.usage`（pi-ai parseChunkUsage → addUsage 路径）与 Σ fold(recording tee 原始 SSE usage)（独立折算：input = max(0, prompt − cacheRead − cacheWrite)）**逐字段相等**——两条独立解析路径读同一份线上字节互为校验；cacheReadTokens 单列在位，不与质量结论混排
- **R4 网关 + R6 Windows 关闭**: 双探针（网关健康 + 模型可达）先行通过后人链；Windows 11 本机直跑（Node v24.13.0 / pnpm 10.30.3，`pnpm --filter review-pi test:e2e`）全绿
- **密钥纪律**: `.env.local`（gitignored）本机注入，vitest 经包内装载器显式读取；record / audit 落盘字节哨兵扫描无 key 值；审计 DSH-isomorphic 20 键口径只含 model（实际请求 id），baseUrl 属本 REPORT 口径

## 探针 2 人话诊断实锚（2026-09-19 本机实测的两类回显形态）

- **无 `/v1` 的 REVIEWER_URL**：deepseek 请求 id 被静默路由到 `glm-5.3-flash`（响应 model 字段不回显请求 id）→ MODEL_MISMATCH，点名错路由签名与 `/v1` 修复——此类端点上的任何运行不可信
- **带 `/v1`**：别名 `deepseek-v4-flash` 合法解析为 `deepseek-v4-flash-ga-260731`（GA 快照，同族版本化构建）→ 放行并在诊断注明解析产物；已知局限：同族层级漂移（如 glm-5.3 → glm-5.3-flash）不判错，探针只拦跨族错路由
