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

// 真跑冒烟（#6 P3a）：VUL4J-1 × config C/D/E 经 REVIEWER_URL 企业网关全链
// 真跑——工具驱动 agentLoop 路径（七工具 + 轮次上界 + config C 全仓注入 +
// config E Context Ledger）。与离线 fake 适配器同一条 runReview 缝，传输层
// 换 recording tee(真 fetch)。
//
// 断言面（每配置一 run）：
// - 双探针先行（一次,三配置共享——同网关同模型）,失败 → 人话诊断整体抛出；
// - 全部请求命中 ${baseUrl}/chat/completions、逐请求回显与请求模型同族；
// - wire 工具面：七工具恒在（C/D/E 每请求）；
// - config C:req0 含全仓注入消息 + fullRepo 记账(键在场,VUL4J-1 大仓必截断)；
// - config E:审计 ledger 键恒投影(键在场);
// - R2:RunRecord.baseline.usage 与 Σ fold(recording tee 原始 usage) 逐字段相等
//   (两条独立解析路径读同一份线上字节,互为校验;请求数由模型行为决定,
//   只断 ≥ 6——六相位下界);
// - 密钥零留痕：record / audit 落盘字节绝不包含 key 值（哨兵全文扫描）。
//
// env 守卫：REVIEWER_URL + API key + VUL4J 快照缺一即整档 skip。密钥纪律：
// key 只进 Authorization 头与内存,绝不进日志/断言输出/留痕文件。

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const EXPERIMENT_ID = "pi-gateway-smoke-cde";

// vitest 不自动读 .env.local——显式装载（显式环境变量优先，文件只补缺）
const envLocal = loadEnvLocalFile(path.join(REPO_ROOT, ".env.local"));
if (envLocal.exists) {
  console.info(`[smoke-gateway-config-cde] .env.local: ${formatEnvLocalSummary(envLocal)}`);
}

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
  console.info(`[smoke-gateway-config-cde] skipped: ${SKIP_REASON}`);
}

/** R2 独立折算（与 smoke-gateway-config-b 同公式；漂移锚点见该文件注释） */
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
  "真跑冒烟：VUL4J-1 × config C/D/E 经 REVIEWER_URL 网关全链真跑（agentLoop + 七工具 + R2 usage 对账 + 密钥零留痕）",
  async () => {
    const endpoint = resolveReviewerEndpoint();

    // 双探针先行（三配置共享一次）：网关健康 + 模型可达
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

    for (const configId of ["C", "D", "E"] as const) {
      // 全链真跑：单案 × 单配置（agentLoop 行为由模型驱动——请求/轮次/工具
      // 调用数不可预钉，断言取不变量而非精确值）
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
        configId,
      });

      // RunRecord 完整性
      expect(record.source).toBe("vul4j");
      expect(record.caseId).toBe("VUL4J-1");
      expect(record.configId).toBe(configId);
      expect(record.model).toBe(REVIEW_MODEL_ID);
      expect(Number.isNaN(Date.parse(record.completedAt))).toBe(false);
      // 轮次上界留痕在位（截断与否由模型行为决定,契约面必须有值）
      expect(record.baseline.rounds).toBeGreaterThanOrEqual(1);
      expect(record.baseline.rounds).toBeLessThanOrEqual(5);
      expect(typeof record.baseline.audit.truncated).toBe("boolean");
      expect(Array.isArray(record.baseline.audit.truncationReasons)).toBe(true);

      // 传输层对账：全部请求命中网关端点、全 200、回显与请求模型同族
      const requests = await recorder.settle();
      expect(requests.length, `${configId} request count`).toBeGreaterThanOrEqual(6);
      for (const [index, request] of requests.entries()) {
        expect(request.url, `${configId} request ${index} endpoint`).toBe(
          `${endpoint.baseUrl}/chat/completions`,
        );
        expect(request.status, `${configId} request ${index} status`).toBe(200);
        if (request.respondedModel !== undefined) {
          expect(
            modelEchoMatches(REVIEW_MODEL_ID, request.respondedModel),
            `${configId} request ${index} model echo: ${request.respondedModel}`,
          ).toBe(true);
        }
        expect(request.rawUsage, `${configId} request ${index} raw usage captured`).toBeDefined();
      }

      // wire 工具面：七工具恒在（每请求）
      const audit = JSON.parse(readFileSync(auditPath, "utf8")) as {
        requests: { wireBody: string; tools?: { name: string }[] }[];
        fullRepo?: unknown;
        ledger?: unknown;
        [extra: string]: unknown;
      };
      expect(audit.requests).toHaveLength(requests.length);
      for (const [index, request] of audit.requests.entries()) {
        const wire = JSON.parse(request.wireBody) as {
          tools?: { function: { name: string } }[];
        };
        expect(
          wire.tools?.map((tool) => tool.function.name),
          `${configId} request ${index} wire tools`,
        ).toEqual([
          "review_get_diff",
          "review_get_symbol",
          "review_get_file",
          "review_find_references",
          "review_get_call_chain",
          "review_search_rule",
          "review_search_history",
        ]);
      }
      // 审计投影 tools = 点分名
      expect(audit.requests[0].tools?.map((tool) => tool.name)).toEqual([
        "review.get_diff",
        "review.get_symbol",
        "review.get_file",
        "review.find_references",
        "review.get_call_chain",
        "review.search_rule",
        "review.search_history",
      ]);

      // 配置面审计键：C = fullRepo 记账（VUL4J-1 大仓必截断）；E = ledger 恒投影
      if (configId === "C") {
        const fullRepo = audit.fullRepo as { truncated?: boolean; totalFiles?: number } | undefined;
        expect(fullRepo, `${configId} audit fullRepo key`).toBeDefined();
        expect(fullRepo?.truncated).toBe(true);
        expect(fullRepo?.totalFiles).toBeGreaterThan(0);
      } else {
        expect(audit.fullRepo, `${configId} must not project fullRepo`).toBeUndefined();
      }
      if (configId === "E") {
        expect(Array.isArray(audit.ledger), `${configId} audit ledger key`).toBe(true);
      } else {
        expect(audit.ledger, `${configId} must not project ledger`).toBeUndefined();
      }

      // R2 关闭：两条独立解析路径读同一份线上字节，逐字段对账
      const expectedUsage = sumFoldedUsage(requests.map((request) => request.rawUsage));
      expect(record.baseline.usage).toEqual(expectedUsage);
      expect(record.baseline.usage.inputTokens).toBeGreaterThan(0);
      expect(record.baseline.usage.outputTokens).toBeGreaterThan(0);
      expect(record.baseline.usage.cacheReadTokens).toBeDefined();

      // 密钥零留痕：record / audit 原始落盘字节绝不包含 key 值
      const recordText = readFileSync(recordPath, "utf8");
      const auditText = readFileSync(auditPath, "utf8");
      expect(recordText).not.toContain(endpoint.apiKey);
      expect(auditText).not.toContain(endpoint.apiKey);

      const usage = record.baseline.usage;
      console.info(
        `[${EXPERIMENT_ID}] VUL4J-1/${configId}/rep-1 via ${endpoint.baseUrl} (${REVIEW_MODEL_ID}): ` +
          `${requests.length} requests; rounds ${record.baseline.rounds}; toolCalls ${record.baseline.toolCalls}; ` +
          `truncated ${record.baseline.audit.truncated}; usage input ${usage.inputTokens} / output ${usage.outputTokens} / ` +
          `cacheRead ${usage.cacheReadTokens ?? 0}; record ${path.relative(REPO_ROOT, recordPath)}`,
      );
    }
  },
  45 * 60_000,
);
