import assert from "node:assert/strict";
import { createPluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { env } from "cloudflare:test";
import { decodePluginSettingValue, isEncryptedPluginSetting, resolvePluginEncryptionKeys } from "emdash";

// Synthetic service replies only. All actions still cross the built plugin's
// production dispatcher, Worker Loader, HTTP policy and D1 settings/KV bridges.
export const CONNECT = "https://dinkuskit.com/api/store-connections";
export const JWKS = "https://dinkuskit.com/account/.well-known/jwks.json";
export const STATUS = "https://payments.dinkuskit.com/v1/status";
export const CONTROL = "state:registry-v2-control";
export const SETTING = "registry_session";
export const SITE = "https://shop.example";

export type Host = Awaited<ReturnType<typeof createPluginRuntimeTestHost>>;
// Disposable, generated in memory for this test worker only; never persisted
// or printed. EmDash keeps its normal AES-GCM settings encryption enabled.
const syntheticEncryptionKey = `emdash_enc_v1_${btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
  .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}`;
process.env.EMDASH_ENCRYPTION_KEY = syntheticEncryptionKey;
(env as unknown as Record<string, unknown>).EMDASH_ENCRYPTION_KEY = syntheticEncryptionKey;

export async function session(host: Host) {
  const raw = await host.inspect.settings.raw(SETTING);
  assert.ok(isEncryptedPluginSetting(raw), "session must be encrypted at rest");
  return JSON.parse(await decodePluginSettingValue<string>(host.manifest.id, SETTING, raw,
    host.manifest.admin.settingsSchema!, await resolvePluginEncryptionKeys({ EMDASH_ENCRYPTION_KEY: syntheticEncryptionKey })));
}
export type Control = {
  phase: string; flowId: string; adminId: string; origin: string;
  expiresAt: number; nextPollAt: number; secretHash: string;
  binding?: { siteId: string; origin: string; issuer: string; subject: string };
  receipt?: Record<string, unknown>;
};

export async function control(host: Host) {
  const value = await host.inspect.kv.get<Control>(CONTROL);
  assert.ok(value);
  return value;
}

export function body(request: ReturnType<Host["http"]["requests"]>[number]) {
  return JSON.parse(new TextDecoder().decode(request.body));
}

export async function fixture(options: { installedId?: string } = {}) {
  const bindings = env as unknown as { EMDASH_PLUGIN_MANIFEST: string };
  const originalManifest = bindings.EMDASH_PLUGIN_MANIFEST;
  let host: Host;
  try {
    if (options.installedId) {
      bindings.EMDASH_PLUGIN_MANIFEST = JSON.stringify({ ...JSON.parse(originalManifest), id: options.installedId });
    }
    host = await createPluginRuntimeTestHost({ site: { url: SITE } });
  } finally { bindings.EMDASH_PLUGIN_MANIFEST = originalManifest; }
  const admin = await host.fixtures.user({ email: "connection-admin@example.invalid", role: "admin" });
  const { privateKey, publicKey } = await generateKeyPair("ES256");
  const jwk = { ...await exportJWK(publicKey), kid: "synthetic-connection-key", alg: "ES256" };
  const action = (id: string) => host.admin.act("/status", id, { user: admin });
  const page = () => host.admin.loadPage("/status", { user: admin });
  const receipt = (id: string) => host.actions.routes.request("store-proof", {
    method: "GET", url: `https://plugin.test/_emdash/api/plugins/${host.manifest.id}/store-proof?connection_id=${id}`,
  });
  async function prepareStart(id: string) {
    await host.http.respond(CONNECT, Response.json({
      protocol_version: 2, site_id: "synthetic-site", connection_id: id,
      challenge: "synthetic-public-challenge", expires_at: Date.now() + 590_000,
      interval: 1, verification_uri: `https://dinkuskit.com/account/connect?connection_id=${id}`,
    }));
  }
  async function pollDue() {
    // plugin-test's scheduled clock does not control Date.now in the plugin
    // isolate. Seed only timing metadata in real D1, never bypass exchange/CAS.
    await host.fixtures.plugin.kv(CONTROL, { ...await control(host), nextPollAt: Date.now() - 1 });
  }
  async function prepareExchange() {
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ site_id: "synthetic-site", scope: "payments:admin" })
      .setProtectedHeader({ alg: "ES256", kid: jwk.kid })
      .setIssuer("https://dinkuskit.com/account").setAudience("dinkus-payments")
      .setSubject("synthetic-organization").setIssuedAt(now).setExpirationTime(now + 300).sign(privateKey);
    await host.http.respond(`${CONNECT}/token`, Response.json({
      access_token: token, token_type: "Bearer", site_id: "synthetic-site", expires_in: 300,
    }));
    // Continue validates and saves the exchange token. Status is a separate action.
    await host.http.respond(JWKS, Response.json({ keys: [jwk] }));
    return token;
  }
  async function prepareStatus(disconnected: boolean | "setup" = false) {
    await host.http.respond(JWKS, Response.json({ keys: [jwk] }));
    await host.http.respond(STATUS, Response.json(disconnected === "setup" ? { state: "setup_required", mode: "test", bindingRef: "synthetic-binding", connectionEvidence: { provider: "stripe", mode: "test", result: "unknown", accountRef: "acct_synthetic" } } : disconnected ? { state: "disconnected", mode: "test" } : {
      state: "ready", mode: "test", bindingRef: "synthetic-binding",
      connectionEvidence: { provider: "stripe", mode: "test", result: "verified", accountRef: "acct_synthetic" },
    }));
  }
  async function prepareProcessorStatus(disconnected: boolean | "setup" = "setup") {
    await prepareStatus(disconnected);
  }
  async function prepareDiagnostics(state: "connecting" | "recovery_required", diagnostics: unknown, status = 200) {
    await host.http.respond(JWKS, Response.json({ keys: [jwk] }));
    await host.http.respond(STATUS, Response.json({ state, mode: "test", bindingRef: "synthetic-binding" }));
    await host.http.respond("https://payments.dinkuskit.com/v1/connect/diagnostics", Response.json(diagnostics, { status }));
  }
  async function prepareStatusResponse(payload: unknown, status = 200) {
    await host.http.respond(JWKS, Response.json({ keys: [jwk] }));
    await host.http.respond(STATUS, Response.json(payload, { status }));
  }
  async function prepareSetupDiagnostics(state: "connecting" | "recovery_required", diagnostics: unknown) {
    await prepareDiagnostics(state, diagnostics);
  }
  async function prepareSetupStatusResponse(payload: unknown, status = 200) {
    await prepareStatusResponse(payload, status);
  }
  return { host, admin, action, page, receipt, prepareStart, pollDue, prepareExchange, prepareStatus, prepareProcessorStatus, prepareDiagnostics, prepareStatusResponse, prepareSetupDiagnostics, prepareSetupStatusResponse };
}

export async function snapshot(host: Host) {
  // In-memory synthetic state only. Never log or retain the token/verifier.
  return { control: await control(host), setting: await host.inspect.settings.raw(SETTING) };
}
