import type { QuotaStatus, QuotaTarget } from "./types.js";

export type FetchLike = typeof globalThis.fetch;

export class QuotaApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "QuotaApiError";
  }
}

export function quotaEndpoint(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.pathname = "/v1/session-quota";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function isQuotaStatus(value: unknown): value is QuotaStatus {
  if (!value || typeof value !== "object") return false;
  const status = value as Partial<QuotaStatus>;
  return (
    typeof status.capacity === "number" &&
    typeof status.total_remaining === "number" &&
    typeof status.all_weekly_exhausted === "boolean" &&
    Array.isArray(status.buckets) &&
    typeof status.retry_after_seconds === "number" &&
    status.buckets.every(
      (bucket) =>
        bucket &&
        typeof bucket.session === "string" &&
        typeof bucket.cap === "number" &&
        typeof bucket.remaining === "number" &&
        typeof bucket.held === "number" &&
        typeof bucket.available === "number",
    )
  );
}

export class QuotaClient {
  constructor(
    readonly target: QuotaTarget,
    private readonly fetchImpl: FetchLike = globalThis.fetch,
  ) {}

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await this.fetchImpl(`${this.target.endpoint}${path}`, {
      ...init,
      headers: {
        accept: "application/json",
        ...this.target.headers,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
    });
    const text = await response.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = text;
    }
    if (!response.ok) {
      const detail =
        body && typeof body === "object" && "error" in body
          ? JSON.stringify((body as { error: unknown }).error)
          : text || response.statusText;
      throw new QuotaApiError(`Quota API ${response.status}: ${detail}`, response.status, body);
    }
    return body;
  }

  async getStatus(signal?: AbortSignal): Promise<QuotaStatus> {
    const body = await this.request("", { signal });
    if (!isQuotaStatus(body)) throw new Error("Quota API returned an invalid status payload");
    return body;
  }

  async setCap(session: string, cap: number, signal?: AbortSignal): Promise<void> {
    await this.request(`/sessions/${encodeURIComponent(session)}`, {
      method: "PUT",
      signal,
      body: JSON.stringify({ cap }),
    });
  }

  async clear(session: string, signal?: AbortSignal): Promise<void> {
    await this.request(`/sessions/${encodeURIComponent(session)}`, { method: "DELETE", signal });
  }

  async clearAll(signal?: AbortSignal): Promise<void> {
    await this.request("/sessions", { method: "DELETE", signal });
  }

  async skim(amount: number, signal?: AbortSignal, session = ""): Promise<number> {
    const body = await this.request("/skim", {
      method: "POST",
      signal,
      body: JSON.stringify({ amount, session }),
    });
    const transferred = body && typeof body === "object" && "transferred" in body ? body.transferred : undefined;
    // Match the ledger's accounting epsilon. The transfer has already been
    // applied: rounding dust must not turn success into an error or a retry.
    const tolerance = 1e-8;
    if (typeof transferred !== "number" || !Number.isFinite(transferred) || transferred < 0 || transferred > amount + tolerance) {
      throw new Error("Quota API returned an invalid skim result");
    }
    return Math.min(transferred, amount);
  }
}
