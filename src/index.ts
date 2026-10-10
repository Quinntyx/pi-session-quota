import type { ExtensionAPI, ExtensionContext, TurnEndEvent } from "@earendil-works/pi-coding-agent";
import { splitArguments } from "./args.js";
import { quotaCompletions } from "./completions.js";
import { parseProvisionedQuotaError, type ProvisionedQuotaErrorInfo } from "./errors.js";
import { formatStatus } from "./format.js";
import { formatPoints, parsePoints } from "./points.js";
import type { FetchLike } from "./quota-client.js";
import { isCliProxyApiProvider, quotaClientForContext } from "./target.js";
import { resolveTmuxSession } from "./tmux.js";
import { SESSION_HEADER } from "./types.js";
import { QuotaWaiter } from "./waiter.js";

export interface ExtensionDependencies {
  fetch?: FetchLike;
  resolveSession?: () => Promise<string | null>;
  waiter?: QuotaWaiter;
}

function assistantQuotaError(message: unknown) {
  if (!message || typeof message !== "object") return null;
  const candidate = message as { role?: string; stopReason?: string; errorMessage?: unknown };
  if (candidate.role !== "assistant" || candidate.stopReason !== "error") return null;
  return parseProvisionedQuotaError(candidate.errorMessage);
}

function commandSession(value: string | undefined, current: string | null): string {
  if (value !== undefined) return value;
  if (current !== null) return current;
  throw new Error("No tmux session detected; specify a session explicitly");
}

export function createExtension(dependencies: ExtensionDependencies = {}) {
  const fetchImpl = dependencies.fetch ?? globalThis.fetch;
  const getSession = dependencies.resolveSession ?? (() => resolveTmuxSession());
  const waiter = dependencies.waiter ?? new QuotaWaiter();

  return function sessionQuotaExtension(pi: ExtensionAPI): void {
    pi.on("before_provider_headers", async (event, ctx) => {
      if (!ctx.model || !isCliProxyApiProvider(ctx.model.provider)) return;
      const session = await getSession();
      if (session !== null) event.headers[SESSION_HEADER] = session;
    });

    const waitForQuota = async (
      ctx: ExtensionContext,
      retryAfterSeconds: number | undefined,
      requiredPoints?: number,
    ): Promise<"retry" | "aborted"> => {
      const client = await quotaClientForContext(ctx, fetchImpl);
      const session = (await getSession()) ?? "";
      pi.events.emit("session-quota:wait-state", { active: true, reason: "provisioned_quota_exhausted" });
      try {
        return await waiter.waitUntilRetry(client, session, ctx, retryAfterSeconds, requiredPoints);
      } finally {
        pi.events.emit("session-quota:wait-state", { active: false, reason: "provisioned_quota_exhausted" });
      }
    };

    let resumeProvisioned = false;
    let responseQuota: ProvisionedQuotaErrorInfo | null = null;

    pi.on("turn_start", () => { responseQuota = null; });
    pi.on("after_provider_response", (event, ctx) => {
      if (!ctx.model || !isCliProxyApiProvider(ctx.model.provider)) return;
      // Native Codex intentionally replaces all 429 bodies with a friendly
      // upstream-limit message. Headers retain our admission failure identity.
      const headers = new Headers(event.headers);
      responseQuota = null;
      if (event.status !== 429 || headers.get("x-cliproxyapi-quota-code") !== "provisioned_quota_exhausted") return;
      const retry = Number(headers.get("x-cliproxyapi-quota-retry-after"));
      const required = Number(headers.get("x-cliproxyapi-quota-required-points"));
      responseQuota = {
        ...(Number.isFinite(retry) && retry > 0 ? { retryAfterSeconds: retry } : {}),
        ...(Number.isFinite(required) && required > 0 ? { requiredPoints: required } : {}),
      };
    });

    pi.on("message_end", (event, ctx) => {
      if (!ctx.model || !isCliProxyApiProvider(ctx.model.provider)) return;
      const message = event.message;
      if (message.role !== "assistant" || message.stopReason !== "error") return;
      const info = assistantQuotaError(message) ?? responseQuota;
      if (!info) return;
      // Keep the admission metadata for turn_end after replacing Codex's
      // misleading generic 429 text in the finalized, displayed message.
      responseQuota = info;
      return {
        message: {
          ...message,
          errorMessage: "Reached provisioned quota cap, waiting for reset. Workflow remains active; this is not a terminal error.",
        },
      };
    });

    pi.on("turn_end", async (event: TurnEndEvent, ctx) => {
      if (!ctx.model || !isCliProxyApiProvider(ctx.model.provider)) return;
      const message = event.message as { role?: string; stopReason?: string };
      const info = assistantQuotaError(event.message) ??
        (message.role === "assistant" && message.stopReason === "error" ? responseQuota : null);
      responseQuota = null;
      if (!info) { resumeProvisioned = false; return; }

      const result = await waitForQuota(ctx, info.retryAfterSeconds, info.requiredPoints);
      if (result !== "retry") return;
      resumeProvisioned = true;

      return {
        entries: [{ type: "context_edit" as const, targetId: event.messageEntryId, replacement: null }],
        continue: true,
      };
    });

    // The installed core deliberately terminates its low-level loop after an
    // error, even when turn_end requests continuation. Keep settlement pending
    // until a fresh projected context (with queued steering) can be continued.
    pi.on("agent_before_settle", () => {
      if (!resumeProvisioned) return;
      resumeProvisioned = false;
      return { continue: true };
    });

    pi.registerCommand("quota", {
      description: "List or manage CLIProxyAPI session quotas",
      getArgumentCompletions: quotaCompletions,
      handler: async (rawArgs, ctx) => {
        try {
          const args = splitArguments(rawArgs);
          const action = args.shift() ?? "list";
          const client = await quotaClientForContext(ctx, fetchImpl);

          if (action === "list" || action === "status") {
            if (args.length) throw new Error(`Usage: /quota ${action}`);
            ctx.ui.notify(formatStatus(await client.getStatus(ctx.signal)), "info");
            return;
          }

          if (action === "set") {
            if (args.length < 1 || args.length > 2) throw new Error("Usage: /quota set <points|percent%> [session]");
            const { points } = parsePoints(args[0], { allowZero: true });
            const session = commandSession(args[1], await getSession());
            await client.setCap(session, points, ctx.signal);
            waiter.wake();
            ctx.ui.notify(`Set ${session || "interactive"} cap to ${formatPoints(points)} points`, "info");
            return;
          }

          if (action === "clear") {
            if (args.length > 1) throw new Error("Usage: /quota clear [session]");
            const session = commandSession(args[0], await getSession());
            await client.clear(session, ctx.signal);
            waiter.wake();
            ctx.ui.notify(`Cleared quota cap for ${session || "interactive"}`, "info");
            return;
          }

          if (action === "clear-all") {
            if (args.length) throw new Error("Usage: /quota clear-all");
            await client.clearAll(ctx.signal);
            waiter.wake();
            ctx.ui.notify("Cleared all session quota caps", "info");
            return;
          }

          if (action === "skim") {
            if (args.length > 1) throw new Error("Usage: /quota skim [points|percent%]");
            const { points } = parsePoints(args[0] ?? "10");
            const transferred = await client.skim(points, ctx.signal);
            waiter.wake();
            ctx.ui.notify(`Skimmed ${formatPoints(transferred)} quota points`, "info");
            return;
          }

          throw new Error("Usage: /quota list | set <points> [session] | clear [session] | clear-all | skim [points]");
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        }
      },
    });
  };
}

export default createExtension();
