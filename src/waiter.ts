import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { QuotaClient } from "./quota-client.js";
import { formatPoints } from "./points.js";
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
    minimumRetryDelayMs = 0,
  ): Promise<WaitResult> {
    const label = session || "interactive";
    const retryNotBefore = Date.now() + minimumRetryDelayMs;
    let nextPollAt = Date.now();
    let lastError: string | undefined;
    let availablePoints: number | undefined;
    let busy = false;
    let debt = 0;
    let frame = 0;
    const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    const updateUi = () => {
      const seconds = Math.max(0, Math.ceil((nextPollAt - Date.now()) / 1_000));
      const suffix = lastError ? `; status unavailable (${lastError})` : `; recheck in ${seconds}s`;
      const budget = availablePoints === undefined ? "" : `Available: ${formatPoints(availablePoints)} points`;
      const owed = debt > 0 ? `; debt: ${formatPoints(debt)} points` : "";
      const title = busy ? "Waiting for in-flight request" : "Reached provisioned quota cap, waiting for reset";
      ctx.ui.setStatus("session-quota", `quota waiting: ${label}${suffix}`);
      ctx.ui.setWidget(
        "session-quota",
        [
          `${frames[frame++ % frames.length]} ${title} (${label}).`,
          ...(budget ? [budget + owed + suffix] : [suffix.slice(2)]),
          "Workflow remains active. Escape cancels; commands and steering remain available.",
        ],
        { placement: "belowEditor" },
      );
      ctx.ui.setWorkingMessage(`${title}…`);
    };
    updateUi();
    const ticker = setInterval(updateUi, 250);

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
          availablePoints = bucket?.available;
          // The server owns soft-cap concurrency and actual burn eligibility.
          if (status.all_weekly_exhausted) return "retry";
          debt = bucket?.debt ?? 0;
          const ready = bucket?.admission_ready ?? Boolean(bucket && bucket.available > 0);
          busy = Boolean(bucket && !ready && bucket.available > 0 && (bucket.in_flight ?? 0) > 0);
          if (ready && Date.now() >= retryNotBefore) return "retry";
          suggestedDelay = ready ? (retryNotBefore - Date.now()) / 1_000 : status.retry_after_seconds;
        }

        const seconds = Number.isFinite(suggestedDelay) && (suggestedDelay ?? 0) > 0 ? suggestedDelay! : 5;
        const pollMs = Math.min(Math.max(seconds * 1_000, 1_000), 5_000);
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
