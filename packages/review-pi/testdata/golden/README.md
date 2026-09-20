# 黄金基准（golden fixtures）

测量常量面的字节真源，提取自 DSH 线 t-series 审计记录（测量产物，而非源码转写）：
B 线族提取自 config B rep-1 审计的 req0 messages，A 线族提取自同实验 config A
rep-1 审计的 requests[].wireBody 原文——提取源与方式见下文「提取源」，
均按原文/`content` 字节落文件，未做任何改写。

## 文件清单

| 文件 | 内容 | 案例相关性 |
| --- | --- | --- |
| `system-prompt.txt` | Zone A 系统提示（2317 字节，跨 MR 字节稳定） | 案例无关 |
| `phase-1.txt` … `phase-6.txt` | 六阶段指令消息（"Phase N of 6 - <名称>." 起头） | 案例无关 |
| `zone-b-vul4j-1.txt` | VUL4J-1 的 Zone B 全文（14754 字节） | 案例相关 |
| `mr-message-vul4j-1.txt` | VUL4J-1 的 MR 用户消息 | 案例相关 |
| `vul4j-1.diff` | VUL4J-1 的统一 diff（自 MR 消息 ```diff 围栏内字节提取；空上下文行为单空格） | 案例相关 |
| `prefetch-{1,2,3}-vul4j-1.txt` | VUL4J-1 预取三层（Symbol/Reference/CallChain） | 案例相关 |
| `reply-{1..5}-vul4j-1.txt` | DSH B 线六请求回复 1–5（config B 语境） | 案例相关 |
| `expected-baseline-vul4j-1-b.json` | B 线期望基线（findings/rejections/phaseLog/prefetch 记账） | 案例相关 |
| `wire-req0-vul4j-1.json` | DSH B 线 req0 wireBody 原文 | 案例相关 |
| `wire-a-req{0..5}-vul4j-1.json` | DSH **A 线**六请求 wireBody 原文（P2 字节门 CI 对照真源） | 案例相关 |
| `reply-a-{1..5}-vul4j-1.txt` | DSH **A 线**回复 1–5（自 wire-a-req{1..5} 的 messages[-2] 提取） | 案例相关 |

## 提取源

- B 线族（`zone-b` / `mr-message` / `prefetch-*` / `reply-*` / `expected-baseline` / `wire-req0`）：
  `runs/phase2-dsh-t1/audit/vul4j/VUL4J-1/B/rep-1/audit/20260914T180846.922-B-VUL4J-1.json`。
- A 线族（`wire-a-*` / `reply-a-*`，#5 P2 字节门）：同实验 config A rep-1 审计
  （`runs/phase2-dsh-t1/audit/vul4j/VUL4J-1/A/rep-1/audit/`）。
  `wire-a-req<N>` = requests[N].wireBody 序列化点原文（未改写、无尾随换行）；
  `reply-a-<N>` = wire-a-req<N> 的 messages[-2].content（下一请求携带的真实回复）。
  终局回复（phase-6）不进任何请求，由门内合成（verdicts 空 + complete true）。
- 源审计均 gitignored（本机 runs/ 目录；迁移自 DSH 兄弟仓 phase2 实测）。

## 纪律

- 这些文件是**测量常量**：pi 内核线复刻组装面必须与之字节一致（P1a 断言；
  P2 正式字节门在此之上建门，对照 DSH 审计真源）。
- `wire-a-*` 族是 P2 字节门的 **CI 常开对照真源**（config A 零预取零工具，
  不依赖 gitignored 快照即可全链重放对照）；`byte-gate-control.gate.ts` 消费。
- 方言对照（空回复路径）在**运行时**对 `wire-a-req5` 做最小字节手术
  （reply-5 的 assistant content → null）并以空串重放——镜像
  t2/VUL4J-79/B/rep-2 的真源形状（DSH `content:null` ↔ pi 省略该消息）；
  fixture 文件本身不改写。
- 修改任何一份文件都需要显式变更记录（它们不是可自由调参的测试数据）。
- 案例无关文件（system-prompt、phase-N）用于一切组装测试；案例相关文件
  仅用于 VUL4J-1 全链对照，且依赖根仓 `data/` 的同源快照。
