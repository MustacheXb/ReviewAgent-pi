/**
 * #28 Bearer Authenticator（ADR-0013 决策 5）：HTTP `Authorization: Bearer`
 * 头 → Principal 的解析面。
 *
 * - token→principal 的 JSON 映射文件（`{ tokens: { <token>: { tenantId,
 *   subject, scopes } } }`）；构造期读取并全量校验——缺失/非法 fail fast
 *   拒启动（demo 脚本自生成临时 token 文件满足该前提）。
 * - 每请求 mtime+size 双键检测热轮换：变了重读，不重启即生效；重读失败
 *   （半写态/权限抖动）保留旧表继续服务 + 诊断缝上抛，不拒服务——
 *   凭据轮换的原子性由运维面保证。
 * - scope 值单源 REVIEW_SCOPES；Principal 只取三字段，映射文件里的多余
 *   字段不透传（防未声明面进协议）。
 * - token 是高熵服务凭据（非用户口令），查表比对不做 timing-safe——
 *   内网单实例形态的取舍，注释为凭。
 */

import { readFileSync, statSync } from "node:fs";

import { REVIEW_SCOPES, type Principal, type ReviewScope } from "../rpc/context.js";

/** 诊断输出缝（缺省 no-op：测试/装配按需接 stderr 与 redaction） */
export type AuthDiagnosticSink = (message: string) => void;

export interface TokenFileAuthenticatorOptions {
  /** token→principal 映射文件路径（构造期必须存在且合法） */
  readonly tokenFile: string;
  /** 诊断缝（热轮换读失败等；缺省丢弃） */
  readonly onDiagnostic?: AuthDiagnosticSink;
}

/** Bearer 凭据形态（RFC 7235：scheme 大小写不敏感；token 无空白） */
const BEARER_PATTERN = /^bearer[ \t]+(\S+)$/i;

/** 映射文件的内存形态：token → principal 三字段（多余字段丢弃） */
type TokenTable = ReadonlyMap<string, Principal>;

export interface Authenticator {
  /** 未认证（缺头/坏形态/未知 token）返回 undefined；401 由 HTTP 适配器映射 */
  authenticate(authorization: string | undefined): Promise<Principal | undefined>;
}

/** 文件面错误（构造期 fail fast 用；消息含路径不含文件内容——内容是敏感面） */
class TokenFileError extends Error {
  constructor(tokenFile: string, reason: string) {
    super(`token file ${tokenFile}: ${reason}`);
    this.name = "TokenFileError";
  }
}

export function createTokenFileAuthenticator(options: TokenFileAuthenticatorOptions): Authenticator {
  let table = loadTable(options.tokenFile);
  const initialStat = statSync(options.tokenFile);
  let lastMtimeMs = initialStat.mtimeMs;
  let lastSize = initialStat.size;

  return {
    async authenticate(authorization): Promise<Principal | undefined> {
      if (authorization === undefined) {
        return undefined;
      }
      const match = BEARER_PATTERN.exec(authorization);
      if (match === null) {
        return undefined;
      }
      const token = match[1]!;
      refreshIfChanged(options.tokenFile);
      const principal = table.get(token);
      return principal === undefined ? undefined : copyPrincipal(principal);
    },
  };

  /** mtime+size 变化才重读（同毫秒重写靠 size 兜底；未变化零 I/O） */
  function refreshIfChanged(tokenFile: string): void {
    let mtimeMs: number;
    let size: number;
    try {
      const info = statSync(tokenFile);
      mtimeMs = info.mtimeMs;
      size = info.size;
    } catch {
      return; // 轮换窗口的瞬时缺失：保留旧表（构造期已 fail fast 保证曾经合法）
    }
    if (mtimeMs === lastMtimeMs && size === lastSize) {
      return;
    }
    try {
      table = loadTable(tokenFile);
      lastMtimeMs = mtimeMs;
      lastSize = size;
    } catch (error) {
      // 半写态/瞬时不可读：保留旧表继续服务，诊断缝上抛（不拒服务）
      const reason = error instanceof TokenFileError ? error.message : String(error);
      options.onDiagnostic?.(`token file reload failed, keeping previous table: ${reason}`);
    }
  }
}

/** 全量读取 + 校验（构造期与热轮换共用；任何违例上抛 TokenFileError） */
function loadTable(tokenFile: string): TokenTable {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(tokenFile, "utf8"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new TokenFileError(tokenFile, `unreadable or invalid JSON (${reason})`);
  }
  if (!isRecord(parsed) || !isRecord(parsed.tokens)) {
    throw new TokenFileError(tokenFile, 'expected top-level object with a "tokens" map');
  }
  const table = new Map<string, Principal>();
  for (const [token, principal] of Object.entries(parsed.tokens)) {
    if (token.length === 0) {
      throw new TokenFileError(tokenFile, "token keys must be non-empty strings");
    }
    if (!isRecord(principal)) {
      throw new TokenFileError(tokenFile, `principal for a token must be an object`);
    }
    const { tenantId, subject, scopes } = principal;
    if (typeof tenantId !== "string" || tenantId.length === 0) {
      throw new TokenFileError(tokenFile, "tenantId must be a non-empty string");
    }
    if (typeof subject !== "string" || subject.length === 0) {
      throw new TokenFileError(tokenFile, "subject must be a non-empty string");
    }
    if (!Array.isArray(scopes) || scopes.some((scope) => !isScope(scope))) {
      throw new TokenFileError(
        tokenFile,
        `scopes must be an array of ${REVIEW_SCOPES.join(" / ")}`,
      );
    }
    // 只取三字段构造（映射文件的多余字段不透传——防未声明面进协议）
    table.set(token, { tenantId, subject, scopes: [...scopes] });
  }
  return table;
}

function isScope(value: unknown): value is ReviewScope {
  return typeof value === "string" && (REVIEW_SCOPES as readonly string[]).includes(value);
}

/** 返回副本：调用方拿到 Principal 后改 scopes 不污染内部表（不可变纪律） */
function copyPrincipal(principal: Principal): Principal {
  return {
    tenantId: principal.tenantId,
    subject: principal.subject,
    scopes: [...principal.scopes],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
