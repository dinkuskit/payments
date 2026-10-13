import { decodeDiagnostics, type ConnectionDiagnostics } from "./connection-diagnostics.js";

export const PROVIDER_IDENTITY_RESULTS = ["match", "mismatch", "unconfirmed", "unavailable"] as const;
export type ProviderIdentityResult = typeof PROVIDER_IDENTITY_RESULTS[number];

export const BOUNDED_IDENTITY_HTTP_STATUSES = [200, 400, 401, 403, 404, 409, 429, 500, 502, 503, 504] as const;

export type ProviderIdentityDiagnostic = {
  result: ProviderIdentityResult;
  validTestPrefix: boolean;
  httpStatus?: number;
  at: number;
  diagnostics?: ConnectionDiagnostics;
};

export function decodeProviderIdentityDiagnostic(input: unknown, now = Date.now()): ProviderIdentityDiagnostic {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid_provider_identity");
  const d = input as Record<string, unknown>;
  if (Object.keys(d).some(k => !["result", "validTestPrefix", "httpStatus", "at", "diagnostics"].includes(k))) {
    throw new Error("invalid_provider_identity");
  }
  if (!PROVIDER_IDENTITY_RESULTS.includes(d.result as ProviderIdentityResult)) {
    throw new Error("invalid_provider_identity");
  }
  if (typeof d.validTestPrefix !== "boolean") {
    throw new Error("invalid_provider_identity");
  }
  if (d.httpStatus !== undefined) {
    if (typeof d.httpStatus !== "number" || !Number.isInteger(d.httpStatus) || !BOUNDED_IDENTITY_HTTP_STATUSES.includes(d.httpStatus as (typeof BOUNDED_IDENTITY_HTTP_STATUSES)[number])) {
      throw new Error("invalid_provider_identity");
    }
  }
  if (typeof d.at !== "number" || !Number.isSafeInteger(d.at) || d.at < 0 || d.at > now) {
    throw new Error("invalid_provider_identity");
  }
  if ((d.result === "match" || d.result === "mismatch") && (d.validTestPrefix !== true || d.httpStatus !== 200)) throw new Error("invalid_provider_identity");
  let safeDiag: ConnectionDiagnostics | undefined;
  if (d.diagnostics !== undefined) {
    safeDiag = decodeDiagnostics(d.diagnostics, now);
  }
  return {
    result: d.result as ProviderIdentityResult,
    validTestPrefix: d.validTestPrefix,
    ...(d.httpStatus !== undefined ? { httpStatus: d.httpStatus } : {}),
    at: d.at,
    ...(safeDiag ? { diagnostics: safeDiag } : {}),
  };
}
