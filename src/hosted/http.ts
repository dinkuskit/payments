import { AuthorizeNetWebhookError } from "../authorize-net/webhook.js";
import { CheckoutError, validatePaymentRequest } from "../checkout/sessions.js";
import { WebhookError } from "../checkout/webhook.js";
import { assertCommercePaymentWake, WakeError, type CommercePaymentWake } from "../checkout/wakes.js";
import type { PaymentOutcome, PaymentRequest } from "../commerce/checkout-port.js";
import type { Principal, createConnectionService } from "./connection.js";

type ConnectionApi = Pick<ReturnType<typeof createConnectionService>, "connect" | "status" | "checkoutBinding" | "existingBinding">;
type CheckoutApi = {
  ensureSession(request: PaymentRequest): Promise<PaymentOutcome>;
  lookup(request: PaymentRequest): Promise<PaymentOutcome>;
};
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
  if (error.message === "connection_owner_mismatch") return 403;
  if (error instanceof WakeError && error.message === "invalid_wake") return 400;
  if (error instanceof WakeError && error.message === "invalid_batch_limit") return 400;
  if (error instanceof WakeError) return 409;
  if (error instanceof CheckoutError &&
      (error.message === "invalid_request" || error.message === "invalid_amount" || error.message === "request_too_large")) return 400;
  if (error instanceof CheckoutError) return 409;
  return 503;
}

export function createHostedHandler(options: {
  authenticate(request: Request, scope: "payments:admin" | "payments:checkout"): Promise<Principal>;
  service(principal: Principal): ConnectionApi;
  checkout?(principal: Principal): CheckoutApi;
  wakes?(principal: Principal): WakeApi;
  webhook?(payload: Uint8Array, signature: string, stripeAccount: string | null): Promise<void>;
  authorizeNetWebhook?(payload: Uint8Array, signature: string, eventId: string, siteId: string): Promise<void>;
}) {
  const respond = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
  return async (request: Request): Promise<Response> => {
    const { pathname, searchParams } = new URL(request.url);
    if (pathname === "/v1/webhooks/stripe") {
      if (request.method !== "POST") return respond({ error: "method_not_allowed" }, 405);
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
    const authorizeNetPath = pathname.match(/^\/v1\/webhooks\/authorize-net\/([^/]+)$/);
    if (authorizeNetPath) {
      if (request.method !== "POST") return respond({ error: "method_not_allowed" }, 405);
      if (!options.authorizeNetWebhook || searchParams.size) return respond({ error: "not_found" }, 404);
      const signature = request.headers.get("x-anet-signature");
      const eventId = request.headers.get("x-anet-notification-id");
      if (!signature || !eventId) return respond({ error: "missing_signature" }, 400);
      try {
        await options.authorizeNetWebhook(new Uint8Array(await request.arrayBuffer()), signature, eventId, authorizeNetPath[1]);
        return respond({ received: true });
      } catch (error) {
        if (error instanceof AuthorizeNetWebhookError || error instanceof WebhookError ||
            (error instanceof Error && error.message === "site_mismatch")) {
          return respond({ error: error instanceof Error ? error.message : "site_mismatch" }, 400);
        }
        if (error instanceof Error && /signature/i.test(error.message)) return respond({ error: "invalid_signature" }, 400);
        return respond({ error: "wake_failed" }, 500);
      }
    }
    const methods: Record<string, string> = {
      "/v1/connect": "POST",
      "/v1/status": "GET",
      "/v1/checkout-binding": "GET",
      "/v1/existing-binding": "GET",
      "/v1/checkout/session": "POST",
      "/v1/checkout/lookup": "POST",
      "/v1/checkout/wakes": "GET",
      "/v1/checkout/wakes/ack": "POST",
    };
    if (!methods[pathname]) return respond({ error: "not_found" }, 404);
    if (request.method !== methods[pathname]) return respond({ error: "method_not_allowed" }, 405);
    const checkoutScope = pathname !== "/v1/connect" && pathname !== "/v1/status";
    let principal: Principal;
    try { principal = await options.authenticate(request, checkoutScope ? "payments:checkout" : "payments:admin"); }
    catch { return respond({ error: "unauthorized" }, 401); }
    try {
      if (pathname === "/v1/connect") {
        const service = options.service(principal);
        // No caller-controlled account, mode, return URL, or provider selection.
        // Check bytes, not stream presence: a bodyless runtime POST can still
        // have a non-null, exhausted stream. No caller input is buffered.
        if (searchParams.size || await hasBodyBytes(request)) return respond({ error: "unexpected_input" }, 400);
        return respond(await service.connect(principal));
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
      if (searchParams.size) return respond({ error: "unexpected_input" }, 400);
      const requestBody = await readCheckoutRequest(request);
      const checkout = options.checkout(principal);
      return respond(pathname === "/v1/checkout/session" ? await checkout.ensureSession(requestBody) : await checkout.lookup(requestBody));
    } catch (error) {
      return respond({ error: error instanceof Error ? error.message : "service_unavailable" }, checkoutErrorStatus(error));
    }
  };
}
