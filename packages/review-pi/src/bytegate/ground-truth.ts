// P2 字节纪律门(#5)——DSH 审计真源发现与加载。
//
// 真源 = P0 采纳时整树拷入本仓 runs/ 的 t-series 审计(runs/phase2-dsh-t*/
// audit/**/requests[].wireBody,序列化点原文)。RunRecord 体内的
// baseline.auditPath 仍指向 DSH 兄弟仓绝对路径——经 relocateAuditPath
// 按尾部重锚本仓(P0 采纳约定消费,门可移植运行于本仓实验根)。
//
// 回放协议:wireBody 自身携带完整重放脚本——回复 1..n-1 取自后续请求
// messages.at(-2)(assistant,上一回合的真实回复);终局回复不进任何
// 请求,按循环终止信号合成(verdicts 空 + complete true)。DSH 空回复
// (content:null)重放为空串——pi 序列化后该消息不入 wire,对照面差异
// 登记为 EMPTY_ASSISTANT_REPLY(wire-parity)。

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { relocateAuditPath } from "./audit-path.js";
import { deepEqualJson } from "./json-equal.js";

/** 门驱动的配置面(C/D/E = P3 agentLoop,不在本门范围) */
export type GateConfigId = "A" | "B";

/** 一条待对照的真源记录(发现产物:重定位后可直接读) */
export interface GateRecordRef {
  readonly experimentId: string;
  readonly caseId: string;
  readonly configId: GateConfigId;
  readonly rep: number;
  readonly recordPath: string;
  readonly auditPath: string;
}

/** 实验目录名模式:phase2-dsh-t<N> */
const EXPERIMENT_DIR_PATTERN = /^phase2-dsh-t\d+$/;
/** 记录文件名模式:rep-<N>.json */
const RECORD_FILE_PATTERN = /^rep-(\d+)\.json$/;

/**
 * 扫描 runsRoot 下的 t-series 真源记录(A/B × rep-N)。
 * 目录结构与记录体字段交叉校验(caseId/configId/rep/auditPath);
 * 重定位后审计文件必须存在;任何错位/损坏抛错——门数据必须精确。
 */
export function discoverGateRecords(runsRoot: string): readonly GateRecordRef[] {
  if (!existsSync(runsRoot)) {
    return [];
  }
  const refs: GateRecordRef[] = [];
  const experiments = readdirSync(runsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && EXPERIMENT_DIR_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  for (const experimentId of experiments) {
    const vul4jRoot = path.join(runsRoot, experimentId, "runs", "vul4j");
    if (!existsSync(vul4jRoot)) {
      continue;
    }
    for (const caseId of readdirSync(vul4jRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!caseId.isDirectory()) {
        continue;
      }
      for (const configId of ["A", "B"] as const) {
        const configDir = path.join(vul4jRoot, caseId.name, configId);
        if (!existsSync(configDir)) {
          continue;
        }
        for (const file of readdirSync(configDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
          const match = RECORD_FILE_PATTERN.exec(file.name);
          if (!file.isFile() || match === null) {
            continue;
          }
          refs.push(
            buildRecordRef(runsRoot, experimentId, caseId.name, configId, Number(match[1])),
          );
        }
      }
    }
  }
  return refs;
}

function buildRecordRef(
  runsRoot: string,
  experimentId: string,
  caseId: string,
  configId: GateConfigId,
  rep: number,
): GateRecordRef {
  const recordPath = path.join(runsRoot, experimentId, "runs", "vul4j", caseId, configId, `rep-${rep}.json`);
  const record = readJson(recordPath) as Record<string, unknown>;
  const baseline = record["baseline"];
  if (typeof baseline !== "object" || baseline === null) {
    throw new Error(`gate record has no baseline object: ${recordPath}`);
  }
  const auditPathRaw = (baseline as Record<string, unknown>)["auditPath"];
  if (typeof auditPathRaw !== "string" || auditPathRaw === "") {
    throw new Error(`gate record has no baseline.auditPath: ${recordPath}`);
  }
  for (const [field, expected] of [
    ["caseId", caseId],
    ["configId", configId],
  ] as const) {
    if (record[field] !== expected) {
      throw new Error(
        `gate record ${field} "${String(record[field])}" does not match directory "${expected}": ${recordPath}`,
      );
    }
  }
  if (record["rep"] !== rep) {
    throw new Error(`gate record rep ${String(record["rep"])} does not match filename rep-${rep}: ${recordPath}`);
  }
  const auditPath = relocateAuditPath(auditPathRaw, runsRoot);
  if (!existsSync(auditPath)) {
    throw new Error(`relocated audit file does not exist: ${auditPath} (from ${auditPathRaw})`);
  }
  return { experimentId, caseId, configId, rep, recordPath, auditPath };
}

/** 案输入(target-cases.json 一行;truth 等额外字段不属门输入面) */
export interface GateCaseInput {
  readonly caseId: string;
  readonly repoPath: string;
  readonly diff: string;
  readonly issueDescription: string;
}

/** 加载案输入表:data/vul4j/target-cases.json → Map(caseId → 输入) */
export function loadCaseInputs(repoRoot: string): ReadonlyMap<string, GateCaseInput> {
  const casesPath = path.join(repoRoot, "data", "vul4j", "target-cases.json");
  const parsed = readJson(casesPath);
  if (!Array.isArray(parsed)) {
    throw new Error(`target-cases.json must be a JSON array: ${casesPath}`);
  }
  const inputs = new Map<string, GateCaseInput>();
  for (const entry of parsed) {
    const record = entry as Record<string, unknown>;
    const caseId = record["caseId"];
    if (typeof caseId !== "string" || caseId === "") {
      throw new Error(`target-cases.json entry has no caseId: ${casesPath}`);
    }
    for (const field of ["repoPath", "diff", "issueDescription"] as const) {
      if (typeof record[field] !== "string" || record[field] === "") {
        throw new Error(`target-cases entry ${caseId} has no string ${field}: ${casesPath}`);
      }
    }
    inputs.set(caseId, {
      caseId,
      repoPath: record["repoPath"] as string,
      diff: record["diff"] as string,
      issueDescription: record["issueDescription"] as string,
    });
  }
  return inputs;
}

/** 合成终局回复:最后一个 phase-6 回复不进任何请求,只需解析为终止信号 */
export const SYNTHESIZED_TERMINAL_REPLY = '{"verdicts":[],"complete":true}';

/** 一条真源记录的可重放真身 */
export interface WireTruth {
  readonly rounds: number;
  readonly wireBodies: readonly string[];
  /** 回放脚本:回复 1..n-1(真)+ 终局(合成) */
  readonly replies: readonly string[];
}

/**
 * 加载审计真源并校验可回放不变量:
 * - 请求数 = rounds × 6(六阶段各一请求);
 * - 每请求 i≥1 = 上一请求 + assistant 回复 + 下一指令(+2 不变量,append-only);
 * - 回复取自 messages.at(-2),终局回复合成;
 * - 空回复(DSH 方言 content:null)重放为空串——pi 侧重放空串经
 *   pi-ai 序列化后该消息整条不入 wire(对照面差异登记 EMPTY_ASSISTANT_REPLY)。
 */
export function loadWireTruth(auditPath: string): WireTruth {
  const audit = readJson(auditPath) as Record<string, unknown>;
  const rounds = audit["rounds"];
  const requests = audit["requests"];
  if (typeof rounds !== "number" || !Number.isInteger(rounds) || rounds < 1) {
    throw new Error(`audit has no integer rounds >= 1: ${auditPath}`);
  }
  if (!Array.isArray(requests) || requests.length !== rounds * 6) {
    throw new Error(
      `audit request count ${Array.isArray(requests) ? requests.length : "n/a"} does not equal rounds(${rounds}) x 6: ${auditPath}`,
    );
  }
  const wireBodies = requests.map((request, index) => {
    const wireBody = (request as Record<string, unknown>)["wireBody"];
    if (typeof wireBody !== "string" || wireBody === "") {
      throw new Error(`audit request ${index} has no wireBody string: ${auditPath}`);
    }
    return wireBody;
  });

  const messages = wireBodies.map((wire) => parseMessages(wire, auditPath));
  const replies: string[] = [];
  for (let index = 1; index < wireBodies.length; index++) {
    const previous = messages[index - 1];
    const current = messages[index];
    if (current === undefined || previous === undefined) {
      throw new Error(`unreachable: message list shorter than wire list: ${auditPath}`);
    }
    const assistant = current[current.length - 2];
    if (assistant === undefined || assistant["role"] !== "assistant") {
      throw new Error(
        `audit request ${index} has no assistant reply at messages[-2] (+2 invariant broken): ${auditPath}`,
      );
    }
    const prefix = current.slice(0, -2);
    if (!deepEqualJson(prefix, previous)) {
      throw new Error(
        `audit request ${index} is not append-only over request ${index - 1}: ${auditPath}`,
      );
    }
    const content = assistant["content"];
    if (typeof content === "string") {
      replies.push(content);
    } else if (content === null) {
      replies.push("");
    } else {
      throw new Error(
        `audit request ${index} assistant reply content is neither string nor null (DSH empty-reply dialect): ${auditPath}`,
      );
    }
  }
  replies.push(SYNTHESIZED_TERMINAL_REPLY);
  return { rounds, wireBodies, replies };
}

function parseMessages(wire: string, auditPath: string): Record<string, unknown>[] {
  const parsed: unknown = JSON.parse(wire);
  const messages =
    typeof parsed === "object" && parsed !== null
      ? (parsed as { messages?: unknown }).messages
      : undefined;
  if (!Array.isArray(messages)) {
    throw new Error(`audit wireBody is not an object with a messages array: ${auditPath}`);
  }
  if (messages.some((entry) => typeof entry !== "object" || entry === null)) {
    throw new Error(`audit wireBody messages is malformed: ${auditPath}`);
  }
  return messages as Record<string, unknown>[];
}

function readJson(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, "utf8"));
}
