import { AuthorizeNetWebhookError } from "../authorize-net/webhook.js";
import { CheckoutError, validatePaymentRequest } from "../checkout/sessions.js";
import { isPlayground, PLAYGROUND_IP_LIMIT, PLAYGROUND_RATE_LIMIT_ERROR } from "../checkout/playground.js";
import { WebhookError } from "../checkout/webhook.js";
import { assertCommercePaymentWake, WakeError, type CommercePaymentWake } from "../checkout/wakes.js";
import type { PaymentOutcome, PaymentRequest } from "../commerce/checkout-port.js";
import type { Principal, createConnectionService } from "./connection.js";
import { clientIpRateKey } from "./client-ip.js";
import { hostedHttpRoutes, hostedWebhookRoutes, matchAuthorizeNetWebhookSite } from "./manifest.js";

type ConnectionApi = Pick<ReturnType<typeof createConnectionService>, "connect" | "status" | "checkoutBinding" | "existingBinding"> & {
  diagnostics?(principal: Principal): ReturnType<ReturnType<typeof createConnectionService>["diagnostics"]> | Promise<ReturnType<ReturnType<typeof createConnectionService>["diagnostics"]>>;
  providerIdentityDiagnostic?(principal: Principal): Promise<unknown>;
  prepareRejectedLegacyV2?(principal: Principal): Promise<unknown>;
};
type CheckoutApi = {
  ensureSession(request: PaymentRequest): Promise<PaymentOutcome>;
  lookup(request: PaymentRequest): Promise<PaymentOutcome>;
  /** Playground only: confirm a payment by Checkout Session id on the store's success page. */
  receipt?(sessionId: string): Promise<PaymentOutcome>;
};
/** Request facts a checkout may need beyond the validated body. */
export type CheckoutContext = { clientIp?: string };

/** Only these routes are open to the playground's narrow pass. */
const PLAYGROUND_ROUTES = new Set(["/v1/checkout/session", "/v1/checkout/lookup", "/v1/checkout/receipt"]);
const PLAYGROUND_SESSION_ID = /^cs_test_[A-Za-z0-9]{1,200}$/;
type WakeApi = {
  list(bindingRef: string, limit: number): Promise<readonly CommercePaymentWake[]>;
  acknowledge(wake: CommercePaymentWake): Promise<boolean>;
};

const MAX_CHECKOUT_BODY_BYTES = 128 * 1024;

async function readCheckoutRequest(request: Request): Promise<PaymentRequest> {
  if (!request.body) throw new CheckoutError("invalid_request");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_CHECKOUT_BODY_BYTES) throw new CheckoutError("request_too_large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  try {
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const body = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)) as PaymentRequest;
    return validatePaymentRequest(body);
  } catch (error) {
    if (error instanceof CheckoutError) throw error;
    throw new CheckoutError("invalid_request");
  }
}

async function hasBodyBytes(request: Request): Promise<boolean> {
  if (request.body === null) return false;
  // workerd can represent a bodyless POST as an exhausted stream. Reject
  // content on the first byte rather than buffering caller input.
  const reader = request.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return false;
      if (value.byteLength > 0) return true;
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

function checkoutErrorStatus(error: unknown): number {
  if (!(error instanceof Error)) return 503;
  // Thrown inside the playground Durable Object; only the message survives RPC.
  if (error.message === PLAYGROUND_RATE_LIMIT_ERROR) return 429;
  if (error.message === "stripe_mode_mismatch" || error.message === "playground_unconfigured" || error.message === "diagnostic_unavailable") return 503;
  if (error.message === "connection_owner_mismatch") return 403;
  if (error.message === "legacy_recovery_forbidden") return 403;
  if (["legacy_recovery_refused", "legacy_recovery_conflict", "legacy_recovery_platform_mismatch"].includes(error.message)) return 409;
  // Thrown inside the store's Durable Object; only the message survives RPC.
  if (error.message === "store_origin_missing") return 409;
  if (error instanceof WakeError && error.message === "invalid_wake") return 400;
  if (error instanceof WakeError && error.message === "invalid_batch_limit") return 400;
  if (error instanceof WakeError) return 409;
  if (error instanceof CheckoutError &&
      (error.message === "invalid_request" || error.message === "invalid_amount" || error.message === "request_too_large")) return 400;
  if (error instanceof CheckoutError) return 409;
  return 503;
}

export function createHostedHandler(options: {
  authenticate(request: Request, scope: "payments:admin" | "payments:checkout" | readonly ("payments:admin" | "payments:checkout")[]): Promise<Principal>;
  service(principal: Principal): ConnectionApi;
  checkout?(principal: Principal, context: CheckoutContext): CheckoutApi;
  wakes?(principal: Principal): WakeApi;
  webhook?(payload: Uint8Array, signature: string, stripeAccount: string | null): Promise<void>;
  authorizeNetWebhook?(payload: Uint8Array, signature: string, eventId: string, siteId: string): Promise<void>;
}) {
  const respond = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
  return async (request: Request): Promise<Response> => {
    const { pathname, searchParams } = new URL(request.url);
    if (pathname === hostedWebhookRoutes.stripe.path) {
      if (request.method !== hostedWebhookRoutes.stripe.method) return respond({ error: "method_not_allowed" }, 405);
      if (!options.webhook) return respond({ error: "not_found" }, 404);
      const signature = request.headers.get("stripe-signature");
      if (!signature) return respond({ error: "missing_signature" }, 400);
      try {
        // Verify the original bytes. Do not JSON.parse before signature use.
        await options.webhook(new Uint8Array(await request.arrayBuffer()), signature, request.headers.get("stripe-account"));
        return respond({ received: true });
      } catch (error) {
        if (error instanceof WebhookError) return respond({ error: error.message }, error.message === "raw_payload_required" || error.message === "missing_signature" ? 400 : 409);
        if (error instanceof CheckoutError) return respond({ error: error.message }, 409);
        if (error instanceof Error && /signature/i.test(error.message)) return respond({ error: "invalid_signature" }, 400);
        return respond({ error: "wake_failed" }, 500);
      }
    }
    const authorizeNetSite = matchAuthorizeNetWebhookSite(pathname);
    if (authorizeNetSite) {
      if (request.method !== hostedWebhookRoutes.authorizeNet.method) return respond({ error: "method_not_allowed" }, 405);
      if (!options.authorizeNetWebhook || searchParams.size) return respond({ error: "not_found" }, 404);
      const signature = request.headers.get("x-anet-signature");
      const eventId = request.headers.get("x-anet-notification-id");
      if (!signature || !eventId) return respond({ error: "missing_signature" }, 400);
      try {
        await options.authorizeNetWebhook(new Uint8Array(await request.arrayBuffer()), signature, eventId, authorizeNetSite);
        return respond({ received: true });
      } catch (error) {
        if (error instanceof AuthorizeNetWebhookError || error instanceof WebhookError ||
            (error instanceof Error && (error.message === "site_mismatch" || error.message === "invalid_invoice_reference"))) {
          return respond({ error: error instanceof Error ? error.message : "site_mismatch" }, 400);
        }
        if (error instanceof Error && /signature/i.test(error.message)) return respond({ error: "invalid_signature" }, 400);
        return respond({ error: "wake_failed" }, 500);
      }
    }
    const route = Object.hasOwn(hostedHttpRoutes, pathname)
      ? hostedHttpRoutes[pathname as keyof typeof hostedHttpRoutes] : undefined;
    if (!route) return respond({ error: "not_found" }, 404);
    if (request.method !== route.method) return respond({ error: "method_not_allowed" }, 405);
    let principal: Principal;
    try { principal = await options.authenticate(request, route.scope); }
    catch { return respond({ error: "unauthorized" }, 401); }
    const playground = isPlayground(principal);
    if (playground && !PLAYGROUND_ROUTES.has(pathname)) return respond({ error: "forbidden" }, 403);
    if (!playground && pathname === "/v1/checkout/receipt") return respond({ error: "not_found" }, 404);
    try {
      if (pathname === "/v1/connect") {
        const service = options.service(principal);
        // No caller-controlled account, mode, return URL, or provider selection.
        // Check bytes, not stream presence: a bodyless runtime POST can still
        // have a non-null, exhausted stream. No caller input is buffered.
        if (searchParams.size || await hasBodyBytes(request)) return respond({ error: "unexpected_input" }, 400);
        return respond(await service.connect(principal));
      }
      if (pathname === "/v1/connect/diagnostics") {
        if (searchParams.size || await hasBodyBytes(request)) return respond({ error: "unexpected_input" }, 400);
        const service = options.service(principal);
        if (!service.diagnostics) return respond({ error: "not_found" }, 404);
        return respond(await service.diagnostics(principal));
      }
      if (pathname === "/v1/connect/reconcile-legacy-rejection") {
        if (searchParams.size || await hasBodyBytes(request)) return respond({ error: "unexpected_input" }, 400);
        const service = options.service(principal);
        if (!service.prepareRejectedLegacyV2) return respond({ error: "not_found" }, 404);
        return respond(await service.prepareRejectedLegacyV2(principal));
      }
      if (pathname === "/v1/connect/provider-identity") {
        if (searchParams.size || await hasBodyBytes(request)) return respond({ error: "unexpected_input" }, 400);
        const service = options.service(principal);
        if (!service.providerIdentityDiagnostic) return respond({ error: "not_found" }, 404);
        return respond(await service.providerIdentityDiagnostic(principal));
      }
      if (pathname === "/v1/status") {
        const service = options.service(principal);
        if (searchParams.size) return respond({ error: "unexpected_input" }, 400);
        return respond(await service.status(principal));
      }
      if (pathname === "/v1/checkout-binding" || pathname === "/v1/existing-binding") {
        const service = options.service(principal);
        const refs = searchParams.getAll("bindingRef");
        if (refs.length !== 1 || searchParams.size !== 1 || refs[0].length < 1 || refs[0].length > 200) return respond({ error: "invalid_binding" }, 400);
        const binding = pathname === "/v1/existing-binding"
          ? await service.existingBinding(principal, refs[0])
          : await service.checkoutBinding(principal, refs[0]);
        return binding ? respond(binding) : respond({ error: pathname === "/v1/existing-binding" ? "binding_not_found" : "payments_not_ready" }, 409);
      }
      if (pathname === "/v1/checkout/wakes") {
        if (!options.wakes) return respond({ error: "not_found" }, 404);
        const refs = searchParams.getAll("bindingRef");
        const limits = searchParams.getAll("limit");
        const queryKeys = [...searchParams.keys()];
        if (queryKeys.some(key => key !== "bindingRef" && key !== "limit") ||
            refs.length !== 1 || refs[0].length < 1 || refs[0].length > 200 || limits.length > 1 ||
            (searchParams.size !== 1 && searchParams.size !== 2)) {
          return respond({ error: "invalid_wake_query" }, 400);
        }
        const limit = limits.length === 0 ? 25 : /^(?:[1-9][0-9]?|100)$/.test(limits[0]) ? Number(limits[0]) : NaN;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) return respond({ error: "invalid_batch_limit" }, 400);
        return respond(await options.wakes(principal).list(refs[0], limit));
      }
      if (pathname === "/v1/checkout/wakes/ack") {
        if (!options.wakes || searchParams.size) return respond({ error: "unexpected_input" }, 400);
        let wake: CommercePaymentWake;
        try {
          wake = await request.json() as CommercePaymentWake;
          assertCommercePaymentWake(wake);
        } catch {
          return respond({ error: "invalid_wake" }, 400);
        }
        return respond({ acknowledged: await options.wakes(principal).acknowledge(wake) });
      }
      if (!options.checkout) return respond({ error: "not_found" }, 404);
      if (pathname === "/v1/checkout/receipt") {
        // Validated before any Durable Object is touched.
        const ids = searchParams.getAll("session_id");
        if (searchParams.size !== 1 || ids.length !== 1 || !PLAYGROUND_SESSION_ID.test(ids[0])) return respond({ error: "invalid_session_id" }, 400);
        const checkout = options.checkout(principal, {});
        if (!checkout.receipt) return respond({ error: "not_found" }, 404);
        return respond(await checkout.receipt(ids[0]));
      }
      if (searchParams.size) return respond({ error: "unexpected_input" }, 400);
      const requestBody = await readCheckoutRequest(request);
      const context: CheckoutContext = {};
      if (playground && pathname === "/v1/checkout/session") {
        // The playground Worker calls server-to-server, so it forwards the
        // shopper's IP. Without one, the per-IP limit cannot apply: fail closed.
        const clientIp = request.headers.get("x-dinkus-client-ip")?.trim();
        if (!clientIp) return respond({ error: "client_ip_required" }, 400);
        // Strictly parsed and normalized (lowercase, IPv6 by /64) so malformed
        // or rotated values cannot mint fresh per-IP buckets.
        const clientIpKey = clientIpRateKey(clientIp);
        if (!clientIpKey) return respond({ error: "invalid_client_ip", message: "x-dinkus-client-ip must be a valid IPv4 or IPv6 address." }, 400);
        context.clientIp = clientIpKey;
      }
      const checkout = options.checkout(principal, context);
      return respond(pathname === "/v1/checkout/session" ? await checkout.ensureSession(requestBody) : await checkout.lookup(requestBody));
    } catch (error) {
      const status = checkoutErrorStatus(error);
      if (status === 429) {
        return Response.json({ error: PLAYGROUND_RATE_LIMIT_ERROR, message: "Too many playground checkouts. Please wait a few minutes and try again." }, {
          status, headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "Retry-After": String(PLAYGROUND_IP_LIMIT.windowMs / 1000) },
        });
      }
      return respond({ error: error instanceof Error ? error.message : "service_unavailable" }, status);
    }
  };
}
