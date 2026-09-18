// 候选拦截链（测量常量面：六阶段语义的 Evidence Gate 部分）。
// "No Evidence, No Finding"：SCHEMA_INVALID → NON_ENGLISH → NO_EVIDENCE
// → VERIFICATION_FAILED → DUPLICATE_ID，每候选至多留痕一条（首个失败阶段）。
import type { Finding } from "../contracts/finding.js";
import type { CandidateRejection } from "../contracts/run.js";
import { validateFinding } from "../finding/finding-schema.js";
import type { VerificationVerdict } from "../loop/parse.js";

export interface GateInput {
  /** Deep Reasoning 阶段产出的原始候选对象 */
  readonly candidates: readonly unknown[];
  /** Evidence Verification 阶段的裁决（按候选 id 索引） */
  readonly verdicts: ReadonlyMap<string, VerificationVerdict>;
  /** 已产出的 Finding id 集合（跨轮去重；不会被本函数修改） */
  readonly emittedIds: ReadonlySet<string>;
  readonly round: number;
}

export interface GateOutput {
  readonly findings: readonly Finding[];
  readonly rejections: readonly CandidateRejection[];
  readonly emittedIds: ReadonlySet<string>;
}

export function applyCandidateGate(input: GateInput): GateOutput {
  const findings: Finding[] = [];
  const rejections: CandidateRejection[] = [];
  const emittedIds = new Set(input.emittedIds);

  input.candidates.forEach((candidate, index) => {
    const candidateId = readCandidateId(candidate, input.round, index);
    const rejection = firstFailingStage(candidate, candidateId, input.verdicts, emittedIds);
    if (rejection !== undefined) {
      rejections.push(rejection);
      return;
    }
    findings.push(toFinding(candidate));
    emittedIds.add(candidateId);
  });

  return { findings, rejections, emittedIds };
}

function readCandidateId(candidate: unknown, round: number, index: number): string {
  if (typeof candidate === "object" && candidate !== null) {
    const id = (candidate as { id?: unknown }).id;
    if (typeof id === "string" && id.length > 0) {
      return id;
    }
  }
  return `round-${round}-candidate-${index}`;
}

function firstFailingStage(
  candidate: unknown,
  candidateId: string,
  verdicts: ReadonlyMap<string, VerificationVerdict>,
  emittedIds: ReadonlySet<string>,
): CandidateRejection | undefined {
  const schemaErrors = validateFinding(candidate);
  if (schemaErrors.length > 0) {
    return { candidateId, stage: "SCHEMA_INVALID", reason: schemaErrors.join("; ") };
  }
  if (containsNonEnglish(candidate)) {
    return { candidateId, stage: "NON_ENGLISH", reason: "finding text must be English only" };
  }
  if (!hasEvidence(candidate)) {
    return { candidateId, stage: "NO_EVIDENCE", reason: "no evidence cited (No Evidence, No Finding)" };
  }
  const verdict = verdicts.get(candidateId);
  if (verdict === undefined) {
    return { candidateId, stage: "VERIFICATION_FAILED", reason: "no verification verdict for candidate" };
  }
  if (!verdict.pass) {
    const detail = verdict.reason.length > 0 ? `: ${verdict.reason}` : "";
    return {
      candidateId,
      stage: "VERIFICATION_FAILED",
      reason: `evidence verification rejected the candidate${detail}`,
    };
  }
  if (emittedIds.has(candidateId)) {
    return {
      candidateId,
      stage: "DUPLICATE_ID",
      reason: "a finding with this id was already emitted in an earlier round",
    };
  }
  return undefined;
}

/** 检查候选文本字段是否含 CJK 字符（输出全英文纪律） */
const CJK_PATTERN = /[㐀-䶿一-鿿豈-﫿　-〿＀-￯]/;

function containsNonEnglish(candidate: unknown): boolean {
  const record = candidate as Record<string, unknown>;
  const texts = [record.title, record.description, ...(record.evidence as readonly unknown[])];
  return texts.some((text) => typeof text === "string" && CJK_PATTERN.test(text));
}

function hasEvidence(candidate: unknown): boolean {
  const evidence = (candidate as { evidence?: unknown }).evidence;
  return (
    Array.isArray(evidence) && evidence.some((entry) => typeof entry === "string" && entry.trim().length > 0)
  );
}

function toFinding(candidate: unknown): Finding {
  // 形状已由 validateFinding 保证；只投影已知字段（多余字段静默丢弃）
  const record = candidate as {
    id: string;
    severity: Finding["severity"];
    category: string;
    file: string;
    line: number;
    title: string;
    description: string;
    evidence: readonly string[];
    rule: string;
    confidence: number;
  };
  return {
    id: record.id,
    severity: record.severity,
    category: record.category,
    file: record.file,
    line: record.line,
    title: record.title,
    description: record.description,
    evidence: [...record.evidence],
    rule: record.rule,
    confidence: record.confidence,
  };
}
