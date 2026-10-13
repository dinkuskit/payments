const STAGES = {
  read_control: "The saved connection could not be read.",
  read_session: "The saved authorization could not be read or validated.",
  verify_session: "The DinkusKit authorization could not be verified.",
  fetch_status: "The Payments service did not return a successful status response.",
  decode_status: "The Payments service returned an unrecognized status response.",
  recheck_control: "The saved connection could not be rechecked after receiving its status.",
} as const;

export type StatusCheckStage = keyof typeof STAGES;
export type StatusCheckFailure = { stage: StatusCheckStage; httpStatus?: number };

// Accept only our closed stage vocabulary and an HTTP status. Never inspect or
// carry an exception, response body, stored value, or account identifier.
export function readStatusCheckFailure(value: unknown): StatusCheckFailure | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => key !== "stage" && key !== "httpStatus") ||
      typeof record.stage !== "string" || !Object.hasOwn(STAGES, record.stage)) return null;
  if (record.httpStatus !== undefined && (typeof record.httpStatus !== "number" ||
      !Number.isInteger(record.httpStatus) || record.httpStatus < 100 || record.httpStatus > 599)) return null;
  return { stage: record.stage as StatusCheckStage, ...(record.httpStatus === undefined ? {} : { httpStatus: record.httpStatus as number }) };
}

export function describeStatusCheckFailure(value: unknown): string {
  const failure = readStatusCheckFailure(value);
  const detail = failure ? `${STAGES[failure.stage]} Support code: status_${failure.stage}${failure.httpStatus === undefined ? "" : ` (HTTP ${failure.httpStatus})`}.` : "The connection status could not be confirmed.";
  return `Payments setup check failed. ${detail} No processor setup was attempted by this check. Use Check connection to try again.`;
}
