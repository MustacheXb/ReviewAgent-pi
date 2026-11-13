/**
 * Reference smoke runner（#43 C_ref / #44 Claude Code，eval-only）。
 *
 * 用法（仓库根）：
 *   CAMPAIGN_REAL=1 pnpm reference-smoke -- --kind c-ref \
 *     --cases data/vul4j/p1-smoke-cases.json --case-count 1
 *   CAMPAIGN_REAL=1 pnpm reference-smoke -- --kind claude-code \
 *     --cases data/vul4j/p1-smoke-cases.json --case-count 3
 *
 * 产物在 `runs/eval/<kind>-smoke-<date>/`（gitignored）：
 * - c-ref：runs/ + judge/ + eval-sidecar/full-repo/ + summary.json
 * - claude-code：records/ + judge/ + column.json + COLUMN.md + failures.json
 *
 * 真实网关 / CLI 由 `CAMPAIGN_REAL=1` 门控；`.env.local` 只补缺，不回显 key。
 */
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertRealCampaignGate,
  prepareRealCampaign,
  resolveJudgeEnv,
} from "../src/eval/assembly/index.js";
import {
  parseCampaignCases,
  type CampaignPlan,
} from "../src/eval/campaign/index.js";
import { toEvalRunRecord } from "../src/eval/campaign/records.js";
import {
  campaignRecordPath,
  writeJsonFile,
} from "../src/eval/campaign/store.js";
import {
  buildClaudeCodeColumn,
  createClaudeCodeClient,
  detectClaudeCodeVersion,
  renderClaudeCodeColumnMarkdown,
  toClaudeCodeReferenceRecord,
  type ClaudeCodeReferenceRecord,
} from "../src/eval/reference/claude-code/index.js";
import { createCRefKernel } from "../src/eval/ref/index.js";
import { judgeFindings } from "../src/eval/judge/chain.js";
import {
  GptJudgeClient,
  judgeCompletionCapOf,
  validateModel,
} from "../src/eval/judge/index.js";
import type { MatchCounts } from "../src/eval/analysis/contracts.js";
import type { MRCase } from "../src/instrument/contracts/mr-case.js";
import { formatEnvLocalSummary, loadEnvLocalFile } from "../src/instrument/env-local.js";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const BASELINE_REF = "eval-e-baseline-2026-11-11";

interface SmokeOptions {
  readonly kind: "c-ref" | "claude-code";
  readonly casesFile: string;
  readonly caseCount: number;
  readonly outDir: string;
  readonly model: string;
  readonly judgeModel: string;
  readonly rep: number;
}

function parseArgs(argv: readonly string[]): SmokeOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (token === "--") {
      // pnpm script 透传时可能保留分隔符
      continue;
    }
    if (!token.startsWith("--")) {
      throw new Error(`unexpected argument ${JSON.stringify(token)}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`flag ${token} requires a value`);
    }
    values.set(token, value);
    index += 1;
  }
  const kind = values.get("--kind");
  if (kind !== "c-ref" && kind !== "claude-code") {
    throw new Error("--kind must be c-ref or claude-code");
  }
  const caseCountRaw = values.get("--case-count") ?? (kind === "c-ref" ? "1" : "3");
  const caseCount = Number(caseCountRaw);
  if (!Number.isInteger(caseCount) || caseCount <= 0) {
    throw new Error("--case-count must be a positive integer");
  }
  const repRaw = values.get("--rep") ?? "1";
  const rep = Number(repRaw);
  if (!Number.isInteger(rep) || rep <= 0) {
    throw new Error("--rep must be a positive integer");
  }
  const date = new Date().toISOString().slice(0, 10);
  return {
    kind,
    casesFile: path.resolve(REPO_ROOT, values.get("--cases") ?? "data/vul4j/p1-smoke-cases.json"),
    caseCount,
    outDir: path.resolve(
      REPO_ROOT,
      values.get("--out") ?? `runs/eval/${kind}-smoke-${date}`,
    ),
    model: values.get("--model") ?? "deepseek-v4-flash",
    judgeModel: values.get("--judge-model") ?? "glm-5.2",
    rep,
  };
}

async function main(argv: readonly string[]): Promise<number> {
  const envSummary = loadEnvLocalFile(path.join(REPO_ROOT, ".env.local"));
  if (envSummary.exists) {
    console.info(`[reference-smoke] .env.local: ${formatEnvLocalSummary(envSummary)}`);
  }
  const options = parseArgs(argv);
  const env = process.env;
  assertRealCampaignGate(env);
  const cases = parseCampaignCases(
    readFileSync(options.casesFile, "utf8"),
    options.casesFile,
  ).slice(0, options.caseCount);
  if (cases.length === 0) {
    throw new Error("reference smoke: no cases selected");
  }
  const judgeClient = createJudgeClient(env, options);
  const judgeCounts: MatchCounts[] = [];
  const failures: unknown[] = [];

  if (options.kind === "c-ref") {
    const setup = prepareRealCampaign({
      model: options.model,
      judgeModel: options.judgeModel,
      repoRoot: REPO_ROOT,
    });
    const kernel = createCRefKernel({ baseKernel: setup.deps.kernel });
    for (const rawCase of cases) {
      const mrCase = resolveCase(rawCase);
      try {
        const request = {
          unit: {
            source: "vul4j" as const,
            caseId: mrCase.caseId,
            configId: "E" as const,
            rep: options.rep,
          },
          mrCase,
          model: options.model,
          experimentRoot: options.outDir,
        };
        const result = await kernel.execute(request);
        const plan: CampaignPlan = {
          campaignId: path.basename(options.outDir),
          baselineRef: BASELINE_REF,
          candidateRef: "C_ref",
          casesFile: options.casesFile,
          reps: options.rep,
          model: options.model,
          arms: ["candidate"],
          outputDir: options.outDir,
        };
        const record = toEvalRunRecord({
          plan,
          unit: { ...request.unit, arm: "candidate" },
          result,
          completedAt: new Date().toISOString(),
        });
        await writeJsonFile(campaignRecordPath(options.outDir, record), {
          ...record,
          ref: "C_ref",
          evalOnly: true,
        });
        const judged = await judgeFindings({
          caseId: mrCase.caseId,
          findings: result.findings,
          truth: mrCase.truth,
          issueDescription: mrCase.issueDescription,
          diff: mrCase.diff,
          client: judgeClient,
        });
        judgeCounts.push(judged.counts);
        await writeJsonFile(path.join(options.outDir, "judge", `${mrCase.caseId}.json`), {
          caseId: mrCase.caseId,
          ref: "C_ref",
          status: judged.status,
          counts: judged.counts,
          anomalies: judged.anomalies,
        });
        await writeJsonFile(path.join(options.outDir, "summary.json"), {
          kind: "c-ref-smoke",
          ref: "C_ref",
          evalOnly: true,
          caseId: mrCase.caseId,
          sidecarPath: result.cRefSidecarPath,
          fullRepo: result.fullRepo,
          findings: result.findings.length,
          judge: judged,
        });
        console.info(
          `[reference-smoke] c-ref ${mrCase.caseId}: findings=${result.findings.length} ` +
            `judge=${judged.status} tp/fp/fn=${judged.counts.tp}/${judged.counts.fp}/${judged.counts.fn} ` +
            `sidecar=${result.cRefSidecarPath}`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push({ caseId: mrCase.caseId, error: message });
        console.error(`[reference-smoke] c-ref ${mrCase.caseId} FAILED: ${message}`);
      }
    }
  } else {
    const cliVersion = await detectClaudeCodeVersion();
    // Harness 同模型对照（用户口径）：Claude Code 必须使用与 ReviewAgent-pi
    // 评测相同的模型 id；不允许回落到 CLI 默认模型（可能是 glm/其它网关模型）。
    const client = createClaudeCodeClient({
      ...(cliVersion !== null ? { cliVersion } : {}),
      model: options.model,
    });
    const records: ClaudeCodeReferenceRecord[] = [];
    for (const rawCase of cases) {
      const mrCase = resolveCase(rawCase);
      try {
        const outcome = await client.run({ caseId: mrCase.caseId, mrCase, rep: options.rep });
        // 同模型对照硬校验：实际模型必须与 ReviewAgent-pi 评测模型一致；
        // 模型被网关 / CLI 配置改写时 fail fast，不产生「harness 差异」假结论。
        if (
          outcome.actualModels === null ||
          !outcome.actualModels.includes(options.model)
        ) {
          throw new Error(
            `Claude Code model mismatch: expected ${JSON.stringify(options.model)}, ` +
              `actual ${JSON.stringify(outcome.actualModels)}`,
          );
        }
        const record = toClaudeCodeReferenceRecord(
          { caseId: mrCase.caseId, mrCase, rep: options.rep },
          outcome,
        );
        records.push(record);
        await writeJsonFile(
          path.join(options.outDir, "records", `${mrCase.caseId}-rep${options.rep}.json`),
          record,
        );
        const judged = await judgeFindings({
          caseId: mrCase.caseId,
          findings: outcome.findings,
          truth: mrCase.truth,
          issueDescription: mrCase.issueDescription,
          diff: mrCase.diff,
          client: judgeClient,
        });
        judgeCounts.push(judged.counts);
        await writeJsonFile(path.join(options.outDir, "judge", `${mrCase.caseId}.json`), {
          caseId: mrCase.caseId,
          ref: "claude-code",
          status: judged.status,
          counts: judged.counts,
          anomalies: judged.anomalies,
        });
        console.info(
          `[reference-smoke] claude-code ${mrCase.caseId}: findings=${outcome.findings.length} ` +
            `turns=${outcome.numTurns ?? "N/A"} cost=${outcome.totalCostUsd ?? "N/A"} ` +
            `denials=${outcome.permissionDenials ?? "N/A"} judge=${judged.status} ` +
            `tp/fp/fn=${judged.counts.tp}/${judged.counts.fp}/${judged.counts.fn}`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push({ caseId: mrCase.caseId, error: message });
        console.error(`[reference-smoke] claude-code ${mrCase.caseId} FAILED: ${message}`);
      }
    }
    const column = buildClaudeCodeColumn(records, { judgeCounts });
    await writeJsonFile(path.join(options.outDir, "column.json"), column);
    await writeJsonFile(path.join(options.outDir, "failures.json"), failures);
    await mkdir(options.outDir, { recursive: true });
    await writeFile(
      path.join(options.outDir, "COLUMN.md"),
      `${renderClaudeCodeColumnMarkdown(column)}\n`,
      "utf8",
    );
    console.info(`[reference-smoke] claude-code column: ${path.join(options.outDir, "COLUMN.md")}`);
  }

  if (options.kind === "c-ref") {
    await writeJsonFile(path.join(options.outDir, "failures.json"), failures);
  }
  return failures.length === 0 ? 0 : 1;
}

function createJudgeClient(env: NodeJS.ProcessEnv, options: SmokeOptions): GptJudgeClient {
  const judgeEnv = resolveJudgeEnv(env);
  if (judgeEnv === null) {
    throw new Error("reference smoke: judge API key missing (JUDGE_API_KEY / OPENAI_API_KEY)");
  }
  validateModel(options.judgeModel, { reviewerModel: options.model });
  judgeCompletionCapOf(options.judgeModel, { customLlmEndpoint: judgeEnv.baseUrl !== null });
  return new GptJudgeClient({
    model: options.judgeModel,
    apiKey: judgeEnv.apiKey,
    ...(judgeEnv.baseUrl !== null ? { baseUrl: judgeEnv.baseUrl } : {}),
    reviewerModel: options.model,
    customLlmEndpoint: judgeEnv.baseUrl !== null,
  });
}

function resolveCase(mrCase: MRCase): MRCase {
  return {
    ...mrCase,
    repoPath: path.isAbsolute(mrCase.repoPath)
      ? mrCase.repoPath
      : path.resolve(REPO_ROOT, mrCase.repoPath),
  };
}

try {
  process.exit(await main(process.argv.slice(2)));
} catch (error) {
  console.error(`[reference-smoke] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}
