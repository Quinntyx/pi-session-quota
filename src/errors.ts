import { PROVISIONED_QUOTA_CODE, type QuotaErrorBody } from "./types.js";

export interface ProvisionedQuotaErrorInfo {
  retryAfterSeconds?: number;
  requiredPoints?: number;
}

function collectStrings(value: unknown, output: string[], seen: Set<object>): void {
  if (typeof value === "string") {
    output.push(value);
    return;
  }
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    collectStrings(child, output, seen);
  }
}

export function parseProvisionedQuotaError(value: unknown): ProvisionedQuotaErrorInfo | null {
  const strings: string[] = [];
  collectStrings(value, strings, new Set());
  const combined = strings.join("\n");
  if (!combined.includes(PROVISIONED_QUOTA_CODE)) return null;

  const retryPatterns = [
    /["']retry_after_seconds["']\s*:\s*(\d+(?:\.\d+)?)/i,
    /retry[_ -]?after(?:[_ -]?seconds)?[^0-9]*(\d+(?:\.\d+)?)/i,
  ];
  for (const pattern of retryPatterns) {
    const match = combined.match(pattern);
    if (match) {
      const required = combined.match(/["']required_points["']\s*:\s*(\d+(?:\.\d+)?(?:e[+-]?\d+)?)/i);
      return { retryAfterSeconds: Number(match[1]), ...(required ? {requiredPoints: Number(required[1])} : {}) };
    }
  }
  return {};
}

export function quotaCodeFromBody(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  return (value as QuotaErrorBody).error?.code;
}
