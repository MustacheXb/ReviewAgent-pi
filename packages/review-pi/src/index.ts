// review-pi：pi 内核线 Review Runtime（#3，ADR-0009）。
//
// 内核变量面从 0 重写：controller（六阶段直驱）、Zone A/B/C 组装、
// findings 解析与审计投影，全部落在 pi 原语（@earendil-works/pi-ai）上。
// 测量常量面（Zone A 文案、Zone B 配比、六阶段语义、Finding/Evidence 契约）
// 以 DSH 线审计真源为黄金基准复刻，见 testdata/golden/。
//
// 模块随 TDD 循环逐个落地，公开导出按模块补齐。
export {};
