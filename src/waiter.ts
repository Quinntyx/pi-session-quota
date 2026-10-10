import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { QuotaClient } from "./quota-client.js";
import type { QuotaStatus } from "./types.js";

export type WaitResult = "retry" | "aborted";

function abortError(): Error {
  const error = new Error("Quota wait aborted");
  error.name = "AbortError";
  return error;
}

export class QuotaWaiter {
  private wakeCurrent: (() => void) | undefined;
  private wakeGeneration = 0;

  wake(): void {
    this.wakeGeneration++;
    this.wakeCurrent?.();
  }

  private wait(ms: number, signal: AbortSignal | undefined, observedWakeGeneration: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError());
        return;
      }
      if (this.wakeGeneration !== observedWakeGeneration) {
        resolve();
        return;
      }
      let done = false;
      const finish = (error?: Error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (this.wakeCurrent === onWake) this.wakeCurrent = undefined;
        error ? reject(error) : resolve();
      };
      const onAbort = () => finish(abortError());
      const onWake = () => finish();
      const timer = setTimeout(onWake, ms);
      this.wakeCurrent = onWake;
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  async waitUntilRetry(
    client: QuotaClient,
    session: string,
    ctx: ExtensionContext,
    initialRetryAfterSeconds?: number,
    requiredPoints = 0,
  ): Promise<WaitResult> {
    const label = session || "interactive";
    let nextPollAt = Date.now();
    let lastError: string | undefined;
    const updateUi = () => {
      const seconds = Math.max(0, Math.ceil((nextPollAt - Date.now()) / 1_000));
      const suffix = lastError ? `; status unavailable (${lastError})` : `; recheck in ${seconds}s`;
      ctx.ui.setStatus("session-quota", `quota waiting: ${label}${suffix}`);
      ctx.ui.setWidget(
        "session-quota",
        [`Provisioned quota exhausted for ${label}. Pi is paused asynchronously${suffix}.`, "Escape cancels; commands and steering remain available."],
        { placement: "belowEditor" },
      );
      ctx.ui.setWorkingMessage("Waiting for provisioned quota…");
    };
    const ticker = setInterval(updateUi, 1_000);

    try {
      let suggestedDelay = initialRetryAfterSeconds;
      while (!ctx.signal?.aborted) {
        const observedWakeGeneration = this.wakeGeneration;
        let status: QuotaStatus | undefined;
        try {
          status = await client.getStatus(ctx.signal);
          lastError = undefined;
        } catch (error) {
          if (ctx.signal?.aborted || (error instanceof Error && error.name === "AbortError")) return "aborted";
          lastError = error instanceof Error ? error.message : String(error);
        }

        if (status) {
          const bucket = status.buckets.find((item) => item.session === session) ?? status.buckets.find((item) => item.session === "");
          if (status.all_weekly_exhausted || (bucket && bucket.available > 0 && bucket.available + 1e-9 >= requiredPoints)) return "retry";
          suggestedDelay = status.retry_after_seconds;
        }

        const seconds = Number.isFinite(suggestedDelay) && (suggestedDelay ?? 0) > 0 ? suggestedDelay! : 5;
        const pollMs = Math.min(Math.max(seconds * 1_000, 1_000), 30_000);
        nextPollAt = Date.now() + pollMs;
        updateUi();
        try {
          await this.wait(pollMs, ctx.signal, observedWakeGeneration);
        } catch (error) {
          if (error instanceof Error && error.name === "AbortError") return "aborted";
          throw error;
        }
      }
      return "aborted";
    } finally {
      clearInterval(ticker);
      this.wakeCurrent = undefined;
      ctx.ui.setStatus("session-quota", undefined);
      ctx.ui.setWidget("session-quota", undefined);
      ctx.ui.setWorkingMessage();
    }
  }
}
