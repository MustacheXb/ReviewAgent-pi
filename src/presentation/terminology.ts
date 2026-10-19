/**
 * 呈现面术语表（#13，ADR-0010「英文产出 + 核外翻译投影」的域词单源）：
 * 把检视英文产物中的域词锚定到本项目规范中文（CONTEXT.md Language 节词表），
 * 供注入的翻译引擎参考——**不是硬替换器**（翻译由引擎裁量，术语表只锚域词
 * 口径；硬替换会破坏叙事与语法，取舍见 ADR-0010 Considered Options）。
 *
 * 单源纪律：条目与版本号只在本模块定义；TERMINOLOGY_VERSION 随投影留痕落档
 * （消费端可追溯某份中文呈现用的是哪代术语口径），域词口径变更时递增版本号。
 * v1 最小集取 CONTEXT.md Language 节的呈现相关域词（Finding / Evidence /
 * severity 档位说明等）；真引擎（LLM/网关）由消费端装配——本票范围外，
 * 本模块零网络零密钥。
 */

/** 术语表版本（v1 = CONTEXT.md Language 节呈现域词最小集） */
export const TERMINOLOGY_VERSION = 1;

export interface TerminologyEntry {
  /** 英文域词（源文档语言侧——检视产物恒英文，ADR-0010） */
  readonly en: string;
  /** 规范中文译名（呈现语言侧） */
  readonly zh: string;
  /** 使用注记（语境约束 / 档位口径 / 避免的译法，供引擎参考） */
  readonly note?: string;
}

/** 域词表（单源；en 侧无重复由 tests/presentation/terminology.test.ts 锁定） */
export const TERMINOLOGY: readonly TerminologyEntry[] = [
  { en: "Finding", zh: "检视结论", note: "避免译作 评论 / 告警 / issue（泛化）" },
  { en: "Evidence", zh: "证据", note: "支撑结论的可验证材料：具体符号、行号与代码摘录" },
  { en: "Evidence Gate", zh: "证据门", note: "No Evidence, No Finding——无证据的候选不得作为结论产出" },
  {
    en: "Severity",
    zh: "严重级",
    note: "P0–P3 代码属结构化字段不译；档位口径 P0=致命、P1=高、P2=中、P3=低",
  },
  { en: "Risk Class", zh: "风险分级", note: "Low / Medium / High，决定上下文加载深度" },
  { en: "Minimal Sufficient Context", zh: "最小充分上下文", note: "避免译作 精简上下文 / 恰好够用的上下文" },
  { en: "Diff-first", zh: "Diff 优先", note: "以 Diff 为检视入口、按需扩展；不是 Diff-only" },
  { en: "Context Ledger", zh: "上下文登记账", note: "避免译作 上下文缓存（与前缀缓存混淆）" },
  { en: "Stable Prefix", zh: "稳定前缀", note: "Zone A——检视角色、政策、工具与输出 Schema" },
  { en: "Repo Map", zh: "仓库结构视图", note: "静态确定性生成，不经过 LLM" },
  { en: "Symbol Index", zh: "符号索引", note: "签名级，不含函数体" },
  { en: "Review Runtime", zh: "检视运行时", note: "区别于通用 Coding Runtime" },
];
