import { formatPoints } from "./points.js";
import type { QuotaStatus } from "./types.js";

export function formatStatus(status: QuotaStatus): string {
  const lines = [
    `Capacity: ${formatPoints(status.capacity)} | remaining: ${formatPoints(status.total_remaining)} | weekly exhausted: ${status.all_weekly_exhausted ? "yes" : "no"}`,
  ];
  if (status.buckets.length === 0) {
    lines.push("No session caps.");
  } else {
    lines.push("session | cap | remaining | held | available");
    for (const bucket of status.buckets) {
      lines.push(
        `${bucket.session || "interactive"} | ${formatPoints(bucket.cap)} | ${formatPoints(bucket.remaining)} | ${formatPoints(bucket.held)} | ${formatPoints(bucket.available)}`,
      );
    }
  }
  if (status.retry_after_seconds > 0) lines.push(`Retry after: ${formatPoints(status.retry_after_seconds)}s`);
  return lines.join("\n");
}
