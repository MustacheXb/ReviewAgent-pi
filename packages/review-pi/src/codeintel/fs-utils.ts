import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * 文件系统读取辅助（测量常量面）：Zone B 构造与预取共用。
 *
 * 确定性纪律：
 * - 所有对外的仓库内路径一律为 POSIX 风格相对路径（与 git diff 路径一致），
 *   避免 Windows 反斜杠泄漏进请求字节；
 * - 读取时统一 CRLF -> LF，保证同一仓库在不同检出配置下行尾一致；
 * - 非 UTF-8 字节按 U+FFFD 替换（Vul4J 老项目可能存在 Latin-1 源文件），
 *   替换是确定性的：同输入永远同输出。
 */

/** 归一化为 POSIX 风格路径分隔符 */
export function toPosixPath(p: string): string {
  return p
    .split(/[\\/]+/)
    .filter((segment) => segment.length > 0)
    .join("/");
}

/** 把 rg 返回的（可能是绝对或相对）路径转成相对 root 的 POSIX 路径 */
export function toRepoRelativePath(root: string, candidate: string): string {
  const posixRoot = toPosixPath(root);
  const posixCandidate = toPosixPath(candidate);
  if (posixCandidate === posixRoot) {
    return "";
  }
  const prefix = posixCandidate.startsWith(`${posixRoot}/`) ? `${posixRoot}/` : undefined;
  if (prefix !== undefined) {
    return posixCandidate.slice(prefix.length);
  }
  // rg 以相对形式回显时的兜底（path.relative 处理 ".." 等情况）
  return toPosixPath(path.relative(root, candidate));
}

/** UTF-8 容错读取 + 行尾归一化（CRLF -> LF） */
export async function readUtf8Tolerant(absPath: string): Promise<string> {
  try {
    const bytes = await readFile(absPath);
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    return text.replace(/\r\n/g, "\n");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to read file "${absPath}": ${message}`, { cause: error });
  }
}

/** Windows 盘符根形态（"D:" / "d:"）——toPosixPath 剥分隔符后的残留 */
const DRIVE_ROOT_PATTERN = /^[A-Za-z]:$/;

/**
 * 仓库展示名：根目录 basename（剥离尾部分隔符；根路径——POSIX "/" 与
 * Windows 盘符根 "D:"——及空名回退 "repo"）。
 * 纯字符串分段解析，不经 path.resolve——平台无关且不依赖 cwd：resolve 在
 * POSIX 上会把 Windows 盘符路径当相对路径拼上 cwd（实测 Linux CI 上
 * basename 错成 "D:"）。输入含两种平台形态（target-cases.json 的
 * Windows 绝对路径 / loadRepoContext 已 resolve 的原生绝对路径，后者
 * 无 "."、".." 段，纯分段与 resolve+basename 等价）。
 */
export function repoRootName(repoPath: string): string {
  const posix = toPosixPath(repoPath);
  const last = posix.slice(posix.lastIndexOf("/") + 1);
  if (last === "" || DRIVE_ROOT_PATTERN.test(last)) {
    return "repo";
  }
  return last;
}
