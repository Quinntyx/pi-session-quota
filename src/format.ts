import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { formatPoints } from "./points.js";
import type { QuotaStatus } from "./types.js";

function sessionLabel(session: string): string {
  // Session names are data, not terminal control sequences or additional rows.
  return stripTerminalSequences(session || "interactive").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
}

export function formatStatus(status: QuotaStatus): string {
  const lines = [
    `Capacity: ${formatPoints(status.capacity)} | remaining: ${formatPoints(status.total_remaining)} | weekly exhausted: ${status.all_weekly_exhausted ? "yes" : "no"}`,
  ];
  if (status.buckets.length === 0) {
    lines.push("No session caps.");
  } else {
    const headings = ["Session", "Cap", "Remaining", "Held", "Available"];
    const rows = status.buckets.map((bucket) => [
      sessionLabel(bucket.session), formatPoints(bucket.cap), formatPoints(bucket.remaining),
      formatPoints(bucket.held), formatPoints(bucket.available),
    ]);
    const widths = headings.map((heading, column) =>
      Math.max(visibleWidth(heading), ...rows.map((row) => visibleWidth(row[column]))),
    );
    const border = (left: string, join: string, right: string) =>
      left + widths.map((width) => "─".repeat(width + 2)).join(join) + right;
    const rowLine = (row: string[]) => "│" + row.map((cell, column) => {
      const padding = " ".repeat(widths[column] - visibleWidth(cell));
      return column === 0 ? ` ${cell}${padding} ` : ` ${padding}${cell} `;
    }).join("│") + "│";
    lines.push(border("┌", "┬", "┐"), rowLine(headings), border("├", "┼", "┤"));
    for (const row of rows) lines.push(rowLine(row));
    lines.push(border("└", "┴", "┘"));
  }
  if (status.retry_after_seconds > 0) lines.push(`Retry after: ${formatPoints(status.retry_after_seconds)}s`);
  return lines.join("\n");
}
