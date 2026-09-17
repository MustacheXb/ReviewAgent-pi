import { defineConfig } from "vitest/config";

// 上游 telemetry 无本地 vitest 配置（依赖默认 include 覆盖 test/**）；本仓根
// vitest.config.ts 携带自定义 include（src/**, tests/**）且会被向上查找应用，
// 空壳本地配置切断继承、恢复默认 include（fork 增量文件，见分支基线方案）。
export default defineConfig({
	test: {
		environment: "node",
	},
});
