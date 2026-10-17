const HASH_LENGTH = 16;
const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32_ALPHABET[(value >>> bits) & 0x1f];
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  return out;
}

/**
 * Derive the normalized plugin ID for a Registry-published plugin using the
 * exact EmDash algorithm: `r_` + 16 lowercase RFC 4648 base32 chars of
 * SHA-256(`${publisherDid}\n${slug}`).
 */
export async function makeRegistryPluginId(publisherDid: string, slug: string): Promise<string> {
  const did = publisherDid.trim();
  const s = slug.trim();
  if (!did) throw new Error("makeRegistryPluginId: publisherDid is required");
  if (!s) throw new Error("makeRegistryPluginId: slug is required");
  const input = `${did}\n${s}`;
  const hashBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  const encoded = base32Encode(new Uint8Array(hashBuffer));
  return `r_${encoded.slice(0, HASH_LENGTH)}`;
}

export const REGISTRY_PUBLISHER_DID = "did:plc:ekk4pjmkh3k3ql2kfoex3qt4" as const;
export const STABLE_REGISTRY_SLUG = "dinkus-payments" as const;
export const BETA_REGISTRY_SLUG = "dinkus-payments-beta" as const;
export const STABLE_INSTALLED_PLUGIN_ID = "r_3brsc2on3bu673rn" as const;
export const BETA_INSTALLED_PLUGIN_ID = "r_sffx6l4z6mpqliki" as const;

export type InstalledRegistryPluginId =
  | typeof STABLE_INSTALLED_PLUGIN_ID
  | typeof BETA_INSTALLED_PLUGIN_ID;

export type RegistryPluginSlug =
  | typeof STABLE_REGISTRY_SLUG
  | typeof BETA_REGISTRY_SLUG;

export type RegistryInstallationIdentity = Readonly<{
  publisherDid: typeof REGISTRY_PUBLISHER_DID;
  slug: RegistryPluginSlug;
  installedPluginId: InstalledRegistryPluginId;
}>;

export const registryInstallationIdentity: RegistryInstallationIdentity = Object.freeze({
  publisherDid: REGISTRY_PUBLISHER_DID,
  slug: STABLE_REGISTRY_SLUG,
  installedPluginId: STABLE_INSTALLED_PLUGIN_ID,
});

export const betaRegistryInstallationIdentity: RegistryInstallationIdentity = Object.freeze({
  publisherDid: REGISTRY_PUBLISHER_DID,
  slug: BETA_REGISTRY_SLUG,
  installedPluginId: BETA_INSTALLED_PLUGIN_ID,
});

export const acceptedRegistryInstallationIdentities: readonly RegistryInstallationIdentity[] = Object.freeze([
  registryInstallationIdentity,
  betaRegistryInstallationIdentity,
]);

export const ACCEPTED_INSTALLED_PLUGIN_IDS: readonly InstalledRegistryPluginId[] = Object.freeze([
  STABLE_INSTALLED_PLUGIN_ID,
  BETA_INSTALLED_PLUGIN_ID,
]);

export function isAcceptedRegistryPluginId(value: unknown): value is InstalledRegistryPluginId {
  return value === STABLE_INSTALLED_PLUGIN_ID || value === BETA_INSTALLED_PLUGIN_ID;
}

export function resolveRegistryInstallationIdentity(
  pluginIdOrSlug: unknown = registryInstallationIdentity.installedPluginId,
): RegistryInstallationIdentity | null {
  if (
    pluginIdOrSlug === undefined ||
    pluginIdOrSlug === null ||
    pluginIdOrSlug === STABLE_INSTALLED_PLUGIN_ID ||
    pluginIdOrSlug === STABLE_REGISTRY_SLUG
  ) {
    return registryInstallationIdentity;
  }
  if (
    pluginIdOrSlug === BETA_INSTALLED_PLUGIN_ID ||
    pluginIdOrSlug === BETA_REGISTRY_SLUG
  ) {
    return betaRegistryInstallationIdentity;
  }
  return null;
}

export function registryCallbackPath(
  installedPluginId: InstalledRegistryPluginId = registryInstallationIdentity.installedPluginId,
): `/_emdash/admin/plugins/${InstalledRegistryPluginId}/status` {
  if (!isAcceptedRegistryPluginId(installedPluginId)) {
    throw new Error("unsupported_registry_plugin_id");
  }
  return `/_emdash/admin/plugins/${installedPluginId}/status`;
}

export function registryProofPath(
  installedPluginId: InstalledRegistryPluginId = registryInstallationIdentity.installedPluginId,
): `/_emdash/api/plugins/${InstalledRegistryPluginId}/store-proof` {
  if (!isAcceptedRegistryPluginId(installedPluginId)) {
    throw new Error("unsupported_registry_plugin_id");
  }
  return `/_emdash/api/plugins/${installedPluginId}/store-proof`;
}

export function parsePaymentsCallbackUri(
  callbackUri: string,
  expectedOrigin: string,
): {
  identity: RegistryInstallationIdentity;
  installedPluginId: InstalledRegistryPluginId;
  callbackUri: string;
  proofUri: string;
} | null {
  if (typeof callbackUri !== "string" || typeof expectedOrigin !== "string" || !expectedOrigin) {
    return null;
  }
  for (const identity of acceptedRegistryInstallationIdentities) {
    const expectedCallback = `${expectedOrigin}${registryCallbackPath(identity.installedPluginId)}`;
    if (callbackUri === expectedCallback) {
      return {
        identity,
        installedPluginId: identity.installedPluginId,
        callbackUri: expectedCallback,
        proofUri: `${expectedOrigin}${registryProofPath(identity.installedPluginId)}`,
      };
    }
  }
  return null;
}
