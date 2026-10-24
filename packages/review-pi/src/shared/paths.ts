import { homedir } from "node:os";
import { isAbsolute, join, resolve as nodeResolvePath, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 路径归一/解析小工具（#27，stdio 方案拍板 27）：自 pi coding-agent
 * `packages/coding-agent/src/utils/paths.ts`（MIT，Earendil Works / Mario
 * Zechner，锚定 6671c604）移植 normalizePath / resolvePath /
 * getCwdRelativePath 三个函数及其依赖（normalizeWindowsShellPath、
 * PathInputOptions）。出处与许可见仓库根 THIRD-PARTY-NOTICES.md 的
 * coding-agent 条目。
 *
 * fork 适配（行为等价，形态本地化）：
 * - 只移植 stdio 方案拍板 27 点名的三函数及其依赖（getCwdRelativePath 当前
 *   仅测试消费，HTTP 线方案 §3.2 预留复用）——canonicalizePath / isLocalPath /
 *   getFileRevision / markPathIgnoredByCloudSync 等其余件不随迁；
 * - 缩进与导入序按本仓风格重排；`import ... from "./child-process.ts"`
 *   依赖随 markPathIgnoredByCloudSync 一并消失；
 * - 注释补充本仓消费语境（rpc 面 repoPath / diff.path 解析底座，
 * 「omit to discover, provide to override」——ADR-0013 决策 3）。
 */

const UNICODE_SPACES = /[  -   　]/g;

export interface PathInputOptions {
  /** Trim leading/trailing whitespace before normalization. */
  trim?: boolean;
  /** Expand leading `~` to a home directory. Defaults to true. */
  expandTilde?: boolean;
  /** Home directory used for `~` expansion. Defaults to `os.homedir()`. */
  homeDir?: string;
  /** Strip a leading `@`, used for CLI @file paths. */
  stripAtPrefix?: boolean;
  /** Normalize unicode space variants to regular spaces. */
  normalizeUnicodeSpaces?: boolean;
}

/** Convert Git Bash, MSYS, Cygwin, and WSL drive paths to a form native Windows APIs accept. */
export function normalizeWindowsShellPath(filePath: string): string {
  if (!filePath.startsWith("/") || filePath.startsWith("//") || filePath.includes("\\")) return filePath;
  const match = filePath.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
  if (match === null) return filePath;
  const drive = match[1];
  if (drive === undefined) return filePath;
  const suffix = match[2]?.replaceAll("/", "\\");
  return `${drive.toUpperCase()}:\\${suffix ?? ""}`;
}

export function normalizePath(input: string, options: PathInputOptions = {}): string {
  let normalized = options.trim ? input.trim() : input;
  if (options.normalizeUnicodeSpaces) {
    normalized = normalized.replace(UNICODE_SPACES, " ");
  }
  if (options.stripAtPrefix && normalized.startsWith("@")) {
    normalized = normalized.slice(1);
  }
  if (process.platform === "win32") {
    normalized = normalizeWindowsShellPath(normalized);
  }

  if (options.expandTilde ?? true) {
    const home = options.homeDir ?? homedir();
    if (normalized === "~") return home;
    if (normalized.startsWith("~/") || (process.platform === "win32" && normalized.startsWith("~\\"))) {
      return join(home, normalized.slice(2));
    }
  }

  if (/^file:\/\//.test(normalized)) {
    return fileURLToPath(normalized);
  }

  return normalized;
}

export function resolvePath(input: string, baseDir: string = process.cwd(), options: PathInputOptions = {}): string {
  const normalized = normalizePath(input, options);
  const normalizedBaseDir = normalizePath(baseDir);
  return isAbsolute(normalized) ? nodeResolvePath(normalized) : nodeResolvePath(normalizedBaseDir, normalized);
}

export function getCwdRelativePath(filePath: string, cwd: string): string | undefined {
  const resolvedCwd = resolvePath(cwd);
  const resolvedPath = resolvePath(filePath, resolvedCwd);
  const relativePath = relative(resolvedCwd, resolvedPath);
  const isInsideCwd =
    relativePath === "" ||
    (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));

  return isInsideCwd ? relativePath || "." : undefined;
}
