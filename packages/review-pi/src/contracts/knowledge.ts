/**
 * C3 Knowledge 检索语料契约（#6 P3a：search_rule / search_history 数据源）。
 *
 * - 规则语料（rules）= CWD 缺陷模式规则 + 业务规则（search_rule 数据源）；
 * - 历史记语料（history）= 历史 Review / 历史缺陷记录（search_history 数据源）；
 * - 语料由调用方静态注入（零 LLM、零构建），缺省空语料；
 * - 检索为大小写不敏感的子串匹配（纯函数，确定性：同语料 + 同 query 永远同输出）。
 *
 * 工具 schema 属 Zone A（不依赖语料内容），语料只影响工具结果（Zone C）。
 */

/** 一条知识语料条目（规则或历史记录的最小静态形态） */
export interface KnowledgeEntry {
  /** 条目标识（语料内唯一；渲染为 "[id]"） */
  readonly id: string;
  /** 短标题（参与匹配；渲染为条目首行） */
  readonly title: string;
  /** 正文（参与匹配；可多行） */
  readonly text: string;
}

/** 一次检视运行的知识语料（两个语料相互独立，均可缺省为空） */
export interface KnowledgeCorpus {
  readonly rules?: readonly KnowledgeEntry[];
  readonly history?: readonly KnowledgeEntry[];
}

/** 空语料（缺省：无规则/历史知识源配置；t-series 真源即为空语料形态） */
export const EMPTY_KNOWLEDGE_CORPUS: KnowledgeCorpus = {};
