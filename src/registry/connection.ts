import { pluginResponse } from "emdash/plugin";
import { decodeStatus } from "./status.js";

export type UserInfo = { id: string };
export type SiteInfo = { url: string };
export type HttpAccess = { fetch(url: string, init?: RequestInit): Promise<Response> };
export type Versioned<T> = { value: T; revision: string };
export type KVAccess = {
  get<T>(key: string): Promise<T | null>;
  getVersioned<T>(key: string): Promise<Versioned<T> | null>;
  compareAndSet(key: string, expectedRevision: string | null, value: unknown): Promise<{ applied: boolean }>;
  compareAndDelete(key: string, expectedRevision: string): Promise<{ applied: boolean }>;
};
export type SettingsAccess = {
  get<T>(key: string): Promise<T | null>;
  getVersioned<T>(key: string): Promise<Versioned<T> | null>;
  compareAndSet(key: string, expectedRevision: string | null, value: unknown): Promise<{ applied: boolean }>;
  compareAndDelete(key: string, expectedRevision: string): Promise<{ applied: boolean }>;
};

export const REGISTRY_ORIGIN = "https://dinkuskit.com";
export const REGISTRY_ISSUER = "https://dinkuskit.com/account";
export const REGISTRY_JWKS_URL = `${REGISTRY_ORIGIN}/account/.well-known/jwks.json`;
export const REGISTRY_CONNECT_URL = `${REGISTRY_ORIGIN}/api/store-connections`;
export const REGISTRY_CLIENT_ID = "dinkus-payments-emdash";
export const REGISTRY_SERVICE = "payments";
export const REGISTRY_CALLBACK_PATH = "/_emdash/admin/plugins/dinkus-payments/status";
export const REGISTRY_PROOF_PATH = "/_emdash/api/plugins/dinkus-payments/store-proof";
export const REGISTRY_AUDIENCE = "dinkus-payments";
export const REGISTRY_SCOPE = "payments:admin";

const STATE_SETTING = "registry_session";
const CONTROL_KEY = "state:registry-v2-control";
const SITE_ID_RE = /^[A-Za-z0-9_-]{1,200}$/;
const MAX_TRANSACTION_MS = 600_000;
const MAX_TOKEN_MS = 300_000;

export type RegistryConfig = Readonly<{
  endpoint: Readonly<{ status: string }> | null;
  /** Build-time local proof only; never derived from settings or route input. */
  testOnly?: Readonly<{ storeOrigin: string; verificationOrigin: string }>;
}>;
export type ProofReceipt = Readonly<{
  version: 2; site_id: string; connection_id: string; challenge: string;
  client_id: typeof REGISTRY_CLIENT_ID; service: typeof REGISTRY_SERVICE;
  site_origin: string; callback_uri: string; code_challenge: string; expires_at: number;
}>;
type Binding = { siteId: string; origin: string; issuer: string; subject: string };
type FlowSecret = { kind: "flow"; flowId: string; verifier: string };
type SessionSecret = { kind: "session"; flowId: string; token: string };
type Control = {
  phase: "starting" | "pending" | "exchanging" | "complete" | "failed";
  flowId: string; adminId: string; origin: string; expiresAt: number;
  binding?: Binding; receipt?: ProofReceipt; verificationUri?: string;
  interval?: number; nextPollAt?: number; secretHash?: string;
};
export type RegistryFlowResult =
  | { state: "unconfigured" | "disconnected" | "connecting" | "ready" | "checking" | "action_required" | "recovery_required"; receipt?: ProofReceipt; status?: unknown }
  | { state: "pending"; verificationUri: string; interval: number; expiresAt: number }
  | { state: "failed"; message: "restart_required" | "connection_unavailable" };

export function canonicalOrigin(value: string, testOrigin?: string): string | null {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/") return null;
    if (url.origin === testOrigin && url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port) return url.origin;
    if (url.protocol !== "https:" || url.port) return null;
    return url.origin;
  } catch { return null; }
}
function randomBytes(size: number) { const bytes = new Uint8Array(size); crypto.getRandomValues(bytes); return bytes; }
function base64url(value: Uint8Array) { let binary = ""; for (const byte of value) binary += String.fromCharCode(byte); return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, ""); }
function decodeBase64url(value: string) {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((value.length + 3) % 4);
  const binary = atob(padded); const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
function decodeJsonSegment<T>(value: string): T {
  try { return JSON.parse(new TextDecoder().decode(decodeBase64url(value))) as T; } catch { throw new Error("invalid_token"); }
}
async function sha256(value: string) { return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))); }
function safeString(value: unknown, max = 512): value is string { return typeof value === "string" && value.length > 0 && value.length <= max; }
function exactCallback(origin: string) { return `${origin}${REGISTRY_CALLBACK_PATH}`; }
function noRedirect(init: RequestInit = {}): RequestInit { return { ...init, redirect: "manual" }; }
function validTestOrigin(value: string): boolean {
  try { const url = new URL(value); return url.origin === value && url.protocol === "http:" && url.hostname === "127.0.0.1" && !!url.port; }
  catch { return false; }
}

export function createRegistryConnection(options: {
  kv: KVAccess; settings: SettingsAccess; http?: HttpAccess; site: SiteInfo; config: RegistryConfig;
  now?: () => number; id?: () => string;
}) {
  const now = options.now ?? Date.now;
  const test = options.config.testOnly;
  const validConfig = !test || validTestOrigin(test.storeOrigin) && validTestOrigin(test.verificationOrigin);
  const origin = validConfig ? canonicalOrigin(options.site.url, test?.storeOrigin) : null;
  const verificationOrigin = test?.verificationOrigin ?? REGISTRY_ORIGIN;
  const configured = options.config.endpoint?.status ?? null;
  const newId = options.id ?? (() => base64url(randomBytes(18)));
  const current = () => options.kv.getVersioned<Control>(CONTROL_KEY);
  const failure = (): RegistryFlowResult => ({ state: "failed", message: "restart_required" });
  function pending(c: Control): RegistryFlowResult {
    return { state: "pending", verificationUri: c.verificationUri!, interval: c.interval!, expiresAt: c.expiresAt };
  }
  async function fail(c: Versioned<Control>) {
    await options.kv.compareAndSet(CONTROL_KEY, c.revision, { ...c.value, phase: "failed", secretHash: undefined });
    return failure();
  }
  async function secret(c: Control) {
    const entry = await options.settings.getVersioned<string>(STATE_SETTING);
    if (!entry || typeof entry.value !== "string" || await sha256(entry.value) !== c.secretHash) throw new Error("invalid_state");
    const value = JSON.parse(entry.value) as FlowSecret | SessionSecret;
    if (value.flowId !== c.flowId) throw new Error("invalid_state");
    return { ...entry, parsed: value };
  }
  async function start(user: UserInfo): Promise<RegistryFlowResult> {
    if (!origin || !user?.id || !options.http) return { state: "unconfigured" };
    const prior = await current();
    const p = prior?.value;
    if (p && ["starting", "pending", "exchanging"].includes(p.phase) && p.expiresAt > now()) {
      return p.phase === "pending" && p.adminId === user.id ? pending(p) : { state: "connecting" };
    }
    if (p?.binding && p.binding.origin !== origin) return failure();
    const c: Control = { phase: "starting", flowId: newId(), adminId: user.id, origin, expiresAt: now() + 30_000, binding: p?.binding };
    if (!(await options.kv.compareAndSet(CONTROL_KEY, prior?.revision ?? null, c)).applied) return { state: "connecting" };
    const reservation = await current();
    if (!reservation || reservation.value.flowId !== c.flowId) return failure();
    try {
      const stored = await options.settings.getVersioned<string>(STATE_SETTING);
      const verifier = base64url(randomBytes(32));
      const challenge = await sha256(verifier);
      const response = await options.http.fetch(REGISTRY_CONNECT_URL, noRedirect({ method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ protocol_version: 2, client_id: REGISTRY_CLIENT_ID, service: REGISTRY_SERVICE,
          site_origin: origin, callback_uri: exactCallback(origin), code_challenge: challenge, code_challenge_method: "S256" }) }));
      if (!response.ok) return fail(reservation);
      const body = await response.json() as Record<string, unknown>;
      const { site_id: siteId, connection_id: connectionId, expires_at: expiresAt, interval } = body;
      if (body.protocol_version !== 2 || !safeString(siteId, 200) || !SITE_ID_RE.test(siteId) ||
          !safeString(connectionId, 200) || !safeString(body.challenge, 512) ||
          typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt) || expiresAt <= now() || expiresAt > now() + MAX_TRANSACTION_MS ||
          typeof interval !== "number" || !Number.isInteger(interval) || interval < 1 || interval > 60 ||
          body.verification_uri !== `${verificationOrigin}/account/connect?connection_id=${encodeURIComponent(connectionId)}` ||
          c.binding && c.binding.siteId !== siteId) return fail(reservation);
      if (now() >= c.expiresAt) return fail(reservation);
      const value = JSON.stringify({ kind: "flow", flowId: c.flowId, verifier } satisfies FlowSecret);
      const fresh = await current();
      if (fresh?.revision !== reservation.revision) return failure();
      if (!(await options.settings.compareAndSet(STATE_SETTING, stored?.revision ?? null, value)).applied) return fail(reservation);
      const next: Control = { ...c, phase: "pending", expiresAt, interval, nextPollAt: now() + interval * 1000,
        secretHash: await sha256(value), verificationUri: body.verification_uri as string,
        receipt: { version: 2, site_id: siteId, connection_id: connectionId, challenge: body.challenge,
          client_id: REGISTRY_CLIENT_ID, service: REGISTRY_SERVICE, site_origin: origin,
          callback_uri: exactCallback(origin), code_challenge: challenge, expires_at: expiresAt } };
      return (await options.kv.compareAndSet(CONTROL_KEY, reservation.revision, next)).applied ? pending(next) : failure();
    } catch { return fail(reservation); }
  }
  async function receipt(connectionId: string): Promise<ProofReceipt | null> {
    const c = (await current())?.value;
    return origin && c && ["pending", "exchanging"].includes(c.phase) && c.origin === origin && c.expiresAt > now() &&
      c.receipt?.connection_id === connectionId ? c.receipt : null;
  }
  async function verifySessionToken(token: string, siteId: string) {
    const parts = token.split(".");
    if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) throw new Error("invalid_token");
    const header = decodeJsonSegment<{ alg?: unknown; kid?: unknown; crit?: unknown; b64?: unknown }>(parts[0]);
    if (header.crit !== undefined || header.b64 !== undefined || header.alg !== "ES256" || typeof header.kid !== "string" || !safeString(header.kid, 200)) throw new Error("invalid_token");
    const response = await options.http!.fetch(REGISTRY_JWKS_URL, noRedirect({ method: "GET" }));
    if (!response.ok) throw new Error("invalid_token");
    const body = await response.json() as { keys?: Record<string, unknown>[] };
    const jwk = body.keys?.find(key => key.kid === header.kid && key.kty === "EC" && key.crv === "P-256" &&
      (key.alg === undefined || key.alg === "ES256"));
    if (!jwk) throw new Error("invalid_token");
    const key = await crypto.subtle.importKey("jwk", jwk as JsonWebKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    if (!await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, decodeBase64url(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`))) throw new Error("invalid_token");
    const payload = decodeJsonSegment<{ iss?: unknown; aud?: unknown; iat?: unknown; exp?: unknown; sub?: unknown; site_id?: unknown; scope?: unknown; nbf?: unknown }>(parts[1]);
    const issuedAt = payload.iat, expiresAt = payload.exp;
    if (typeof issuedAt !== "number" || typeof expiresAt !== "number" || !Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt) || expiresAt <= now() / 1000 ||
      issuedAt > now() / 1000 || expiresAt <= issuedAt || expiresAt - issuedAt > MAX_TOKEN_MS / 1000 ||
      payload.nbf !== undefined && (typeof payload.nbf !== "number" || !Number.isSafeInteger(payload.nbf) || payload.nbf > now() / 1000) || typeof payload.sub !== "string" ||
      !payload.sub.trim() || payload.sub.length > 200 || payload.iss !== REGISTRY_ISSUER || (payload.aud !== REGISTRY_AUDIENCE && !(Array.isArray(payload.aud) && payload.aud.length === 1 && payload.aud[0] === REGISTRY_AUDIENCE)) ||
      payload.site_id !== siteId || payload.scope !== REGISTRY_SCOPE) throw new Error("invalid_token");
    return { token, subject: payload.sub, expiresAt: expiresAt * 1000 };
  }
  async function exchange(user: UserInfo): Promise<RegistryFlowResult> {
    const prior = await current();
    const c = prior?.value;
    if (!prior || !c || !origin || c.adminId !== user?.id || c.origin !== origin || c.expiresAt <= now() || !options.http) return failure();
    if (c.phase === "complete") return status(user);
    if (c.phase === "exchanging") return { state: "connecting" };
    if (c.phase !== "pending") return failure();
    if (now() < c.nextPollAt!) return pending(c);
    if (!(await options.kv.compareAndSet(CONTROL_KEY, prior.revision, { ...c, phase: "exchanging" })).applied) return { state: "connecting" };
    const reserved = await current();
    if (!reserved || reserved.value.flowId !== c.flowId || reserved.value.phase !== "exchanging") return failure();
    try {
      const stored = await secret(c);
      if (stored.parsed.kind !== "flow") return fail(reserved);
      const response = await options.http.fetch(`${REGISTRY_CONNECT_URL}/token`, noRedirect({ method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: REGISTRY_CLIENT_ID, connection_id: c.receipt!.connection_id, code_verifier: stored.parsed.verifier }) }));
      const body = await response.json() as Record<string, unknown>;
      if (!response.ok) {
        if (body.error !== "authorization_pending" || c.expiresAt <= now()) return fail(reserved);
        const next = { ...c, nextPollAt: now() + c.interval! * 1000 };
        return (await options.kv.compareAndSet(CONTROL_KEY, reserved.revision, next)).applied ? pending(next) : failure();
      }
      if (!safeString(body.access_token, 4096) || body.token_type !== "Bearer" || body.site_id !== c.receipt!.site_id ||
          typeof body.expires_in !== "number" || !Number.isInteger(body.expires_in) || body.expires_in < 1 || body.expires_in > 300) return fail(reserved);
      const verified = await verifySessionToken(body.access_token, c.receipt!.site_id);
      const binding: Binding = { siteId: c.receipt!.site_id, origin, issuer: REGISTRY_ISSUER, subject: verified.subject };
      if (c.binding && (c.binding.siteId !== binding.siteId || c.binding.origin !== origin || c.binding.issuer !== binding.issuer || c.binding.subject !== binding.subject)) return fail(reserved);
      if (c.expiresAt <= now() || (await current())?.revision !== reserved.revision) return failure();
      const value = JSON.stringify({ kind: "session", flowId: c.flowId, token: verified.token } satisfies SessionSecret);
      if (!(await options.settings.compareAndSet(STATE_SETTING, stored.revision, value)).applied) return fail(reserved);
      const next: Control = { ...c, phase: "complete", binding, secretHash: await sha256(value), expiresAt: verified.expiresAt,
        receipt: undefined, verificationUri: undefined };
      return (await options.kv.compareAndSet(CONTROL_KEY, reserved.revision, next)).applied ? { state: "ready" } : failure();
    } catch { return fail(reserved); }
  }
  async function status(user?: UserInfo): Promise<RegistryFlowResult> {
    const c = (await current())?.value;
    if (!origin || !options.http) return { state: "unconfigured" };
    if (!c) return { state: configured ? "disconnected" : "unconfigured" };
    if (c.origin !== origin || c.adminId !== user?.id) return { state: "action_required" };
    if (c.expiresAt <= now() || c.phase === "failed") return { state: "action_required" };
    if (c.phase === "pending") return pending(c);
    if (c.phase !== "complete") return { state: "connecting" };
    if (!configured) return { state: "unconfigured" };
    try {
      const stored = await secret(c);
      if (stored.parsed.kind !== "session" || !c.binding) return { state: "action_required" };
      const verified = await verifySessionToken(stored.parsed.token, c.binding.siteId);
      if (verified.subject !== c.binding.subject || c.binding.issuer !== REGISTRY_ISSUER) return { state: "action_required" };
      const url = new URL(configured);
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/v1/status") return { state: "unconfigured" };
      const result = await options.http.fetch(configured, noRedirect({ headers: { Authorization: `Bearer ${verified.token}`, "X-Dinkus-Site": c.binding.siteId } }));
      if (result.status === 401 || result.status === 403) return { state: "action_required" };
      if (!result.ok) return { state: "checking" };
      return { state: "ready", status: { availability: "available", status: decodeStatus(await result.json()), message: "Payments status checked." } };
    } catch { return { state: "checking" }; }
  }
  return { start, receipt, exchange, status, proofPath: REGISTRY_PROOF_PATH };
}

export function safeResponse(status: number, body: unknown) {
  return pluginResponse({ status, headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "Content-Type": "application/json" }, body: { kind: "text", value: JSON.stringify(body) } });
}
