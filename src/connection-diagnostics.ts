export const FAILURE_CATEGORIES = ["authentication", "permission", "platform_required", "rate_limited", "provider_unavailable", "transport_unknown", "unknown"] as const;
export type CreationFailure = { category: typeof FAILURE_CATEGORIES[number]; at: number; status?: number };
export type ConnectionDiagnostics = {
  state: "disconnected" | "connecting" | "recovery_required" | "account_present";
  mode: "test" | "live";
  processorAccountPresent: boolean;
  evidence: "observed" | "unobserved";
  lastFailure?: CreationFailure;
};
export function decodeDiagnostics(input: unknown, now = Date.now()): ConnectionDiagnostics {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw Error("invalid_diagnostics");
  const d = input as Record<string, unknown>;
  if (Object.keys(d).some(k => !["state", "mode", "processorAccountPresent", "evidence", "lastFailure"].includes(k)) ||
      !["disconnected", "connecting", "recovery_required", "account_present"].includes(d.state as string) ||
      !["test", "live"].includes(d.mode as string) || typeof d.processorAccountPresent !== "boolean" ||
      d.processorAccountPresent !== (d.state === "account_present") || !["observed", "unobserved"].includes(d.evidence as string) ||
      (d.evidence === "observed") !== (d.lastFailure !== undefined) ||
      (d.evidence === "observed" && (d.state === "disconnected" || d.state === "account_present"))) throw Error("invalid_diagnostics");
  if (d.lastFailure !== undefined) {
    const f = d.lastFailure as Record<string, unknown>;
    if (!f || typeof f !== "object" || Array.isArray(f) || Object.keys(f).some(k => !["category", "status", "at"].includes(k)) ||
        !FAILURE_CATEGORIES.includes(f.category as CreationFailure["category"]) ||
        typeof f.at !== "number" || !Number.isSafeInteger(f.at) || f.at < 0 || f.at > now ||
        (f.status !== undefined && ![400, 401, 403, 409, 429, 500, 502, 503, 504].includes(f.status as number))) throw Error("invalid_diagnostics");
  }
  return d as ConnectionDiagnostics;
}
