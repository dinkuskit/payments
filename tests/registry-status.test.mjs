import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeStatus,
  unavailableStatusProjection,
} from "../src/registry/status.ts";
import {
  projectSetupScreen,
  renderSetupScreen,
} from "../src/registry/setup.ts";
import plugin from "../src/plugin.ts";

test("decodes every status state and preserves only the public status shape", () => {
  for (const state of [
    "disconnected",
    "connecting",
    "setup_required",
    "ready",
    "checking",
    "action_required",
    "recovery_required",
  ]) {
    assert.deepEqual(decodeStatus({ state, mode: "test" }), { state, mode: "test" });
  }
  assert.deepEqual(
    decodeStatus({ state: "ready", mode: "live", bindingRef: "binding-1" }),
    { state: "ready", mode: "live", bindingRef: "binding-1" },
  );
  assert.deepEqual(
    decodeStatus({
      state: "ready",
      mode: "test",
      bindingRef: "binding-1",
      connectionEvidence: { provider: "stripe", mode: "test", result: "verified", accountRef: "acct_one" },
    }),
    {
      state: "ready",
      mode: "test",
      bindingRef: "binding-1",
      connectionEvidence: { provider: "stripe", mode: "test", result: "verified", accountRef: "acct_one" },
    },
  );
  assert.deepEqual(
    decodeStatus({
      state: "ready",
      mode: "test",
      connectionEvidence: { provider: "authorize_net", mode: "test", result: "unsupported" },
    }),
    {
      state: "ready",
      mode: "test",
      connectionEvidence: { provider: "authorize_net", mode: "test", result: "unsupported" },
    },
  );
});

test("rejects provider fields, missing fields, invalid modes, and extra fields", () => {
  for (const value of [
    { state: "ready", mode: "test", providerId: "stripe" },
    { state: "ready" },
    { state: "ready", mode: "sandbox" },
    { state: "ready", mode: "test", connectionEvidence: { provider: "stripe", mode: "test", result: "unsupported" } },
    { state: "checking", mode: "test", connectionEvidence: { provider: "stripe", mode: "test", result: "unknown" } },
    { state: "unknown", mode: "test" },
    { state: "ready", mode: "test", bindingRef: "" },
    { state: "ready", mode: "test", connectionEvidence: { provider: "stripe", mode: "live", result: "verified", accountRef: "acct_one" } },
    { state: "ready", mode: "test", connectionEvidence: { provider: "stripe", mode: "test", result: "verified" } },
    { state: "ready", mode: "test", connectionEvidence: { provider: "stripe", mode: "test", result: "verified", accountRef: "merchant-one" } },
    { state: "ready", mode: "test", connectionEvidence: { provider: "authorize_net", mode: "test", result: "verified" } },
    { state: "ready", mode: "test", connectionEvidence: { provider: "authorize_net", mode: "test", result: "unsupported", accountRef: "merchant-one" } },
    { state: "action_required", mode: "test", connectionEvidence: { provider: "stripe", mode: "test", result: "verified", accountRef: "acct_one" } },
    { state: "ready", mode: "test", connectionEvidence: { provider: "stripe", mode: "test", result: "unknown", accountRef: "acct_one" } },
  ]) {
    assert.throws(() => decodeStatus(value), /invalid_status/);
  }
});

test("legacy status has no fabricated evidence", () => {
  assert.deepEqual(decodeStatus({ state: "ready", mode: "live" }), { state: "ready", mode: "live" });
});

test("production projection stays unavailable", () => {
  assert.deepEqual(unavailableStatusProjection(), {
    availability: "unavailable",
    status: null,
    message: "Connect your DinkusKit account to check payment setup. Account connection is not available in this build.",
  });
});

test("setup projection asks for a test order until Commerce confirms one", () => {
  const verifiedTest = projectSetupScreen({
    availability: "available",
    status: {
      state: "ready",
      mode: "test",
      connectionEvidence: {
        provider: "stripe",
        mode: "test",
        result: "verified",
        accountRef: "acct_one",
      },
    },
  });
  assert.equal(verifiedTest.overall, "Connected: Stripe test mode");
  assert.equal(verifiedTest.steps[0].status, "test_mode");
  assert.equal(verifiedTest.steps[0].description, "Test card payments work at checkout. Real customer payments need a live Stripe connection, which isn't set up yet.");
  assert.equal(verifiedTest.steps[1].status, "incomplete");
  assert.equal(
    verifiedTest.steps[1].description,
    "Place an order on your store and pay with a Stripe test card. This step completes when Stripe confirms the payment and Commerce saves the order.",
  );

  const verifiedLive = projectSetupScreen({
    availability: "available",
    status: {
      state: "ready",
      mode: "live",
      connectionEvidence: {
        provider: "stripe",
        mode: "live",
        result: "verified",
        accountRef: "acct_one",
      },
    },
  });
  assert.equal(verifiedLive.steps[0].status, "complete");
  assert.equal(verifiedLive.steps[1].status, "incomplete");
  assert.equal(verifiedLive.steps[1].description, "A paid TEST order visible in Commerce admin has not been confirmed.");
  assert.equal(verifiedLive.overall, "Not ready to sell");
});

test("setup projection gives truthful provider next actions and fails closed", () => {
  for (const result of ["action_required", "unknown"]) {
    const screen = projectSetupScreen({
      availability: "available",
      status: {
        state: result === "action_required" ? "action_required" : "checking",
        mode: "test",
        connectionEvidence: {
          provider: "stripe",
          mode: "test",
          result,
          accountRef: "acct_one",
        },
      },
    });
    assert.equal(screen.steps[0].status, "incomplete");
    assert.match(screen.steps[0].description, /Stripe/);
    assert.doesNotMatch(screen.steps[0].description, /verified for TEST/);
  }

  const authorizeNet = projectSetupScreen({
    availability: "available",
    status: {
      state: "ready",
      mode: "test",
      connectionEvidence: {
        provider: "authorize_net",
        mode: "test",
        result: "unsupported",
      },
    },
  });
  assert.equal(authorizeNet.steps[0].status, "incomplete");
  assert.match(authorizeNet.steps[0].description, /not supported/);

  const malformed = projectSetupScreen({
    availability: "available",
    status: { state: "ready", mode: "test", provider: "stripe" },
  });
  assert.equal(malformed.steps[0].status, "incomplete");
  assert.match(malformed.steps[0].description, /unavailable/);
});

test("setup renderer has one screen with a usable connect action and no provider selector", () => {
  const serialized = JSON.stringify(renderSetupScreen(unavailableStatusProjection()));
  assert.match(serialized, /Payment setup/);
  assert.match(serialized, /Connect payments/);
  assert.match(serialized, /Place a test order/);
  assert.match(serialized, /Not ready to sell/);
  assert.match(serialized, /"action_id":"connect"/);
  assert.doesNotMatch(serialized, /provider selector|Authorize\.net.*Stripe/);
});

test("admin route is read-only and browser input cannot change output", async () => {
  const response = await plugin.routes.admin.handler(
    {
      input: {
        type: "page_load",
        page: "/status",
        status: {
          availability: "available",
          status: {
            state: "ready",
            mode: "live",
            connectionEvidence: {
              provider: "stripe",
              mode: "live",
              result: "verified",
              accountRef: "acct_browser",
            },
          },
          paid: true,
          ready: true,
          testOrder: { provider: "stripe", total: { currency: "USD", minor: "1200" }, paidAt: 1791728400000, state: "recorded" },
        },
      },
      user: { id: "admin" },
    },
    {
      site: { url: "https://shop.example" },
      kv: { async get() { return null; }, async getVersioned() { return null; }, async compareAndSet() { return { applied: false }; }, async compareAndDelete() { return { applied: false }; } },
      settings: { async get() { return null; }, async getVersioned() { return null; }, async compareAndSet() { return { applied: false }; }, async compareAndDelete() { return { applied: false }; } },
    },
  );
  const serialized = JSON.stringify(response);
  assert.match(serialized, /Payment setup/);
  assert.match(serialized, /Not ready to sell/);
  assert.match(serialized, /paid TEST order visible in Commerce admin has not been confirmed/);
  assert.doesNotMatch(serialized, /acct_browser|"paid":true|"ready":true|Commerce saved it|Place a test order: Complete/);
});

const paidAt = Date.UTC(2026, 9, 11, 14, 31, 5);
const stripeEvidence = { provider: "stripe", mode: "test", result: "verified", accountRef: "acct_one" };
const recorded = { provider: "stripe", total: { currency: "USD", minor: "1200" }, paidAt, state: "recorded" };
function withTestOrder(testOrder, overrides = {}) {
  return { state: "ready", mode: "test", bindingRef: "binding-1", connectionEvidence: stripeEvidence, testOrder, ...overrides };
}

test("decodes TEST-order evidence only for the connected TEST binding and its provider", () => {
  for (const state of ["awaiting_notice", "awaiting_commerce", "recorded"]) {
    const value = withTestOrder({ ...recorded, state });
    assert.deepEqual(decodeStatus(value), value);
  }
  const authorizeNet = withTestOrder({ ...recorded, provider: "authorize_net" }, {
    connectionEvidence: { provider: "authorize_net", mode: "test", result: "unsupported" },
  });
  assert.deepEqual(decodeStatus(authorizeNet), authorizeNet);
  // The order stays shown while the connection itself is being rechecked.
  const checking = { state: "checking", mode: "test", bindingRef: "binding-1", testOrder: recorded };
  assert.deepEqual(decodeStatus(checking), checking);

  for (const testOrder of [
    { ...recorded, orderNumber: "1001" },
    { provider: "stripe", total: recorded.total, paidAt },
    { ...recorded, provider: "paypal" },
    { ...recorded, total: { currency: "EUR", minor: "1200" } },
    { ...recorded, total: { currency: "USD", minor: "0" } },
    { ...recorded, total: { currency: "USD", minor: "012" } },
    { ...recorded, total: { currency: "USD", minor: 1200 } },
    { ...recorded, total: { currency: "USD", minor: "9007199254740993" } },
    { ...recorded, total: { currency: "USD", minor: "1200", tax: "0" } },
    { ...recorded, paidAt: 0 },
    { ...recorded, paidAt: 1.5 },
    { ...recorded, paidAt: 8_640_000_000_000_001 },
    { ...recorded, paidAt: "2026-10-11" },
    { ...recorded, state: "paid" },
    [],
    null,
  ]) {
    assert.throws(() => decodeStatus(withTestOrder(testOrder)), /invalid_status/);
  }
  assert.throws(() => decodeStatus(withTestOrder(recorded, {
    mode: "live", connectionEvidence: { ...stripeEvidence, mode: "live" },
  })), /invalid_status/);
  assert.throws(() => decodeStatus(withTestOrder(recorded, { bindingRef: undefined })), /invalid_status/);
  assert.throws(() => decodeStatus(withTestOrder({ ...recorded, provider: "authorize_net" })), /invalid_status/);
});

test("TEST-order step completes only once Commerce saved the provider-paid order", () => {
  const screen = state => projectSetupScreen({ availability: "available", status: withTestOrder({ ...recorded, state }) });
  const saved = screen("recorded");
  assert.equal(saved.steps[1].status, "complete");
  assert.equal(
    saved.steps[1].description,
    "Stripe confirmed a paid TEST order of $12.00 on Oct 11, 2026 at 2:31 PM UTC, and Commerce saved it. You'll find it in Orders, marked TEST.",
  );
  assert.equal(saved.steps[0].status, "test_mode");
  assert.equal(saved.overall, "Connected: Stripe test mode");

  const saving = screen("awaiting_commerce");
  assert.equal(saving.steps[1].status, "incomplete");
  assert.equal(
    saving.steps[1].description,
    "Stripe confirmed a paid TEST order of $12.00 on Oct 11, 2026 at 2:31 PM UTC. Waiting for Commerce to save it; Commerce checks for payment notices every 5 minutes.",
  );
  const notice = screen("awaiting_notice");
  assert.equal(notice.steps[1].status, "incomplete");
  assert.equal(
    notice.steps[1].description,
    "Stripe confirmed a paid TEST order of $12.00 on Oct 11, 2026 at 2:31 PM UTC. Waiting for Stripe's payment notice to reach Payments.",
  );

  const authorizeNet = projectSetupScreen({ availability: "available", status: withTestOrder({
    provider: "authorize_net", total: { currency: "USD", minor: "123456" }, paidAt: Date.UTC(2026, 0, 2, 0, 5), state: "awaiting_commerce",
  }, { connectionEvidence: { provider: "authorize_net", mode: "test", result: "unsupported" } }) });
  assert.equal(
    authorizeNet.steps[1].description,
    "Authorize.net confirmed a paid TEST order of $1,234.56 on Jan 2, 2026 at 12:05 AM UTC. Waiting for Commerce to save it; Commerce checks for payment notices every 5 minutes.",
  );
  const noon = projectSetupScreen({ availability: "available", status: withTestOrder({
    ...recorded, total: { currency: "USD", minor: "5" }, paidAt: Date.UTC(2026, 11, 31, 12, 0),
  }) });
  assert.match(noon.steps[1].description, /of \$0\.05 on Dec 31, 2026 at 12:00 PM UTC, and Commerce saved it/);

  const rendered = JSON.stringify(renderSetupScreen({
    state: "ready",
    status: { availability: "available", status: withTestOrder(recorded), message: "Payments status checked." },
  }));
  assert.match(rendered, /Place a test order: Complete\. Stripe confirmed a paid TEST order of \$12\.00/);
  assert.match(rendered, /Connect payments: Connected: Stripe test mode\. Test card payments work at checkout/);
  assert.match(rendered, /"title":"Connected: Stripe test mode","description":"Shoppers can pay with Stripe test cards\. Real customer payments need a live Stripe connection\.","variant":"default"/);
  assert.doesNotMatch(rendered, /Not ready to sell|Set up or resume Stripe/);
});

test("a store that hasn't connected Payments on this page asks for Sign in again, not a broken connection", () => {
  const screen = projectSetupScreen({ state: "action_required" });
  assert.equal(screen.overall, "Payment status not checked");
  assert.deepEqual(screen.steps.map(step => step.status), ["unchecked", "unchecked"]);
  assert.match(screen.steps[0].description, /This page needs a fresh DinkusKit sign-in for this store\. Select Sign in again to connect Payments/);
  const rendered = JSON.stringify(renderSetupScreen({ state: "action_required" }));
  assert.match(rendered, /Connect payments: Not checked\./);
  assert.match(rendered, /Place a test order: Not checked\./);
  assert.match(rendered, /"label":"Sign in again","action_id":"connect"/);
  assert.doesNotMatch(rendered, /Not ready to sell|needs attention|Set up or resume Stripe|"variant":"alert"/);
  assert.match(JSON.stringify(renderSetupScreen({ state: "disconnected" })), /"title":"Not ready to sell".*"label":"Connect","action_id":"connect"/);
});

test("store key problems are named, and only Payments being off asks for Sign in again", () => {
  const missing = JSON.stringify(renderSetupScreen({ state: "store_key_required" }));
  assert.match(missing, /"title":"Payment status not checked"/);
  assert.match(missing, /Paste the store key from the Set up Commerce box on DinkusKit\.com into this plugin's settings \(Store key\)/);
  assert.match(missing, /"label":"Check connection","action_id":"check"/);
  assert.doesNotMatch(missing, /Sign in again|Reconnect|"variant":"alert"/);
  const wording = {
    invalid_store_key: /DinkusKit\.com does not know this store key/,
    site_mismatch: /This store key belongs to another store/,
    service_cut_off: /cut Payments off for this store/,
    store_suspended: /This store is suspended at DinkusKit\.com/,
    rate_limited: /busy with this store's passes/,
    payments_refused: /DinkusKit Payments didn't accept this store's pass/,
  };
  for (const [refusal, text] of Object.entries(wording)) {
    const page = JSON.stringify(renderSetupScreen({ state: "pass_refused", refusal }));
    assert.match(page, text);
    assert.match(page, /"label":"Check connection","action_id":"check"/);
    assert.doesNotMatch(page, /Sign in again|Reconnect/);
  }
  const off = JSON.stringify(renderSetupScreen({ state: "pass_refused", refusal: "service_not_enabled" }));
  assert.match(off, /Payments isn't connected for this store at DinkusKit\.com\. Select Sign in again to connect it\./);
  assert.match(off, /"label":"Sign in again","action_id":"connect"/);
});

test("a Stripe change pressed after the page's sign-in lapsed keeps the status and asks for Sign in again", () => {
  const status = { state: "action_required", mode: "test", bindingRef: "b", connectionEvidence: { provider: "stripe", mode: "test", result: "action_required", accountRef: "acct_one" } };
  const page = JSON.stringify(renderSetupScreen({ state: "ready", signIn: true, status: { availability: "available", status } }));
  assert.match(page, /Changing your Stripe setup needs a fresh DinkusKit sign-in on this page\. Select Sign in again/);
  assert.match(page, /"label":"Sign in again","action_id":"connect"/);
  assert.doesNotMatch(page, /Reconnect/);
  const plain = JSON.stringify(renderSetupScreen({ state: "ready", status: { availability: "available", status } }));
  assert.match(plain, /"label":"Reconnect","action_id":"connect"/);
  assert.doesNotMatch(plain, /fresh DinkusKit sign-in|Sign in again/);
});

test("TEST-order step says what comes first when there is no paid TEST order", () => {
  const step = input => projectSetupScreen(input).steps[1];
  const authorizeNet = step({ availability: "available", status: {
    state: "ready", mode: "test", bindingRef: "binding-1",
    connectionEvidence: { provider: "authorize_net", mode: "test", result: "unsupported" },
  } });
  assert.deepEqual(authorizeNet, {
    title: "Place a test order",
    status: "incomplete",
    description: "Place an order on your store and pay with an Authorize.net test card. This step completes when Authorize.net confirms the payment and Commerce saves the order.",
  });
  const needsAttention = step({ availability: "available", status: {
    state: "action_required", mode: "test", bindingRef: "binding-1",
    connectionEvidence: { provider: "stripe", mode: "test", result: "action_required", accountRef: "acct_one" },
  } });
  assert.equal(needsAttention.description, "A paid TEST order visible in Commerce admin has not been confirmed. Connect payments first, then place a test order.");
  const unreachable = "A paid TEST order visible in Commerce admin has not been confirmed. It could not be checked right now. Try again shortly.";
  assert.equal(step({ availability: "available", status: {
    state: "checking", mode: "test", bindingRef: "binding-1",
    connectionEvidence: { provider: "stripe", mode: "test", result: "unknown", accountRef: "acct_one" },
  } }).description, unreachable);
  assert.equal(step({ state: "checking" }).description, unreachable);
  for (const input of [unavailableStatusProjection(), { state: "unconfigured" }, { state: "failed", message: "connection_unavailable" }]) {
    assert.equal(step(input).status, "incomplete");
    assert.equal(step(input).description, "A paid TEST order visible in Commerce admin has not been confirmed. Connect payments first, then place a test order.");
  }
});


test("setup support reference preserves exact closed failure fields only",()=>{
 const at=Date.now()-1234;
 const status={state:"connecting",mode:"test",bindingRef:"stripe_support_fixture"};
 const diagnostics={state:"connecting",mode:"test",processorAccountPresent:false,evidence:"observed",lastFailure:{category:"unknown",status:400,at}};
 const render=(d=diagnostics,s=status,state="ready")=>renderSetupScreen({state,status:{availability:"available",status:s},diagnostics:d});
 const ref=render().blocks.find(b=>b.text?.startsWith("Setup support reference: "));
 assert.deepEqual(JSON.parse(ref.text.slice("Setup support reference: ".length)),{bindingRef:status.bindingRef,failureAt:at,category:"unknown",httpStatus:400});
 for(const [d,s,state] of [[{...diagnostics,raw:"PRIVATE_CANARY"},status,"ready"],[{...diagnostics,mode:"live"},status,"ready"],[{...diagnostics,evidence:"unobserved",lastFailure:undefined},status,"ready"],[diagnostics,{...status,state:"disconnected"},"ready"],[diagnostics,status,"action_required"]]) {
  const out=JSON.stringify(render(d,s,state));assert.doesNotMatch(out,/Setup support reference|PRIVATE_CANARY/);
 }
});

test("pending screen tells the owner the page checks on its own, and says so plainly when approval is missing", () => {
  const fresh = JSON.stringify(renderSetupScreen({ state: "pending", verificationUri: "https://dinkuskit.com/account/connect?connection_id=c1", interval: 5, expiresAt: 1 }));
  assert.match(fresh, /this page checks your approval on its own/);
  assert.match(fresh, /Authorize Payments at DinkusKit/);
  const checked = JSON.stringify(renderSetupScreen({ state: "pending", checked: true, verificationUri: "https://dinkuskit.com/account/connect?connection_id=c1", interval: 5, expiresAt: 1 }));
  assert.match(checked, /DinkusKit hasn't recorded your approval yet/);
  assert.doesNotMatch(checked, /checks your approval on its own/);
});

test("a refused Stripe setup names its reason and that nothing was created", () => {
  const page = JSON.stringify(renderSetupScreen({ state: "setup_refused", refusal: "merchant_country_required" }));
  assert.match(page, /no business country on file for this store\. No Stripe account was created/);
  assert.doesNotMatch(page, /final result is not confirmed/);
  assert.match(page, /"action_id":"check"/);
  const unknown = JSON.stringify(renderSetupScreen({ state: "setup_refused", refusal: "anything-else" }));
  assert.match(unknown, /Payments refused Stripe setup\. No Stripe account was created/);
  assert.doesNotMatch(unknown, /anything-else/);
});

test("with no store key pasted, the page shows the last checked connection with its time", () => {
  const status = { state: "ready", mode: "test", bindingRef: "b", connectionEvidence: { provider: "stripe", mode: "test", result: "verified", accountRef: "acct_one" } };
  const page = renderSetupScreen({ state: "store_key_required", lastChecked: { at: Date.UTC(2026, 9, 18, 17, 10), status } });
  const banner = page.blocks.find(block => block.type === "banner");
  assert.equal(banner.title, "Connected: Stripe test mode");
  assert.match(banner.description, /^Last checked Oct 18, 2026 at 5:10 PM UTC\. Paste the store key in this plugin's settings so this page can check it now\./);
  const text = JSON.stringify(page);
  assert.match(text, /"label":"Check connection","action_id":"check"/);
  assert.doesNotMatch(text, /setup_processor|Sign in again|Reconnect/);
  for (const lastChecked of [undefined, { at: 1, status: { state: "bogus" } }, { at: "soon", status }]) {
    assert.equal(renderSetupScreen({ state: "store_key_required", lastChecked }).blocks[1].title, "Payment status not checked");
  }
});

test("Stripe needing more information points the owner at Stripe's setup and offers the resume button", () => {
  const status = { state: "action_required", mode: "test", bindingRef: "b", connectionEvidence: { provider: "stripe", mode: "test", result: "action_required", accountRef: "acct_one" } };
  const page = JSON.stringify(renderSetupScreen({ state: "ready", status: { availability: "available", status } }));
  assert.match(page, /Select Set up or resume Stripe to open Stripe's setup, which lists what's missing/);
  assert.match(page, /"label":"Set up or resume Stripe","action_id":"setup_processor"/);
});
