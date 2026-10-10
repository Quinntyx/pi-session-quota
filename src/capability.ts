import { QuotaClient } from "./quota-client.js";

interface CacheEntry {
  supported: boolean;
  expiresAt: number;
}

export class CapabilityCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<boolean>>();

  constructor(private readonly negativeTtlMs = 30_000) {}

  async supports(client: QuotaClient, signal?: AbortSignal): Promise<boolean> {
    const key = client.target.endpoint;
    const cached = this.entries.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.supported;

    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const probe = client
      .getStatus(signal)
      .then(() => {
        this.entries.set(key, { supported: true, expiresAt: Number.POSITIVE_INFINITY });
        return true;
      })
      .catch(() => {
        this.entries.set(key, { supported: false, expiresAt: Date.now() + this.negativeTtlMs });
        return false;
      })
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, probe);
    return probe;
  }
}
