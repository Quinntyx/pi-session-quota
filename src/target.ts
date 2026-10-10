import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { QuotaClient, type FetchLike, quotaEndpoint } from "./quota-client.js";

function hasHeader(headers: Record<string, string>, expected: string): boolean {
  const lower = expected.toLowerCase();
  return Object.keys(headers).some((name) => name.toLowerCase() === lower);
}

export function isCliProxyApiProvider(provider: string): boolean {
  return provider.trim().toLowerCase() === "cliproxyapi";
}

export async function quotaClientForContext(
  ctx: ExtensionContext,
  fetchImpl: FetchLike = globalThis.fetch,
): Promise<QuotaClient> {
  const model = ctx.model;
  if (!model) throw new Error("No active model; select a CLIProxyAPI-backed model first");
  if (!isCliProxyApiProvider(model.provider)) {
    throw new Error(`Active provider "${model.provider}" is not CLIProxyAPI`);
  }
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new Error(auth.error);

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(auth.headers ?? {})) {
    if (value !== null) headers[name] = value;
  }
  if (auth.apiKey && !hasHeader(headers, "authorization")) {
    headers.authorization = `Bearer ${auth.apiKey}`;
  }

  return new QuotaClient(
    {
      endpoint: quotaEndpoint(auth.baseUrl ?? model.baseUrl),
      headers,
    },
    fetchImpl,
  );
}
