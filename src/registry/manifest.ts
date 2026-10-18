import plugin from "../plugin.js";
import {
  ACCEPTED_INSTALLED_PLUGIN_IDS,
  BETA_INSTALLED_PLUGIN_ID,
  BETA_REGISTRY_SLUG,
  STABLE_INSTALLED_PLUGIN_ID,
  STABLE_REGISTRY_SLUG,
  acceptedRegistryInstallationIdentities,
  betaRegistryInstallationIdentity,
  isAcceptedRegistryPluginId,
  makeRegistryPluginId,
  parsePaymentsCallbackUri,
  registryCallbackPath,
  registryInstallationIdentity,
  registryProofPath,
  resolveRegistryInstallationIdentity,
  type InstalledRegistryPluginId,
  type RegistryInstallationIdentity,
  type RegistryPluginSlug,
} from "./identity.js";

export type {
  InstalledRegistryPluginId,
  RegistryInstallationIdentity,
  RegistryPluginSlug,
};

export {
  ACCEPTED_INSTALLED_PLUGIN_IDS,
  BETA_INSTALLED_PLUGIN_ID,
  BETA_REGISTRY_SLUG,
  STABLE_INSTALLED_PLUGIN_ID,
  STABLE_REGISTRY_SLUG,
  acceptedRegistryInstallationIdentities,
  betaRegistryInstallationIdentity,
  isAcceptedRegistryPluginId,
  makeRegistryPluginId,
  parsePaymentsCallbackUri,
  registryCallbackPath,
  registryInstallationIdentity,
  registryProofPath,
  resolveRegistryInstallationIdentity,
};

export * from "./setup-journey.js";

export type RegistryRouteDeclaration = {
  name: string;
  path: `/_emdash/api/plugins/${string}/${string}`;
  public: boolean;
  permission?: string;
  methods: readonly string[];
};

type DeclaredRoute = {
  public?: unknown;
  permission?: unknown;
  methods?: readonly string[];
  handler?: unknown;
};

export function assertExplicitRegistryRouteAuth(
  routes: Record<string, unknown> | undefined = plugin.routes,
  identity: RegistryInstallationIdentity = registryInstallationIdentity,
): readonly RegistryRouteDeclaration[] {
  if (!routes || typeof routes !== "object") {
    throw new Error("Payments plugin must declare explicit routes");
  }
  const entries = Object.entries(routes);
  if (entries.length === 0) {
    throw new Error("Payments plugin must declare at least one route");
  }

  return entries.map(([name, raw]) => {
    if (!raw || typeof raw !== "object" || typeof raw === "function") {
      throw new Error(`Payments route "${name}" must use explicit route configuration`);
    }
    const route = raw as DeclaredRoute;
    if (typeof route.public !== "boolean") {
      throw new Error(`Payments route "${name}" must declare an explicit public boolean`);
    }
    if (typeof route.handler !== "function") {
      throw new Error(`Payments route "${name}" must declare a handler`);
    }
    if (!route.public && (typeof route.permission !== "string" || !route.permission)) {
      throw new Error(`Private Payments route "${name}" must declare a permission`);
    }
    if (name === "admin" && route.public) {
      throw new Error("Payments admin route must be private");
    }
    const methods = route.methods ?? ["GET", "POST", "PUT", "DELETE", "PATCH"];
    return Object.freeze({
      name,
      path: `/_emdash/api/plugins/${identity.installedPluginId}/${name}` as const,
      public: route.public,
      ...(typeof route.permission === "string" ? { permission: route.permission } : {}),
      methods: Object.freeze([...methods]),
    });
  });
}

export function verifyRegistryInstallationIdentity(
  actual: Partial<RegistryInstallationIdentity>,
): boolean {
  return acceptedRegistryInstallationIdentities.some(
    (expected) =>
      actual.publisherDid === expected.publisherDid &&
      actual.slug === expected.slug &&
      actual.installedPluginId === expected.installedPluginId,
  );
}

export async function verifyAcceptedRegistryInstallationIdentities(
  derivePluginId: (publisherDid: string, slug: string) => Promise<string> = makeRegistryPluginId,
): Promise<boolean> {
  for (const identity of acceptedRegistryInstallationIdentities) {
    const derived = await derivePluginId(identity.publisherDid, identity.slug);
    if (derived !== identity.installedPluginId) {
      return false;
    }
  }
  return true;
}

const declaredRoutes = Object.freeze(assertExplicitRegistryRouteAuth(plugin.routes, registryInstallationIdentity));
const betaDeclaredRoutes = Object.freeze(assertExplicitRegistryRouteAuth(plugin.routes, betaRegistryInstallationIdentity));

export const registryRouteManifest = Object.freeze({
  ...registryInstallationIdentity,
  routes: declaredRoutes,
  publicRoutes: Object.freeze(
    declaredRoutes.filter((route) => route.public).map((route) => route.path),
  ),
});

export const betaRegistryRouteManifest = Object.freeze({
  ...betaRegistryInstallationIdentity,
  routes: betaDeclaredRoutes,
  publicRoutes: Object.freeze(
    betaDeclaredRoutes.filter((route) => route.public).map((route) => route.path),
  ),
});

export const acceptedRegistryRouteManifests = Object.freeze([
  registryRouteManifest,
  betaRegistryRouteManifest,
] as const);
