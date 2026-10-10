import plugin from "../plugin.js";

export const registryInstallationIdentity = Object.freeze({
  publisherDid: "did:plc:ekk4pjmkh3k3ql2kfoex3qt4",
  slug: "dinkus-payments",
  installedPluginId: "r_3brsc2on3bu673rn",
});

type RouteDeclaration = {
  public?: boolean;
  permission?: string;
  methods?: readonly string[];
  handler?: unknown;
};

export function assertExplicitRegistryRouteAuth(
  routes: Record<string, unknown>,
): asserts routes is Record<string, RouteDeclaration> {
  for (const [name, route] of Object.entries(routes)) {
    if (typeof route !== "object" || route === null || typeof (route as RouteDeclaration).handler !== "function") {
      throw new Error(`Registry route "${name}" must use an explicit route configuration`);
    }
    const declaration = route as RouteDeclaration;
    if (typeof declaration.public !== "boolean") {
      throw new Error(`Registry route "${name}" must declare an explicit public boolean`);
    }
    if (declaration.public && declaration.permission !== undefined) {
      throw new Error(`Public Registry route "${name}" must not declare a permission`);
    }
    if (!declaration.public && !declaration.permission) {
      throw new Error(`Private Registry route "${name}" must declare a permission`);
    }
    if (name === "admin" && declaration.public) {
      throw new Error("admin route must be private");
    }
  }
}

const registryRoutes = plugin.routes ?? {};
assertExplicitRegistryRouteAuth(registryRoutes);

export const registryRouteManifest = Object.freeze({
  installedPluginId: registryInstallationIdentity.installedPluginId,
  nativeSlug: registryInstallationIdentity.slug,
  routes: Object.freeze(
    Object.entries(registryRoutes).map(([name, route]) => {
      const declaration = route as RouteDeclaration;
      return Object.freeze({
        name,
        path: `/_emdash/api/plugins/${registryInstallationIdentity.installedPluginId}/${name}`,
        public: declaration.public as boolean,
        ...(declaration.permission ? { permission: declaration.permission } : {}),
        ...(declaration.methods ? { methods: [...declaration.methods] } : {}),
      });
    }),
  ),
  publicRoutes: Object.freeze(
    Object.entries(registryRoutes)
      .filter(([, route]) => (route as RouteDeclaration).public === true)
      .map(([name]) => `/_emdash/api/plugins/${registryInstallationIdentity.installedPluginId}/${name}`),
  ),
});

export function verifyRegistryInstallationIdentity(identity: {
  publisherDid: string;
  slug: string;
  installedPluginId: string;
}): boolean {
  return identity.publisherDid === registryInstallationIdentity.publisherDid &&
    identity.slug === registryInstallationIdentity.slug &&
    identity.installedPluginId === registryInstallationIdentity.installedPluginId &&
    identity.installedPluginId !== (identity.slug as string);
}
