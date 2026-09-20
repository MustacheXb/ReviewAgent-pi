/**
 * 工具入参校验与错误回显（#6 P3a；与 DSH 线执行器层语义等价）。
 *
 * pi 协议差异（内核效应，非移植项）：DSH 线 ToolCall.argumentsJson 是模型
 * 原文 JSON 字符串（executor 层 parseToolArguments 解析）；pi 内核在流式
 * 解析缝已把参数解析为对象后才进入工具执行——参数合法性校验因此前移到
 * pi-agent-core 的 schema 校验层，本模块只承载字段级校验（requireStringArg /
 * optionalPositiveIntArg）与错误回显纪律，错误消息字节与 DSH 线一致。
 */

/** 必填字符串参数（空白视为缺失） */
export function requireStringArg(
  toolName: string,
  args: Record<string, unknown>,
  field: string,
): string {
  const value = args[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${toolName}: argument "${field}" must be a non-empty string`);
  }
  return value;
}

/** 可选正整数参数（缺省 undefined） */
export function optionalPositiveIntArg(
  toolName: string,
  args: Record<string, unknown>,
  field: string,
): number | undefined {
  const value = args[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${toolName}: argument "${field}" must be a positive integer (got ${JSON.stringify(value)})`);
  }
  return value;
}

/** 错误信息中的原文回显（有界） */
export function boundedEcho(text: string, maxChars: number): string {
  const trimmed = text.trim();
  return trimmed.length <= maxChars ? trimmed : `${trimmed.slice(0, maxChars)}...`;
}

/**
 * 仓库相对 POSIX 路径归一化与校验（拒绝绝对路径与 ".." 越界段——防路径逃逸）。
 */
export function normalizeRepoPath(toolName: string, rawPath: string): string {
  const posix = rawPath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (posix.startsWith("/") || /^[A-Za-z]:/.test(posix)) {
    throw new Error(`${toolName}: path must be repository-relative, got absolute path "${posix}"`);
  }
  const segments = posix.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0 || segments.includes("..")) {
    throw new Error(`${toolName}: path "${posix}" must stay inside the repository snapshot`);
  }
  return segments.join("/");
}
