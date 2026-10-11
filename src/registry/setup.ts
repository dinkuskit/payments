import {
  decodeStatus,
  type PaymentsStatus,
  type StatusProjection,
} from "./status.js";

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
  if (status?.state === "checking" || (!status && connectionState === "checking")) {
    return { title, status: "incomplete", description: `${unconfirmedCommerceOrder} It could not be checked right now. Try again shortly.` };
  }
  return { title, status: "incomplete", description: `${unconfirmedCommerceOrder} Connect payments first, then place a test order.` };
}

function connectionStep(status: PaymentsStatus | null, connectionState?: string): SetupStep {
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
    return { title: "Connect payments", status: "incomplete", description: "DinkusKit Payments status was checked. No processor account is connected. Processor setup is not available in this build." };
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

export function projectSetupScreen(input: unknown): SetupScreenProjection {
  let status: PaymentsStatus | null = null;
  let connectionState: string | undefined;
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    const projection = input as Partial<StatusProjection>;
    if (typeof (input as { state?: unknown }).state === "string") {
      connectionState = (input as { state: string }).state;
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
      connectionStep(status, connectionState),
      testOrderStep(status, connectionState),
    ],
  };
}

export function renderSetupScreen(input: unknown) {
  const nested = input && typeof input === "object" && "state" in input && "status" in input ? input.status : input;
  const projection = projectSetupScreen(nested);
  const state = typeof input === "object" && input !== null && !Array.isArray(input) &&
    typeof (input as { state?: unknown }).state === "string" ? (input as { state: string }).state : "disconnected";
  const action = state === "pending" || state === "connecting" ? "continue" : state === "checking" || state === "ready" ? "check" : "connect";
  const actionLabel = action === "continue" ? "Continue" : action === "check" ? "Check connection" : "Connect";
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
      {
        type: "actions",
        elements: [
          ...(state === "pending" && input && typeof input === "object" && "verificationUri" in input && typeof input.verificationUri === "string"
            ? [{ type: "link", label: "Authorize Payments at DinkusKit", target: { kind: "external", url: input.verificationUri } }] : []),
          { type: "button", label: actionLabel, action_id: action },
          ...(action === "check" ? [{ type: "button", label: "Reconnect", action_id: "connect" }] : []),
        ],
      },
    ],
  };
}
