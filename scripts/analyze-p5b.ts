/**
 * P5b 对照报告复算脚本（issue #11）。
 *
 * 用途：从 runs/ 留痕与 gate JSON 锚点重放 docs/report/《Phase 2 pi 内核全量对照报告》
 * 全部数字表，保证「无手抽数字」（复算范式对齐兄弟仓 analyze-phase2.ts）。纯离线
 * 读取聚合，零网关消耗，零新指标定义；可测计算在 src/experiment/p5b-compare.ts（单测覆盖）。
 *
 * 四侧：phase2-pi（pi 内核被测，本仓 #17）+ phase2-main（DSH 线主数据基线，POC1 内核）+
 * phase2-noise（POC1 重跑噪声底）+ phase2-dsh（DSH 内核附录侧参照）。
 * 「DSH 侧」限定语纪律：phase2-main/noise 内核为 POC1（原薄 harness），DSH 内核数据在
 * phase2-dsh——引用必须分层表述，不得笼统称「DSH 内核」。
 *
 * 运行：
 *   pnpm analyze:p5b
 * 输出：markdown 表格（stdout），与报告表格逐项对应。
 * 退出码：0 成功；2 加载错误。
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ConfigId } from "../src/instrument/contracts/config.js";
import type { MetricsReport, VerdictReports } from "../src/metrics/types.js";
import type { AlignmentGateReport } from "../src/metrics/alignment-gate.js";
import type { ExperimentReport, JudgeStageReport } from "../src/experiment/report.js";
import {
  crossSideRange,
  judgeNineDims,
  NINE_DIMS,
  P5B_CONFIG_IDS,
  repSigma,
  SIGMA_METRICS,
  zeroFindingRate,
} from "../src/experiment/p5b-compare.js";

/** 四侧实验目录（pi 被测 / 基线 / 噪声底 / DSH 内核参照） */
const SIDES = ["phase2-pi", "phase2-main", "phase2-noise", "phase2-dsh"] as const;
type Side = (typeof SIDES)[number];
const SIDE_LABEL: Record<Side, string> = {
  "phase2-pi": "pi",
  "phase2-main": "main",
  "phase2-noise": "noise",
  "phase2-dsh": "dsh",
};

/** 对齐门 JSON 锚点（pnpm alignment-gate -- --baseline runs/phase2-main --candidate runs/phase2-pi --noise runs/phase2-noise --out ...） */
const GATE_JSON = ".cache/gate-phase2-pi.json";

/** judge completion 信封上界（#39：glm 系推理模型 32768/调用；调用 usage 不落盘） */
const JUDGE_ENVELOPE_TOKENS = 32768;

type JudgePerConfig = JudgeStageReport["perConfig"][number];

// ── 基础工具（移植自 analyze-phase2.ts，同款）──────────────────────────
function fmt(value: number | null | undefined, digits = 4): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return String(Number(value.toFixed(digits)));
}
function fmtTokens(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  if (Math.abs(value) >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (Math.abs(value) >= 1e3) return `${(value / 1e3).toFixed(1)}k`;
  return String(Math.round(value));
}
function statOf(entries: readonly JudgePerConfig[], configId: ConfigId): JudgePerConfig | undefined {
  return entries.find((entry) => entry.configId === configId);
}

async function readJson(path: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (error) {
    throw new Error(`cannot read ${path}: ${(error as Error).message}`);
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`cannot parse ${path}: ${(error as Error).message}`);
  }
}
async function readReport(side: Side): Promise<ExperimentReport> {
  return (await readJson(join("runs", side, "report.json"))) as ExperimentReport;
}
/** 判定面就绪性：verdicts/judge 阶段缺失即失败（报告要求四侧全量可复算，不静默降级） */
function stageOf(report: ExperimentReport, side: Side): { verdicts: VerdictReports; judge: JudgeStageReport } {
  if (report.verdicts === null) throw new Error(`report of ${side} missing verdicts stage`);
  if (report.judge === null) throw new Error(`report of ${side} missing judge stage`);
  return { verdicts: report.verdicts, judge: report.judge };
}

// ── 执行 record 收集（预算/时点面数据源；缺失即报错——报告要求 450/450 可复算）──
interface ExecRecord {
  readonly completedAt: string;
  readonly inputTokens: number;
  readonly cacheReadTokens: number;
  readonly outputTokens: number;
}
async function collectExecRecords(experimentId: Side): Promise<ReadonlyArray<ExecRecord>> {
  const records: ExecRecord[] = [];
  const casesRoot = join("runs", experimentId, "runs", "vul4j");
  let caseDirs: string[];
  try {
    caseDirs = await readdir(casesRoot);
  } catch {
    throw new Error(`cannot list ${casesRoot}`);
  }
  for (const caseId of caseDirs) {
    for (const configId of P5B_CONFIG_IDS) {
      for (const rep of [1, 2, 3]) {
        const path = join(casesRoot, caseId, configId, `rep-${rep}.json`);
        let parsed: {
          readonly completedAt?: string;
          readonly baseline?: { readonly usage?: { readonly inputTokens?: number; readonly cacheReadTokens?: number; readonly outputTokens?: number } };
        };
        try {
          parsed = (await readJson(path)) as typeof parsed;
        } catch {
          throw new Error(`missing unit record ${path} (report requires 450/450 records)`);
        }
        const usage = parsed.baseline?.usage;
        if (parsed.completedAt === undefined || usage === undefined) {
          throw new Error(`malformed unit record ${path}`);
        }
        records.push({
          completedAt: parsed.completedAt,
          inputTokens: usage.inputTokens ?? 0,
          cacheReadTokens: usage.cacheReadTokens ?? 0,
          outputTokens: usage.outputTokens ?? 0,
        });
      }
    }
  }
  return records;
}

// ── 面 ────────────────────────────────────────────────────────────────
function faceVerdicts(verdictsBySide: ReadonlyMap<Side, VerdictReports>): string[] {
  const out: string[] = [];
  const emit = (line = "") => out.push(line);
  emit("## T1 判级分布（S/A/B，锚 = C rep2+ 热口径；四侧并列）");
  emit();
  emit(`| config | ${SIDES.map((s) => SIDE_LABEL[s]).join(" | ")} |`);
  emit(`|---|${SIDES.map(() => "---").join("|")}|`);
  for (const configId of P5B_CONFIG_IDS) {
    emit(`| ${configId} | ${SIDES.map((side) => verdictsBySide.get(side)?.verdicts.find((v) => v.configId === configId)?.outcome ?? "—").join(" | ")} |`);
  }
  const piVerdicts = verdictsBySide.get("phase2-pi");
  const outcomesOf = (map: VerdictReports | undefined): string =>
    JSON.stringify(P5B_CONFIG_IDS.map((c) => map?.verdicts.find((v) => v.configId === c)?.outcome));
  emit();
  emit(`锚可用性：pi anchor=${piVerdicts?.anchorConfigId ?? "—"} available=${piVerdicts?.anchorAvailable ?? "—"}；四侧 outcome 逐字一致 = ${[...verdictsBySide.values()].every((m) => outcomesOf(m) === outcomesOf(piVerdicts))}`);
  emit();
  return out;
}

function faceCriteria(piVerdicts: VerdictReports): string[] {
  const bVerdict = piVerdicts.verdicts.find((v) => v.configId === "B");
  if (bVerdict === undefined) return [];
  const out: string[] = [];
  const emit = (line = "") => out.push(line);
  emit("### T1b pi 侧 B 配置判据明细（S 级四判据 + 全档位）");
  emit();
  emit("| grade | metric | value | threshold | pass |");
  emit("|---|---|---|---|---|");
  for (const c of bVerdict.criteria) {
    const isToken = c.metric === "TOTAL_TOKENS";
    emit(`| ${c.grade} | ${c.metric} | ${isToken ? fmtTokens(c.value) : fmt(c.value)} | ${c.threshold === null ? "—" : isToken ? fmtTokens(c.threshold) : fmt(c.threshold)} | ${c.pass ? "✅" : "❌"} |`);
  }
  emit();
  return out;
}

function faceNineDims(judges: ReadonlyMap<Side, JudgeStageReport>): string[] {
  const out: string[] = [];
  const emit = (line = "") => out.push(line);
  emit("## T2 九维度主表（judge 口径每配置 90 单元均值；行 = config × 侧）");
  emit();
  emit(`| config | side | ${NINE_DIMS.join(" | ")} |`);
  emit(`|---|---|${NINE_DIMS.map(() => "---").join("|")}|`);
  for (const configId of P5B_CONFIG_IDS) {
    for (const side of SIDES) {
      const entry = statOf(judges.get(side)?.perConfig ?? [], configId);
      if (entry === undefined) continue;
      const dims = judgeNineDims(entry);
      const cells = NINE_DIMS.map((dim) =>
        dim === "totalTokens" || dim === "carc" ? fmtTokens(dims[dim]) : fmt(dims[dim], dim === "toolCalls" ? 1 : dim === "rounds" ? 2 : 4),
      );
      emit(`| ${configId} | ${SIDE_LABEL[side]} | ${cells.join(" | ")} |`);
    }
  }
  emit();
  return out;
}

function faceAnchor(verdictsBySide: ReadonlyMap<Side, VerdictReports>): string[] {
  const out: string[] = [];
  const emit = (line = "") => out.push(line);
  emit("## T3 锚面（C 锚 rep2+ 热口径 rule；判级的参照原点）");
  emit();
  emit(`| 侧 | anchor available | recall | precision | totalTokens | cacheHitRate |`);
  emit(`|---|---|---|---|---|---|`);
  for (const side of SIDES) {
    const report = verdictsBySide.get(side);
    // anchor 恒为 C rep2+ 热口径指标，同一 report 内各 verdict 共享——取任意行
    const anchor = report?.verdicts[0]?.anchor;
    if (report === undefined || anchor === undefined) continue;
    emit(`| ${SIDE_LABEL[side]} | ${report.anchorAvailable} | ${fmt(anchor.recall)} | ${fmt(anchor.precision)} | ${fmtTokens(anchor.totalTokens)} | ${fmt(anchor.cacheHitRate)} |`);
  }
  emit();
  return out;
}

function faceSigma(judges: ReadonlyMap<Side, JudgeStageReport>): string[] {
  const out: string[] = [];
  const emit = (line = "") => out.push(line);
  emit("## T4 跨 rep σ（#36 误差棒口径：按 (case,config) 分组 3-rep 样本 σ、null 剔除、≥2 有效 rep、对 30 案取均值；rule 口径）");
  emit();
  emit("| config/metric | pi | main |");
  emit("|---|---|---|");
  const sigmaBySide = new Map<Side, Map<string, number>>();
  for (const side of ["phase2-pi", "phase2-main"] as const) {
    sigmaBySide.set(side, repSigma(judges.get(side)?.results ?? []));
  }
  for (const configId of P5B_CONFIG_IDS) {
    for (const metric of SIGMA_METRICS) {
      const key = `${configId}/${metric}`;
      const pi = sigmaBySide.get("phase2-pi")?.get(key) ?? Number.NaN;
      const main = sigmaBySide.get("phase2-main")?.get(key) ?? Number.NaN;
      const isToken = metric === "totalTokens";
      emit(`| ${key} | ${isToken ? fmtTokens(pi) : fmt(pi)} | ${isToken ? fmtTokens(main) : fmt(main)} |`);
    }
  }
  emit();
  return out;
}

function faceRange(judges: ReadonlyMap<Side, JudgeStageReport>): string[] {
  const out: string[] = [];
  const emit = (line = "") => out.push(line);
  emit("## T5 跨侧极差（四侧 max−min；任一侧缺失 → —；与 T4 跨 rep σ 分开引用）");
  emit();
  emit(`| config | ${NINE_DIMS.join(" | ")} |`);
  emit(`|---|${NINE_DIMS.map(() => "---").join("|")}|`);
  for (const configId of P5B_CONFIG_IDS) {
    // 九维提取复用 judgeNineDims（与 T2 主表同一封装，避免内联重写漂移）
    const dimsBySide = SIDES.map((side) => {
      const entry = statOf(judges.get(side)?.perConfig ?? [], configId);
      return entry === undefined ? null : judgeNineDims(entry);
    });
    const cells: string[] = [];
    for (const dim of NINE_DIMS) {
      const range = crossSideRange(dimsBySide.map((dims) => (dims === null ? null : dims[dim])));
      cells.push(dim === "totalTokens" || dim === "carc" ? fmtTokens(range) : fmt(range));
    }
    emit(`| ${configId} | ${cells.join(" | ")} |`);
  }
  emit();
  return out;
}

/** 冷热分层数值提取（rule 口径；rep1 冷单列 / rep2+ 热主口径，MetricsReport 分层聚合） */
function coldHot(metrics: MetricsReport | null | undefined, configId: ConfigId, field: "cacheHitRate" | "totalTokens"): { cold: number | null; hot: number | null } {
  const summary = metrics?.perConfig[configId];
  const read = (stat: { values: Record<string, { mean: number } | null> } | null | undefined): number | null => {
    const v = stat?.values[field];
    return v === null || v === undefined ? null : v.mean;
  };
  return { cold: read(summary?.cold), hot: read(summary?.hot) };
}

function faceColdHot(metricsBySide: ReadonlyMap<Side, MetricsReport | null>): string[] {
  const out: string[] = [];
  const emit = (line = "") => out.push(line);
  emit("## T5b 冷热分层（rule 口径；rep1 冷单列 vs rep2+ 热主口径——判级锚取热口径，缓存/token 结构看冷热差）");
  emit();
  emit("| config | side | 冷 cacheHit | 热 cacheHit | 冷 tokens | 热 tokens |");
  emit("|---|---|---|---|---|---|");
  for (const configId of P5B_CONFIG_IDS) {
    for (const side of SIDES) {
      const cache = coldHot(metricsBySide.get(side), configId, "cacheHitRate");
      const tokens = coldHot(metricsBySide.get(side), configId, "totalTokens");
      emit(`| ${configId} | ${SIDE_LABEL[side]} | ${fmt(cache.cold)} | ${fmt(cache.hot)} | ${fmtTokens(tokens.cold)} | ${fmtTokens(tokens.hot)} |`);
    }
  }
  emit();
  return out;
}

function faceBudget(execBySide: ReadonlyMap<Side, ReadonlyArray<ExecRecord>>, judges: ReadonlyMap<Side, JudgeStageReport>): string[] {
  const out: string[] = [];
  const emit = (line = "") => out.push(line);
  emit("## T6 预算总账（四侧；billed = input+output，withCache = +cacheReadTokens；cacheRead 单列）");
  emit();
  emit("| 侧 | billed | withCache | cacheRead（单列） | judge 信封上界 |");
  emit("|---|---|---|---|---|");
  for (const side of SIDES) {
    const records = execBySide.get(side) ?? [];
    const input = records.reduce((a, r) => a + r.inputTokens, 0);
    const cache = records.reduce((a, r) => a + r.cacheReadTokens, 0);
    const output = records.reduce((a, r) => a + r.outputTokens, 0);
    const judgeEnvelope = (judges.get(side)?.judgedCount ?? 0) * JUDGE_ENVELOPE_TOKENS;
    emit(`| ${SIDE_LABEL[side]} | ${fmtTokens(input + output)} | ${fmtTokens(input + cache + output)} | ${fmtTokens(cache)} | ${fmtTokens(judgeEnvelope)} |`);
  }
  emit();
  return out;
}

function faceChain(judges: ReadonlyMap<Side, JudgeStageReport>): string[] {
  const out: string[] = [];
  const emit = (line = "") => out.push(line);
  emit("## T7 判定形态（judge 链四侧）");
  emit();
  emit("| 侧 | runCount | judged | skipped-no-findings | error | 零 finding 率 |");
  emit("|---|---|---|---|---|---|");
  for (const side of SIDES) {
    const judge = judges.get(side);
    if (judge === undefined) continue;
    const zf = zeroFindingRate(judge);
    emit(`| ${SIDE_LABEL[side]} | ${judge.runCount} | ${judge.judgedCount} | ${judge.skippedNoFindingsCount} | ${judge.errorCount} | ${fmt(zf.rate)} |`);
  }
  emit();
  return out;
}

function faceTemporal(execBySide: ReadonlyMap<Side, ReadonlyArray<ExecRecord>>): string[] {
  const out: string[] = [];
  const emit = (line = "") => out.push(line);
  emit("## T8 执行窗（各侧首末 record）");
  emit();
  emit("| 侧 | 首 | 末 |");
  emit("|---|---|---|");
  for (const side of SIDES) {
    const records = execBySide.get(side) ?? [];
    const times = records.map((r) => r.completedAt).sort();
    emit(`| ${SIDE_LABEL[side]} | ${times[0] ?? "—"} | ${times[times.length - 1] ?? "—"} |`);
  }
  emit();
  return out;
}

function faceGate(gate: AlignmentGateReport): string[] {
  const out: string[] = [];
  const emit = (line = "") => out.push(line);
  emit("## T9 对齐门（ADR-0007 第三轮应用；gate JSON 锚点复放）");
  emit();
  emit(`判定：**${gate.verdict}** —— ${gate.basis}`);
  emit();
  emit("### 格判定（修订 = 对称 max σ 带；遗留 = #29 单侧带）");
  emit();
  emit("| config/metric | 修订 | 遗留 |");
  emit("|---|---|---|");
  for (const cell of gate.cells) {
    emit(`| ${cell.configId}/${cell.metric} | ${cell.status} | ${cell.legacyStatus} |`);
  }
  emit();
  emit("### 配对符号检验（噪声对照在场时为主判据）");
  emit();
  emit("| metric | pairs | worse/better/ties | p(更差方向) | 判定 |");
  emit("|---|---|---|---|---|");
  for (const p of gate.paired) {
    const pText = p.worseDirectionP === null ? "—" : p.worseDirectionP < 1e-4 ? "<0.0001" : fmt(p.worseDirectionP);
    emit(`| ${p.metric} | ${p.pairCount} | ${p.candidateWorse}/${p.candidateBetter}/${p.ties} | ${pText} | ${p.verdict} |`);
  }
  emit();
  const t = gate.temporal;
  if (t !== null) {
    emit(`时点配对：candidate-baseline ${fmt(t.candidateGapHours, 1)}h / noise-baseline ${fmt(t.noiseGapHours, 1)}h（阈值 48h${t.exceedsThreshold ? "，超阈预警" : ""}）`);
    emit();
  }
  if (gate.advisories.length > 0) {
    emit("advisories：");
    for (const a of gate.advisories) emit(`- ${a}`);
    emit();
  }
  return out;
}

// ── 主流程 ────────────────────────────────────────────────────────────
async function main(): Promise<number> {
  const out: string[] = [];
  const emit = (line = "") => out.push(line);
  emit("# P5b 对照复算（pi↔DSH；四侧 = pi 被测 / main 基线 / noise 噪声底 / dsh 内核参照）");
  emit();
  emit(`数据源：runs/{${SIDES.join(",")}}/report.json + 450×4 执行 record + ${GATE_JSON}；重放命令 pnpm analyze:p5b（无手抽数字）。`);
  emit();

  const verdictsBySide = new Map<Side, VerdictReports>();
  const judges = new Map<Side, JudgeStageReport>();
  const metricsBySide = new Map<Side, MetricsReport | null>();
  for (const side of SIDES) {
    const report = await readReport(side);
    const { verdicts, judge } = stageOf(report, side);
    verdictsBySide.set(side, verdicts);
    judges.set(side, judge);
    metricsBySide.set(side, report.metrics);
  }
  const execBySide = new Map<Side, ReadonlyArray<ExecRecord>>();
  for (const side of SIDES) {
    execBySide.set(side, await collectExecRecords(side));
  }
  let gate: AlignmentGateReport;
  try {
    gate = (await readJson(GATE_JSON)) as AlignmentGateReport;
  } catch (error) {
    throw new Error(`cannot load gate JSON (${GATE_JSON}): ${(error as Error).message}——先跑 pnpm alignment-gate -- --baseline runs/phase2-main --candidate runs/phase2-pi --noise runs/phase2-noise --out ${GATE_JSON}`);
  }

  const piVerdicts = verdictsBySide.get("phase2-pi");
  if (piVerdicts === undefined) throw new Error("phase2-pi verdicts missing");
  out.push(...faceVerdicts(verdictsBySide));
  out.push(...faceCriteria(piVerdicts));
  out.push(...faceNineDims(judges));
  out.push(...faceAnchor(verdictsBySide));
  out.push(...faceSigma(judges));
  out.push(...faceRange(judges));
  out.push(...faceColdHot(metricsBySide));
  out.push(...faceBudget(execBySide, judges));
  out.push(...faceChain(judges));
  out.push(...faceTemporal(execBySide));
  out.push(...faceGate(gate));

  for (const line of out) console.log(line);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(String((error as Error)?.message ?? error));
    process.exit(2);
  });
