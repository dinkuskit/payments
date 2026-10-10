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
const unknownCommerceOrder =
  "A paid TEST order visible in Commerce admin has not been confirmed. Test-order checking is not available in this build.";

function connectionStep(status: PaymentsStatus | null): SetupStep {
  if (!status?.connectionEvidence) {
    return {
      title: "Connect payments",
      status: "incomplete",
      description:
        `${unavailableConnection} Account connection is not available in this build.`,
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
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    const projection = input as Partial<StatusProjection>;
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
      connectionStep(status),
      {
        title: "Place a test order",
        status: "incomplete",
        description: unknownCommerceOrder,
      },
    ],
  };
}

export function renderSetupScreen(input: unknown) {
  const projection = projectSetupScreen(input);
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
    ],
  };
}
