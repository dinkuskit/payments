import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

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
