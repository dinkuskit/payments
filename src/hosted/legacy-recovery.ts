import type { Connection } from "./connection.js";
import { countryCode } from "./merchant-country.js";

/** One operator-approved legacy rejection, never supplied by a request body. */
export interface LegacyRecoveryPolicy {
  operationId: string;
  siteId: string;
  bindingRef: string;
  failureAt: number;
  evidenceSha256: string;
  rejection: "accounts_v1_unsupported";
  rejectedRequestCount: 6;
  country: string;
  expiresAt: number;
}
export interface LegacyRecoveryAdmission {
  operatorAccount: string;
  operatorSite: string;
  expectedPlatform: string;
  policy: LegacyRecoveryPolicy;
}
export interface LegacyRecoveryReceipt {
  state: "prepared";
  mode: "test";
  bindingRef: string;
  operationId: string;
  preparedAt: number;
}
export interface LegacyRecoveryRecord {
  operationId: string;
  evidenceSha256: string;
  rejection: "accounts_v1_unsupported";
  rejectedRequestCount: 6;
  preparedAt: number;
  sourceFingerprint: string;
  /** Protected service state, never included in the operator response. */
  previous: Connection;
}

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const epoch = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const digest = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const segment = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value);
const policyKeys = ["operationId", "siteId", "bindingRef", "failureAt", "evidenceSha256", "rejection", "rejectedRequestCount", "country", "expiresAt"];

export function validLegacyRecoveryAdmission(value: unknown): value is LegacyRecoveryAdmission {
  if (!object(value) || Object.keys(value).some(key => !["operatorAccount", "operatorSite", "expectedPlatform", "policy"].includes(key)) ||
      typeof value.operatorAccount !== "string" || !value.operatorAccount || value.operatorAccount.length > 512 || !segment(value.operatorSite) ||
      typeof value.expectedPlatform !== "string" || !/^acct_[A-Za-z0-9]{1,200}$/.test(value.expectedPlatform) || !object(value.policy)) return false;
  const p = value.policy;
  return Object.keys(p).length === policyKeys.length && Object.keys(p).every(key => policyKeys.includes(key)) &&
    segment(p.operationId) && segment(p.siteId) && p.siteId === value.operatorSite &&
    typeof p.bindingRef === "string" && /^stripe_[A-Za-z0-9_-]{1,190}$/.test(p.bindingRef) &&
    epoch(p.failureAt) && epoch(p.expiresAt) &&
    digest(p.evidenceSha256) && p.rejection === "accounts_v1_unsupported" && p.rejectedRequestCount === 6 && countryCode(p.country);
}

/** Absence disables the operation. Invalid configuration never enables it. */
export function legacyRecoveryAdmission(
  raw: string | undefined,
  identity: { issuer?: string; operatorAccount?: string; operatorSite?: string; expectedPlatform?: string },
): LegacyRecoveryAdmission | undefined {
  if (!raw) return undefined;
  if (raw.length > 4096) throw Error("legacy_recovery_configuration_invalid");
  try {
    const account = JSON.parse(identity.operatorAccount ?? "null");
    if (!Array.isArray(account) || account.length !== 2 || account[0] !== identity.issuer ||
        typeof account[1] !== "string" || !account[1].trim() || account[1].length > 200 ||
        JSON.stringify(account) !== identity.operatorAccount) throw Error();
    const admission = { operatorAccount: identity.operatorAccount, operatorSite: identity.operatorSite,
      expectedPlatform: identity.expectedPlatform, policy: JSON.parse(raw) };
    if (!validLegacyRecoveryAdmission(admission)) throw Error();
    return admission;
  } catch { throw Error("legacy_recovery_configuration_invalid"); }
}

/** Hash a parsed service record; never return or log its private contents. */
export async function legacyStateFingerprint(record: Connection): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(record)));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
}

/** The consumer accepts only this bounded, non-secret preparation receipt. */
export function decodeLegacyRecoveryReceipt(value: unknown, now = Date.now()): LegacyRecoveryReceipt {
  if (!object(value) || Object.keys(value).sort().join(",") !== "bindingRef,mode,operationId,preparedAt,state" ||
      value.state !== "prepared" || value.mode !== "test" || typeof value.bindingRef !== "string" ||
      !/^stripe_[A-Za-z0-9_-]{1,190}$/.test(value.bindingRef) || !segment(value.operationId) ||
      !epoch(value.preparedAt) || Number(value.preparedAt) > now + 5000) throw Error("invalid_recovery_receipt");
  return value as unknown as LegacyRecoveryReceipt;
}

export function recoveryReceipt(record: Connection): LegacyRecoveryReceipt {
  const recovery = record.legacyRecovery!;
  return { state: "prepared", mode: "test", bindingRef: record.bindingRef,
    operationId: recovery.operationId, preparedAt: recovery.preparedAt };
}
