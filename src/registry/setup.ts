import { decodeDiagnostics, type ConnectionDiagnostics } from "../connection-diagnostics.js";
import { describeStatusCheckFailure } from "./check-failure.js";
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
  status: "incomplete" | "complete";
  description: string;
};

export type SetupScreenProjection = {
  title: "Payment setup";
  overall: "Not ready to sell";
  steps: [SetupStep, SetupStep];
};

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

function connectionStep(status: PaymentsStatus | null, connectionState?: string, diagnostics?: ConnectionDiagnostics, checkFailure?: unknown): SetupStep {
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
  if (connectionState === "pending" || connectionState === "connecting") {
    return {
      title: "Connect payments",
      status: "incomplete",
      description: "Continue sign in at your DinkusKit account to authorize Payments. Processor setup is not yet confirmed.",
    };
  }
  if (connectionState === "action_required") {
    return {
      title: "Connect payments",
      status: "incomplete",
      description: "Your DinkusKit Payments connection needs attention. Reconnect explicitly to continue.",
    };
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
      status: "incomplete",
      description:
        "Stripe is connected for TEST payments only. A live connection still needs to be verified.",
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
        "Stripe needs attention before its connection can be verified. Review the payment account connection and try again.",
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
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    const projection = input as Partial<StatusProjection>;
    if (typeof (input as { state?: unknown }).state === "string") {
      connectionState = (input as { state: string }).state;
      checkFailure = (input as { checkFailure?: unknown }).checkFailure;
    }
    if (projection.availability === "available") {
      try {
        status = decodeStatus(projection.status);
      } catch {
        status = null;
      }
    }
  }

  return {
    title: "Payment setup",
    overall: "Not ready to sell",
    steps: [
      connectionStep(status, connectionState, diagnostics, checkFailure),
      testOrderStep(status, connectionState),
    ],
  };
}

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

export function renderSetupScreen(input: unknown) {
  const nested = input && typeof input === "object" && "state" in input && "status" in input ? input.status : input;
  const projection = projectSetupScreen(nested, input && typeof input === "object" && "diagnostics" in input ? input.diagnostics as ConnectionDiagnostics : undefined);
  const state = typeof input === "object" && input !== null && !Array.isArray(input) &&
    typeof (input as { state?: unknown }).state === "string" ? (input as { state: string }).state : "disconnected";
  const action = state === "pending" || state === "connecting" ? "continue" : state === "provider_identity" || state === "authorized" || state === "checking" || state === "check_failed" || state === "setup_unconfirmed" || state === "ready" || state === "processor_setup" ? "check" : "connect";
  const statusValue = nested && typeof nested === "object" && "status" in nested ? nested.status : null;
  const processorPending = statusValue && typeof statusValue === "object" && "state" in statusValue && ["connecting", "recovery_required"].includes(statusValue.state as string);
  const needsRecovery = statusValue && typeof statusValue === "object" && "state" in statusValue && statusValue.state === "recovery_required";
  const evidence = statusValue && typeof statusValue === "object" && "connectionEvidence" in statusValue ? statusValue.connectionEvidence : null;
  const canSetup = !needsRecovery && (state === "ready" || state === "processor_setup") &&
    (!evidence || typeof evidence !== "object" || !("provider" in evidence) ||
      (evidence.provider === "stripe" && "result" in evidence && evidence.result !== "verified"));
  const actionLabel = action === "continue" ? "Continue" : action === "check" ? "Check connection" : "Connect";
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
      {
        type: "banner",
        title: projection.overall,
        description:
          "Complete both steps before accepting regular customer payments.",
        variant: "alert",
      },
      ...projection.steps.map((step) => ({
        type: "section",
        text: `${step.title}: ${step.status === "complete" ? "Complete" : "Not complete"}. ${step.description}`,
      })),
      ...(supportReference ? [{ type: "section", text: `Setup support reference: ${supportReference}` }] : []),
      ...(providerIdentity ? [{
        type: "section",
        text: `Provider identity: ${describeProviderIdentity(providerIdentity)}`,
      }] : []),
      {
        type: "actions",
        elements: [
          ...(state === "pending" && input && typeof input === "object" && "verificationUri" in input && typeof input.verificationUri === "string"
            ? [{ type: "link", label: "Authorize Payments at DinkusKit", target: { kind: "external", url: input.verificationUri } }] : []),
          ...(state === "processor_setup" && input && typeof input === "object" && "onboardingUrl" in input && typeof input.onboardingUrl === "string"
            ? [{ type: "link", label: "Continue setup at Stripe", target: { kind: "external", url: input.onboardingUrl } }] : []),
          ...(canSetup ? [{ type: "button", label: "Set up or resume Stripe", action_id: "setup_processor" }] : []),
          { type: "button", label: actionLabel, action_id: action },
          ...(action === "check" && !processorPending ? [{ type: "button", label: "Reconnect", action_id: "connect" }] : []),
          ...(isConnected ? [{ type: "button", label: "Check provider identity", action_id: "check_provider_identity" }] : []),
        ],
      },
    ],
  };
}
