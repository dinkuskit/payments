import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { lookupProofRequest } from "../scripts/stripe-test-mode-proof-logic.mjs";

const script = "scripts/stripe-test-mode-proof.mjs";

function runProof(env, ...args) {
  return execFileSync(process.execPath, ["--import", "tsx", script, ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

test("Stripe proof is a non-contact dry-run by default", () => {
  assert.equal(runProof({ STRIPE_API_KEY: "" }), "stripe test mode dry-run: PASS\n");
});

test("explicit provider-contact modes fail without a Stripe key", () => {
  for (const args of [["--run"], ["--lookup", "cs_test_abc"]]) {
    assert.throws(
      () => runProof({ STRIPE_API_KEY: "" }, ...args),
      error => {
        assert.equal(error.status, 1);
        assert.equal(error.stdout, "stripe test key: FAIL (blocked: Stripe test key not present)\n");
        return true;
      },
    );
  }
});

test("Stripe proof rejects lookup mode without a session id", () => {
  assert.throws(
    () => runProof({ STRIPE_API_KEY: "" }, "--lookup"),
    error => {
      assert.equal(error.status, 1);
      assert.equal(error.stdout, "lookup session id: FAIL (a cs_test_ id is required)\n");
      return true;
    },
  );
});

test("Stripe proof refuses a live key before any provider contact", () => {
  assert.throws(
    () => runProof({ STRIPE_API_KEY: "sk_live_never_printed" }, "--run"),
    error => {
      assert.equal(error.status, 1);
      assert.equal(error.stdout, "stripe test key: FAIL\n");
      assert.doesNotMatch(error.stdout, /sk_live/);
      return true;
    },
  );
});

test("Stripe proof requires a connected test account without contacting Stripe", () => {
  assert.throws(
    () => runProof({ STRIPE_API_KEY: "sk_test_synthetic", STRIPE_TEST_ACCOUNT_ID: "" }, "--run"),
    error => {
      assert.equal(error.status, 1);
      assert.equal(error.stdout, "stripe test connected account: FAIL (STRIPE_TEST_ACCOUNT_ID is required)\n");
      assert.doesNotMatch(error.stdout, /sk_test/);
      return true;
    },
  );
});

test("lookup proof rejects a provider amount drift before any network call", () => {
  assert.throws(() => lookupProofRequest({
    livemode: false,
    currency: "usd",
    amountTotal: 200,
    metadata: {
      dinkus_attempt: "stripe-proof-123",
      dinkus_binding: "stripe_test_proof",
      dinkus_site: "stripe-test-proof",
    },
  }), /proof_amount_mismatch/);
});
