export const STRIPE_PROOF_AMOUNT_MINOR = "100";
export const STRIPE_PROOF_CURRENCY = "usd";

export function createProofRequest(attemptId, bindingRef) {
  return {
    attemptId,
    bindingRef,
    lines: [{
      catalogItemId: "proof-item",
      quantity: 1,
      name: "Stripe test proof",
      unitPrice: { currency: "USD", minor: STRIPE_PROOF_AMOUNT_MINOR },
    }],
    total: { currency: "USD", minor: STRIPE_PROOF_AMOUNT_MINOR },
    paymentWindow: { minSeconds: 1800, maxSeconds: 1860 },
    paymentMethods: ["card"],
  };
}

export function lookupProofRequest(session) {
  if (session.livemode || session.currency !== STRIPE_PROOF_CURRENCY ||
      session.amountTotal !== Number(STRIPE_PROOF_AMOUNT_MINOR)) {
    throw new Error("proof_amount_mismatch");
  }
  const { dinkus_attempt: attemptId, dinkus_binding: bindingRef, dinkus_site: siteId } = session.metadata ?? {};
  if (!/^stripe-proof-[0-9]+$/.test(attemptId ?? "") || !bindingRef || !siteId) {
    throw new Error("proof_metadata_mismatch");
  }
  return {
    attemptId,
    bindingRef,
    siteId,
    request: createProofRequest(attemptId, bindingRef),
  };
}
