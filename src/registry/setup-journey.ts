import {
  ACCEPTED_INSTALLED_PLUGIN_IDS,
  BETA_INSTALLED_PLUGIN_ID,
  BETA_REGISTRY_SLUG,
  STABLE_INSTALLED_PLUGIN_ID,
  STABLE_REGISTRY_SLUG,
  registryCallbackPath,
  registryProofPath,
  resolveRegistryInstallationIdentity,
  type InstalledRegistryPluginId,
  type RegistryInstallationIdentity,
  type RegistryPluginSlug,
} from "./identity.js";

export type PaymentsSetupBlock = {
  type: string;
  text?: string;
  title?: string;
  description?: string;
  variant?: string;
  elements?: Array<{
    type: string;
    label: string;
    action_id?: string;
    target?: { kind: string; url: string };
  }>;
};

export type PaymentsSetupPage = {
  blocks: PaymentsSetupBlock[];
};

export type PaymentsSetupTarget = {
  identity: RegistryInstallationIdentity;
  slug: RegistryPluginSlug;
  installedPluginId: InstalledRegistryPluginId;
  statusPath: `/_emdash/admin/plugins/${InstalledRegistryPluginId}/status`;
  statusUrl: string;
  proofPath: `/_emdash/api/plugins/${InstalledRegistryPluginId}/store-proof`;
  proofUrl: string;
};

export type PaymentsSetupScreenInspection = {
  hasPaymentSetupHeader: boolean;
  bannerTitle: string | null;
  connectedStripeTestMode: boolean;
  authorizationSaved: boolean;
  hasConnectPaymentsStep: boolean;
  hasPlaceTestOrderStep: boolean;
  actionIds: string[];
  buttonLabels: string[];
  authorizationUrl: string | null;
  hasSecretLeak: boolean;
};

export type PaymentsSetupJourneyDriver = {
  loadStatusPage(): Promise<PaymentsSetupPage>;
  clickAction(actionId: "connect" | "continue" | "check"): Promise<PaymentsSetupPage>;
  authorizeAtDinkusKit?(verificationUrl: string): Promise<void>;
};

export type PaymentsSetupJourneyResult = {
  ok: boolean;
  target: PaymentsSetupTarget;
  stepsExecuted: string[];
  finalInspection: PaymentsSetupScreenInspection;
};

export const PAYMENTS_SETUP_JOURNEY = Object.freeze({
  id: "payments-setup-stripe-test-mode",
  tag: "@running",
  title: "Merchant connects Payments in Stripe test mode and verifies connection status",
  acceptedSlugs: Object.freeze([STABLE_REGISTRY_SLUG, BETA_REGISTRY_SLUG]),
  acceptedInstalledPluginIds: ACCEPTED_INSTALLED_PLUGIN_IDS,
  expectedBanner: "Connected: Stripe test mode",
  expectedStepText:
    "Connect payments: Connected: Stripe test mode. Test card payments work at checkout.",
  expectedCheckActionLabel: "Check connection",
  expectedCheckActionId: "check",
});

const SECRET_LEAK_PATTERN =
  /\b(?:sk_test_[0-9A-Za-z]+|sk_live_[0-9A-Za-z]+|rk_test_[0-9A-Za-z]+|rk_live_[0-9A-Za-z]+|whsec_[0-9A-Za-z]+|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/;

export function resolvePaymentsSetupTarget(
  storeOrigin: string,
  pluginIdOrSlug: string = BETA_REGISTRY_SLUG,
): PaymentsSetupTarget {
  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(storeOrigin);
  } catch {
    throw new Error(`Invalid store origin for Payments setup journey: ${storeOrigin}`);
  }
  if (
    parsedOrigin.origin === "null" ||
    parsedOrigin.pathname !== "/" ||
    parsedOrigin.search ||
    parsedOrigin.hash
  ) {
    throw new Error(`Store origin must be a bare origin URL: ${storeOrigin}`);
  }

  const identity = resolveRegistryInstallationIdentity(pluginIdOrSlug);
  if (!identity) {
    throw new Error(
      `Unsupported Payments Registry plugin "${pluginIdOrSlug}". Expected ${STABLE_REGISTRY_SLUG} (${STABLE_INSTALLED_PLUGIN_ID}) or ${BETA_REGISTRY_SLUG} (${BETA_INSTALLED_PLUGIN_ID}).`,
    );
  }

  const statusPath = registryCallbackPath(identity.installedPluginId);
  const proofPath = registryProofPath(identity.installedPluginId);

  return {
    identity,
    slug: identity.slug,
    installedPluginId: identity.installedPluginId,
    statusPath,
    statusUrl: `${parsedOrigin.origin}${statusPath}`,
    proofPath,
    proofUrl: `${parsedOrigin.origin}${proofPath}`,
  };
}

export function inspectPaymentsSetupScreen(page: PaymentsSetupPage): PaymentsSetupScreenInspection {
  const blocks = Array.isArray(page?.blocks) ? page.blocks : [];
  const serialized = JSON.stringify(blocks);
  const header = blocks.find((block) => block.type === "header");
  const banner = blocks.find((block) => block.type === "banner");
  const sections = blocks
    .filter((block) => block.type === "section" && typeof block.text === "string")
    .map((block) => block.text as string);
  const actionElements = blocks
    .filter((block) => block.type === "actions" && Array.isArray(block.elements))
    .flatMap((block) => block.elements ?? []);

  const buttonLabels = actionElements
    .filter((el) => el.type === "button" && typeof el.label === "string")
    .map((el) => el.label);
  const actionIds = actionElements
    .filter((el) => el.type === "button" && typeof el.action_id === "string")
    .map((el) => el.action_id as string);
  const authLink = actionElements.find(
    (el) =>
      el.type === "link" &&
      el.label === "Authorize Payments at DinkusKit" &&
      typeof el.target?.url === "string",
  );

  const connectPaymentsSection =
    sections.find((text) => text.startsWith("Connect payments:")) ?? "";
  const placeTestOrderSection =
    sections.find((text) => text.startsWith("Place a test order:")) ?? "";

  return {
    hasPaymentSetupHeader: header?.text === "Payment setup",
    bannerTitle: typeof banner?.title === "string" ? banner.title : null,
    connectedStripeTestMode:
      banner?.title === PAYMENTS_SETUP_JOURNEY.expectedBanner &&
      connectPaymentsSection.includes(PAYMENTS_SETUP_JOURNEY.expectedStepText),
    authorizationSaved: connectPaymentsSection.includes("Your DinkusKit authorization was saved."),
    hasConnectPaymentsStep: Boolean(connectPaymentsSection),
    hasPlaceTestOrderStep: Boolean(placeTestOrderSection),
    actionIds,
    buttonLabels,
    authorizationUrl: authLink?.target?.url ?? null,
    hasSecretLeak: SECRET_LEAK_PATTERN.test(serialized),
  };
}

export async function runPaymentsSetupJourney(options: {
  storeOrigin: string;
  pluginIdOrSlug?: string;
  driver: PaymentsSetupJourneyDriver;
}): Promise<PaymentsSetupJourneyResult> {
  const target = resolvePaymentsSetupTarget(
    options.storeOrigin,
    options.pluginIdOrSlug ?? BETA_REGISTRY_SLUG,
  );
  const stepsExecuted: string[] = [];

  let page = await options.driver.loadStatusPage();
  stepsExecuted.push(`open:${target.statusPath}`);
  let inspection = inspectPaymentsSetupScreen(page);

  if (!inspection.hasPaymentSetupHeader) {
    throw new Error("Payments setup page did not render the 'Payment setup' header.");
  }
  if (inspection.hasSecretLeak) {
    throw new Error("Payments setup page leaked secret or token material on initial load.");
  }

  if (inspection.actionIds.includes("connect") && !inspection.connectedStripeTestMode) {
    page = await options.driver.clickAction("connect");
    stepsExecuted.push("click:connect");
    inspection = inspectPaymentsSetupScreen(page);
    if (inspection.hasSecretLeak) {
      throw new Error("Payments setup page leaked secret or token material after Connect.");
    }
  }

  if (inspection.actionIds.includes("continue")) {
    if (!inspection.authorizationUrl) {
      throw new Error("Pending Payments setup screen did not expose 'Authorize Payments at DinkusKit' link.");
    }
    if (options.driver.authorizeAtDinkusKit) {
      await options.driver.authorizeAtDinkusKit(inspection.authorizationUrl);
      stepsExecuted.push("authorize:dinkuskit");
    }
    page = await options.driver.clickAction("continue");
    stepsExecuted.push("click:continue");
    inspection = inspectPaymentsSetupScreen(page);
    if (inspection.hasSecretLeak) {
      throw new Error("Payments setup page leaked secret or token material after Continue.");
    }
  }

  if (!inspection.actionIds.includes("check") || !inspection.buttonLabels.includes("Check connection")) {
    throw new Error("Payments setup screen did not expose the 'Check connection' action.");
  }

  page = await options.driver.clickAction("check");
  stepsExecuted.push("click:check");
  inspection = inspectPaymentsSetupScreen(page);

  if (inspection.hasSecretLeak) {
    throw new Error("Payments setup page leaked secret or token material after Check connection.");
  }

  const ok =
    inspection.hasPaymentSetupHeader &&
    inspection.connectedStripeTestMode &&
    inspection.hasConnectPaymentsStep &&
    inspection.hasPlaceTestOrderStep &&
    !inspection.hasSecretLeak;

  if (!ok) {
    throw new Error(
      `Payments setup journey did not reach '${PAYMENTS_SETUP_JOURNEY.expectedBanner}' (banner=${inspection.bannerTitle ?? "none"}).`,
    );
  }

  return {
    ok,
    target,
    stepsExecuted,
    finalInspection: inspection,
  };
}
