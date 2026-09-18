import { readFileSync } from "node:fs";

// 黄金基准加载器（测试基建，不进 dist）：统一从 testdata/golden 取
// DSH 审计真源字节。相对路径以本文件（src/testing/）为锚。
export function goldenFixture(name: string): string {
  return readFileSync(new URL(`../../testdata/golden/${name}`, import.meta.url), "utf8");
}
