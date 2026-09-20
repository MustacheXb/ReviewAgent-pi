/**
 * review-pi CLI 运行时产物面（实现见同目录 cli-runtime.js，纯 node 内建
 * 零依赖——bin 在 dist 可信之前运行不能 import 构建产物）。
 * 消费方：bin/review-pi.js 与进程烟测 src/cli/bin.process.test.ts（自愈
 * 构建按腿判鲜，与 bin 同一真源，防两处漂移）。
 */

/** 一条运行时产物腿：入口文件 + 源树 + 构建命令 */
export interface RuntimeLeg {
  readonly label: string;
  readonly entry: string;
  readonly sourceRoots: readonly string[];
  readonly buildCommand: string;
}

/** 拒跑项：腿 + 拒因（缺席 / 过期） */
export interface RuntimeArtifactRefusal extends RuntimeLeg {
  readonly kind: "missing" | "stale";
}

/** 在位 + 判鲜检查结果（全腿报告） */
export type RuntimeArtifactCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly refusals: readonly RuntimeArtifactRefusal[] };

/** 本包 CLI 编译入口（bin 的 spawn 目标） */
export declare const CLI_COMPILED_ENTRY: string;

/** 运行时产物腿表（label / 入口 / 源树 / 构建命令） */
export declare function runtimeLegs(): readonly RuntimeLeg[];

/** 在位 + 判鲜检查：任一腿缺席/过期即拒跑 */
export declare function checkRuntimeArtifacts(): RuntimeArtifactCheck;

/** 拒跑文案（stderr，含每腿构建指引） */
export declare function renderRefusals(refusals: readonly RuntimeArtifactRefusal[]): string;
