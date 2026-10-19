import { describe, expect, test } from "vitest";
import { computeAcceptanceKpi, latestDispositions } from "./kpi.js";
import type { DispositionRecord } from "./record.js";

// 人工接受率 KPI（#15，绝对口径纯函数）：直接从处置记录集算出，不依赖
// 锚相对结论（生产 KPI 与评测判级解耦）；total=0 → acceptanceRate=null
// （N/A ≠ 0——对齐仓内指标纪律：空集不冒充 0）；只有 accept 算接受。

function record(
  findingId: string,
  disposition: DispositionRecord["disposition"],
  notedAt: string,
  anchors: Partial<Pick<DispositionRecord, "caseId" | "configId" | "rep">> = {},
): DispositionRecord {
  return {
    source: "vul4j",
    caseId: "VUL4J-1",
    configId: "E",
    rep: 1,
    model: "deepseek-v4-flash",
    findingId,
    disposition,
    notedAt,
    ...anchors,
  };
}

describe("latestDispositions（latest-wins 读取视图）", () => {
  test("同一 finding（同锚同 findingId）重复处置：最新 notedAt 胜（两种到达序都对）", () => {
    const older = record("F100", "accept", "2026-10-19T10:00:00.000Z");
    const newer = record("F100", "reject", "2026-10-19T11:00:00.000Z");
    expect(latestDispositions([older, newer])).toEqual([newer]);
    expect(latestDispositions([newer, older])).toEqual([newer]);
  });

  test("findingId 仅 run 内唯一：跨 case / 跨 rep 的同名 id 不互吃（按 finding 全身份分组）", () => {
    const a = record("F100", "accept", "2026-10-19T10:00:00.000Z");
    const b = record("F100", "reject", "2026-10-19T11:00:00.000Z", { caseId: "VUL4J-2" });
    const c = record("F100", "false-positive", "2026-10-19T12:00:00.000Z", { rep: 2 });
    expect(latestDispositions([a, b, c])).toHaveLength(3);
  });

  test("notedAt 同刻并列：后到（文件序更晚）胜——追加序即时间意图", () => {
    const first = record("F100", "accept", "2026-10-19T10:00:00.000Z");
    const second = record("F100", "reject", "2026-10-19T10:00:00.000Z");
    expect(latestDispositions([first, second])).toEqual([second]);
  });

  test("混合精度 ISO 串按时间纪元比较（字典序陷阱：…00.100Z 在时间上晚于 …00Z）", () => {
    const withMillis = record("F100", "accept", "2026-10-19T10:00:00.100Z");
    const wholeSeconds = record("F100", "reject", "2026-10-19T10:00:00Z");
    expect(latestDispositions([wholeSeconds, withMillis])).toEqual([withMillis]);
  });

  test("空集 → 空视图；纯函数不改入参", () => {
    expect(latestDispositions([])).toEqual([]);
    const input = [record("F100", "accept", "2026-10-19T10:00:00.000Z")];
    latestDispositions(input);
    expect(input).toHaveLength(1);
  });
});

describe("computeAcceptanceKpi（绝对口径）", () => {
  test("空集 → total 0 + acceptanceRate null（N/A ≠ 0，空集不冒充 0）", () => {
    expect(computeAcceptanceKpi([])).toEqual({
      accepted: 0,
      rejected: 0,
      falsePositive: 0,
      total: 0,
      acceptanceRate: null,
    });
  });

  test("直出口径：accepted/total；只有 accept 算接受（reject 与 false-positive 都不是）", () => {
    const kpi = computeAcceptanceKpi([
      record("F100", "accept", "2026-10-19T10:00:00.000Z"),
      record("F101", "reject", "2026-10-19T10:01:00.000Z"),
      record("F102", "false-positive", "2026-10-19T10:02:00.000Z"),
    ]);
    expect(kpi).toEqual({
      accepted: 1,
      rejected: 1,
      falsePositive: 1,
      total: 3,
      acceptanceRate: 1 / 3,
    });
  });

  test("latest-wins 后再计数：翻转处置只数最新值", () => {
    const kpi = computeAcceptanceKpi([
      record("F100", "accept", "2026-10-19T10:00:00.000Z"),
      record("F100", "false-positive", "2026-10-19T11:00:00.000Z"),
      record("F101", "accept", "2026-10-19T10:30:00.000Z"),
    ]);
    expect(kpi).toEqual({
      accepted: 1,
      rejected: 0,
      falsePositive: 1,
      total: 2,
      acceptanceRate: 0.5,
    });
  });

  test("全接受 → acceptanceRate 1", () => {
    const kpi = computeAcceptanceKpi([
      record("F100", "accept", "2026-10-19T10:00:00.000Z"),
      record("F101", "accept", "2026-10-19T10:01:00.000Z"),
    ]);
    expect(kpi.acceptanceRate).toBe(1);
  });
});
