import { QUOTA_CAPACITY } from "./types.js";

export interface ParsedPoints {
  points: number;
  source: "points" | "percent";
}

export function parsePoints(input: string, options: { allowZero?: boolean } = {}): ParsedPoints {
  const text = input.trim();
  const percent = text.endsWith("%");
  const numericText = percent ? text.slice(0, -1).trim() : text;
  const value = Number(numericText);

  if (!numericText || !Number.isFinite(value)) {
    throw new Error(`Invalid quota amount: ${input}`);
  }
  if (value < 0 || (!options.allowZero && value === 0)) {
    throw new Error("Quota amount must be greater than zero");
  }

  if (value > QUOTA_CAPACITY) {
    throw new Error(`Quota points cannot exceed ${QUOTA_CAPACITY}`);
  }
  return { points: value, source: percent ? "percent" : "points" };
}

export function formatPoints(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}
