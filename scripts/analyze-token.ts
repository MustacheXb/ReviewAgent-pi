/**
 * Token 分析单命令（#51 / ADR-0018）：薄壳入口，只做 I/O 装配。
 *
 * 三种输入形态（互斥）：
 *   --record <file>                              单条 RunRecord JSON
 *   --experiment <dir>                           实验目录（读取 <dir>/runs/<source>/<case>/<config>/rep-<n>.json）
 *   --runs-root <dir> --experiment-id <id>       runs 根目录 + experimentId
 *
 * 输出（--out，缺省当前目录）：token-analysis.json / token-analysis.md。
 * 纯分析逻辑在 src/eval/analysis（零 fs / 零网络 / 零密钥）；本文件只读记录
 * 文件与记录指向的审计文件（#60：requests[].wireBody 供 reusable-prefix
 * 预测），写报告，不读环境变量、不发起网络请求。输出确定：记录按路径排序，
 * 报告不含时间戳。
 *
 * 退出码：0 成功；1 读取 / 分析失败；2 用法错误。
 */
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RunRecord } from "review-pi";
import {
  analyzeRuns,
  renderAnalysisMarkdown,
  type AnalysisPriceTable,
  type AnalysisReport,
  type AnalysisRunInput,
} from "../src/eval/analysis/index.js";
import {
  errorMessage,
  flagOk,
  parseCliArgs,
  type CliArgSpec,
  type CliParseResult,
} from "../src/instrument/cli-args.js";

export type AnalyzeTokenInput =
  | { readonly kind: "record"; readonly path: string }
  | { readonly kind: "experiment"; readonly path: string }
  | { readonly kind: "runs"; readonly runsRoot: string; readonly experimentId: string };

export interface AnalyzeTokenOptions {
  readonly input: AnalyzeTokenInput;
  readonly priceTablePath: string | null;
  readonly outDir: string;
}

export interface AnalyzeTokenOutputs {
  readonly jsonPath: string;
  readonly markdownPath: string;
}

export const ANALYSIS_JSON_FILENAME = "token-analysis.json";
export const ANALYSIS_MARKDOWN_FILENAME = "token-analysis.md";

const USAGE = `用法：analyze-token (--record <file> | --experiment <dir> | --runs-root <dir> --experiment-id <id>)
                    [--pricing <file>] [--out <dir>]
  --record           单条 RunRecord JSON 文件
  --experiment       实验目录（读取 <dir>/runs/<source>/<case>/<config>/rep-<n>.json）
  --runs-root        runs 根目录；须与 --experiment-id 成对使用
  --experiment-id    experimentId；解析为 <runs-root>/<experiment-id>
  --pricing          可选价目表 JSON（缺省 → currency / priceValidFrom 为 null）
  --out              输出目录（缺省当前目录；写 token-analysis.json / .md）
取值形式：--flag value 或 --flag=value；--help 打印用法`;

interface CliValues {
  readonly record?: string;
  readonly experiment?: string;
  readonly runsRoot?: string;
  readonly experimentId?: string;
  readonly pricing?: string;
  readonly out: string;
}

const CLI_SPEC: CliArgSpec<CliValues, AnalyzeTokenOptions> = {
  usage: USAGE,
  defaultValues: () => ({ out: "." }),
  booleanFlags: {},
  valueFlags: {
    "--record": (value) => flagOk({ record: value }),
    "--experiment": (value) => flagOk({ experiment: value }),
    "--runs-root": (value) => flagOk({ runsRoot: value }),
    "--experiment-id": (value) => flagOk({ experimentId: value }),
    "--pricing": (value) => flagOk({ pricing: value }),
    "--out": (value) => flagOk({ out: value }),
  },
  finalize: (values, fail) => {
    if (values.runsRoot !== undefined && values.experimentId === undefined) {
      return fail("--runs-root requires --experiment-id");
    }
    if (values.experimentId !== undefined && values.runsRoot === undefined) {
      return fail("--experiment-id requires --runs-root");
    }
    const modes = [values.record, values.experiment, values.runsRoot].filter(
      (value) => value !== undefined,
    );
    if (modes.length !== 1) {
      return fail("exactly one input mode is required (--record | --experiment | --runs-root + --experiment-id)");
    }
    const input: AnalyzeTokenInput =
      values.record !== undefined
        ? { kind: "record", path: values.record }
        : values.experiment !== undefined
          ? { kind: "experiment", path: values.experiment }
          : {
              kind: "runs",
              runsRoot: values.runsRoot as string,
              experimentId: values.experimentId as string,
            };
    return {
      ok: true,
      options: {
        input,
        priceTablePath: values.pricing ?? null,
        outDir: values.out,
      },
    };
  },
};

export function parseAnalyzeTokenArgs(argv: readonly string[]): CliParseResult<AnalyzeTokenOptions> {
  return parseCliArgs(argv, CLI_SPEC);
}

/** 单条记录文件 → 只含该记录的输入 */
export async function loadAnalyzeTokenInputs(
  options: AnalyzeTokenOptions,
): Promise<readonly AnalysisRunInput[]> {
  const files =
    options.input.kind === "record"
      ? [options.input.path]
      : await listRecordFiles(experimentDirOf(options.input));
  if (files.length === 0) {
    throw new Error("no RunRecord files (rep-<n>.json) found");
  }
  const inputs: AnalysisRunInput[] = [];
  for (const file of files) {
    const record = await readRecordFile(file);
    const wireBodies = await readWireBodies(record, file);
    inputs.push({
      record,
      ...(wireBodies !== undefined ? { wireBodies } : {}),
    });
  }
  return inputs;
}

/** 递归列出 rep-<n>.json（按路径码点序；审计文件 audit.json 不匹配） */
export async function listRecordFiles(root: string): Promise<readonly string[]> {
  const runsDir = path.join(root, "runs");
  const base = (await isDirectory(runsDir)) ? runsDir : root;
  const out: string[] = [];
  await walk(base, out);
  out.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  return out;
}

export async function writeAnalysisOutputs(
  report: AnalysisReport,
  outDir: string,
): Promise<AnalyzeTokenOutputs> {
  const resolved = path.resolve(outDir);
  await mkdir(resolved, { recursive: true });
  const jsonPath = path.join(resolved, ANALYSIS_JSON_FILENAME);
  const markdownPath = path.join(resolved, ANALYSIS_MARKDOWN_FILENAME);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, renderAnalysisMarkdown(report), "utf8");
  return { jsonPath, markdownPath };
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const parsed = parseAnalyzeTokenArgs(argv);
  if (!parsed.ok) {
    process.stderr.write(`${parsed.message}\n${parsed.usage}\n`);
    return 2;
  }
  try {
    const inputs = await loadAnalyzeTokenInputs(parsed.options);
    const priceTable = await readPriceTable(parsed.options.priceTablePath);
    const report = analyzeRuns({
      runs: inputs,
      ...(priceTable === null ? {} : { priceTable }),
    });
    const outputs = await writeAnalysisOutputs(report, parsed.options.outDir);
    process.stdout.write(`${outputs.jsonPath}\n${outputs.markdownPath}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`analyze-token: ${errorMessage(error)}\n`);
    return 1;
  }
}

async function readRecordFile(file: string): Promise<RunRecord> {
  return (await readJsonFile(file)) as RunRecord;
}

/**
 * 从记录指向的审计文件读取相邻请求 wireBody（#60）：只读本地文件、零网络、
 * 零密钥。相对 auditPath 以记录文件目录为基准解析（记录搬迁后可移植）。
 *
 * N/A 纪律：审计缺失 / 不可读 / 无 requests / **任一 request 缺 wireBody**
 * → undefined（报告省 reusablePrefix 键）。不允许丢弃个别请求后把原本不
 * 相邻的两条当相邻比较（会高估预测且失真 requestCount）。
 */
async function readWireBodies(
  record: RunRecord,
  recordFile: string,
): Promise<readonly string[] | undefined> {
  const rawPath = record.baseline.auditPath;
  if (typeof rawPath !== "string" || rawPath.length === 0) {
    return undefined;
  }
  const auditPath = path.isAbsolute(rawPath)
    ? rawPath
    : path.resolve(path.dirname(recordFile), rawPath);
  let audit: unknown;
  try {
    audit = await readJsonFile(auditPath);
  } catch {
    // 审计文件缺失/不可读：可选预测按 N/A 省略，不让整份报告失败
    return undefined;
  }
  if (!isRecord(audit) || !Array.isArray(audit.requests)) {
    return undefined;
  }
  const bodies: string[] = [];
  for (const request of audit.requests) {
    if (!isRecord(request) || typeof request.wireBody !== "string") {
      return undefined;
    }
    bodies.push(request.wireBody);
  }
  return bodies.length === 0 ? undefined : bodies;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 价目表完整形状按 ADR-0018 §6 校验；批 1 只回显 currency / priceValidFrom，
 * 三种价格由批 4（缓存合同 / 货币口径）消费。
 */
async function readPriceTable(file: string | null): Promise<AnalysisPriceTable | null> {
  if (file === null) {
    return null;
  }
  return (await readJsonFile(file)) as AnalysisPriceTable;
}

async function readJsonFile(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, "utf8")) as unknown;
}

function experimentDirOf(input: Exclude<AnalyzeTokenInput, { kind: "record" }>): string {
  return input.kind === "experiment" ? input.path : path.join(input.runsRoot, input.experimentId);
}

async function walk(dir: string, out: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, out);
    } else if (/^rep-\d+\.json$/.test(entry.name)) {
      out.push(full);
    }
  }
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  process.exitCode = await main();
}
