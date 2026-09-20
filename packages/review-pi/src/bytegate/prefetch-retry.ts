// P2 字节纪律门(#5)——预取瞬态失败重试(门 harness 韧性,非产品代码)。
//
// 实测两例:rg 30s 单搜超时在本机盘争用下瞬时复发(solo t2 探针、全量
// t4 beforeAll;5 门文件并行预取 × Defender 实时扫描放大)。预取是
// 确定性纯函数(同输入字节相同),重试产物与一次成功无差,不进对照面
// 噪声;仅对 rg 超时特征错误退避重试一次(等扫描积压排空),其余错误
// 直通上抛——真失败不掩盖。

/** rg 超时错误特征(裸错误与上游包装错误均含该子串) */
export function isRipgrepTimeout(error: unknown): boolean {
  return error instanceof Error && error.message.includes("ripgrep timed out");
}

/** 退避时长:等盘争用(Defender 扫描积压)排空再重试 */
export const TRANSIENT_SEARCH_RETRY_BACKOFF_MS = 60_000;

/** 瞬态(rg 超时)失败退避后整算一次;其余错误直通(不重试不掩盖) */
export async function retryTransientSearch<T>(
  attempt: () => Promise<T>,
  backoffMs: number = TRANSIENT_SEARCH_RETRY_BACKOFF_MS,
): Promise<T> {
  try {
    return await attempt();
  } catch (error) {
    if (!isRipgrepTimeout(error)) {
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, backoffMs));
    return attempt();
  }
}
