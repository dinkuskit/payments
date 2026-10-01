import assert from "node:assert/strict";
import test from "node:test";
import { assertWakeContext, consumeWakeBatch, WakeError } from "../src/checkout/wakes.ts";

const first = {
  eventId: "evt_one",
  attemptId: "attempt-one",
  siteId: "site-one",
  bindingRef: "binding-one",
  stripeAccountId: "acct_one",
  mode: "test",
};

function store(events) {
  const acknowledged = new Set();
  return {
    pending(limit) {
      return events.filter(event => !acknowledged.has(event.eventId)).slice(0, limit);
    },
    acknowledge(context) {
      const event = events.find(candidate => candidate.eventId === context.eventId);
      if (!event || Object.keys(context).some(key => event[key] !== context[key])) throw new WakeError("wake_association_mismatch");
      const alreadyAcknowledged = acknowledged.has(context.eventId);
      acknowledged.add(context.eventId);
      return !alreadyAcknowledged;
    },
    acknowledged,
  };
}

test("only canonical event IDs are accepted", () => {
  assertWakeContext(first);
  assert.throws(() => assertWakeContext({ ...first, eventId: "not-an-event" }), /invalid_event_id/);
});

test("false, pending, unknown, and thrown reconciliation results retain events", async () => {
  const events = [
    first,
    { ...first, eventId: "evt_two" },
    { ...first, eventId: "evt_three" },
    { ...first, eventId: "evt_four" },
  ];
  const durable = store(events);
  const result = await consumeWakeBatch(durable, async context => {
    if (context.eventId === "evt_one") return false;
    if (context.eventId === "evt_two") return "pending";
    if (context.eventId === "evt_three") return "unknown";
    throw new Error("commerce_down");
  });
  assert.deepEqual(result, { inspected: 4, acknowledged: 0 });
  assert.deepEqual([...durable.acknowledged], []);
});

test("callback cannot mutate any association field before exact acknowledgement", async () => {
  const durable = store([first, { ...first, eventId: "evt_two" }]);
  for (const field of ["eventId", "attemptId", "siteId", "bindingRef", "stripeAccountId", "mode"]) {
    let callbackContext;
    assert.deepEqual(await consumeWakeBatch(durable, async context => {
      callbackContext = context;
      assert.deepEqual({ ...context }, first);
      context[field] = "wrong-value";
      return true;
    }, 1), { inspected: 1, acknowledged: 0 });
    assert.deepEqual({ ...callbackContext }, first);
    assert.deepEqual([...durable.acknowledged], []);
  }
  assert.deepEqual(await consumeWakeBatch(durable, async context => {
    assert.deepEqual({ ...context }, first);
    return true;
  }, 1), { inspected: 1, acknowledged: 1 });
  assert.deepEqual([...durable.acknowledged], ["evt_one"]);
  for (const field of ["eventId", "attemptId", "siteId", "bindingRef", "stripeAccountId", "mode"]) {
    assert.throws(() => durable.acknowledge({ ...first, [field]: "wrong-value" }), /wake_association_mismatch/);
  }
  assert.deepEqual(await consumeWakeBatch(durable, async context => {
    assert.equal(context.eventId, "evt_two");
    return "pending";
  }), { inspected: 1, acknowledged: 0 });
  assert.deepEqual([...durable.acknowledged], ["evt_one"]);
});

test("all six wake fields are required before reconciliation is called", async () => {
  for (const field of ["eventId", "attemptId", "siteId", "bindingRef", "stripeAccountId", "mode"]) {
    const malformed = { ...first };
    delete malformed[field];
    assert.throws(() => assertWakeContext(malformed), /invalid_wake_context|invalid_event_id/);
  }
  let called = false;
  await assert.rejects(
    consumeWakeBatch(store([{ ...first, siteId: undefined }]), async () => {
      called = true;
      return true;
    }),
    /invalid_wake_context/,
  );
  assert.equal(called, false);
});

test("overlapping consumers reconcile an event once and count only its ACK", async () => {
  const durable = store([first]);
  let callbackCalls = 0;
  let release;
  const callbackStarted = new Promise(resolve => { release = resolve; });
  let allowCallback;
  const callbackGate = new Promise(resolve => { allowCallback = resolve; });
  const reconcile = async context => {
    callbackCalls++;
    release();
    await callbackGate;
    assert.equal(context.eventId, "evt_one");
    return true;
  };

  const firstConsumer = consumeWakeBatch(durable, reconcile);
  await callbackStarted;
  const secondConsumer = consumeWakeBatch(durable, reconcile);
  allowCallback();

  assert.deepEqual(await Promise.all([firstConsumer, secondConsumer]), [
    { inspected: 1, acknowledged: 1 },
    { inspected: 0, acknowledged: 0 },
  ]);
  assert.equal(callbackCalls, 1);
});

test("a conditional ACK that changes zero rows is not counted", async () => {
  const durable = store([first]);
  durable.acknowledge(first);
  assert.deepEqual(await consumeWakeBatch(durable, async () => true), {
    inspected: 0,
    acknowledged: 0,
  });

  const conditionalStore = {
    pending: () => [first],
    acknowledge: () => false,
  };
  assert.deepEqual(await consumeWakeBatch(conditionalStore, async () => true), {
    inspected: 1,
    acknowledged: 0,
  });
});

test("pending and failed reconciliation release the store for retries", async () => {
  const durable = store([first]);
  let calls = 0;
  const pendingThenRetry = [
    consumeWakeBatch(durable, async () => {
      calls++;
      return "pending";
    }),
    consumeWakeBatch(durable, async () => {
      calls++;
      return true;
    }),
  ];
  assert.deepEqual(await Promise.all(pendingThenRetry), [
    { inspected: 1, acknowledged: 0 },
    { inspected: 1, acknowledged: 1 },
  ]);
  assert.equal(calls, 2);

  const failedStore = store([first]);
  const failed = consumeWakeBatch(failedStore, async () => { throw new Error("temporary"); });
  const retry = consumeWakeBatch(failedStore, async () => true);
  assert.deepEqual(await Promise.all([failed, retry]), [
    { inspected: 1, acknowledged: 0 },
    { inspected: 1, acknowledged: 1 },
  ]);
});
