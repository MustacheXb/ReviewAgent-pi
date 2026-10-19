/**
 * 模型迁移门 CLI 入口（#14，生产化四必做之三）：换模型 / 换网关前的安全自证
 * ——双探针（目标 modelId）+ 单案生产入口 config E 真跑，全绿才放行。
 * 门逻辑单源 src/gate/migration-gate.ts（纯注入，离线单测
 * tests/gate/migration-gate.test.ts 全覆盖）；本文件只做装配。
 *
 * 装配面（root 程序闭包中 pi 触达的合法位置——pi-kernel.ts 头注释闭包纪律：
 * 装配只在 scripts 入口与测试）：
 * - loadEnvLocalFile（.env.local，显式环境变量优先）；
 * - resolveReviewerEndpoint（REVIEWER_URL / REVIEWER_API_KEY → endpoint；
 *   --base-url 显式覆盖目标网关，key 仍只走环境变量）；
 * - runSmokeProbes / formatSmokeDiagnostics（review-pi 公开面：双探针 + 8 类
 *   失败人话诊断单源，经闭包注入门模块）；
 * - piKernel（ReviewKernel 执行缝的 pi 侧——真跑经缝完成，脚本不 import
 *   runReview）；
 * - 单案输入：data/vul4j/smoke-cases.json 的 VUL4J-38（root 侧自备 fixture
 *   路径，tests/e2e/pi-seam-matrix.e2e.ts 同款装载；快照缺失 fail fast 提示
 *   pnpm materialize:vul4j）。
 *
 * 基线模型镜像：review-pi REVIEW_MODEL_ID 未进包公开导出面（index.ts 只导出
 * 内核入口/记录类型/网关解析/双探针），此处镜像 "deepseek-v4-flash"（flash 档）
 * 为漂移锚点——基线换档先改 review-pi 单源再同步此处。
 *
 * 运行（仓库根；真跑网关调用、烧真钱，不进 CI——零网络纪律 #28，真跑由
 * 用户裁量执行；经 package.json 脚本）：
 *   pnpm migration-gate -- --model glm-5.3-flash
 *   pnpm migration-gate -- --model deepseek-v4-pro --confirm-high-risk-upgrade
 *   pnpm migration-gate -- --model deepseek-v4-flash --base-url https://gw.example.com/v1
 *
 * 编译：tsc -p tsconfig.migration-gate.json（同 tsconfig.experiment.json 先例
 * 必须走 -p——内联 flags 丢失 tsconfig 的 baseUrl/paths，review-pi 类型链经
 * node_modules 解析回 vendored pi 源码而编译爆炸）。
 *
 * 退出码：0 门 PASS（放行）；1 门 FAILED（任一段红，人话诊断在 stdout）；
 * 2 用法/装配错误（坏旗标、缺凭据、缺单案 fixture / 快照）。
 *
 * 密钥纪律：key 只从环境解析进闭包（探针 + piKernel），绝不进 stdout/
 * 诊断/留痕（门模块签名面无 key 字段——哨兵测试锁定）。
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatSmokeDiagnostics,
  resolveReviewerEndpoint,
  runSmokeProbes,
  type ReviewerEndpoint,
} from "review-pi";
import { piKernel } from "../src/experiment/pi-kernel.js";
import { runMigrationGate } from "../src/gate/migration-gate.js";
import type { MigrationGateDeps, MigrationGateResult } from "../src/gate/migration-gate.js";
import { errorMessage, flagFail, flagOk, parseCliArgs } from "../src/instrument/cli-args.js";
import type { CliArgSpec, CliParseResult, ValueFlagParser } from "../src/instrument/cli-args.js";
import { formatEnvLocalSummary, loadEnvLocalFile } from "../src/instrument/env-local.js";
import type { MRCase } from "../src/instrument/contracts/mr-case.js";

// REPO_ROOT 锚点：编译产物位于 .tmp-gen/scripts/（tsconfig 保留 scripts/ 子目录），
// 仓库根在两级之上——与文档运行路径 node .tmp-gen/scripts/run-migration-gate.js 对应
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
/**
 * 门真跑留痕目录（runs/migration-gate）：内核审计照常落盘（时间戳文件名不冲突），
 * 不写 plan/cases——非实验目录；分析工具均按显式目录寻址，不盲扫 runs/ 根。
 */
const GATE_EXPERIMENT_ID = "migration-gate";
/** 单案 fixture（root 侧 seam 冒烟先例用例；快照 = .cache/datasets/vul4j-repos/VUL4J-38-*） */
const GATE_CASE_ID = "VUL4J-38";
/** 基线模型（镜像 review-pi REVIEW_MODEL_ID，flash 档——漂移锚点，见模块注释） */
const BASELINE_MODEL_ID = "deepseek-v4-flash";

const USAGE = `用法：run-migration-gate --model <id> [--base-url <url>] [--confirm-high-risk-upgrade]
  --model                      迁移目标模型 id（必填；换到什么探什么）
  --base-url                   目标网关 base URL（缺省 REVIEWER_URL / DEEPSEEK_URL 解析产物；
                               需自带 /v1 前缀——OpenAI 兼容网关路径约定）
  --confirm-high-risk-upgrade  同族 flash->pro 高险升级的显式确认（消融验证项，不默认启用；
                               缺省时该升级路径被门拒绝）
取值形式：--flag value 或 --flag=value；--help 打印用法`;

interface GateCliOptions {
  readonly model: string;
  readonly baseUrl: string | null;
  readonly confirmHighRiskUpgrade: boolean;
}

/** 解析期可变值（model / base-url 单次值 flag） */
interface GateParseValues {
  model: string | null;
  baseUrl: string | null;
  confirmHighRiskUpgrade: boolean;
}

/** flag 名 → 解析期字段名（显式映射表：--base-url 带连字符，alignment-gate 的
 *  slice(2) 直取惯例只对无连字符 flag 成立——slice 会得到 "base-url" 而非
 *  "baseUrl"，字段查表恒 undefined 导致「重复给值」误报） */
const VALUE_FLAG_FIELDS = {
  "--model": "model",
  "--base-url": "baseUrl",
} as const;

/** 单次值 flag：重复给值报错（model / base-url 共用形态） */
function singleValueFlag(flagName: keyof typeof VALUE_FLAG_FIELDS): ValueFlagParser<GateParseValues> {
  const field = VALUE_FLAG_FIELDS[flagName];
  return (value, current) =>
    current[field] !== null
      ? flagFail(`flag ${flagName} given more than once`)
      : flagOk<GateParseValues>(field === "model" ? { model: value } : { baseUrl: value });
}

const MIGRATION_GATE_ARG_SPEC: CliArgSpec<GateParseValues, GateCliOptions> = {
  usage: USAGE,
  defaultValues: (): GateParseValues => ({ model: null, baseUrl: null, confirmHighRiskUpgrade: false }),
  booleanFlags: { "--confirm-high-risk-upgrade": { confirmHighRiskUpgrade: true } },
  valueFlags: {
    "--model": singleValueFlag("--model"),
    "--base-url": singleValueFlag("--base-url"),
  },
  finalize: (values, fail): CliParseResult<GateCliOptions> => {
    if (values.model === null) {
      return fail(
        "--model is required (the migration target model id — the gate probes exactly what you migrate to)",
      );
    }
    if (values.model.trim() === "") {
      return fail("--model must be a non-empty model id");
    }
    return {
      ok: true,
      options: {
        model: values.model,
        baseUrl: values.baseUrl,
        confirmHighRiskUpgrade: values.confirmHighRiskUpgrade,
      },
    };
  },
};

/** 单案装载（pi-seam-matrix e2e 同款：smoke-cases.json + repoPath 相对根解析防 CWD 漂移） */
function loadGateCase(): MRCase | null {
  let raw: unknown;
  try {
    raw = JSON.parse(
      readFileSync(path.join(REPO_ROOT, "data", "vul4j", "smoke-cases.json"), "utf8"),
    ) as unknown;
  } catch {
    return null;
  }
  if (!Array.isArray(raw)) {
    return null;
  }
  const entry = raw.find(
    (candidate) =>
      typeof candidate === "object" &&
      candidate !== null &&
      (candidate as { caseId?: unknown }).caseId === GATE_CASE_ID,
  );
  if (entry === undefined) {
    return null;
  }
  const mrCase = entry as MRCase;
  return { ...mrCase, repoPath: path.join(REPO_ROOT, mrCase.repoPath) };
}

/**
 * 目标端点解析：--base-url 显式覆盖时做同款协议校验 + 尾斜杠归一
 * （reviewer-endpoint.ts baseUrlOf 语义镜像——resolver 是冻结仪器不能改，
 * 语义漂移锚点）；缺省用 REVIEWER_URL 解析产物（已归一）。
 * key 缺失由 resolveReviewerEndpoint fail fast（消息不含 key 值）。
 */
function resolveTargetEndpoint(baseUrlOverride: string | null): ReviewerEndpoint {
  const endpoint = resolveReviewerEndpoint();
  return {
    baseUrl:
      baseUrlOverride !== null ? normalizeBaseUrl(baseUrlOverride, "--base-url") : endpoint.baseUrl,
    apiKey: endpoint.apiKey,
  };
}

/** 目标网关 base URL 归一：协议校验 + 尾斜杠归一 */
function normalizeBaseUrl(value: string, source: string): string {
  if (!/^https?:\/\//.test(value)) {
    throw new Error(
      `target base URL must start with http:// or https:// (from ${source}: ${JSON.stringify(value)})`,
    );
  }
  return value.replace(/\/+$/, "");
}

/** 门 deps 装配：探针闭包 + pi 内核（key 只进闭包——门模块签名面无 key） */
function assembleGateDeps(endpoint: ReviewerEndpoint): MigrationGateDeps {
  return {
    runProbes: async (target) => {
      const probes = await runSmokeProbes({
        baseUrl: target.baseUrl,
        apiKey: endpoint.apiKey,
        modelId: target.modelId,
        fetch: globalThis.fetch,
      });
      return { ok: probes.ok, report: formatSmokeDiagnostics(probes) };
    },
    kernel: piKernel({ apiKey: endpoint.apiKey, baseUrl: endpoint.baseUrl, fetch: globalThis.fetch }),
  };
}

async function main(argv: readonly string[]): Promise<number> {
  // 进程入口显式装载 .env.local（显式环境变量优先，文件只补缺）
  const envSummary = loadEnvLocalFile(path.join(REPO_ROOT, ".env.local"));
  if (envSummary.exists) {
    console.info(`[migration-gate] .env.local: ${formatEnvLocalSummary(envSummary)}`);
  }

  const parsed = parseCliArgs(argv, MIGRATION_GATE_ARG_SPEC);
  if (!parsed.ok) {
    console.error(`${parsed.message}\n${parsed.usage}`);
    return 2;
  }

  let endpoint: ReviewerEndpoint;
  try {
    endpoint = resolveTargetEndpoint(parsed.options.baseUrl);
  } catch (error) {
    console.error(`[migration-gate] ${errorMessage(error)}`);
    return 2;
  }

  const mrCase = loadGateCase();
  if (mrCase === null) {
    console.error(
      `[migration-gate] smoke case ${GATE_CASE_ID} not found in data/vul4j/smoke-cases.json — ` +
        "the gate needs the single-case fixture for the production-entry real run",
    );
    return 2;
  }
  if (!existsSync(mrCase.repoPath)) {
    console.error(
      `[migration-gate] repository snapshot missing (${mrCase.repoPath}) — run pnpm materialize:vul4j`,
    );
    return 2;
  }

  let result: MigrationGateResult;
  try {
    result = await runMigrationGate(assembleGateDeps(endpoint), {
      baselineModelId: BASELINE_MODEL_ID,
      targetModelId: parsed.options.model,
      targetBaseUrl: endpoint.baseUrl,
      mrCase,
      experimentRoot: path.join(REPO_ROOT, "runs", GATE_EXPERIMENT_ID),
      confirmHighRiskUpgrade: parsed.options.confirmHighRiskUpgrade,
    });
  } catch (error) {
    // 门入参形状/装配错误（门内 fail fast 抛出）→ 用法级退出码；
    // 真跑失败已在门内分类（RUN_ERROR 等），不落此处
    console.error(`[migration-gate] ${errorMessage(error)}`);
    return 2;
  }

  console.log(result.report);
  return result.ok ? 0 : 1;
}

process.exit(await main(process.argv.slice(2)));
