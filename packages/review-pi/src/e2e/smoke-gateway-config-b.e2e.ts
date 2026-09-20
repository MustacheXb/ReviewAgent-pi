import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { REVIEWER_API_KEY_ENV_VARS, hasReviewerApiKey } from "review-llm";
import { formatEnvLocalSummary, loadEnvLocalFile } from "../shared/env-local.js";
import { recordingFetch } from "./recording-fetch.js";
import {
  formatSmokeDiagnostics,
  modelEchoMatches,
  runSmokeProbes,
  type RawWireUsage,
} from "../provider/gateway-probe.js";
import { REVIEW_MODEL_ID } from "../provider/pi-client.js";
import { resolveReviewerEndpoint } from "../provider/reviewer-endpoint.js";
import { runReview } from "../run/review-run.js";
import { goldenFixture } from "../testing/golden.js";
import { VUL4J_1_ISSUE, VUL4J_1_SNAPSHOT } from "../testing/vul4j1-script.js";

// 真跑冒烟（#4，R4 网关 + R2 usage 口径 + R6 Windows 直跑关闭面）：
// VUL4J-1 × config B 经 REVIEWER_URL 企业网关全链真跑——与离线 fake 适配器
// 同一条 runReview 缝，传输层换 recording tee(真 fetch)。
//
// 断言面：
// - 双探针先行（网关健康 + 模型可达），失败 → 人话诊断整体抛出；
// - 六回合全命中 ${baseUrl}/chat/completions、逐请求回显 = 请求模型
//   （无 /v1 静默错路由，本机 2026-09-19 实测签名）；
// - R2：RunRecord.baseline.usage（pi-ai parseChunkUsage → addUsage 路径）与
//   Σ fold(recording tee 原始 usage)（独立折算路径）逐字段相等——两条解析
//   路径读同一份线上字节，互为校验；cacheReadTokens 单列在位；
// - 密钥零留痕：record / audit 落盘字节绝不包含 key 值（哨兵全文扫描）。
//
// env 守卫：REVIEWER_URL + API key（.env.local 注入或显式环境变量）+ VUL4J
// 快照缺一即整档 skip（console.info 原因）。密钥纪律：key 只进 Authorization
// 头与内存，绝不进日志/断言输出/留痕文件。

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const EXPERIMENT_ID = "pi-gateway-smoke";

// vitest 不自动读 .env.local——显式装载（显式环境变量优先，文件只补缺）
const envLocal = loadEnvLocalFile(path.join(REPO_ROOT, ".env.local"));
if (envLocal.exists) {
  console.info(`[smoke-gateway-config-b] .env.local: ${formatEnvLocalSummary(envLocal)}`);
}

// key 存在性判断走 review-llm 单源（hasReviewerApiKey：与 resolveApiKey
// 同名同序同 trim 语义，实验预检与 e2e 冒烟门共用，防各自复制漂移）
const SKIP_REASON = (() => {
  if (!existsSync(VUL4J_1_SNAPSHOT)) {
    return `VUL4J-1 snapshot fixture missing (${VUL4J_1_SNAPSHOT})`;
  }
  if ((process.env.REVIEWER_URL ?? "").trim() === "") {
    return "REVIEWER_URL not set — this smoke drives the enterprise gateway (set it in .env.local; the official DeepSeek endpoint is a different entry)";
  }
  if (!hasReviewerApiKey()) {
    return `no reviewer API key found (expected one of ${REVIEWER_API_KEY_ENV_VARS.join(", ")})`;
  }
  return null;
})();

if (SKIP_REASON !== null) {
  console.info(`[smoke-gateway-config-b] skipped: ${SKIP_REASON}`);
}

/**
 * R2 独立折算：input = max(0, prompt − cacheRead − cacheWrite)。
 * 公式与 vendored pi-ai openai-completions.ts parseChunkUsage 逐字一致
 * （漂移锚点：pi 侧若改折算，此处需同步）。认识论口径：本折算与 pi-ai
 * 属同公式双实现，双路对账只能证「两路读同一字节后结果一致」；公式
 * 本身由离线黄金（t 系列真值 {9579, 14484, 24064} 对 pi-ai 折算路径）钉死。
 */
function foldRawUsage(raw: RawWireUsage): {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
} {
  const cacheWrite = raw.cacheWriteTokens ?? 0;
  return {
    inputTokens: Math.max(0, raw.promptTokens - raw.cacheReadTokens - cacheWrite),
    outputTokens: raw.completionTokens,
    cacheReadTokens: raw.cacheReadTokens,
  };
}

function sumFoldedUsage(
  raws: readonly (RawWireUsage | undefined)[],
): { inputTokens: number; outputTokens: number; cacheReadTokens: number } {
  const folded = raws.map((raw, index) => {
    if (raw === undefined) {
      throw new Error(
        `request ${index} captured no usage frame (the gateway did not report usage on the final SSE chunk)`,
      );
    }
    return foldRawUsage(raw);
  });
  return {
    inputTokens: folded.reduce((total, usage) => total + usage.inputTokens, 0),
    outputTokens: folded.reduce((total, usage) => total + usage.outputTokens, 0),
    cacheReadTokens: folded.reduce((total, usage) => total + usage.cacheReadTokens, 0),
  };
}

test.skipIf(SKIP_REASON !== null)(
  "真跑冒烟：VUL4J-1 × config B 经 REVIEWER_URL 网关全链真跑（双探针 + R2 usage 对账 + 密钥零留痕）",
  async () => {
    // 1) 网关接入解析（REVIEWER_URL > DEEPSEEK_* 别名；审计只含 model，baseUrl 属 REPORT 口径）
    const endpoint = resolveReviewerEndpoint();

    // 2) 双探针先行：网关健康 + 模型可达；失败 → 人话诊断整体抛出（不进入全链）
    const probes = await runSmokeProbes({
      baseUrl: endpoint.baseUrl,
      apiKey: endpoint.apiKey,
      modelId: REVIEW_MODEL_ID,
      fetch: globalThis.fetch,
    });
    if (!probes.ok) {
      throw new Error(
        `smoke probes failed — fix the gateway findings before judging the run:\n${formatSmokeDiagnostics(probes)}`,
      );
    }

    // 3) 全链真跑：单案 × config B（组装 → pi-ai 序列化 → 真网关 → 解析 → 审计投影）
    const recorder = recordingFetch(globalThis.fetch);
    const { record, recordPath, auditPath } = await runReview({
      caseId: "VUL4J-1",
      repoPath: VUL4J_1_SNAPSHOT,
      diff: goldenFixture("vul4j-1.diff"),
      issueDescription: VUL4J_1_ISSUE,
      apiKey: endpoint.apiKey,
      baseUrl: endpoint.baseUrl,
      fetch: recorder.fetch,
      runsRoot: path.join(REPO_ROOT, "runs"),
      experimentId: EXPERIMENT_ID,
      rep: 1,
    });

    // 4) RunRecord 完整性（真跑产物全字段在位；结构口径与离线黄金同构）
    expect(record.source).toBe("vul4j");
    expect(record.caseId).toBe("VUL4J-1");
    expect(record.configId).toBe("B");
    expect(record.rep).toBe(1);
    expect(record.model).toBe(REVIEW_MODEL_ID);
    expect(Number.isNaN(Date.parse(record.completedAt))).toBe(false);
    expect(record.baseline.rounds).toBe(1);
    expect(record.baseline.toolCalls).toBe(0);

    // 5) 传输层对账：六回合全命中网关端点、全 200、逐请求回显与请求模型同族
    //    （网关别名可解析为版本化 GA 快照；跨族静默错路由 = 失败——探针同口径）
    const requests = await recorder.settle();
    expect(requests).toHaveLength(6);
    for (const [index, request] of requests.entries()) {
      expect(request.url, `request ${index} endpoint`).toBe(
        `${endpoint.baseUrl}/chat/completions`,
      );
      expect(request.status, `request ${index} status`).toBe(200);
      if (request.respondedModel !== undefined) {
        expect(
          modelEchoMatches(REVIEW_MODEL_ID, request.respondedModel),
          `request ${index} model echo: ${request.respondedModel}`,
        ).toBe(true);
      }
      expect(request.rawUsage, `request ${index} raw usage captured`).toBeDefined();
    }

    // 6) R2 关闭：DSH usage 口径 {inputTokens, outputTokens, cacheReadTokens}
    //    逐字段对账（两条独立解析路径读同一份线上字节）；cacheReadTokens 单列在位
    const expectedUsage = sumFoldedUsage(requests.map((request) => request.rawUsage));
    expect(record.baseline.usage).toEqual(expectedUsage);
    expect(record.baseline.usage.inputTokens).toBeGreaterThan(0);
    expect(record.baseline.usage.outputTokens).toBeGreaterThan(0);
    // 单列口径：字段必须在位（契约可选，真跑必须报数；值可为 0——首请求未命中缓存）
    expect(record.baseline.usage.cacheReadTokens).toBeDefined();

    // 7) 审计与记录同源：audit.usage ≡ record usage；审计 20 键口径只含 model
    const audit = JSON.parse(readFileSync(auditPath, "utf8")) as {
      usage: unknown;
      model: string;
      requests: unknown[];
    };
    expect(audit.usage).toEqual(record.baseline.usage);
    expect(audit.model).toBe(REVIEW_MODEL_ID);
    expect(audit.requests).toHaveLength(6);

    // 8) 密钥零留痕：record / audit 原始落盘字节绝不包含 key 值
    const recordText = readFileSync(recordPath, "utf8");
    const auditText = readFileSync(auditPath, "utf8");
    expect(recordText).not.toContain(endpoint.apiKey);
    expect(auditText).not.toContain(endpoint.apiKey);

    // 9) 人话摘要（cacheRead 单列报数，不与质量结论混排）
    const usage = record.baseline.usage;
    const cacheRead = usage.cacheReadTokens ?? 0;
    console.info(
      `[${EXPERIMENT_ID}] VUL4J-1/B/rep-1 via ${endpoint.baseUrl} (${REVIEW_MODEL_ID}): ` +
        `${requests.length} requests; usage input ${usage.inputTokens} / output ${usage.outputTokens} / ` +
        `cacheRead ${cacheRead} (billed ${usage.inputTokens + usage.outputTokens}, ` +
        `with cache ${usage.inputTokens + usage.outputTokens + cacheRead}); ` +
        `record ${path.relative(REPO_ROOT, recordPath)}`,
    );
  },
  30 * 60_000,
);
