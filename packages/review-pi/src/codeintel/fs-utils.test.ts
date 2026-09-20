import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { readUtf8Tolerant, repoRootName, toPosixPath, toRepoRelativePath } from "./fs-utils.js";

// 文件系统辅助（测量常量面）：仓库内路径一律 POSIX 相对（防 Windows 反斜杠泄漏进请求字节），
// 读取统一 CRLF → LF，非 UTF-8 字节按 U+FFFD 确定性替换。

test("toPosixPath：反斜杠 / 重复分隔符归一", () => {
  expect(toPosixPath("src\\main\\java\\A.java")).toBe("src/main/java/A.java");
  expect(toPosixPath("a//b\\\\c")).toBe("a/b/c");
});

test("toRepoRelativePath：绝对路径剥根、反斜杠归一、相等为空、外部走 relative", () => {
  expect(toRepoRelativePath("D:/repo", "D:/repo/src/A.java")).toBe("src/A.java");
  expect(toRepoRelativePath("D:/repo", "D:\\repo\\src\\A.java")).toBe("src/A.java");
  expect(toRepoRelativePath("D:/repo", "D:/repo")).toBe("");
  expect(toRepoRelativePath("D:/repo", "D:/other/A.java")).toBe("../other/A.java");
});

test("readUtf8Tolerant：CRLF → LF；非法 UTF-8 字节替换为 U+FFFD", async () => {
  // 断言必须 await：未 await 的 .resolves 在测试体同步返回后才结算，
  // finally 的 rmSync 会先删临时目录——Linux CI 上删除稳定赢（ENOENT），
  // Windows 本机读赢掩盖了竞态（实测两轮 CI 红）。
  const dir = mkdtempSync(`${tmpdir()}/review-pi-fs-`);
  try {
    const crlfPath = `${dir}/crlf.txt`;
    writeFileSync(crlfPath, Buffer.from("a\r\nb\r\n", "utf8"));
    await expect(readUtf8Tolerant(crlfPath)).resolves.toBe("a\nb\n");

    const invalidPath = `${dir}/invalid.txt`;
    writeFileSync(invalidPath, Buffer.from([0x61, 0xff, 0x62]));
    await expect(readUtf8Tolerant(invalidPath)).resolves.toBe("a\uFFFDb");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("repoRootName：根目录 basename；盘符根与空名回退 repo", () => {
  expect(repoRootName("D:/xubao/repos/VUL4J-1-f5903fa564")).toBe("VUL4J-1-f5903fa564");
  expect(repoRootName("D:/repo/")).toBe("repo");
  expect(repoRootName("D:/")).toBe("repo");
  // 平台无关合同：POSIX 根同样回退（Linux CI 上 path.resolve 曾把 "D:/"
  // 拼上 cwd 使 basename 错成 "D:"——本用例组钉死跨平台行为）
  expect(repoRootName("/")).toBe("repo");
  expect(repoRootName("/home/runner/repos/VUL4J-1")).toBe("VUL4J-1");
});

test("readUtf8Tolerant：读不存在的文件显式抛错（fail fast）", async () => {
  await expect(readUtf8Tolerant("D:/definitely/not/here.txt")).rejects.toThrow(/failed to read file/);
});
