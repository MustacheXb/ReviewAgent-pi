import path from "node:path";
import { expect, test } from "vitest";
import { relocateAuditPath } from "./audit-path.js";

// P2 字节纪律门(#5)——auditPath 重定位纯函数缝。
//
// P0 采纳时 t-series 审计真源整树拷入本仓 runs/,但 RunRecord 体内的
// baseline.auditPath 仍是 DSH 兄弟仓的绝对路径(落盘原文,不回写)。
// 门在本仓实验根可移植运行 = 按记录路径尾部(最后一个 "runs" 段之后)
// 重新锚定到本仓 runs 根。

/** t-series 记录内真实形态(DSH 仓绝对路径,Windows 反斜杠) */
const DSH_AUDIT_PATH =
  "D:\\xubao\\code\\AI4SE\\ReviewAgent\\runs\\phase2-dsh-t1\\audit\\vul4j\\" +
  "VUL4J-1\\B\\rep-1\\audit\\20260914T180846.922-B-VUL4J-1.json";

/** 重定位后的尾部(接在本仓 runs 根之后) */
const RELOCATED_TAIL = path.join(
  "phase2-dsh-t1",
  "audit",
  "vul4j",
  "VUL4J-1",
  "B",
  "rep-1",
  "audit",
  "20260914T180846.922-B-VUL4J-1.json",
);

test("重定位:DSH 绝对路径尾部接本仓 runs 根(Windows 反斜杠形态)", () => {
  const runsRoot = path.join("D:", "repo-pi", "runs");
  expect(relocateAuditPath(DSH_AUDIT_PATH, runsRoot)).toBe(
    path.join(runsRoot, RELOCATED_TAIL),
  );
});

test("重定位:正斜杠形态同样收口(分隔符无关)", () => {
  const forward = DSH_AUDIT_PATH.replaceAll("\\", "/");
  const runsRoot = path.join("D:", "repo-pi", "runs");
  expect(relocateAuditPath(forward, runsRoot)).toBe(
    path.join(runsRoot, RELOCATED_TAIL),
  );
});

test("重定位:多个 runs 段取最后一个(记录尾部才是实验根坐标)", () => {
  const doubled = path.join("D:", "a", "runs", "b", "runs") +
    "\\" + "phase2-dsh-t2\\audit\\vul4j\\VUL4J-2\\A\\rep-1\\audit\\x.json";
  const runsRoot = path.join("D:", "repo-pi", "runs");
  expect(relocateAuditPath(doubled, runsRoot)).toBe(
    path.join(
      runsRoot,
      "phase2-dsh-t2",
      "audit",
      "vul4j",
      "VUL4J-2",
      "A",
      "rep-1",
      "audit",
      "x.json",
    ),
  );
});

test("重定位:无 runs 段 → 抛(无法锚定)", () => {
  expect(() =>
    relocateAuditPath("D:\\xubao\\code\\ReviewAgent\\audit\\vul4j\\x.json", "runs"),
  ).toThrow(/no "runs" path segment/i);
});

test("重定位:runs 为末段(无尾部)→ 抛", () => {
  expect(() => relocateAuditPath("D:\\a\\b\\runs", "runs")).toThrow(/no tail/i);
});

test("重定位:段须精确等于 runs(xruns / runs.json 不算)→ 抛", () => {
  expect(() =>
    relocateAuditPath("D:\\a\\xruns\\phase2\\audit\\x.json", "runs"),
  ).toThrow(/no "runs" path segment/i);
  expect(() =>
    relocateAuditPath("D:\\a\\runs.json\\phase2\\audit\\x.json", "runs"),
  ).toThrow(/no "runs" path segment/i);
});
