import { decodeDiagnostics, type ConnectionDiagnostics } from "../connection-diagnostics.js";
import { decodeLegacyRecoveryReceipt } from "../hosted/legacy-recovery.js";
import { describeStatusCheckFailure } from "./check-failure.js";
import type { PassRefusal, SetupRefusal } from "./connection.js";
import {
  decodeStatus,
  type PaymentsStatus,
  type StatusProjection,
} from "./status.js";
import {
  decodeProviderIdentityDiagnostic,
  type ProviderIdentityDiagnostic,
} from "../provider-identity.js";

export type SetupStep = {
  title: string;
  // test_mode: verified for TEST payments only. unchecked: this page could not
  // read status with the store key, which says nothing about checkout.
  status: "incomplete" | "complete" | "test_mode" | "unchecked";
  description: string;
};

export type SetupOverall = "Not ready to sell" | "Connected: Stripe test mode" | "Payment status not checked";

export type SetupScreenProjection = {
  title: "Payment setup";
  overall: SetupOverall;
  steps: [SetupStep, SetupStep];
};

const STEP_LABELS: Record<SetupStep["status"], string> = {
  complete: "Complete",
  incomplete: "Not complete",
  test_mode: "Connected: Stripe test mode",
  unchecked: "Not checked",
};
const signInNeeded =
  "This page needs a fresh DinkusKit sign-in for this store. Select Sign in again to connect Payments with your DinkusKit account. Checkout doesn't use this sign-in.";
const storeKeyNeeded =
  "Paste the store key from the Set up Commerce box on DinkusKit.com into this plugin's settings (Store key), the same key Commerce uses. This page trades it for a short pass each time it checks your payment status. Then select Check connection.";
const PASS_REFUSAL_TEXT: Record<PassRefusal, string> = {
  invalid_store_key: "DinkusKit.com does not know this store key. Paste the current one from the Set up Commerce box into this plugin's settings, or make a new key there.",
  site_mismatch: "This store key belongs to another store. Paste the key from this store's Set up Commerce box into this plugin's settings.",
  service_not_enabled: "Payments isn't connected for this store at DinkusKit.com. Select Sign in again to connect it.",
  service_cut_off: "DinkusKit.com has cut Payments off for this store. Contact DinkusKit.",
  store_suspended: "This store is suspended at DinkusKit.com. Contact DinkusKit.",
  rate_limited: "DinkusKit.com is busy with this store's passes. Try again in a minute.",
  payments_refused: "DinkusKit Payments didn't accept this store's pass. Select Check connection to try again, and contact DinkusKit if it keeps happening.",
};
function describePassRefusal(refusal: unknown): string {
  return typeof refusal === "string" && Object.hasOwn(PASS_REFUSAL_TEXT, refusal)
    ? PASS_REFUSAL_TEXT[refusal as PassRefusal] : PASS_REFUSAL_TEXT.payments_refused;
}

const unavailableConnection =
  "Your payment connection is unavailable, so it could not be checked.";
const unconfirmedCommerceOrder =
  "A paid TEST order visible in Commerce admin has not been confirmed.";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function providerName(provider: "stripe" | "authorize_net"): string {
  return provider === "authorize_net" ? "Authorize.net" : "Stripe";
}

function dollars(minor: string): string {
  const cents = BigInt(minor);
  const whole = (cents / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `$${whole}.${String(cents % 100n).padStart(2, "0")}`;
}

// Written out by hand so every runtime prints the same words.
function utcTime(ms: number): string {
  const at = new Date(ms);
  const hour = at.getUTCHours();
  const minute = String(at.getUTCMinutes()).padStart(2, "0");
  return `${MONTHS[at.getUTCMonth()]} ${at.getUTCDate()}, ${at.getUTCFullYear()} at ${hour % 12 || 12}:${minute} ${hour < 12 ? "AM" : "PM"} UTC`;
}

function testOrderStep(status: PaymentsStatus | null, connectionState?: string): SetupStep {
  const title = "Place a test order";
  if (connectionState === "action_required" || connectionState === "store_key_required" || connectionState === "pass_refused") {
    return { title, status: "unchecked", description: "Your test orders can't be checked until this page can read your payment status." };
  }
  if (connectionState === "authorized") {
    return { title, status: "incomplete", description: `${unconfirmedCommerceOrder} Check the payment connection before placing a test order.` };
  }
  const order = status?.testOrder;
  if (order) {
    const provider = providerName(order.provider);
    const paid = `${provider} confirmed a paid TEST order of ${dollars(order.total.minor)} on ${utcTime(order.paidAt)}`;
    if (order.state === "recorded") {
      return { title, status: "complete", description: `${paid}, and Commerce saved it. You'll find it in Orders, marked TEST.` };
    }
    if (order.state === "awaiting_commerce") {
      return { title, status: "incomplete", description: `${paid}. Waiting for Commerce to save it; Commerce checks for payment notices every 5 minutes.` };
    }
    return { title, status: "incomplete", description: `${paid}. Waiting for ${provider}'s payment notice to reach Payments.` };
  }
  if (status?.state === "ready") {
    if (status.mode !== "test" || !status.connectionEvidence) return { title, status: "incomplete", description: unconfirmedCommerceOrder };
    const provider = providerName(status.connectionEvidence.provider);
    const card = `${provider === "Authorize.net" ? "an" : "a"} ${provider} test card`;
    return {
      title,
      status: "incomplete",
      description: `Place an order on your store and pay with ${card}. This step completes when ${provider} confirms the payment and Commerce saves the order.`,
    };
  }
  if (status?.state === "checking" || (!status && (connectionState === "checking" || connectionState === "check_failed" || connectionState === "setup_unconfirmed"))) {
    return { title, status: "incomplete", description: `${unconfirmedCommerceOrder} It could not be checked right now. Try again shortly.` };
  }
  return { title, status: "incomplete", description: `${unconfirmedCommerceOrder} Connect payments first, then place a test order.` };
}

const SETUP_REFUSAL_TEXT: Record<SetupRefusal, string> = {
  merchant_country_required: "Payments couldn't start Stripe setup because DinkusKit Payments has no business country on file for this store. No Stripe account was created. Ask DinkusKit support to add the store's country, then select Check connection and Set up or resume Stripe.",
  payments_service_unconfigured: "Payments couldn't start Stripe setup because the DinkusKit Payments service isn't set up to create payment accounts right now. No Stripe account was created. Contact DinkusKit support.",
};

function describeSetupRefusal(refusal: unknown): string {
  return typeof refusal === "string" && Object.hasOwn(SETUP_REFUSAL_TEXT, refusal)
    ? SETUP_REFUSAL_TEXT[refusal as SetupRefusal]
    : "Payments refused Stripe setup. No Stripe account was created. Select Check connection to try again.";
}

function connectionStep(status: PaymentsStatus | null, connectionState?: string, diagnostics?: ConnectionDiagnostics, checkFailure?: unknown, pendingChecked = false, refusal?: unknown): SetupStep {
  if (connectionState?.startsWith("legacy_recovery_")) {
    return { title: "Connect payments", status: "incomplete", description: "Recovery preparation and Stripe setup are separate actions. Check the preparation result below before continuing." };
  }
  if (connectionState === "provider_identity") {
    return { title: "Connect payments", status: "incomplete", description: "The identity diagnostic does not refresh payment readiness. Use Check connection to check setup status." };
  }
  if (connectionState === "setup_unconfirmed") {
    return { title: "Connect payments", status: "incomplete", description: describeStatusCheckFailure(checkFailure, true) };
  }
  if (connectionState === "authorized") {
    return { title: "Connect payments", status: "incomplete", description: "Your DinkusKit authorization was saved. Use Check connection to read the payment account status. No processor setup was attempted." };
  }
  if (connectionState === "check_failed") {
    return { title: "Connect payments", status: "incomplete", description: describeStatusCheckFailure(checkFailure) };
  }
  if (status?.state === "connecting" || status?.state === "recovery_required") {
    const messages = {
      authentication: "The payment service could not authenticate with Stripe. Contact support; reconnecting your DinkusKit account will not fix this.",
      permission: "Stripe refused the payment service's permission to create the account. Contact support.",
      platform_required: "Stripe requires payment platform setup before this account can be created. Contact support.",
      rate_limited: "Stripe limited the account setup request. No automatic retry was made.",
      provider_unavailable: "Stripe was unavailable during account setup. The result is not confirmed; no automatic retry was made.",
      transport_unknown: "The account setup response could not be confirmed. No automatic retry was made.",
      unknown: "Account setup failed, but no safe detailed cause is available. Contact support.",
    };
    const description = diagnostics?.lastFailure ? messages[diagnostics.lastFailure.category] : "The payment account has not been confirmed. No recorded failure detail is available for this attempt.";
    return { title: "Connect payments", status: "incomplete", description: `${description} ${status.state === "recovery_required" ? "The safe setup retry window has ended. Contact support to recover this connection; do not start another account." : "Your DinkusKit authorization is connected. Check status before deciding whether to explicitly resume setup."}` };
  }
  if (connectionState === "unconfigured") {
    return {
      title: "Connect payments",
      status: "incomplete",
      description: "Connect your DinkusKit account to check payment setup. No Payments service endpoint is configured.",
    };
  }
  if (connectionState === "pending") {
    return {
      title: "Connect payments",
      status: "incomplete",
      description: pendingChecked
        ? "DinkusKit hasn't recorded your approval yet. Select Authorize Payments at DinkusKit, select Approve there, and DinkusKit brings you back here."
        : "Select Authorize Payments at DinkusKit and select Approve there. DinkusKit brings you back here, and this page checks your approval on its own.",
    };
  }
  if (connectionState === "connecting") {
    return { title: "Connect payments", status: "incomplete", description: "Your DinkusKit sign-in is still finishing. Select Continue to check it again." };
  }
  if (connectionState === "setup_refused") {
    return { title: "Connect payments", status: "incomplete", description: describeSetupRefusal(refusal) };
  }
  if (connectionState === "action_required") {
    return { title: "Connect payments", status: "unchecked", description: signInNeeded };
  }
  if (connectionState === "store_key_required") {
    return { title: "Connect payments", status: "unchecked", description: storeKeyNeeded };
  }
  if (connectionState === "pass_refused") {
    return { title: "Connect payments", status: "unchecked", description: describePassRefusal(refusal) };
  }
  if (connectionState === "checking") {
    return {
      title: "Connect payments",
      status: "incomplete",
      description: "Checking Payments setup. Processor account connection is not implied by a DinkusKit grant.",
    };
  }
  if (status?.state === "disconnected") {
    return { title: "Connect payments", status: "incomplete", description: "DinkusKit Payments status was checked. No processor account is connected. Select Set up Stripe to connect your processor account." };
  }
  if (!status?.connectionEvidence) {
    return {
      title: "Connect payments",
      status: "incomplete",
      description:
        `${unavailableConnection} Connect your DinkusKit account to continue.`,
    };
  }

  const evidence = status.connectionEvidence;
  if (evidence.provider === "authorize_net") {
    return {
      title: "Connect payments",
      status: "incomplete",
      description:
        "Authorize.net connection checks are not supported in this build, so its connection cannot be verified here.",
    };
  }

  if (evidence.result === "verified" && evidence.mode === "test") {
    return {
      title: "Connect payments",
      status: "test_mode",
      description:
        "Test card payments work at checkout. Real customer payments need a live Stripe connection, which isn't set up yet.",
    };
  }

  if (evidence.result === "verified" && evidence.mode === "live") {
    return {
      title: "Connect payments",
      status: "complete",
      description:
        "Stripe live connection is verified. A provider-paid TEST order still needs to be confirmed.",
    };
  }

  if (evidence.result === "action_required") {
    return {
      title: "Connect payments",
      status: "incomplete",
      description:
        "Stripe needs more information before it can take payments. Select Set up or resume Stripe to open Stripe's setup, which lists what's missing. For a TEST account, use Stripe's test values. Then select Check connection.",
    };
  }

  return {
    title: "Connect payments",
    status: "incomplete",
    description:
      "Stripe connection status could not be confirmed. Check the payment account connection and try again.",
  };
}

export function projectSetupScreen(input: unknown, diagnostics?: ConnectionDiagnostics): SetupScreenProjection {
  let status: PaymentsStatus | null = null;
  let connectionState: string | undefined;
  let checkFailure: unknown;
  let pendingChecked = false;
  let refusal: unknown;
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    const projection = input as Partial<StatusProjection>;
    if (typeof (input as { state?: unknown }).state === "string") {
      connectionState = (input as { state: string }).state;
      checkFailure = (input as { checkFailure?: unknown }).checkFailure;
      pendingChecked = (input as { checked?: unknown }).checked === true;
      refusal = (input as { refusal?: unknown }).refusal;
    }
    if (projection.availability === "available") {
      try {
        status = decodeStatus(projection.status);
      } catch {
        status = null;
      }
    }
  }

  const steps: [SetupStep, SetupStep] = [
    connectionStep(status, connectionState, diagnostics, checkFailure, pendingChecked, refusal),
    testOrderStep(status, connectionState),
  ];
  // Ready to sell needs a verified live connection and a saved TEST order, which
  // no status can show yet, so a verified TEST connection is the best result.
  const overall: SetupOverall = steps[0].status === "test_mode" ? "Connected: Stripe test mode"
    : steps[0].status === "unchecked" ? "Payment status not checked" : "Not ready to sell";
  return { title: "Payment setup", overall, steps };
}

const BANNERS: Record<SetupOverall, { description: string; variant: "default" | "alert" }> = {
  "Not ready to sell": { description: "Complete both steps before accepting regular customer payments.", variant: "alert" },
  "Connected: Stripe test mode": { description: "Shoppers can pay with Stripe test cards. Real customer payments need a live Stripe connection.", variant: "default" },
  "Payment status not checked": { description: "This page couldn't read your payment status. The first step says why. Checkout isn't affected.", variant: "default" },
};

export function describeProviderIdentity(diagnostic: ProviderIdentityDiagnostic): string {
  const parts: string[] = [];
  if (diagnostic.result === "match") {
    parts.push("Stripe test platform identity matches configured account.");
  } else if (diagnostic.result === "mismatch") {
    parts.push("Stripe test platform identity does not match configured account.");
  } else if (diagnostic.result === "unconfirmed") {
    parts.push("Stripe test platform identity could not be confirmed.");
  } else {
    parts.push("Stripe test platform identity check is unavailable.");
  }
  if (diagnostic.validTestPrefix) {
    parts.push("Test key prefix verified.");
  }
  if (diagnostic.httpStatus !== undefined) {
    parts.push(`HTTP ${diagnostic.httpStatus}.`);
  }
  if (diagnostic.result !== "unavailable" && diagnostic.at) {
    parts.push(`Checked at ${utcTime(diagnostic.at)}.`);
  }
  const failure = diagnostic.diagnostics?.lastFailure;
  if (failure) parts.push(`Recorded setup failure: ${failure.category}${failure.status === undefined ? "" : ` (HTTP ${failure.status})`}, ${utcTime(failure.at)}. This is the prior attempt, not the identity check.`);
  return parts.join(" ");
}

function setupSupportReference(status: unknown, diagnostics: unknown): string | undefined {
  try {
    const current = decodeStatus(status);
    const detail = decodeDiagnostics(diagnostics);
    if (current.mode !== "test" || !current.bindingRef ||
        !["connecting", "recovery_required"].includes(current.state) ||
        detail.state !== current.state || detail.mode !== current.mode || !detail.lastFailure) return;
    return JSON.stringify({
      bindingRef: current.bindingRef,
      failureAt: detail.lastFailure.at,
      category: detail.lastFailure.category,
      ...(detail.lastFailure.status === undefined ? {} : { httpStatus: detail.lastFailure.status }),
    });
  } catch { return; }
}

// Until the store key is pasted, show the last status this admin read,
// labelled with when it was read, instead of an unknown connection.
function lastCheckedProjection(input: unknown): { projection: SetupScreenProjection; at: number } | undefined {
  if (!input || typeof input !== "object" || (input as { state?: unknown }).state !== "store_key_required") return;
  const last = (input as { lastChecked?: unknown }).lastChecked;
  if (!last || typeof last !== "object") return;
  const { at, status } = last as { at?: unknown; status?: unknown };
  if (typeof at !== "number" || !Number.isSafeInteger(at) || at <= 0) return;
  try { decodeStatus(status); } catch { return; }
  return { projection: projectSetupScreen({ availability: "available", status }), at };
}

export function renderSetupScreen(input: unknown) {
  const nested = input && typeof input === "object" && "state" in input && "status" in input ? input.status : input;
  const lastChecked = lastCheckedProjection(input);
  const projection = lastChecked?.projection ?? projectSetupScreen(nested, input && typeof input === "object" && "diagnostics" in input ? input.diagnostics as ConnectionDiagnostics : undefined);
  const banner = lastChecked
    ? { ...BANNERS[projection.overall], description: `Last checked ${utcTime(lastChecked.at)}. Paste the store key in this plugin's settings so this page can check it now. Checkout isn't affected.` }
    : BANNERS[projection.overall];
  const state = typeof input === "object" && input !== null && !Array.isArray(input) &&
    typeof (input as { state?: unknown }).state === "string" ? (input as { state: string }).state : "disconnected";
  const refusal = input && typeof input === "object" ? (input as { refusal?: unknown }).refusal : undefined;
  const keyProblem = state === "store_key_required" || state === "pass_refused" && refusal !== "service_not_enabled";
  const action = state === "pending" || state === "connecting" ? "continue" : keyProblem || state === "provider_identity" || state === "authorized" || state === "checking" || state === "check_failed" || state === "setup_unconfirmed" || state === "setup_refused" || state === "ready" || state === "processor_setup" ? "check" : "connect";
  // A Stripe change was asked for after this page's DinkusKit sign-in lapsed.
  const signIn = state === "ready" && input && typeof input === "object" && (input as { signIn?: unknown }).signIn === true;
  const statusValue = nested && typeof nested === "object" && "status" in nested ? nested.status : null;
  const processorPending = statusValue && typeof statusValue === "object" && "state" in statusValue && ["connecting", "recovery_required"].includes(statusValue.state as string);
  const needsRecovery = statusValue && typeof statusValue === "object" && "state" in statusValue && statusValue.state === "recovery_required";
  const recoveryState = state.startsWith("legacy_recovery_");
  let recoveryText: string | undefined;
  if (state === "legacy_recovery_confirmation") {
    recoveryText = "Prepare the support-approved TEST connection for a new setup attempt? This preserves the rejected attempt and does not create a Stripe account. Continue only after support has approved this recovery.";
  } else if (state === "legacy_recovery_prepared") {
    try {
      const receipt = decodeLegacyRecoveryReceipt((input as { receipt?: unknown }).receipt);
      recoveryText = `Recovery preparation saved for ${receipt.bindingRef}. No Stripe account was created. Select Check connection, then start Stripe setup separately only when approved.`;
    } catch { recoveryText = "Recovery preparation could not be confirmed. Ask support to check it before starting Stripe setup."; }
  } else if (state === "legacy_recovery_unconfirmed") {
    recoveryText = "Recovery preparation could not be confirmed. Ask support to check it before starting Stripe setup.";
  }
  const evidence = statusValue && typeof statusValue === "object" && "connectionEvidence" in statusValue ? statusValue.connectionEvidence : null;
  const canSetup = !needsRecovery && (state === "ready" || state === "processor_setup") &&
    (!evidence || typeof evidence !== "object" || !("provider" in evidence) ||
      (evidence.provider === "stripe" && "result" in evidence && evidence.result !== "verified"));
  const actionLabel = action === "continue" ? "Continue" : action === "check" ? "Check connection" : state === "action_required" || state === "pass_refused" ? "Sign in again" : "Connect";
  const isConnected = state === "ready" || state === "processor_setup" || state === "provider_identity";
  const supportReference = (state === "ready" || state === "processor_setup") && input && typeof input === "object" && "diagnostics" in input
    ? setupSupportReference(statusValue, input.diagnostics) : undefined;
  const rawProviderIdentity = input && typeof input === "object" && "providerIdentity" in input
    ? (input as { providerIdentity?: unknown }).providerIdentity
    : undefined;
  let providerIdentity: ProviderIdentityDiagnostic | undefined;
  if (rawProviderIdentity) {
    try {
      providerIdentity = decodeProviderIdentityDiagnostic(rawProviderIdentity);
    } catch {
      providerIdentity = { result: "unconfirmed", validTestPrefix: false, at: Date.now() };
    }
  }

  return {
    blocks: [
      { type: "header", text: projection.title },
      { type: "banner", title: projection.overall, ...banner },
      ...projection.steps.map((step) => ({
        type: "section",
        text: `${step.title}: ${STEP_LABELS[step.status]}. ${step.description}`,
      })),
      ...(supportReference ? [{ type: "section", text: `Setup support reference: ${supportReference}` }] : []),
      ...(providerIdentity ? [{
        type: "section",
        text: `Provider identity: ${describeProviderIdentity(providerIdentity)}`,
      }] : []),
      ...(recoveryText ? [{ type: "section", text: recoveryText }] : []),
      ...(signIn ? [{ type: "section", text: "Changing your Stripe setup needs a fresh DinkusKit sign-in on this page. Select Sign in again, then try it again." }] : []),
      {
        type: "actions",
        elements: [
          ...(state === "pending" && input && typeof input === "object" && "verificationUri" in input && typeof input.verificationUri === "string"
            ? [{ type: "link", label: "Authorize Payments at DinkusKit", target: { kind: "external", url: input.verificationUri } }] : []),
          ...(state === "processor_setup" && input && typeof input === "object" && "onboardingUrl" in input && typeof input.onboardingUrl === "string"
            ? [{ type: "link", label: "Continue setup at Stripe", target: { kind: "external", url: input.onboardingUrl } }] : []),
          ...(canSetup ? [{ type: "button", label: "Set up or resume Stripe", action_id: "setup_processor" }] : []),
          ...(state === "legacy_recovery_confirmation" ? [{ type: "button", label: "Confirm recovery preparation", action_id: "prepare_legacy_v2" }] : []),
          { type: "button", label: recoveryState ? "Check connection" : actionLabel, action_id: recoveryState ? "check" : action },
          ...(action === "check" && !keyProblem && !processorPending ? [{ type: "button", label: signIn ? "Sign in again" : "Reconnect", action_id: "connect" }] : []),
          ...(isConnected ? [{ type: "button", label: "Check provider identity", action_id: "check_provider_identity" }] : []),
          ...(needsRecovery && "mode" in statusValue && statusValue.mode === "test" ? [{ type: "button", label: "Review support-approved recovery", action_id: "review_legacy_v2" }] : []),
        ],
      },
    ],
  };
}
