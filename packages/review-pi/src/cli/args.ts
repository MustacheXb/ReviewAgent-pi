import { basename } from "node:path";
import { CONFIGS, type ConfigId } from "../contracts/config.js";
import { REVIEW_MODEL_ID } from "../provider/pi-client.js";

/**
 * #7 review-pi CLI 参数解析（进程内主缝第一层）：`review-pi review` 与
 * `review-pi smoke` 两个子命令的用法契约。形态对齐 DSH 线 review-agent
 * args.ts（union 结果、不抛异常——用户输入错误是预期路径，不是完整性
 * 事故）；config 合法性对照 CONFIGS 注册表（A–E 矩阵真源）。
 *
 * pi 线差异（自立决策，不从 DSH 仓导入）：
 * - 缺省 config = B（生产形态：零工具 + 确定性预取管线；DSH 线缺省 A）；
 * - 无 --language 旗标（输出语言是 DSH 线后分家决策，pi 线自立 ADR 前不实装）；
 * - smoke 只认 --model（双探针自检不跑检视，参数面自然更窄）。
 *
 * model 是实验数据（#45 语义）：自由 id 透传，缺省单源 = 钉住的评审模型
 * （REVIEW_MODEL_ID），无 model 环境变量。与 DSH 线 review bin 的
 * 「flash/pro 别名 + 退役 id 拒绝」口径有意分家（ADR-0008 别名面属核外
 * 实验 CLI；pi 内核 reviewModelOf 对目录外 id 一律以钉住画像透传，无别名目录）。
 */

/** review 子命令的已知旗标（未知旗标 = 用法错误） */
const KNOWN_REVIEW_FLAGS: readonly string[] = [
  "--repo",
  "--mr",
  "--config",
  "--issue",
  "--out",
  "--model",
];

/** smoke 子命令的已知旗标 */
const KNOWN_SMOKE_FLAGS: readonly string[] = ["--model"];

/** 用法文案（stderr 错误路径的同款文案，单一来源） */
export const USAGE_TEXT = `usage: review-pi review --repo <path> --mr <diff-file> [--config A-E] [--issue <text>] [--out <dir>] [--model <id>]
       review-pi smoke [--model <id>]
  （smoke = 网关冒烟自检，P1b 双探针：网关健康 + 模型可达，输出人话诊断）

review 旗标：
  --repo    <path>       仓库快照根目录（必需）
  --mr      <diff-file>  MR diff 文件路径（必需；caseId = 文件名去扩展名）
  --config  <A-E>        配置形态（缺省 B = 生产形态：零工具 + 确定性预取）
  --issue   <text>       MR 议题描述（缺省空）
  --out     <dir>        输出目录（审计与运行记录落盘；缺省 review-pi-output）
  --model   <id>         评审模型 id（缺省 ${REVIEW_MODEL_ID}；自由 id 透传）

smoke 旗标：
  --model   <id>         冒烟模型 id（同缺省与校验；端点/key 走 REVIEWER_* 环境变量或 .env.local，绝不回显）`;

/** 解析后的 review 命令参数（config 已收窄为 A–E；caseId 由 --mr 派生） */
export interface ReviewCliArgs {
  readonly repo: string;
  readonly mr: string;
  /** 检视单元身份：--mr 文件名去扩展名（一案一 diff 文件约定） */
  readonly caseId: string;
  readonly config: ConfigId;
  readonly issue: string;
  readonly out: string;
  /** 评审模型：缺省 REVIEW_MODEL_ID；自由 id 透传（空串/空白 = 用法错误） */
  readonly model: string;
}

/** 解析后的 smoke 命令参数 */
export interface SmokeCliArgs {
  readonly model: string;
}

/** 解析结果：子命令 + 参数，或用法错误消息（调用方负责呈现与退出码） */
export type ParseCliArgsResult =
  | { readonly ok: true; readonly command: "review"; readonly args: ReviewCliArgs }
  | { readonly ok: true; readonly command: "smoke"; readonly args: SmokeCliArgs }
  | { readonly ok: false; readonly message: string };

/** 旗标循环（两子命令共用）：未知旗标 / 重复旗标 / 值缺席（含值吞旗标）都是用法错误 */
function parseFlags(
  rest: readonly string[],
  knownFlags: readonly string[],
): { readonly ok: true; readonly values: Map<string, string> } | { readonly ok: false; readonly message: string } {
  const values = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    if (flag === undefined || !knownFlags.includes(flag)) {
      return { ok: false, message: `unknown flag ${JSON.stringify(flag)}` };
    }
    if (values.has(flag)) {
      return { ok: false, message: `duplicate flag ${flag}` };
    }
    const value = rest[index + 1];
    // 值以 -- 开头 = 相邻旗标被吞（如 `--issue --out x`）——fail fast 不静默
    if (value === undefined || value.startsWith("--")) {
      return { ok: false, message: `flag ${flag} requires a value` };
    }
    values.set(flag, value);
  }
  return { ok: true, values };
}

/** --model 的缺省与校验（两子命令同口径） */
function parseModelFlag(
  values: Map<string, string>,
): { readonly ok: true; readonly model: string } | { readonly ok: false; readonly message: string } {
  const modelRaw = values.get("--model") ?? REVIEW_MODEL_ID;
  if (modelRaw.trim().length === 0) {
    return {
      ok: false,
      message: `invalid --model ${JSON.stringify(modelRaw)}: must be a non-empty model id (free ids accepted)`,
    };
  }
  return { ok: true, model: modelRaw };
}

export function parseCliArgs(argv: readonly string[]): ParseCliArgsResult {
  const [command, ...rest] = argv;
  if (command !== "review" && command !== "smoke") {
    return {
      ok: false,
      message:
        argv.length === 0
          ? "missing command (expected `review` or `smoke`)"
          : `unknown command ${JSON.stringify(command)} (expected \`review\` or \`smoke\`)`,
    };
  }
  const flags = parseFlags(rest, command === "review" ? KNOWN_REVIEW_FLAGS : KNOWN_SMOKE_FLAGS);
  if (!flags.ok) {
    return flags;
  }
  const model = parseModelFlag(flags.values);
  if (!model.ok) {
    return model;
  }
  if (command === "smoke") {
    return { ok: true, command: "smoke", args: { model: model.model } };
  }

  const repo = flags.values.get("--repo");
  if (repo === undefined) {
    return { ok: false, message: "missing required flag --repo" };
  }
  const mr = flags.values.get("--mr");
  if (mr === undefined) {
    return { ok: false, message: "missing required flag --mr" };
  }
  const configRaw = flags.values.get("--config") ?? "B";
  if (!(configRaw in CONFIGS)) {
    return { ok: false, message: `invalid --config ${JSON.stringify(configRaw)}: expected one of A, B, C, D, E` };
  }

  return {
    ok: true,
    command: "review",
    args: {
      repo,
      mr,
      caseId: basename(mr).replace(/\.[^.]*$/, ""),
      config: configRaw as ConfigId,
      issue: flags.values.get("--issue") ?? "",
      out: flags.values.get("--out") ?? "review-pi-output",
      model: model.model,
    },
  };
}
