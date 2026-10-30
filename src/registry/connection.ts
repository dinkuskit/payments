import { validOnboardingUrl } from "../onboarding-url.js";
import { decodeProviderIdentityDiagnostic, type ProviderIdentityDiagnostic } from "../provider-identity.js";
import { decodeDiagnostics, type ConnectionDiagnostics } from "../connection-diagnostics.js";
import { businessCountry } from "../business-country.js";
import { pluginResponse } from "emdash/plugin";
import {
  betaRegistryInstallationIdentity,
  registryCallbackPath,
  registryInstallationIdentity,
  registryProofPath,
  resolveRegistryInstallationIdentity,
  type InstalledRegistryPluginId,
  type RegistryPluginSlug,
} from "./identity.js";
import { decodeStatus } from "./status.js";
import type { StatusCheckFailure, StatusCheckStage } from "./check-failure.js";

export type UserInfo = { id: string };
export type SiteInfo = { url: string };
export type PluginInfo = { id?: string; version?: string };
export type HttpAccess = { fetch(url: string, init?: RequestInit): Promise<Response> };
export type Versioned<T> = { value: T; revision: string };
export type KVAccess = {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
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
export const REGISTRY_CALLBACK_PATH = `/_emdash/admin/plugins/${registryInstallationIdentity.installedPluginId}/status`;
export const REGISTRY_BETA_CALLBACK_PATH = `/_emdash/admin/plugins/${betaRegistryInstallationIdentity.installedPluginId}/status`;
export const REGISTRY_PROOF_PATH = `/_emdash/api/plugins/${registryInstallationIdentity.installedPluginId}/store-proof`;
export const REGISTRY_BETA_PROOF_PATH = `/_emdash/api/plugins/${betaRegistryInstallationIdentity.installedPluginId}/store-proof`;
export const REGISTRY_AUDIENCE = "dinkus-payments";
export const REGISTRY_SCOPE = "payments:admin";
// The status read trades this plugin's own store key here for the same pass
// checkout uses (payments-status-store-pass-039). DinkusKit.com hands the key
// over at the end of Connect (store-connect-per-plugin-key-080); it is kept in
// the encrypted Connect setting and goes nowhere else.
export const STORE_PASSES_URL = `${REGISTRY_ORIGIN}/api/store-passes`;
export const STORE_PASS_SCOPE = "payments:checkout";
const STORE_KEY_RE = /^dk_store_[A-Za-z0-9_-]{43}$/;
// DinkusKit.com's named store-pass refusals, plus Payments refusing the pass.
export const PASS_REFUSALS = ["invalid_store_key", "site_mismatch", "service_not_enabled", "service_cut_off", "store_suspended", "rate_limited", "payments_refused"] as const;
export type PassRefusal = typeof PASS_REFUSALS[number];

const STATE_SETTING = "registry_session";
const CONTROL_KEY = "state:registry-v2-control";
const SITE_ID_RE = /^[A-Za-z0-9_-]{1,200}$/;
const MAX_TRANSACTION_MS = 600_000;
const MAX_TOKEN_MS = 300_000;
// Continue waits out a short DinkusKit poll interval instead of showing the
// same pending screen, which reads as a failed approval.
const MAX_POLL_WAIT_MS = 10_000;
const LAST_STATUS_KEY = "state:last-status";

export type RegistryConfig = Readonly<{
  endpoint: Readonly<{ status: string }> | null;
  /** Optional override for installed plugin ID (`r_3brsc2on3bu673rn` or `r_sffx6l4z6mpqliki`). */
  installedPluginId?: InstalledRegistryPluginId | RegistryPluginSlug | string;
  /** Build-time local proof only; never derived from settings or route input. */
  testOnly?: Readonly<{ storeOrigin: string; verificationOrigin: string }>;
}>;
export type ProofReceipt = Readonly<{
  version: 2; site_id: string; connection_id: string; challenge: string;
  client_id: typeof REGISTRY_CLIENT_ID; service: typeof REGISTRY_SERVICE;
  site_origin: string; callback_uri: string; code_challenge: string; expires_at: number;
}>;
type Binding = { siteId: string; origin: string; issuer: string; subject: string };
type FlowSecret = { kind: "flow"; flowId: string; verifier: string; storeKey?: string };
type SessionSecret = { kind: "session"; flowId: string; token: string; storeKey?: string };
type LastStatus = { siteId: string; origin: string; adminId: string; checkedAt: number; status: unknown };
// Closed vocabulary of /v1/connect refusals that are known to create nothing.
// Never carry any other response text to the page.
export const SETUP_REFUSALS = ["merchant_country_required", "payments_service_unconfigured"] as const;
export type SetupRefusal = typeof SETUP_REFUSALS[number];
type Control = {
  phase: "starting" | "pending" | "exchanging" | "complete" | "failed";
  flowId: string; adminId: string; origin: string; expiresAt: number;
  binding?: Binding; receipt?: ProofReceipt; verificationUri?: string;
  interval?: number; nextPollAt?: number; secretHash?: string;
  // Status read with the new grant's token, saved with the grant itself.
  lastStatus?: { checkedAt: number; status: unknown };
};
export type RegistryFlowResult =
  | { state: "provider_identity"; providerIdentity: ProviderIdentityDiagnostic }
  | { state: "unconfigured" | "disconnected" | "connecting" | "ready" | "checking" | "recovery_required"; receipt?: ProofReceipt; status?: unknown; diagnostics?: ConnectionDiagnostics; signIn?: true; detailSignIn?: true }
  | { state: "action_required" }
  | { state: "store_key_required"; lastChecked?: { at: number; status: unknown } }
  | { state: "pass_refused"; refusal: PassRefusal }
  | { state: "setup_refused"; refusal: SetupRefusal }
  | { state: "commerce_required" }
  | { state: "check_failed"; checkFailure: StatusCheckFailure }
  | { state: "setup_unconfirmed"; checkFailure?: StatusCheckFailure }
  | { state: "processor_setup"; onboardingUrl: string; expiresAt: number; status?: unknown; diagnostics?: ConnectionDiagnostics }
  | { state: "pending"; verificationUri: string; interval: number; expiresAt: number; checked?: true }
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
function noRedirect(init: RequestInit = {}): RequestInit { return { ...init, redirect: "manual" }; }
// The store key in the Connect setting, whichever step it was saved at.
function storeKeyIn(value: unknown): string | undefined {
  try {
    const key = typeof value === "string" ? (JSON.parse(value) as { storeKey?: unknown }).storeKey : undefined;
    return typeof key === "string" && STORE_KEY_RE.test(key) ? key : undefined;
  } catch { return undefined; }
}
function validTestOrigin(value: string): boolean {
  try { const url = new URL(value); return url.origin === value && url.protocol === "http:" && url.hostname === "127.0.0.1" && !!url.port; }
  catch { return false; }
}

export function createRegistryConnection(options: {
  kv: KVAccess; settings: SettingsAccess; http?: HttpAccess; site: SiteInfo; config: RegistryConfig;
  plugin?: PluginInfo; now?: () => number; id?: () => string; sleep?: (ms: number) => Promise<void>;
}) {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const test = options.config.testOnly;
  const installation = resolveRegistryInstallationIdentity(options.config.installedPluginId ?? options.plugin?.id);
  const callbackPath = installation ? registryCallbackPath(installation.installedPluginId) : REGISTRY_CALLBACK_PATH;
  const proofPath = installation ? registryProofPath(installation.installedPluginId) : REGISTRY_PROOF_PATH;
  const exactCallback = (siteOrigin: string) => `${siteOrigin}${callbackPath}`;
  const validConfig = Boolean(installation) && (!test || validTestOrigin(test.storeOrigin) && validTestOrigin(test.verificationOrigin));
  const origin = validConfig ? canonicalOrigin(options.site.url, test?.storeOrigin) : null;
  const verificationOrigin = test?.verificationOrigin ?? REGISTRY_ORIGIN;
  const configured = options.config.endpoint?.status ?? null;
  const newId = options.id ?? (() => base64url(randomBytes(18)));
  const current = () => options.kv.getVersioned<Control>(CONTROL_KEY);
  const failure = (): RegistryFlowResult => ({ state: "failed", message: "restart_required" });
  const checkFailure = (stage: StatusCheckStage, httpStatus?: number): RegistryFlowResult => ({
    state: "check_failed", checkFailure: { stage, ...(httpStatus === undefined ? {} : { httpStatus }) },
  });
  function pending(c: Control, checked = false): RegistryFlowResult {
    return { state: "pending", verificationUri: c.verificationUri!, interval: c.interval!, expiresAt: c.expiresAt, ...(checked ? { checked: true as const } : {}) };
  }
  // Last status this admin read for this store, shown only until Connect has
  // given this plugin its store key. Never a token, never used for checkout.
  async function keyRequired(c: Control, user?: UserInfo): Promise<RegistryFlowResult> {
    if (!c.binding || !user?.id || c.adminId !== user.id) return { state: "store_key_required" };
    // The newer of the status saved with the grant and the last Check.
    let latest = c.lastStatus && Number.isSafeInteger(c.lastStatus.checkedAt) ? c.lastStatus : undefined;
    try {
      const last = await options.kv.get<LastStatus>(LAST_STATUS_KEY);
      if (last && last.adminId === user.id && last.siteId === c.binding.siteId && last.origin === origin &&
          Number.isSafeInteger(last.checkedAt) && (!latest || last.checkedAt > latest.checkedAt)) latest = last;
    } catch { /* The status saved with the grant, if any, still applies. */ }
    return latest ? { state: "store_key_required", lastChecked: { at: latest.checkedAt, status: latest.status } } : { state: "store_key_required" };
  }
  // One bridge call: the sandbox allows ten per request.
  async function rememberStatus(c: Control, binding: Binding, status: unknown) {
    try {
      await options.kv.set(LAST_STATUS_KEY, { siteId: binding.siteId, origin: c.origin, adminId: c.adminId, checkedAt: now(), status } satisfies LastStatus);
    } catch { /* The live result is still shown; only the lapsed view loses it. */ }
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
      if (!response.ok) {
        // Commerce connects first and registers the store (store-connect-flow-081).
        const refusal = response.status === 409 ? await response.json().then(value => (value as { error?: unknown })?.error, () => undefined) : undefined;
        await fail(reservation);
        return refusal === "connect_commerce_first" ? { state: "commerce_required" } : failure();
      }
      const body = await response.json() as Record<string, unknown>;
      const { site_id: siteId, connection_id: connectionId, expires_at: expiresAt, interval } = body;
      if (body.protocol_version !== 2 || !safeString(siteId, 200) || !SITE_ID_RE.test(siteId) ||
          !safeString(connectionId, 200) || !safeString(body.challenge, 512) ||
          typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt) || expiresAt <= now() || expiresAt > now() + MAX_TRANSACTION_MS ||
          typeof interval !== "number" || !Number.isInteger(interval) || interval < 1 || interval > 60 ||
          body.verification_uri !== `${verificationOrigin}/account/connect?connection_id=${encodeURIComponent(connectionId)}` ||
          c.binding && c.binding.siteId !== siteId) return fail(reservation);
      if (now() >= c.expiresAt) return fail(reservation);
      // A new Connect keeps the current key until DinkusKit.com hands over the next one.
      const storeKey = storeKeyIn(stored?.value);
      const value = JSON.stringify({ kind: "flow", flowId: c.flowId, verifier, ...(storeKey ? { storeKey } : {}) } satisfies FlowSecret);
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
  async function exchange(user: UserInfo, opts: { wait?: boolean } = {}): Promise<RegistryFlowResult> {
    let prior: Versioned<Control> | null;
    try { prior = await current(); } catch { return checkFailure("read_control"); }
    const c = prior?.value;
    if (!prior || !c || !origin || !options.http) return status(user);
    // A finished, lapsed or other admin's sign-in is reported the way the page
    // load reports it, never as a broken connection.
    if (c.phase === "complete" || c.phase === "failed" || c.adminId !== user?.id || c.origin !== origin || c.expiresAt <= now()) return status(user);
    if (c.phase === "exchanging") return { state: "connecting" };
    if (c.phase !== "pending") return failure();
    if (now() < c.nextPollAt!) {
      const wait = c.nextPollAt! - now();
      if (opts.wait === false || wait > MAX_POLL_WAIT_MS) return pending(c);
      // Reuse this read: the reservation below fails if control changed while
      // waiting, and a second read would push a new grant past ten bridge calls.
      await sleep(wait + 50);
    }
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
        return (await options.kv.compareAndSet(CONTROL_KEY, reserved.revision, next)).applied ? pending(next, true) : failure();
      }
      if (!safeString(body.access_token, 4096) || body.token_type !== "Bearer" || body.site_id !== c.receipt!.site_id ||
          typeof body.expires_in !== "number" || !Number.isInteger(body.expires_in) || body.expires_in < 1 || body.expires_in > 300 ||
          body.store_key !== undefined && (typeof body.store_key !== "string" || !STORE_KEY_RE.test(body.store_key))) return fail(reserved);
      const storeKey = (body.store_key as string | undefined) ?? stored.parsed.storeKey;
      const verified = await verifySessionToken(body.access_token, c.receipt!.site_id);
      const binding: Binding = { siteId: c.receipt!.site_id, origin, issuer: REGISTRY_ISSUER, subject: verified.subject };
      if (c.binding && (c.binding.siteId !== binding.siteId || c.binding.origin !== origin || c.binding.issuer !== binding.issuer || c.binding.subject !== binding.subject)) return fail(reserved);
      // The token was just verified, so read status with it now and show the
      // real connection. The result is saved with the grant, so this path stays
      // at ten bridge calls: one status fetch, no diagnostics, no extra write.
      const url = statusUrl();
      const checked: RegistryFlowResult = url ? await readStatus({ ...c, binding }, binding, verified.token, url, { diagnostics: false }) : { state: "ready" };
      const shown = checked.state === "ready" && "status" in checked ? (checked.status as { status?: unknown } | undefined)?.status : undefined;
      if (c.expiresAt <= now() || (await current())?.revision !== reserved.revision) return failure();
      const value = JSON.stringify({ kind: "session", flowId: c.flowId, token: verified.token, ...(storeKey ? { storeKey } : {}) } satisfies SessionSecret);
      if (!(await options.settings.compareAndSet(STATE_SETTING, stored.revision, value)).applied) return fail(reserved);
      const next: Control = { ...c, phase: "complete", binding, secretHash: await sha256(value), expiresAt: verified.expiresAt,
        receipt: undefined, verificationUri: undefined, ...(shown ? { lastStatus: { checkedAt: now(), status: shown } } : {}) };
      return (await options.kv.compareAndSet(CONTROL_KEY, reserved.revision, next)).applied ? checked : failure();
    } catch { return fail(reserved); }
  }
  function statusUrl(): URL | null {
    if (!configured) return null;
    try {
      const url = new URL(configured);
      return url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/v1/status" ? null : url;
    } catch { return null; }
  }
  async function status(user?: UserInfo): Promise<RegistryFlowResult> {
    let stage: StatusCheckStage = "read_control";
    try {
      const c = (await current())?.value;
      if (!origin || !options.http) return { state: "unconfigured" };
      if (!c) return { state: configured ? "disconnected" : "unconfigured" };
      if (c.origin !== origin) return { state: "action_required" };
      // This admin's own sign-in still in progress; anyone else reads status.
      if (c.adminId === user?.id && c.expiresAt > now() && c.phase !== "failed" && c.phase !== "complete") {
        return c.phase === "pending" ? pending(c) : { state: "connecting" };
      }
      // Only Connect makes the store's binding; a status read never needs the sign-in.
      if (!c.binding) return { state: "action_required" };
      const url = statusUrl();
      if (!url) return { state: "unconfigured" };
      stage = "read_key";
      const storeKey = storeKeyIn(await options.settings.get<unknown>(STATE_SETTING));
      if (!storeKey) return keyRequired(c, user);
      stage = "fetch_pass";
      const traded = await options.http.fetch(STORE_PASSES_URL, noRedirect({ method: "POST",
        headers: { Authorization: `Bearer ${storeKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ site_id: c.binding.siteId, scope: STORE_PASS_SCOPE, audience: REGISTRY_AUDIENCE }) }));
      if (!traded.ok) {
        const error = await traded.json().then(value => (value as { error?: unknown })?.error, () => undefined);
        if (traded.status === 429) return { state: "pass_refused", refusal: "rate_limited" };
        if (PASS_REFUSALS.includes(error as PassRefusal) && error !== "payments_refused") return { state: "pass_refused", refusal: error as PassRefusal };
        return checkFailure(stage, traded.status);
      }
      stage = "decode_pass";
      const token = admitStorePass((await traded.json() as { access_token?: unknown })?.access_token, c.binding.siteId);
      // Diagnostics stay admin-only: they use this admin's own live sign-in, or are skipped.
      const adminToken = async () => {
        if (c.adminId !== user?.id || c.phase !== "complete" || c.expiresAt <= now()) return null;
        const stored = await secret(c).catch(() => null);
        return stored?.parsed.kind === "session" ? stored.parsed.token : null;
      };
      const checked = await readStatus(c, c.binding, token, url, { remember: true, storePass: true, diagnosticsToken: adminToken });
      return checked.state === "action_required" ? { state: "pass_refused", refusal: "payments_refused" } : checked;
    } catch { return checkFailure(stage); }
  }
  // Payments verifies the signature; this only refuses a pass that is plainly
  // not DinkusKit.com's checkout pass for this store.
  function admitStorePass(token: unknown, siteId: string): string {
    if (typeof token !== "string" || token.length > 4096) throw new Error("invalid_pass");
    const parts = token.split(".");
    if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) throw new Error("invalid_pass");
    const payload = decodeJsonSegment<{ iss?: unknown; aud?: unknown; exp?: unknown; site_id?: unknown; scope?: unknown }>(parts[1]);
    if (payload.iss !== REGISTRY_ISSUER || !(payload.aud === REGISTRY_AUDIENCE || Array.isArray(payload.aud) && payload.aud.includes(REGISTRY_AUDIENCE)) ||
        payload.site_id !== siteId || typeof payload.scope !== "string" || !payload.scope.split(" ").includes(STORE_PASS_SCOPE) ||
        typeof payload.exp !== "number" || !Number.isSafeInteger(payload.exp) || payload.exp <= now() / 1000) throw new Error("invalid_pass");
    return token;
  }
  // A Stripe-changing button pressed after the page's sign-in lapsed: show the
  // current status and ask for Sign in again, which the action needs.
  async function signInFor(user: UserInfo): Promise<RegistryFlowResult> {
    const checked = await status(user);
    return checked.state === "ready" ? { ...checked, signIn: true } : checked;
  }
  // Both callers have already verified this exact token and owner binding.
  // Setup reuses that proof within the same invocation; all control rechecks
  // remain in place before and after the provider request and returned status.
  async function readStatus(c: Control, binding: Binding, token: string, url: URL, opts: { diagnostics?: boolean; remember?: boolean; storePass?: boolean; diagnosticsToken?: () => Promise<string | null> } = {}): Promise<RegistryFlowResult> {
    let stage: StatusCheckStage = "fetch_status";
    try {
      const result = await options.http!.fetch(url.href, noRedirect({ headers: { Authorization: `Bearer ${token}`, "X-Dinkus-Site": binding.siteId } }));
      if (result.status === 401 || result.status === 403) return { state: "action_required" };
      if (!result.ok) return checkFailure(stage, result.status);
      stage = "decode_status";
      const decoded = decodeStatus(await result.json());
      let diagnostics: ConnectionDiagnostics | undefined;
      let detailSignIn = false;
      if (opts.diagnostics !== false && (decoded.state === "connecting" || decoded.state === "recovery_required")) {
        try {
          const detailToken = opts.diagnosticsToken ? await opts.diagnosticsToken() : token;
          detailSignIn = !detailToken;
          const response = detailToken ? await options.http!.fetch(`${url.origin}/v1/connect/diagnostics`, noRedirect({ headers: { Authorization: `Bearer ${detailToken}`, "X-Dinkus-Site": binding.siteId } })) : null;
          if (response?.ok) {
            const value = decodeDiagnostics(await response.json(), now());
            if (value.mode === decoded.mode && value.state === decoded.state) diagnostics = value;
          }
        } catch { /* Legacy or unavailable diagnostics leave the verified status intact. */ }
        stage = "recheck_control";
        // A store pass does not depend on the page's sign-in, only on the same binding.
        if ((await current())?.value.flowId !== c.flowId || !opts.storePass && c.expiresAt <= now()) return { state: "action_required" };
      }
      if (opts.remember) await rememberStatus(c, binding, decoded);
      return { state: "ready", status: { availability: "available", status: decoded, message: "Payments status checked." }, ...(diagnostics ? { diagnostics } : {}), ...(detailSignIn ? { detailSignIn: true as const } : {}) };
    } catch { return checkFailure(stage); }
  }
  async function setupProcessor(user: UserInfo, country?: unknown): Promise<RegistryFlowResult> {
    const prior = await current();
    const c = prior?.value;
    if (!origin || !options.http || !configured) return { state: "unconfigured" };
    if (!c || c.phase !== "complete" || c.adminId !== user?.id || c.origin !== origin || c.expiresAt <= now() || !c.binding) return signInFor(user);
    let requested = false;
    try {
      const endpoint = new URL(configured);
      if (endpoint.protocol !== "https:" || endpoint.port || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== "/v1/status") return { state: "unconfigured" };
      const stored = await secret(c);
      if (stored.parsed.kind !== "session") return { state: "action_required" };
      const verified = await verifySessionToken(stored.parsed.token, c.binding.siteId);
      if (verified.subject !== c.binding.subject || c.binding.issuer !== REGISTRY_ISSUER) return { state: "action_required" };
      if ((await current())?.revision !== prior!.revision || c.expiresAt <= now()) return { state: "action_required" };
      requested = true;
      // Only a listed business country is sent; without one the service refuses
      // a new Stripe setup with merchant_country_required and creates nothing.
      const response = await options.http.fetch(`${endpoint.origin}/v1/connect`, noRedirect(businessCountry(country)
        ? { method: "POST", headers: { Authorization: `Bearer ${verified.token}`, "X-Dinkus-Site": c.binding.siteId, "Content-Type": "application/json" }, body: JSON.stringify({ country }) }
        : { method: "POST", headers: { Authorization: `Bearer ${verified.token}`, "X-Dinkus-Site": c.binding.siteId } }));
      if (response.status === 401 || response.status === 403) return { state: "action_required" };
      if (!response.ok) {
        const refusal = await response.json().then(value => (value as { error?: unknown })?.error, () => undefined);
        return SETUP_REFUSALS.includes(refusal as SetupRefusal) ? { state: "setup_refused", refusal: refusal as SetupRefusal } : { state: "setup_unconfirmed" };
      }
      const body = await response.json() as Record<string, unknown>;
      if ((await current())?.revision !== prior!.revision || c.expiresAt <= now()) return { state: "action_required" };
      if (!body || Array.isArray(body) || Object.keys(body).some(key => !["state", "mode", "bindingRef", "url", "expiresAt"].includes(key)) || !["disconnected", "connecting", "setup_required", "action_required", "ready", "checking", "recovery_required"].includes(body.state as string) || !["test", "live"].includes(body.mode as string)) return { state: "setup_unconfirmed" };
      if (body.bindingRef !== undefined && (!safeString(body.bindingRef, 200))) return { state: "setup_unconfirmed" };
      if (body.url === undefined && body.expiresAt === undefined) {
        const checked = await readStatus(c, c.binding, verified.token, endpoint);
        return checked.state === "check_failed" ? { state: "setup_unconfirmed", checkFailure: checked.checkFailure } : checked;
      }
      if (!["setup_required", "action_required"].includes(body.state as string) || !safeString(body.bindingRef, 200)) return { state: "setup_unconfirmed" };
      if (typeof body.url !== "string" || typeof body.expiresAt !== "number" || !Number.isSafeInteger(body.expiresAt) || body.expiresAt <= now() || body.expiresAt > now() + 3_600_000) return { state: "setup_unconfirmed" };
      if (!validOnboardingUrl(body.url, body.mode as "test" | "live")) return { state: "setup_unconfirmed" };
      const checked = await readStatus(c, c.binding, verified.token, endpoint);
      if (checked.state === "check_failed") return { state: "setup_unconfirmed", checkFailure: checked.checkFailure };
      if (checked.state === "ready" && ((checked.status as { status?: { mode?: string; bindingRef?: string } })?.status?.mode !== body.mode || (checked.status as { status?: { bindingRef?: string } })?.status?.bindingRef !== body.bindingRef)) return { state: "setup_unconfirmed" };
      if (checked.state !== "ready" || (await current())?.revision !== prior!.revision || c.expiresAt <= now() || body.expiresAt <= now()) return checked.state === "ready" ? { state: "action_required" } : checked;
      return { state: "processor_setup", onboardingUrl: body.url, expiresAt: body.expiresAt, status: checked.status, diagnostics: checked.diagnostics };
    } catch { return { state: requested ? "setup_unconfirmed" : "checking" }; }
  }
  async function providerIdentity(user: UserInfo): Promise<RegistryFlowResult> {
    const prior = await current();
    const c = prior?.value;
    if (!origin || !options.http || !configured) return { state: "unconfigured" };
    if (!c || c.phase !== "complete" || c.adminId !== user?.id || c.origin !== origin || c.expiresAt <= now() || !c.binding) return signInFor(user);
    const unavailable = (): RegistryFlowResult => ({ state: "provider_identity", providerIdentity: { result: "unavailable", validTestPrefix: false, at: now() } });
    try {
      const endpoint = new URL(configured);
      if (endpoint.protocol !== "https:" || endpoint.port || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== "/v1/status") return { state: "unconfigured" };
      const stored = await secret(c);
      if (stored.parsed.kind !== "session") return { state: "action_required" };
      const verified = await verifySessionToken(stored.parsed.token, c.binding.siteId);
      if (verified.subject !== c.binding.subject || c.binding.issuer !== REGISTRY_ISSUER) return { state: "action_required" };
      if ((await current())?.revision !== prior!.revision || c.expiresAt <= now()) return { state: "action_required" };
      const response = await options.http.fetch(`${endpoint.origin}/v1/connect/provider-identity`, noRedirect({ headers: { Authorization: `Bearer ${verified.token}`, "X-Dinkus-Site": c.binding.siteId } }));
      if ((await current())?.revision !== prior!.revision || c.expiresAt <= now()) return { state: "action_required" };
      if (!response.ok) return unavailable();
      return { state: "provider_identity", providerIdentity: decodeProviderIdentityDiagnostic(await response.json(), now()) };
    } catch { return unavailable(); }
  }
  return {
    start,
    receipt,
    exchange,
    status,
    setupProcessor,
    providerIdentity,
    proofPath,
    callbackPath,
    installedPluginId: installation?.installedPluginId ?? null,
  };
}

export function safeResponse(status: number, body: unknown) {
  return pluginResponse({ status, headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "Content-Type": "application/json" }, body: { kind: "text", value: JSON.stringify(body) } });
}
