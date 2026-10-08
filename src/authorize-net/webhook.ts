import { AuthorizeNetError, type AuthorizeNetTransaction } from "./checkout.js";

export class AuthorizeNetWebhookError extends Error {}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, "0")).join("");
}

function equalBytes(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index++) difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return difference === 0;
}

export interface AuthorizeNetWebhookEvent {
  readonly id: string;
  readonly payload: unknown;
  readonly transaction: AuthorizeNetTransaction | null;
}

/**
 * Authorize.net documents X-ANET-Signature as sha512=<hex HMAC> over the
 * original request body using the account Signature Key. The event ID is
 * separately replay-fenced by the caller because signature verification alone
 * cannot distinguish a replay.
 */
export async function verifyAuthorizeNetWebhook(
  payload: Uint8Array,
  signature: string,
  signatureKey: string,
  eventId: string,
  seenEventIds: Set<string>,
): Promise<AuthorizeNetWebhookEvent> {
  if (!(payload instanceof Uint8Array)) throw new AuthorizeNetWebhookError("raw_payload_required");
  if (!signatureKey) throw new AuthorizeNetWebhookError("missing_signature_key");
  if (!/^sha512=[0-9a-f]{128}$/i.test(signature)) throw new AuthorizeNetWebhookError("invalid_signature");
  if (!/^[-A-Za-z0-9_:.]{1,200}$/.test(eventId)) throw new AuthorizeNetWebhookError("invalid_event_id");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(signatureKey), { name: "HMAC", hash: "SHA-512" }, false, ["sign"]);
  const expected = `sha512=${hex(await crypto.subtle.sign("HMAC", key, payload))}`;
  if (!equalBytes(expected.toLowerCase(), signature.toLowerCase())) throw new AuthorizeNetWebhookError("invalid_signature");
  if (seenEventIds.has(eventId)) throw new AuthorizeNetWebhookError("replayed_event");

  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder().decode(payload)); }
  catch { throw new AuthorizeNetWebhookError("invalid_payload"); }
  return { id: eventId, payload: parsed, transaction: null };
}

export function createAuthorizeNetWebhookHandler(options: {
  signatureKey: string;
  seenEventIds: Set<string>;
  wake: (event: AuthorizeNetWebhookEvent) => Promise<void>;
}) {
  return async (payload: Uint8Array, signature: string, eventId: string): Promise<void> => {
    const event = await verifyAuthorizeNetWebhook(payload, signature, options.signatureKey, eventId, options.seenEventIds);
    await options.wake(event);
    options.seenEventIds.add(eventId);
  };
}

export function verifyAuthorizeNetReturn(input: {
  requestUrl: string;
  configuredUrl: string;
  transactionId: string;
  amount: string;
  currency: string;
}): { transactionId: string; amount: string; currency: "USD" } {
  const actual = new URL(input.requestUrl);
  const expected = new URL(input.configuredUrl);
  if (actual.protocol !== "https:" || actual.origin !== expected.origin || actual.pathname !== expected.pathname) {
    throw new AuthorizeNetError("forged_return_url");
  }
  if (!/^[0-9]+$/.test(input.transactionId) || input.currency !== "USD" || !/^[0-9]+(?:\.[0-9]{1,2})?$/.test(input.amount)) {
    throw new AuthorizeNetError("invalid_return");
  }
  // This is a navigation hint only. The transaction must still be looked up
  // and amount-checked before Commerce can decide paid/unpaid.
  return { transactionId: input.transactionId, amount: input.amount, currency: "USD" };
}
