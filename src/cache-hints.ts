/** Recent successful Pi usage is an admission estimate, never a billing record. */
export const INPUT_TOKENS_HEADER = "X-CLIProxyAPI-Quota-Input-Tokens";
export const CACHED_TOKENS_HEADER = "X-CLIProxyAPI-Quota-Cached-Tokens";

type Entry = { type?: string; id?: string; targetId?: string; message?: {
  role?: string; stopReason?: string; provider?: string; model?: string;
  content?: unknown; usage?: { input?: number; cacheRead?: number; cacheWrite?: number; output?: number };
} };

export function cacheHints(branch: unknown[], provider: string, model: string): Record<string, string> {
  const entries = branch as Entry[];
  let index = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    const message = entries[i].message;
    if (message?.role === "assistant" && message.stopReason !== "error" && message.stopReason !== "aborted" && message.usage) {
      index = i;
      break;
    }
  }
  if (index < 0) return {};
  const message = entries[index].message!;
  if (message.provider !== provider || message.model !== model) return {};
  const usage = message.usage!;
  const counts = [usage.input ?? 0, usage.cacheRead ?? 0, usage.cacheWrite ?? 0, usage.output ?? 0];
  if (counts.some(value => !Number.isFinite(value) || value < 0)) return {};
  const [input, cached, cacheWrite, output] = counts;
  if (input + cached + cacheWrite <= 0) return {};
  let added = 0;
  for (const entry of entries.slice(index + 1)) {
    if (entry.type === "compaction" || entry.type === "model_change" || entry.type === "branch_summary") return {};
    if (entry.type === "context_edit") {
      // Removing our quota failure does not change the successful prompt prefix.
      const target = entries.find(item => item.id === entry.targetId)?.message;
      if (target?.role !== "assistant" || target.stopReason !== "error") return {};
    }
    const next = entry.message;
    if (!next || next.stopReason === "error" || next.stopReason === "aborted") continue;
    added += Math.ceil(Buffer.byteLength(JSON.stringify(next.content ?? next), "utf8") / 3);
  }
  // Previous output is part of the next input. Include new messages/tool results,
  // envelope headroom, and a 10% cache-prefix safety margin. A real cache miss is
  // billed using actual usage by the proxy, never using these estimates.
  return {
    [INPUT_TOKENS_HEADER]: String(Math.ceil(input + cached + cacheWrite + output + added + 1024)),
    [CACHED_TOKENS_HEADER]: String(Math.floor(cached * 0.9)),
  };
}
