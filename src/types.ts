export const QUOTA_CAPACITY = 250;
export const SESSION_HEADER = "X-CLIProxyAPI-Session";
export const PROVISIONED_QUOTA_CODE = "provisioned_quota_exhausted";
export const WEEKLY_QUOTA_CODE = "weekly_quota_exhausted";

export interface QuotaBucket {
  session: string;
  cap: number;
  remaining: number;
  held: number;
  available: number;
}

export interface QuotaStatus {
  capacity: number;
  total_remaining: number;
  all_weekly_exhausted: boolean;
  buckets: QuotaBucket[];
  retry_after_seconds: number;
}

export interface QuotaErrorBody {
  error?: {
    code?: string;
    message?: string;
    type?: string;
    retry_after_seconds?: number;
  };
}

export interface QuotaTarget {
  endpoint: string;
  headers: Record<string, string>;
}
