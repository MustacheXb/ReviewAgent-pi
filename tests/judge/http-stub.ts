/**
 * Judge 客户端 HTTP 测试替身：注入式 fetch stub + 响应构造器
 * （P4b #9 自退役的 deepseek-stub.ts 平移——createFetchStub / createSleepRecorder /
 * jsonResponse / httpErrorBody 原样保留，唯一在位消费者 = judge 客户端测试）。
 */

export interface RecordedFetchRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

export type StubHandler = (
  request: RecordedFetchRequest,
  index: number,
) => Response | Promise<Response>;

export interface FetchStub {
  readonly fetch: typeof fetch;
  readonly requests: readonly RecordedFetchRequest[];
}

type FetchInput = Parameters<typeof fetch>[0];

/** 可编程 fetch stub：按调用序号返回脚本化 Response；抛错即模拟网络失败 */
export function createFetchStub(handler: StubHandler): FetchStub {
  const requests: RecordedFetchRequest[] = [];
  const stub = async (input: FetchInput, init?: RequestInit): Promise<Response> => {
    const request: RecordedFetchRequest = {
      url: typeof input === "string" ? input : String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? init.body : "",
    };
    requests.push(request);
    return handler(request, requests.length - 1);
  };
  return { fetch: stub, requests };
}

/** 记录退避延时的 sleep stub（零等待） */
export function createSleepRecorder(): {
  readonly sleep: (ms: number) => Promise<void>;
  readonly delays: readonly number[];
} {
  const delays: number[] = [];
  return {
    sleep: (ms: number) => {
      delays.push(ms);
      return Promise.resolve();
    },
    delays,
  };
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** 构造一条 OpenAI 风格错误响应体（{"error":{...}}） */
export function httpErrorBody(message: string, code?: string): unknown {
  return { error: { message, ...(code !== undefined ? { code } : {}) } };
}
