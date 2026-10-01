import type { Mode } from "../hosted/connection.js";

export interface WakeContext {
  readonly eventId: string;
  readonly attemptId: string;
  readonly siteId: string;
  readonly bindingRef: string;
  readonly stripeAccountId: string;
  readonly mode: Mode;
}

export type ReconciliationResult = true | "reconciled" | false | "pending" | "unknown";

export class WakeError extends Error {}

export function assertWakeContext(context: WakeContext): void {
  if (!context || typeof context !== "object") throw new WakeError("invalid_wake_context");
  const required = ["eventId", "attemptId", "siteId", "bindingRef", "stripeAccountId", "mode"];
  const keys = Object.keys(context);
  if (keys.length !== required.length || required.some(key => !Object.prototype.hasOwnProperty.call(context, key))) {
    throw new WakeError("invalid_wake_context");
  }
  if (!/^evt_[A-Za-z0-9]+$/.test(context.eventId)) throw new WakeError("invalid_event_id");
  for (const [name, value] of Object.entries(context)) {
    if (name !== "mode" && (typeof value !== "string" || value.length === 0 || value.length > 200)) {
      throw new WakeError("invalid_wake_context");
    }
  }
  if (context.mode !== "test" && context.mode !== "live") throw new WakeError("invalid_wake_context");
}

export interface WakeEventStore {
  pending(limit: number): WakeContext[];
  acknowledge(context: WakeContext): boolean;
}

const consumptionTails = new WeakMap<object, Promise<void>>();

export async function consumeWakeBatch(
  store: WakeEventStore,
  reconcile: (context: Readonly<WakeContext>) => Promise<ReconciliationResult>,
  limit = 25,
): Promise<{ inspected: number; acknowledged: number }> {
  const previous = consumptionTails.get(store);
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  const tail = (previous ?? Promise.resolve()).then(() => current);
  consumptionTails.set(store, tail);
  await previous;
  try {
    return await consumeWakeBatchSerial(store, reconcile, limit);
  } finally {
    release();
    if (consumptionTails.get(store) === tail) consumptionTails.delete(store);
  }
}

async function consumeWakeBatchSerial(
  store: WakeEventStore,
  reconcile: (context: Readonly<WakeContext>) => Promise<ReconciliationResult>,
  limit: number,
): Promise<{ inspected: number; acknowledged: number }> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new WakeError("invalid_batch_limit");
  const events = store.pending(limit);
  for (const event of events) assertWakeContext(event);
  let acknowledged = 0;
  for (const event of events) {
    const acknowledgement = Object.freeze({ ...event });
    const callbackContext: Readonly<WakeContext> = Object.freeze({ ...acknowledgement });
    try {
      const result = await reconcile(callbackContext);
      if (result === true || result === "reconciled") {
        if (store.acknowledge(acknowledgement)) acknowledged++;
      }
    } catch {
      // A failed reconciliation is retryable; the event remains pending.
    }
  }
  return { inspected: events.length, acknowledged };
}
