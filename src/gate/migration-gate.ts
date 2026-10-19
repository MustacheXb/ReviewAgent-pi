import type { ConfigId } from "../instrument/contracts/config.js";
import type { MRCase } from "../instrument/contracts/mr-case.js";
import type { RunResult } from "../instrument/contracts/run.js";
import type { ExperimentSource } from "../experiment/plan.js";
import type { ReviewKernel, UnitReviewRequest } from "../experiment/review-kernel.js";

/**
 * 模型迁移门（#14，生产化四必做之三）：换模型 / 换网关前的安全自证编排器——
 * 《Config B 生产化方案》§3.3 迁移 runbook 的机器化。
 *
 * 三段串行，前步红即停并给人话诊断（归因 + 下一步动作，文案英文——对齐
 * gateway-probe.ts 诊断风格）：
 *   [1/3] 高险升级检查（纯函数，零网络）：同族 flash→pro 是消融验证项，
 *         不做默认行为（§7.7 保守路线）——未显式确认即拒，不出网；
 *   [2/3] 双探针（目标 modelId——换到什么探什么）：网关健康 + 模型可达
 *         （含静默错路由拦截）；8 类探针侧失败分类经装配层注入，门级只
 *         透传其报告文本；
 *   [3/3] 单案生产入口 config E 真跑（经注入的 ReviewKernel 执行缝）：
 *         探针全绿但全链挂（序列化不兼容 / 流中断 / 审计断言失败）给门级
 *         归因诊断——最小探针请求覆盖不到的面。
 *
 * 冒烟口径（2026-10-19 决策评论修订，B → E）：生产入口 config E 真跑
 * （依据 #11 P5b 对照报告 eb81397：E 为 pi 内核生产入口选型，B recall
 * 五配置垫底不宜作入口冒烟）。票面的 A 分层连通冒烟（最廉价连通探针）
 * 未实现：双探针已覆盖廉价连通自证（探针 2 一次最小 completion 验证
 * 鉴权 + 模型 id + 请求体 + 回显），A 单轮（~25.8k token/单元）属重复
 * 花费——保持门简洁（票面裁量项，取舍见上）。
 *
 * 模块纪律（对齐 pi-kernel.ts 头注释的闭包纪律）：纯依赖注入、零 pi
 * import——探针函数与单案执行（ReviewKernel 缝）全部注入，装配只在
 * scripts/run-migration-gate.ts 与本模块测试；网关 key 只存在于装配闭包，
 * 门模块签名面无 key 字段（哨兵测试断言门结果/诊断文本零 key）。
 */

/** 单案真跑的生产入口配置（2026-10-19 决策评论：B → E） */
export const MIGRATION_GATE_CONFIG_ID: ConfigId = "E";

/** 模型档位词表（高险升级判定只认 flash / pro 两档，其余档位不参与该判定） */
export type ModelTier = "flash" | "pro";

export interface ModelUpgradeClassification {
  /** 同族 flash→pro 升级（消融验证项，不默认启用） */
  readonly highRiskUpgrade: boolean;
  readonly baselineFamily: string;
  readonly targetFamily: string;
  readonly baselineTier: ModelTier | null;
  readonly targetTier: ModelTier | null;
}

/**
 * flash→pro 同族升级判定（纯函数，单测锁定口径）：
 * - 家族按 id 前缀判定（首个 "-" 前的段，小写归一）——CONTEXT.md 异构条目
 *   「家族按 id 前缀判定」同款思路；review-llm providerFamilyOf 的
 *   /^deepseek-/、/^glm-/ 前缀 pattern 是同一口径的已知家族子集；
 * - 档位按 "-" 分段后的精确段匹配（"pro" 段在场即 pro 档，pro 先查——
 *   双档位标记同在场时保守判 pro；版本化 GA 快照如 deepseek-v4-pro-ga-*
 *   同判 pro）。已知局限：黏连段（deepseek-v4-professional）不判 pro——
 *   漏判方向是走正常迁移门，仍受探针 + 单案真跑全链自证兜底；
 * - 高险 = 同族 && 基线 flash 档 && 目标 pro 档。基线非 flash 的换代、
 *   跨家族换 pro、pro→flash 降级均不属本条消融验证项，正常过门不拦。
 */
export function classifyModelUpgrade(
  baselineModelId: string,
  targetModelId: string,
): ModelUpgradeClassification {
  const baselineFamily = familyOf(baselineModelId);
  const targetFamily = familyOf(targetModelId);
  const baselineTier = tierOf(baselineModelId);
  const targetTier = tierOf(targetModelId);
  return {
    highRiskUpgrade:
      baselineFamily === targetFamily && baselineTier === "flash" && targetTier === "pro",
    baselineFamily,
    targetFamily,
    baselineTier,
    targetTier,
  };
}

/** 家族 = 首 "-" 前的 id 前缀（小写归一；空 id 由入参校验前置拦截） */
function familyOf(modelId: string): string {
  return (modelId.split("-")[0] ?? modelId).toLowerCase();
}

/** 档位 = 分段精确匹配（pro 先查保守判；无档位标记 → null） */
function tierOf(modelId: string): ModelTier | null {
  const segments = modelId.toLowerCase().split("-");
  if (segments.includes("pro")) {
    return "pro";
  }
  if (segments.includes("flash")) {
    return "flash";
  }
  return null;
}

/** 门级失败分类（探针侧 8 类在透传报告内，不在此重复枚举） */
export type MigrationGateFailureKind =
  /** 同族 flash→pro 未显式确认（消融验证项，不默认启用） */
  | "HIGH_RISK_UPGRADE_UNCONFIRMED"
  /** 双探针红（细分分类在探针报告文本内透传） */
  | "PROBES_FAILED"
  /** 单案真跑抛错（序列化不兼容 / 流中断 / 审计断言失败等全链失败） */
  | "RUN_ERROR"
  /** 真跑完成但模型 id 与目标不符（错路由 / 执行路径残 id——口径诚实护栏同款语义） */
  | "MODEL_DRIFT"
  /** 真跑完成但 usage 全零（无真实补全——静默空流） */
  | "EMPTY_USAGE";

/** 探针目标（换到什么探什么：目标网关 + 目标模型 id） */
export interface ProbeTarget {
  readonly baseUrl: string;
  readonly modelId: string;
}

/** 探针注入缝的返回面：绿红判定 + 多行人话报告（装配层产，门级透传） */
export interface SmokeProbeOutcome {
  readonly ok: boolean;
  readonly report: string;
}

export interface MigrationGateDeps {
  /** 双探针（装配闭包捕获网关 key——review-pi runSmokeProbes + formatSmokeDiagnostics） */
  readonly runProbes: (target: ProbeTarget) => Promise<SmokeProbeOutcome>;
  /** 单案执行内核（#8 执行缝；真跑 = piKernel 装配，测试 = fake 内核） */
  readonly kernel: ReviewKernel;
}

export interface MigrationGateInput {
  /** 基线模型 id（生产装配 = review-pi REVIEW_MODEL_ID 钉住的 flash 档，见脚本镜像注释） */
  readonly baselineModelId: string;
  /** 迁移目标模型 id（换到什么探什么） */
  readonly targetModelId: string;
  /** 迁移目标网关 base URL（OpenAI 兼容路径约定：自带 /v1 前缀） */
  readonly targetBaseUrl: string;
  /** 单案真跑输入（生产装配 = data/vul4j smoke 单案，经 ReviewKernel 缝） */
  readonly mrCase: MRCase;
  /** 审计落盘锚（runs/<experimentId>；内核审计照常落盘、留痕可查） */
  readonly experimentRoot: string;
  /** 高险升级显式确认旗标（CLI --confirm-high-risk-upgrade；缺省 false = 拒） */
  readonly confirmHighRiskUpgrade: boolean;
}

export interface MigrationGateResult {
  readonly ok: boolean;
  /** 同族 flash→pro 升级标记（放行/拒绝均携带——报告与上层消费） */
  readonly highRiskUpgrade: boolean;
  readonly failureKind?: MigrationGateFailureKind;
  /** 多行人话报告（stdout 直接打印；密钥哨兵——绝不包含网关 key） */
  readonly report: string;
}

/**
 * 跑迁移门：高险检查 → 双探针（目标）→ 单案生产入口真跑，串行前步红即停。
 * 输入形状错误（装配面问题）抛 Error——由装配层转用法级退出码，不混入门判定。
 */
export async function runMigrationGate(
  deps: MigrationGateDeps,
  input: MigrationGateInput,
): Promise<MigrationGateResult> {
  validateMigrationGateInput(input);
  const classification = classifyModelUpgrade(input.baselineModelId, input.targetModelId);

  if (classification.highRiskUpgrade && !input.confirmHighRiskUpgrade) {
    return gateFailure(classification, input, "HIGH_RISK_UPGRADE_UNCONFIRMED", [
      highRiskStageLine(classification, input),
      highRiskDiagnostic(input),
      "[2/3] smoke probes (target model): SKIPPED (high-risk upgrade not confirmed)",
      "[3/3] single-case production run: SKIPPED (high-risk upgrade not confirmed)",
    ]);
  }

  const probeOutcome = await deps.runProbes({
    baseUrl: input.targetBaseUrl,
    modelId: input.targetModelId,
  });
  if (!probeOutcome.ok) {
    return gateFailure(classification, input, "PROBES_FAILED", [
      highRiskStageLine(classification, input),
      `[2/3] smoke probes (target model "${input.targetModelId}"): FAILED`,
      ...indent(probeOutcome.report),
      probesBlockedDiagnostic(),
      "[3/3] single-case production run: SKIPPED (smoke probes failed)",
    ]);
  }

  const runStage = await runSingleCaseStage(deps.kernel, input);
  if (!runStage.ok) {
    return gateFailure(classification, input, runStage.failureKind, [
      highRiskStageLine(classification, input),
      ...probeGreenLines(probeOutcome, input.targetModelId),
      `[3/3] single-case production run (config ${MIGRATION_GATE_CONFIG_ID}, ${input.mrCase.caseId}): FAILED (${runStage.failureKind})`,
      ...indent(runStage.diagnostic),
      ...(runStage.detail !== undefined ? indent(runStage.detail) : []),
    ]);
  }

  return passResult(classification, input, probeOutcome, runStage.result);
}

/** 探针绿后的共用段行（探针 OK 行 + 报告缩进——失败与放行报告同形） */
function probeGreenLines(probeOutcome: SmokeProbeOutcome, targetModelId: string): readonly string[] {
  return [
    `[2/3] smoke probes (target model "${targetModelId}"): OK`,
    ...indent(probeOutcome.report),
  ];
}

/** 全绿放行结果（报告 = 完整头行 + 三段行 + 收尾判定） */
function passResult(
  classification: ModelUpgradeClassification,
  input: MigrationGateInput,
  probeOutcome: SmokeProbeOutcome,
  result: RunResult,
): MigrationGateResult {
  return {
    ok: true,
    highRiskUpgrade: classification.highRiskUpgrade,
    report: [
      gateHeader(input, "PASS"),
      highRiskStageLine(classification, input),
      ...probeGreenLines(probeOutcome, input.targetModelId),
      runSummaryLine(result, input),
      "gate verdict: PASS — the target is cleared for migration.",
    ].join("\n"),
  };
}

/** 单案真跑段（探针绿后）：执行 + 完成性校验（模型回显 / usage 真实性） */
type RunStageOutcome =
  | { readonly ok: true; readonly result: RunResult }
  | {
      readonly ok: false;
      readonly failureKind: Extract<MigrationGateFailureKind, "RUN_ERROR" | "MODEL_DRIFT" | "EMPTY_USAGE">;
      readonly diagnostic: string;
      readonly detail?: string;
    };

async function runSingleCaseStage(
  kernel: ReviewKernel,
  input: MigrationGateInput,
): Promise<RunStageOutcome> {
  let result: RunResult;
  try {
    result = await kernel.execute(singleCaseRequest(input));
  } catch (error) {
    return {
      ok: false,
      failureKind: "RUN_ERROR",
      diagnostic: runErrorDiagnostic(),
      detail: `kernel error: ${excerpt(error instanceof Error ? error.message : String(error))}`,
    };
  }
  if (result.model !== input.targetModelId) {
    return {
      ok: false,
      failureKind: "MODEL_DRIFT",
      diagnostic: modelDriftDiagnostic(result.model, input.targetModelId),
    };
  }
  if (result.usage.inputTokens <= 0 || result.usage.outputTokens <= 0) {
    return {
      ok: false,
      failureKind: "EMPTY_USAGE",
      diagnostic: emptyUsageDiagnostic(result.usage.inputTokens, result.usage.outputTokens),
    };
  }
  return { ok: true, result };
}

/** 单案请求（#8 执行缝契约）：生产入口 config E、rep 1、目标模型 id */
function singleCaseRequest(input: MigrationGateInput): UnitReviewRequest {
  return {
    unit: {
      // source 词表合法性由数据装载层契约保证；非 vul4j 单元由 pi 内核守卫拒绝
      source: input.mrCase.labels.source as ExperimentSource,
      caseId: input.mrCase.caseId,
      configId: MIGRATION_GATE_CONFIG_ID,
      rep: 1,
    },
    mrCase: input.mrCase,
    model: input.targetModelId,
    experimentRoot: input.experimentRoot,
  };
}

/** 门级失败结果（报告 = 完整头行 + 各段行 + 收尾判定；failureKind 可选键条件展开） */
function gateFailure(
  classification: ModelUpgradeClassification,
  input: MigrationGateInput,
  failureKind: MigrationGateFailureKind,
  lines: readonly string[],
): MigrationGateResult {
  return {
    ok: false,
    highRiskUpgrade: classification.highRiskUpgrade,
    failureKind,
    report: [
      gateHeader(input, `FAILED (${failureKind})`),
      ...lines,
      "gate verdict: FAILED — migration blocked; fix the stage findings above and re-run the gate.",
    ].join("\n"),
  };
}

// ===== 报告文案（英文，对齐 gateway-probe.ts 的 diagnostic 风格）=====

function gateHeader(input: MigrationGateInput, statusText: string): string {
  return (
    `migration gate: baseline "${input.baselineModelId}" -> target "${input.targetModelId}" ` +
    `at ${input.targetBaseUrl}: ${statusText}`
  );
}

function highRiskStageLine(
  classification: ModelUpgradeClassification,
  input: MigrationGateInput,
): string {
  if (classification.highRiskUpgrade) {
    return input.confirmHighRiskUpgrade
      ? `[1/3] high-risk upgrade check: CONFIRMED — flash->pro upgrade within the ${classification.baselineFamily} ` +
          "family, explicitly acknowledged via --confirm-high-risk-upgrade; this remains an ablation-verification " +
          "item, not a default production behavior (conservative route, section 7.7)"
      : `[1/3] high-risk upgrade check: REJECTED — flash->pro upgrade within the ${classification.baselineFamily} ` +
          `family (${tierText(classification.baselineTier)} tier -> ${tierText(classification.targetTier)} tier)`;
  }
  if (input.baselineModelId === input.targetModelId) {
    return "[1/3] high-risk upgrade check: OK — target model unchanged (gateway-only migration); " +
      "the flash->pro guard does not apply";
  }
  if (classification.baselineFamily === classification.targetFamily) {
    return `[1/3] high-risk upgrade check: OK — same-family move (${classification.baselineFamily}: ` +
      `${tierText(classification.baselineTier)} -> ${tierText(classification.targetTier)}); not a flash->pro upgrade`;
  }
  return `[1/3] high-risk upgrade check: OK — cross-family move (${classification.baselineFamily} -> ` +
    `${classification.targetFamily}); the flash->pro guard applies only within one family`;
}

function tierText(tier: ModelTier | null): string {
  return tier ?? "unknown tier";
}

function highRiskDiagnostic(input: MigrationGateInput): string {
  return (
    `high-risk upgrade "${input.baselineModelId}" -> "${input.targetModelId}": this is an ablation-verification ` +
    "item, not a default production behavior (conservative route, section 7.7) — the migration gate does not " +
    "enable it by default. If this migration is intentional, re-run with --confirm-high-risk-upgrade and pair " +
    "the rollout with the high-risk-subset ablation protocol."
  );
}

function probesBlockedDiagnostic(): string {
  return (
    "the smoke probes must be green before the single-case production run spends budget — the gate stopped here. " +
    "The failure classification above comes from the probe side (gateway unreachable / auth rejected / model id " +
    "not found / request body rejected / silent misrouting); fix the findings, then re-run the gate."
  );
}

function runErrorDiagnostic(): string {
  return (
    "the single-case production run failed although the smoke probes were green: the minimal probe request " +
    "works, but the full pipeline (wire serialization with tools, streaming, tool loop, audit) does not work " +
    "for the target model at this endpoint. Likely attributions: the target model rejects the full request " +
    "body the kernel serializes (thinking fields / tool schemas), the gateway interrupted the streamed " +
    "response mid-run, or an audit/invariant assertion failed inside the kernel. Next step: inspect the " +
    "kernel error below and the audit trail under the experiment root, and compare the target model's " +
    "tool-calling and streaming support against the baseline model."
  );
}

function modelDriftDiagnostic(actualModel: string | undefined, targetModelId: string): string {
  const actualText = actualModel === undefined ? "(missing model field)" : `"${actualModel}"`;
  return (
    `the single-case run completed but reports model ${actualText} while the gate targets "${targetModelId}": ` +
    "a stale or mismatched model id traveled through the execution path (this check compares the request id " +
    "the kernel reports against the gate target, mirroring the honesty guard in real experiments — silent " +
    "gateway misrouting to a different model is caught by the probe's response echo, not here). " +
    "Fix the model id route before migrating."
  );
}

function emptyUsageDiagnostic(inputTokens: number, outputTokens: number): string {
  return (
    `the single-case run completed but reported zero usage (input ${inputTokens} / output ${outputTokens}): ` +
    "no real completion happened — the gateway likely returned an empty or malformed stream that the kernel " +
    "tolerated. The minimal probe cannot catch this (it does not open a stream). Check the gateway's SSE " +
    "streaming support (stream_options include_usage) for the target model and re-run the gate."
  );
}

function runSummaryLine(result: RunResult, input: MigrationGateInput): string {
  return (
    `[3/3] single-case production run (config ${MIGRATION_GATE_CONFIG_ID}, ${input.mrCase.caseId}): OK — ` +
    `rounds ${result.rounds}, toolCalls ${result.toolCalls}, findings ${result.findings.length}, ` +
    `usage input ${result.usage.inputTokens} / output ${result.usage.outputTokens} / ` +
    `cacheRead ${result.usage.cacheReadTokens ?? 0}; model echo ${result.model}`
  );
}

// ===== 小工具 =====

/** 多行诊断缩进（报告分段嵌套呈现） */
function indent(text: string): readonly string[] {
  return text.split("\n").map((line) => `      ${line}`);
}

/** 错误/诊断摘录（压空白 + 截断，防长堆栈刷屏） */
function excerpt(text: string, maxLength = 400): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length <= maxLength ? collapsed : `${collapsed.slice(0, maxLength)}…`;
}

/** 入参形状校验（装配面错误 fail fast；抛 Error 由装配层转用法级退出码） */
function validateMigrationGateInput(input: MigrationGateInput): void {
  requireNonEmpty(input.baselineModelId, "baselineModelId");
  requireNonEmpty(input.targetModelId, "targetModelId");
  requireNonEmpty(input.targetBaseUrl, "targetBaseUrl");
  requireNonEmpty(input.experimentRoot, "experimentRoot");
  requireNonEmpty(input.mrCase.caseId, "mrCase.caseId");
  requireNonEmpty(input.mrCase.repoPath, "mrCase.repoPath");
}

function requireNonEmpty(value: string, field: string): void {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`migration gate input: ${field} must be a non-empty string`);
  }
}
