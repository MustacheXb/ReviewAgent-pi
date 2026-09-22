/**
 * 网关 prefix cache 门参数探针（#18 调查产物，2026-09-23）。
 *
 * 用途：对 REVIEWER_URL 网关（pi 线被测模型接入点）实测 chat/completions 的
 * 前缀缓存命中行为——「P1 冷发 → 2s → P2 append（共享前缀 = P1 全文）→ 读 P2
 * 的 prompt_cache_hit_tokens」。四组前缀扫描（~1.0k / 1.5k / 2.5k / 4.5k token），
 * 判定当前时段网关的最小前缀门与命中对齐粒度。
 *
 * 背景（2026-09-23 时点实测，火山网关 volceapi.com / deepseek-v4-flash）：
 * 共享前缀 ≤2.5k token 全零命中；4.4k 命中 4,096（2,048 对齐）。S1 的 A 配置
 * 六阶段每请求仅 0.85–3.1k token，结构性过不了门（cacheHit 8.1%）；B/C/D/E
 * 大请求（4k+）正常命中（49–81%）。DSH s1（2026-09-13 同端点）为 64 块低门
 * 行为——网关策略时段性变更，跨时段 cache 列对比需加时段限定（#18）。
 *
 * #17 全量执行前建议跑一轮本探针，把当前门参数留痕进运行记录。
 *
 * 纪律：凭据只从 .env.local 装载（REVIEWER_API_KEY / REVIEWER_URL，缺省回退
 * DEEPSEEK_* 别名），key 值绝不回显；输出仅组名与 usage 数字。真实网关调用，
 * 不进 CI（零网络纪律，#28）。
 *
 * 运行（仓库根执行；与 collect-clean-mrs.ts 同一编译模式）：
 *   pnpm exec tsc --module NodeNext --moduleResolution NodeNext --target ES2023 \
 *     --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --skipLibCheck \
 *     --outDir .tmp-gen scripts/probe-gateway-cache.ts
 *   node .tmp-gen/scripts/probe-gateway-cache.js && rm -rf .tmp-gen
 *
 * 退出码：0 成功；1 凭据缺失或任一请求失败。
 */
import { loadEnvLocalFile } from "../src/instrument/env-local.js";

const MODEL = "deepseek-v4-flash";
const SYSTEM = "You are a cache probe. Follow the user instruction exactly.";

/** 前缀扫描组：filler 字符数按 ~4.1 chars/token 折算目标 token 数 */
const GROUPS = [
	{ name: "1.0k", fillerChars: 4100 },
	{ name: "1.5k", fillerChars: 6400 },
	{ name: "2.5k", fillerChars: 10600 },
	{ name: "4.5k", fillerChars: 18600 },
] as const;

/** P2 的 assistant 中间消息（pi 生产形态：带 reasoning_content 回传） */
const ASSISTANT = {
	role: "assistant",
	content: "Understood. Ready for the next instruction.",
	reasoning_content: "The user asked me to remember the text. I will simply acknowledge and wait.",
} as const;

interface WireMessage {
	readonly role: "system" | "user" | "assistant";
	readonly content: string;
	readonly reasoning_content?: string;
}

/** 网关 usage 方言并集（DeepSeek prompt_cache_hit_tokens / OpenAI prompt_tokens_details.cached_tokens） */
interface UsageShape {
	readonly prompt_tokens?: number;
	readonly completion_tokens?: number;
	readonly prompt_cache_hit_tokens?: number;
	readonly cached_tokens?: number;
	readonly prompt_tokens_details?: { readonly cached_tokens?: number };
}

function isUsageShape(value: unknown): value is UsageShape {
	return typeof value === "object" && value !== null;
}

function cacheHitOf(usage: UsageShape | null): number {
	if (usage === null) {
		return -1;
	}
	return (
		usage.prompt_tokens_details?.cached_tokens ??
		usage.prompt_cache_hit_tokens ??
		usage.cached_tokens ??
		0
	);
}

/** 确定性填充：每组唯一 tag 防跨组前缀污染 */
function filler(tag: string, targetChars: number): string {
	const unit = "The quick brown fox jumps over the lazy dog while reviewing a patch in the repository. ";
	let text = `[${tag}] `;
	let index = 0;
	while (text.length < targetChars) {
		text += `[${index++}] ${unit}`;
	}
	return text;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 单次 chat/completions 调用（pi 生产形态：流式 + zai thinking + stream_options） */
async function call(
	url: string,
	apiKey: string,
	messages: readonly WireMessage[],
): Promise<UsageShape | null> {
	const body = {
		model: MODEL,
		messages,
		thinking: { type: "enabled", clear_thinking: false },
		reasoning_effort: "high",
		max_tokens: 512,
		stream: true,
		stream_options: { include_usage: true },
	};
	const response = await fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
		body: JSON.stringify(body),
	});
	if (!response.ok) {
		throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
	}
	// SSE：usage 在 include_usage 的末尾 chunk；取最后一个带 usage 的帧
	const text = await response.text();
	let usage: UsageShape | null = null;
	for (const line of text.split("\n")) {
		if (!line.startsWith("data: ")) {
			continue;
		}
		const payload = line.slice(6).trim();
		if (payload === "[DONE]") {
			continue;
		}
		try {
			const parsed: unknown = JSON.parse(payload);
			if (typeof parsed === "object" && parsed !== null && "usage" in parsed) {
				const maybeUsage = (parsed as { usage?: unknown }).usage;
				if (isUsageShape(maybeUsage)) {
					usage = maybeUsage;
				}
			}
		} catch {
			// 忽略非 JSON 帧（keep-alive 等）
		}
	}
	return usage;
}

async function main(): Promise<number> {
	const envSummary = loadEnvLocalFile(".env.local");
	const baseUrl = process.env.REVIEWER_URL ?? process.env.DEEPSEEK_URL;
	const apiKey = process.env.REVIEWER_API_KEY ?? process.env.DEEPSEEK_API_KEY;
	if (baseUrl === undefined || baseUrl === "" || apiKey === undefined || apiKey === "") {
		console.error(
			`missing REVIEWER_URL / REVIEWER_API_KEY (env.local: ${envSummary.exists ? `loaded ${envSummary.loadedKeys.join(", ") || "nothing"}` : "absent"}); run from repo root`,
		);
		return 1;
	}
	const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;

	let maxMiss = 0;
	let minHit: number | null = null;
	for (const group of GROUPS) {
		const user1 = `${filler(group.name, group.fillerChars)}\n\nReply with exactly: OK`;
		const p1 = await call(url, apiKey, [
			{ role: "system", content: SYSTEM },
			{ role: "user", content: user1 },
		]);
		await sleep(2000);
		const p2 = await call(url, apiKey, [
			{ role: "system", content: SYSTEM },
			{ role: "user", content: user1 },
			{ role: "assistant", content: ASSISTANT.content, reasoning_content: ASSISTANT.reasoning_content },
			{ role: "user", content: "Now reply with exactly the single word: OK" },
		]);
		const p1Hit = cacheHitOf(p1);
		const p2Hit = cacheHitOf(p2);
		if (p2Hit > 0) {
			minHit = minHit === null ? p2Hit : Math.min(minHit, p2Hit);
		} else {
			maxMiss = Math.max(maxMiss, p2?.prompt_tokens ?? 0);
		}
		console.log(
			`${group.name} | P1 prompt=${p1?.prompt_tokens ?? "?"} hit=${p1Hit < 0 ? "?" : p1Hit} | P2 prompt=${p2?.prompt_tokens ?? "?"} hit=${p2Hit < 0 ? "?" : p2Hit}`,
		);
	}
	console.log(
		`gate: shared-prefix <= ${maxMiss} token -> miss${minHit === null ? "" : `; >= gate -> hit ${minHit} (aligned)`}; 2026-09-23 baseline: <=2.5k miss / 4.4k hit 4096`,
	);
	return 0;
}

process.exit(await main());
