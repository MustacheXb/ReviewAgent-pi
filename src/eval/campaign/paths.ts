/**
 * 评测工件入库路径纪律（#42）：本机绝对路径在报告 / environment 里投影为
 * 仓库相对路径，避免摘要报告泄露机器目录、也避免跨机器复算时路径对不上。
 *
 * 只投影工作目录之下的路径；工作目录之外的路径（临时目录 / 外部数据）保持
 * 原样，不做静默猜测。
 */
export function portableRepoPath(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  const cwd = process.cwd().replaceAll("\\", "/").replace(/\/+$/, "");
  if (normalized === cwd) {
    return ".";
  }
  if (normalized.startsWith(`${cwd}/`)) {
    return normalized.slice(cwd.length + 1);
  }
  return value;
}
