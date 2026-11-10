# 设计方案索引

本目录按主题收纳 ReviewAgent-pi 的工程设计、方案讨论、内核分析和接入说明。文件名保持原样，分类只负责导航。

## 1. 总体架构

| 文档 | 定位 |
|---|---|
| [基于pi 的 ReviewAgent总体架构设计方案文档讨论](<./01-architecture/基于pi 的 ReviewAgent总体架构设计方案文档讨论.md>) | Pi 方案的讨论输入 |
| [基于 Pi 内核的 Review Agent 总体架构设计方案](<./01-architecture/基于 Pi 内核的 Review Agent 总体架构设计方案.md>) | 当前主线的架构 spec 真源 |
| [基于 DeepSeek Harness 的 Review Agent 架构设计方案过程讨论](<./01-architecture/基于 DeepSeek Harness 的 Review Agent 架构设计方案过程讨论.md>) | DSH 线过程讨论 |
| [基于 DeepSeek Harness 的 Review Agent 总体架构设计方案](<./01-architecture/基于 DeepSeek Harness 的 Review Agent 总体架构设计方案.md>) | DSH 线历史架构基线 |
| [ReviewAgent以DSH内核和PI内核的方案对比分析](<./01-architecture/ReviewAgent以DSH内核和PI内核的方案对比分析.md>) | Pi / DSH 内核选型对照 |

## 2. Agent 设计

| 文档 | 定位 |
|---|---|
| [ReviewAgent Token 优化方案](<./02-agent-design/ReviewAgent Token 优化方案——以 20~30% Token 成本达到通用 Agent 检视效果.md>) | 主线 E-only Token 效率方案 |
| [ReviewAgent 竞争力演进方案](<./02-agent-design/ReviewAgent 竞争力演进方案——对标 prime-agent 与 whale-pod 的 Token 效率、Loop 与自进化设计.md>) | Token、Loop 与经验沉淀的演进分析 |
| [ReviewAgent 语义去重与大 MR 检视方案](<./02-agent-design/ReviewAgent 语义去重与大 MR 检视方案.md>) | 大 MR 分片、Finding 去重与覆盖度设计稿 |
| [Config B 生产化方案](<./02-agent-design/Config B 生产化方案——差距分析、推荐路线与修改建议.md>) | 历史生产配置方案，需与当前 E-only 口径区分 |

## 3. 内核

| 文档 | 定位 |
|---|---|
| [pi 内核可行性分析](<./03-kernel/pi 内核可行性分析.md>) | Pi-first 选型的背景分析 |
| [Pi 内核从零实现方案](<./03-kernel/Pi 内核从零实现方案.md>) | Review Runtime 重写与 P0–P5 路线 |
| [Pi 内核定制基线方案](<./03-kernel/Pi 内核定制基线方案.md>) | vendored pi 的 fork 接线基线 |
| [Pi 内核 vendor 价值分析](<./03-kernel/Pi 内核 vendor 价值分析——为什么 vendor 而非 npm 或自写.md>) | vendor 决策与成本边界 |
| [Pi 内核演化缝盘点](<./03-kernel/Pi 内核演化缝盘点.md>) | 内核可修改面的 file:line 事实底座 |
| [Pi 内核上游更新影响分析](<./03-kernel/Pi 内核上游更新影响分析（vendor v0.85.1+11d × upstream v1.3.0）.md>) | 上游版本升级与 backport 影响面 |
| [DSH 内核机制偏差清单](<./03-kernel/DSH 内核机制偏差清单（npm 0.1.2-rc.1 × reference 0.1.5-alpha.1）.md>) | DSH 实测机制与参考实现的偏差记录 |

## 4. 接入与协议

| 文档 | 定位 |
|---|---|
| [ReviewAgent stdio JSONL 长驻模式实现方案](<./04-integration/ReviewAgent stdio JSONL 长驻模式实现方案.md>) | stdio 长驻调用形态 |
| [ReviewAgent RPC-HTTP-JSON-RPC Server 实现方案](<./04-integration/ReviewAgent RPC-HTTP-JSON-RPC Server 实现方案.md>) | HTTP / JSON-RPC 服务形态 |
| [ReviewAgent 企业内部模型网关接入需求规格](<./04-integration/ReviewAgent 企业内部模型网关接入需求规格.md>) | 企业模型网关的功能与计量要求 |
| [DeepSeek 官方 API 与火山引擎网关 token 消耗对比分析](<./04-integration/DeepSeek 官方 API 与火山引擎网关 token 消耗对比分析——面向企业内部模型网关的要求推导.md>) | 网关 token 计量差异与归因 |

## 5. 评测

| 文档 | 定位 |
|---|---|
| [VUL4J 评测方案与数据复制指南](<./05-evaluation/VUL4J 评测方案与数据复制指南.md>) | 数据集、实验矩阵、判定链与复现方式 |
| [ReviewAgent Token 优化评测基准方案](<./05-evaluation/ReviewAgent Token 优化评测基准方案——三层对照体系与 Claude Code 外部参照.md>) | L1/L2/L3 三层对照、E 前后配对与 Claude Code 外部参照 |

## 6. 项目策略

| 文档 | 定位 |
|---|---|
| [ReviewAgent-pi 分支策略（生产 main 与 Demo 分离）](<./06-project-strategy/ReviewAgent-pi 分支策略（生产 main 与 Demo 分离）.md>) | 生产线与 Demo 线的分支归属和同步规则 |
