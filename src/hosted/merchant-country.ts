/** Operator-owned TEST fixture configuration, never inferred from shopper data. */
export interface TestMerchantCountry {
  siteId: string;
  country: string;
  rejectedCreation?: {
    bindingRef: string;
    failureAt: number;
    code: "identity_country_required";
  };
}

export interface TestMerchantCountrySiteEntry {
  siteId: string;
  country: string;
}

export function countryCode(value: unknown): value is string {
  // Stripe validates country eligibility; this validates the ISO alpha-2 shape.
  return typeof value === "string" && /^[A-Z]{2}$/.test(value);
}

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

export function testMerchantCountry(value: string | undefined, siteId: string): TestMerchantCountry | undefined {
  if (value === undefined || value === "") return undefined;
  if (value.length > 2048) throw new Error("merchant_country_configuration_invalid");
  let config: unknown;
  try { config = JSON.parse(value); } catch { throw new Error("merchant_country_configuration_invalid"); }
  if (!object(config) || Object.keys(config).some(k => !["siteId", "country", "rejectedCreation"].includes(k)) ||
      typeof config.siteId !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(config.siteId) || !countryCode(config.country)) {
    throw new Error("merchant_country_configuration_invalid");
  }
  const rejected = config.rejectedCreation;
  if (rejected !== undefined && (!object(rejected) ||
      Object.keys(rejected).some(k => !["bindingRef", "failureAt", "code"].includes(k)) ||
      typeof rejected.bindingRef !== "string" || !/^stripe_[A-Za-z0-9_-]{1,190}$/.test(rejected.bindingRef) ||
      typeof rejected.failureAt !== "number" || !Number.isSafeInteger(rejected.failureAt) || rejected.failureAt < 0 ||
      rejected.code !== "identity_country_required")) throw new Error("merchant_country_configuration_invalid");
  if (config.siteId !== siteId) return undefined;
  return config as unknown as TestMerchantCountry;
}

export function testMerchantCountrySites(value: string | undefined): TestMerchantCountrySiteEntry[] | undefined {
  if (value === undefined || value === "") return undefined;
  if (value.length > 8192) throw new Error("merchant_country_configuration_invalid");
  let list: unknown;
  try { list = JSON.parse(value); } catch { throw new Error("merchant_country_configuration_invalid"); }
  if (!Array.isArray(list) || list.length > 16) throw new Error("merchant_country_configuration_invalid");
  const seen = new Set<string>();
  const entries: TestMerchantCountrySiteEntry[] = [];
  for (const entry of list) {
    if (!object(entry)) throw new Error("merchant_country_configuration_invalid");
    const keys = Object.keys(entry);
    if (keys.length !== 2 || keys.some(k => !["siteId", "country"].includes(k))) {
      throw new Error("merchant_country_configuration_invalid");
    }
    if (typeof entry.siteId !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(entry.siteId) ||
        !countryCode(entry.country)) {
      throw new Error("merchant_country_configuration_invalid");
    }
    if (seen.has(entry.siteId)) throw new Error("merchant_country_configuration_invalid");
    seen.add(entry.siteId);
    entries.push({ siteId: entry.siteId, country: entry.country });
  }
  return entries;
}

/** Additive TEST sites cannot override the singleton's country or repair admission. */
export function resolveMerchantCountry(
  legacyValue: string | undefined,
  sitesValue: string | undefined,
  siteId: string,
): TestMerchantCountry | undefined {
  if (sitesValue === undefined || sitesValue === "") return testMerchantCountry(legacyValue, siteId);
  const sites = testMerchantCountrySites(sitesValue)!;
  const legacy = testMerchantCountry(legacyValue, siteId);
  const match = sites.find(entry => entry.siteId === siteId);
  if (match && legacy) throw new Error("merchant_country_configuration_invalid");
  return match ?? legacy;
}
