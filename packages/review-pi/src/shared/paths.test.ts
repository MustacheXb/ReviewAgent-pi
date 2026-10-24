import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, test } from "vitest";

import { getCwdRelativePath, normalizePath, resolvePath } from "./paths.js";

// #27 paths 移植验收（stdio 方案拍板 27）：pi coding-agent utils/paths.ts 的
// normalizePath / resolvePath / getCwdRelativePath 按源语义移植——repoPath /
// diff.path 解析的公共底座（tilde 展开、Windows shell 路径、file: URL、
// 相对路径基座解析）。此处锚定与上游可对照的行为面，不测实现细节。

describe("normalizePath", () => {
  test("原样透传（无选项时零改写）", () => {
    expect(normalizePath("/srv/repos/vul4j")).toBe("/srv/repos/vul4j");
    expect(normalizePath("relative/path")).toBe("relative/path");
  });

  test("tilde 展开：`~` → home、`~/x` → home/x（缺省开）", () => {
    expect(normalizePath("~")).toBe(homedir());
    expect(normalizePath(path.join("~", "repos", "x"))).toBe(
      path.join(homedir(), "repos", "x"),
    );
  });

  test("tilde 展开可关（expandTilde: false）", () => {
    expect(normalizePath("~/x", { expandTilde: false })).toBe("~/x");
  });

  test("trim：首尾空白先剥再归一", () => {
    expect(normalizePath("  /srv/x  ", { trim: true })).toBe("/srv/x");
  });

  test("stripAtPrefix：CLI @file 形态剥前导 @", () => {
    expect(normalizePath("@/srv/diffs/x.diff", { stripAtPrefix: true })).toBe("/srv/diffs/x.diff");
  });

  test("file: URL → 平台原生路径", () => {
    const native = path.resolve("srv", "x");
    expect(normalizePath(pathToFileURL(native).href)).toBe(native);
  });

  test("Windows Git Bash 形态 /d/x → D:\\x（win32 only；POSIX 原样）", () => {
    if (process.platform === "win32") {
      expect(normalizePath("/d/xubao/code")).toBe("D:\\xubao\\code");
      expect(normalizePath("/mnt/d/x", { expandTilde: false })).toBe("D:\\x");
    } else {
      expect(normalizePath("/d/xubao/code")).toBe("/d/xubao/code");
    }
  });
});

describe("resolvePath", () => {
  test("绝对路径：归一后直取", () => {
    expect(resolvePath("/srv/x", "/base")).toBe(path.resolve("/srv/x"));
  });

  test("相对路径：相对 baseDir 解析（缺省 process.cwd()）", () => {
    expect(resolvePath("sub/x", "/base")).toBe(path.resolve("/base", "sub", "x"));
    expect(resolvePath("sub/x")).toBe(path.resolve(process.cwd(), "sub", "x"));
  });

  test("baseDir 也走归一（~ 基座 + 相对输入）", () => {
    expect(resolvePath("x", "~")).toBe(path.resolve(homedir(), "x"));
  });
});

describe("getCwdRelativePath", () => {
  test("cwd 内 → 相对形态（根自身 → '.'）", () => {
    expect(getCwdRelativePath("/base/sub/x", "/base")).toBe(path.join("sub", "x"));
    expect(getCwdRelativePath("/base", "/base")).toBe(".");
  });

  test("cwd 外 → undefined（不硬造 ../.. 形态）", () => {
    expect(getCwdRelativePath("/elsewhere/x", "/base")).toBeUndefined();
    expect(getCwdRelativePath("/base2/x", "/base")).toBeUndefined();
  });
});
