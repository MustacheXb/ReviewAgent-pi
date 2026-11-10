# ReviewAgent 语义去重与大 MR 检视方案

**状态**：设计稿 v0.1，暂不实施
**设计日期**：2026-11-06
**适用基线**：生产 `main`、`reviewagent v1.0.0`、Config E-only、协议 v3
**适用范围**：`package/review-pi` 的 Review Runtime、worker 执行编排与审计契约

## 1. 背景与结论

当前生产线已经完成 E-only 收口：Review Runtime 固定使用七工具 + Context Ledger，CLI、stdio 与 HTTP server 共用协议 v3。下一阶段的直接质量缺口不是平台接入，而是：

1. 超过已验证域的 MR 只告警，不切分；
2. Finding 只按 ID 去重，无法处理同根因的不同表述；
3. 分片后必然产生跨分片重复 Finding；
4. 当前 Finding 契约缺少结构化身份，难以做可靠合并；
5. 父 Job 缺少覆盖完整性表达，部分失败可能被误认为完整检视。

本方案优先解决上述问题，不依赖平台原生 Review Job 或 `CodePlatformAdapter`。

**核心结论**：

- 对外仍只有 `runReview` 一个深模块，CLI / stdio / HTTP 不需要理解分片。
- 首版不做 embedding 或全量 LLM 语义判定，先实现确定性精确去重与结构去重。
- 大 MR 首版在现有 worker 内顺序执行分片，避免嵌套 worker 池。
- 界内 MR 行为保持不变；超界且可解析时自动分片。
- 父 Job 状态机保持 `queued → running → succeeded / failed / cancelled`，部分完成用 `coverage` 表达。
- Finding 必填 Schema 不变，去重身份与聚类信息作为审计伴生数据。
- 平台 Adapter 暂缓，分片协调器保持平台无关，未来可直接复用。

## 2. 当前事实与痛点

### 2.1 大 MR 当前只做降级标注

[`mr-boundary-guard.ts`](../../../packages/review-pi/src/run/mr-boundary-guard.ts) 以 10 文件、2,000 变更行为验证域边界。超界或不可度量时：

- `RunResult.domainWarning` 留痕；
- 审计文件尾键 `mrBoundary` 留痕；
- Review 仍整体执行。

因此，大 MR 会继续进入有限的轮次和工具预算，质量只能依赖截断兜底，不能保证覆盖。

### 2.2 当前去重只处理重复 ID

[`candidate-gate.ts`](../../../packages/review-pi/src/gate/candidate-gate.ts) 的拦截链为：

```text
SCHEMA_INVALID
→ NON_ENGLISH
→ NO_EVIDENCE
→ VERIFICATION_FAILED
→ DUPLICATE_ID
```

`DUPLICATE_ID` 只能阻止同一 ID 跨轮再次输出，不能识别：

- 同一根因使用不同 ID；
- 同一根因使用不同标题和描述；
- 同一根因在多个分片中被分别发现；
- 同一位置的不同根因。

### 2.3 Finding 证据为自由文本

当前 [`Finding`](../../../packages/review-pi/src/contracts/finding.ts) 的证据为 `string[]`，没有：

- 文件与行号范围的结构化引用；
- enclosing symbol；
- hunk 身份；
- evidence hash；
- 根因或修复动作标识。

直接对标题或描述做相似度判断，容易把相关但不同的问题误合并。

### 2.4 行号与仓库快照坐标系不完全统一

输出契约要求 Finding 行号指向 MR 应用后的文件，但当前仓库快照是 base 侧，符号索引也主要按旧侧范围求交。分片和去重设计必须同时保留：

- 新侧行号，用于最终 Finding；
- 旧侧行号或 hunk 映射，用于读取快照和符号索引；
- 无法可靠映射时，不使用符号作为强合并依据。

### 2.5 现有 Diff 解析不足以生成子 Diff

[`diff-analysis.ts`](../../../packages/review-pi/src/zoneb/diff-analysis.ts) 当前提取文件路径和 hunk 头，但不保留：

- 原始文件头；
- hunk 正文；
- hunk 的增删行数；
- 可重新渲染的子 diff。

不能通过字符串随意截取 diff 生成分片，否则容易破坏 hunk 结构和行号语义。

### 2.6 执行拓扑与超时约束

当前 server 一个 Job 由一个 worker 执行，缺省执行超时为 60 分钟。首版分片不能在 worker 中递归创建 worker 池，需要：

- 在父 worker 内顺序执行；
- 设置最大分片数；
- 明确取消、超时和部分失败语义；
- 聚合 usage、rounds、toolCalls。

## 3. 设计目标

### 3.1 目标

- 对超界但不复杂到无法处理的 MR 自动生成确定性分片计划。
- 每个分片落在当前已验证检视域内。
- 聚合分片结果后输出去重后的 Finding。
- 保留原始 Finding、证据、来源分片和合并原因。
- 支持取消、单分片失败与覆盖不完整表达。
- 不改变界内 MR 的现有行为。
- 不改变 CLI / stdio / HTTP 的请求协议。
- 不引入平台特定字段。

### 3.2 非目标

- 不实现 Webhook、自动评论或平台 Adapter。
- 不实现构建、编译、单测或隔离容器。
- 不引入向量数据库。
- 不默认对所有 Finding 调用 LLM 做相似度判断。
- 不修改 Finding 的 10 个必填字段。
- 不支持无限大的 MR。
- 不自动修复 Finding。
- 不把 Check Engine 作为本方案的依赖。

## 4. 总体设计

```text
CLI / stdio / HTTP
        ↓
   ReviewRequest
        ↓
     runReview
        ↓
 DiffSurface + BoundaryDecision
        ├─ 界内
        │    → runSingleReview
        └─ 超界且可解析
             → ReviewPartitionPlanner
             → PartitionedReviewCoordinator
                 → runSingleReview(part-1)
                 → runSingleReview(part-2)
                 → ...
             → ReviewPostProcessor
             → ParentReviewResult
        ↓
 父审计 / 父 RunRecord
```

### 4.1 模块划分

| 模块 | 职责 | 对外接口 |
|---|---|---|
| `DiffSurface` | 保留原始 diff 结构、文件头、hunk 正文与增删行数 | `parseDiffSurface(diff)` |
| `ReviewPartitionPlanner` | 将超界 diff 切成确定性的分片计划 | `plan(input)` |
| `PartitionedReviewCoordinator` | 执行分片、传播取消、聚合结果 | `run(input)` |
| `FindingIdentity` | 从 Finding、hunk、符号索引推导去重身份 | `identityOf(finding, context)` |
| `FindingDeduplicator` | 精确去重、结构去重、可选语义裁决 | `deduplicate(findings)` |
| `ReviewPostProcessor` | 合并、审计投影与最终结果生成 | `process(result)` |

### 4.2 深模块边界

对调用方继续只暴露 `runReview`。是否分片、如何分片、如何去重均隐藏在模块内部。

不建议：

- 在 `ReviewRequest` 中增加 `partition` 参数；
- 在协议层让调用方指定分片；
- 让 CLI、stdio、HTTP 各自实现分片逻辑；
- 把平台事件、SHA、workspace 等字段带入内核。

## 5. DiffSurface 设计

### 5.1 数据结构

```ts
interface DiffSurface {
  files: DiffFileSurface[];
  totalAddedLines: number;
  totalRemovedLines: number;
  parseStatus: "ok" | "unmeasurable";
  parseReason?: "binary" | "rename-only" | "malformed" | "mixed";
}

interface DiffFileSurface {
  oldPath?: string;
  newPath?: string;
  displayPath: string;
  fileHeaderLines: string[];
  hunks: DiffHunkSurface[];
  addedLines: number;
  removedLines: number;
  unsupportedReason?: "binary" | "rename-only" | "malformed";
}

interface DiffHunkSurface {
  hunkKey: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  bodyLines: string[];
  addedLines: number;
  removedLines: number;
}
```

### 5.2 约束

- 变更行数只计算 `+` / `-` 行，不计算 context 行。
- 子 diff 必须保留原文件头与选中的完整 hunk。
- hunk 内出现 `---` / `+++` 文本时不得误判为文件头。
- 二进制、纯重命名和不可游走 diff 不做分片。
- 分片计划和边界护栏共用同一 DiffSurface，避免双解析口径漂移。
- 相同 diff 输入必须生成完全相同的 hunkKey 和排序。

### 5.3 兼容策略

- 界内 MR 不调用分片器，DiffSurface 只用于边界测量。
- 解析失败时回退当前整体检视路径，并保留 `domainWarning`。
- 现有 `analyzeDiff` 的调用方可以在迁移期继续工作，新模块先并行接入。

## 6. 大 MR 分片设计

### 6.1 数据契约

```ts
interface ReviewPartitionPlan {
  parentCaseId: string;
  strategyVersion: string;
  parts: ReviewPartition[];
  coverage: PartitionCoverage;
}

interface ReviewPartition {
  partId: string;
  files: string[];
  hunks: DiffHunkRef[];
  changedLines: number;
  changedSymbols: string[];
  scopeHash: string;
  diffText: string;
}

interface PartitionCoverage {
  totalFiles: number;
  totalHunks: number;
  plannedFiles: number;
  plannedHunks: number;
  unmappedHunks: DiffHunkRef[];
}
```

`partId` 建议使用稳定格式：

```text
<safeCaseId>-p<NN>-<scopeHash8>
```

### 6.2 分片策略

1. 读取 DiffSurface 中全部文件和 hunk。
2. 从 `RepoContext.packageNameByFile` 获取包归属。
3. 新增或删除文件从路径推导包名。
4. 同包、同目录、同顶层类型的变更优先合并。
5. 每片不超过 10 文件、2,000 变更行。
6. 单文件仍超限时按 hunk 切分，并保留完整文件头。
7. 所有排序使用路径、hunk 起始行和 hunkKey 作为稳定 tie-break。
8. 超过最大分片数或总文件上限时明确标记 out-of-domain。

首版建议：

```text
maxFilesPerPart = 10
maxChangedLinesPerPart = 2000
maxParts = 6
maxTotalFiles = 60
```

`maxParts` 是父 Job 超时和 worker 资源的保护闸，不是最终产品常量；需根据真实 MR 的 P95 耗时重新标定。

### 6.3 跨文件依赖

首版优先使用低成本的静态分组：

- 同 Java 包；
- 同目录；
- 同顶层类型；
- 同一变更方法名。

不建议首版构建全量跨文件依赖图。对于接口定义和调用点分属不同目录的情况：

- 若能从已有符号索引低成本识别，优先同片；
- 若无法识别，必须通过跨分片一致性测试和父级聚合降低漏检风险；
- 后续再引入 `CrossPartDependencyCheck`。

### 6.4 不支持与降级

以下情况不自动切分：

- DiffSurface 无法完整解析；
- 二进制变更；
- 纯重命名；
- hunk 结构损坏；
- 分片数超过硬上限。

这些情况维持当前整体执行与 `domainWarning` 行为，不能生成看似完整但实际缺片的结果。

## 7. 分片执行协调

### 7.1 首版拓扑

首版在当前 worker 内顺序执行分片：

```text
PartitionedReviewCoordinator
  for part of plan.parts:
    runSingleReview(part.diffText)
    collect result
  merge findings
  build parent result
```

不在 worker 内创建新 worker 池，避免：

- 嵌套线程池；
- 并发数与 server 配置冲突；
- 大仓内存成倍放大；
- 取消和 drain 语义复杂化。

### 7.2 取消

- 父 `AbortSignal` 向当前分片透传。
- 取消时停止后续分片。
- 已完成的子结果保留为审计证据，但父 Job 不投影为成功。
- 取消语义沿用当前 `ReviewAbortedError`。

### 7.3 单分片失败

- 单分片失败不立即终止其他分片。
- 父结果必须包含失败分片列表。
- `coverage.complete=false`。
- 成功分片的 Finding 仍可输出，但消费方必须看到不完整标记。
- 若全部分片失败，父 Job 仍按失败处理。

### 7.4 超时与预算

- `maxParts` 控制最坏执行时长。
- 每片沿用当前六阶段、5 轮、6 次工具调用硬上界。
- 父结果聚合所有分片 usage。
- 首版不动态放宽 server 的 60 分钟超时。
- 超过工时预算的 MR 应显式 out-of-domain，而不是等待超时。

### 7.5 进度事件

在内核进度契约尾部增加可选字段：

```ts
interface ReviewRunProgress {
  phase: ReviewPhase;
  round: number;
  toolCalls: number;
  usage?: LlmUsage;
  partIndex?: number;
  partCount?: number;
}
```

不改变现有事件含义；单分片运行时两个字段缺席。

## 8. Finding 身份与去重

### 8.1 去重目标

去重判断标准不是“标题是否相似”，而是：

> 两条 Finding 是否指向同一个根因，并应由同一个修复动作解决。

### 8.2 FindingIdentity

```ts
interface FindingIdentity {
  file: string;
  newLine: number;
  hunkKey?: string;
  mappedOldLine?: number;
  enclosingSymbol?: string;
  category: string;
  rule: string;
  evidenceRefs: EvidenceRef[];
  normalizedTitle: string;
  normalizedDescription: string;
  sourceFindingId: string;
  sourcePartId?: string;
}

interface EvidenceRef {
  kind: "path-line" | "path-range" | "identifier" | "text";
  file?: string;
  startLine?: number;
  endLine?: number;
  value: string;
  normalizedHash: string;
}
```

身份推导顺序：

1. 将 Finding 路径规范化为 POSIX 相对路径；
2. 通过 hunk 的 new 侧范围定位所属 hunk；
3. 尝试映射到 old 侧行号；
4. 若文件存在于 base 快照，读取符号索引并查找 enclosing symbol；
5. 解析证据中的 `path:line`、`path:start-end`、标识符和剩余文本；
6. 对 title、description 和 evidence 做大小写、空白和标点归一化；
7. 不保存模型完整推理文本，只保存去重所需特征。

### 8.3 三层去重

#### 第一层：精确去重

满足以下条件时合并：

- 同文件；
- 同 hunk 或行窗口重叠；
- 同 category；
- 同 rule；
- 规范化证据完全重合或高度重合。

#### 第二层：结构去重

按以下桶分组，避免全量两两比较：

```text
file + hunkKey + category
```

桶内评分维度：

| 维度 | 作用 |
|---|---|
| 同 enclosing symbol | 强结构信号 |
| 证据引用交集 | 强结构信号 |
| 同 rule | 中等结构信号 |
| title token Jaccard | 辅助信号 |
| description token Jaccard | 辅助信号 |
| severity 兼容性 | 冲突抑制 |

建议初始判定：

- 同 hunk + 同 rule + 证据重合：合并；
- 同 enclosing symbol + 证据重合：合并；
- 同位置但描述根因不同：保留，标记 related；
- 结构分处于灰区：首版保留，不自动合并；
- 文本相似但证据无交集：默认不合并。

#### 第三层：受限语义裁决

第三层不是首版必需项。启用时必须满足：

- 只处理结构灰区的候选对；
- 每 Job 设置最大裁决对数；
- 只输入标题、描述、文件、hunk、证据和 category；
- 不输入全仓源码；
- 输出 `merge` / `keep-separate` / `uncertain`；
- `uncertain` 默认保留；
- 每次裁决记录模型、prompt version、输入 hash 和理由；
- 不把裁决结果当作 Finding 真值。

### 8.4 聚类结构

```ts
interface FindingCluster {
  clusterId: string;
  canonicalFinding: Finding;
  members: FindingMember[];
  conflicts: FindingConflict[];
}

interface FindingMember {
  finding: Finding;
  identity: FindingIdentity;
  sourcePartId?: string;
  sourceRunId?: string;
}

interface FindingConflict {
  field: "severity" | "category" | "rule" | "line";
  values: string[];
}
```

### 8.5 合并规则

- canonical ID 选择确定性规则，例如最高置信度优先，置信度相同时按 `sourceRunId + findingId` 排序。
- severity 取最高级别，并记录冲突。
- evidence 取并集，按规范化 hash 稳定排序。
- title / description 不做模型改写，选择最高置信度成员原文。
- category 或 rule 不一致时不自动合并。
- 来自不同分片的成员保留 `sourcePartId`。
- 所有成员原始 Finding 必须保留。

### 8.6 输出语义

- `findings`：去重后的最终 Finding，用于 CLI、server、disposition。
- `findingClusters`：审计伴生数据，用于追溯合并关系。
- `rawFindings`：只在发生合并时落盘，保存原始成员完整内容。
- 旧消费方仍只读取 `findings`。

## 9. 审计与 RunRecord 扩展

### 9.1 向后兼容原则

- 只新增可选尾键；
- 不修改现有必填字段；
- 不改变旧记录读取路径；
- 历史 A–D RunRecord 只读兼容不变；
- 新写记录仍为 Config E。

### 9.2 新增审计结构

```ts
interface PartitionAudit {
  strategyVersion: string;
  plan: ReviewPartitionPlan;
  parts: PartitionRunRecord[];
  coverage: {
    complete: boolean;
    succeededParts: number;
    failedParts: string[];
    skippedParts: string[];
  };
}

interface DedupAudit {
  strategyVersion: string;
  inputFindings: number;
  outputFindings: number;
  clusters: FindingCluster[];
  rawFindings: Finding[];
}
```

父审计可在尾部增加：

```text
partition?: PartitionAudit
dedup?: DedupAudit
```

父 RunSnapshot 可在尾部增加：

```text
coverage?: ReviewCoverage
partition?: PartitionSummary
dedup?: DedupSummary
```

### 9.3 落盘布局

建议保持父 Job 路径不变，并增加子产物：

```text
<runsRoot>/<experimentId>/
  audit/vul4j/<caseId>/E/rep-1/audit/<parent-run>.json
  runs/vul4j/<caseId>/E/rep-1.json
  partitions/<caseId>/
    partition-plan.json
    <partId>/
      audit/
      run-record.json
  dedup/<caseId>/<parent-run>-dedup.json
```

父 Job 的 artifact 接口仍返回父审计和父记录；分片产物作为内部追溯资料。

## 10. 执行入口改造

### 10.1 内部拆分

当前 `runReview` 同时承担执行与持久化。建议内部拆为：

```ts
runSingleReview(input): Promise<SingleReviewResult>
persistSingleReview(input, result): Promise<PersistedReviewResult>
runPartitionedReview(input): Promise<PartitionedReviewResult>
runReview(input): Promise<ReviewRunResult>
```

`runReview` 负责：

1. 解析 DiffSurface；
2. 判断边界；
3. 界内执行单次 Review；
4. 超界执行分片；
5. 运行去重；
6. 写父审计和父记录；
7. 返回兼容结果。

### 10.2 外部入口

- CLI：不改 `--mr` 参数。
- stdio：不改 `review.submit` 参数。
- HTTP：不改协议 v3。
- server worker：不改 `ReviewRunExecutor` 接口。
- `ReviewRunSummary` 只新增可选 coverage / dedup 摘要，不改变 findings 主字段。

### 10.3 幂等

分片计划与去重策略版本必须参与内部稳定身份：

```text
caseId + input diff hash + modelId + review policy version +
partition strategy version + dedup strategy version
```

HTTP 现有幂等键仍按协议执行，不将内部版本暴露给调用方。

## 11. 实施阶段

### Phase 0：结构化 Diff 与契约

- 新增 DiffSurface；
- 新增 partition / identity / cluster 契约；
- 统一边界护栏与分片器的 diff 口径；
- 保持外部行为不变。

**验收**：现有测试全绿；相同 diff 解析结果稳定；界内 MR 行为不变。

### Phase 1：单 Job 精确与结构去重

- 从当前 E Review 的 Finding 推导 FindingIdentity；
- 实现精确去重与结构去重；
- 增加 DedupAudit；
- 不调用额外模型。

**验收**：重复 Finding 数量下降；同位置不同根因不被误合并；原始 Finding 可恢复。

### Phase 2：分片计划 Dry Run

- 实现 ReviewPartitionPlanner；
- 只生成计划和覆盖报告；
- 不执行分片。

**验收**：11 文件或 2,001 变更行 MR 生成有效分片；所有 hunk 均被覆盖或显式列出未覆盖原因；计划确定性。

### Phase 3：顺序分片执行

- 实现 PartitionedReviewCoordinator；
- 在 worker 内顺序执行；
- 父结果聚合 usage、findings、coverage；
- 增加取消、失败和超时测试。

**验收**：分片执行可取消；单分片失败可追溯；父结果不伪装完整成功。

### Phase 4：跨分片去重

- 对分片 Finding 执行统一去重；
- 保留源分片和原始 Finding；
- 在审计中记录 cluster 和冲突。

**验收**：跨分片重复被合并；不同根因不被误合并；每个最终 Finding 可回溯到至少一个分片。

### Phase 5：受限语义裁决

- 只对结构灰区候选对启用；
- 设置调用预算；
- 记录模型、prompt、输入 hash 和理由；
- 默认 uncertain 不合并。

**验收**：误合并率接近零；额外 Token 成本可量化；关闭语义裁决时系统行为完整可用。

## 12. 测试策略

### 12.1 Diff 与分片

- 单文件单 hunk；
- 单文件多 hunk；
- 多文件同包；
- 多文件跨包；
- 新增文件；
- 删除文件；
- 二进制；
- 纯重命名；
- hunk 体出现 `---` / `+++` 文本；
- 损坏 hunk；
- 11 文件边界；
- 2,001 变更行边界；
- 超过 maxParts。

### 12.2 去重

- 同 ID 重复；
- 不同 ID、同根因；
- 同文件不同行、同根因；
- 同文件同行、不同根因；
- 同证据不同描述；
- 同描述不同证据；
- 跨分片重复；
- 不同 severity 冲突；
- 不同 category / rule。

### 12.3 执行

- 第一个分片成功、第二个失败；
- 取消发生在第二个分片；
- 分片超时；
- worker 回收；
- 父 Job 重启；
- 相同输入重复执行结果稳定；
- 父审计可恢复全部原始 Finding。

### 12.4 回归

- 界内 MR 输出与当前一致；
- 旧 RunRecord 读取不受新字段影响；
- disposition 继续按最终 Finding ID 工作；
- CLI / stdio / HTTP 单文档与事件契约不变；
- 现有零网络 CI 纪律不破坏。

## 13. 验收指标

### 13.1 功能

- 可切分大 MR 的分片覆盖率 100%，或显式说明未覆盖片段。
- 每个分片不超过验证域。
- 部分失败父 Job 不显示 `coverage.complete=true`。
- 原始 Finding、合并关系、来源分片可追溯。

### 13.2 质量

- 分片前后 Recall 不下降。
- 重复 Finding 数量显著下降。
- 人工抽检的误合并率接近零。
- 同位置不同根因不得合并。

### 13.3 成本

- 记录分片数、每片 usage、总 usage、总耗时、缓存命中。
- 精确与结构去重阶段零额外模型调用。
- 语义裁决阶段有明确调用上限。

## 14. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| 切分破坏跨文件上下文 | 漏检跨文件缺陷 | 同包优先、同符号优先、跨分片测试集 |
| 去重误合并 | 漏报真实不同问题 | 默认保留、证据优先、语义裁决 uncertain 不合并 |
| 父 Job 超时 | 大 MR 无法完成 | maxParts、out-of-domain、后续服务层 fan-out |
| 审计文件膨胀 | 存储增长 | rawFindings 只在实际合并时落盘 |
| 行号映射错误 | 身份推导错误 | 映射不可靠时禁用符号强信号 |
| 分片顺序不稳定 | 重试和缓存漂移 | 路径 + hunkKey + 行号稳定排序 |
| 部分失败被误读 | 平台错误展示 | coverage 必填摘要、父结果显式标记 |

## 15. 暂缓事项

以下事项明确不在本方案首版范围：

- 平台 Review Job 与 Webhook；
- `CodePlatformAdapter`；
- 平台评论与 Check 发布；
- 服务层子 Job 并行执行；
- 多实例 lease / fence；
- 构建、测试和隔离容器；
- 向量检索和 embedding；
- 在线自修改 Prompt 或工具集。

分片协调器从首版开始保持平台无关。未来接入平台时，Adapter 只负责把平台事件转换为当前 ReviewRequest 和 workspace，不需要改变分片、去重与父结果契约。

## 16. 开放问题

以下参数需要在实现前或 Dry Run 阶段用真实 MR 数据标定：

1. `maxParts` 与 server 60 分钟超时的安全关系；
2. 父 Job 顺序执行是否需要改为服务层 fan-out；
3. canonical Finding ID 的最终选择规则；
4. 分片失败时是否允许发布成功分片结果；
5. 语义裁决采用同模型、轻量模型还是 embedding；
6. 跨文件依赖是否需要首版引入 `CrossPartDependencyCheck`；
7. `rawFindings` 的保留周期和 artifact 清理策略。

## 17. 推荐决策

1. 先实现 Phase 0–2，再做 Phase 3。
2. 精确与结构去重先于语义裁决上线。
3. 首版分片在 worker 内顺序执行，硬限制分片数。
4. 不发协议 v4，不引入平台字段。
5. Finding 必填 Schema 不变，身份和聚类只进审计伴生层。
6. 分片和去重均以确定性、可追溯、安全默认保留为首要原则。
