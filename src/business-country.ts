/**
 * Countries where Stripe opens accounts without an invite or extended-network
 * review (stripe.com/global, checked 2026-10-30). Stripe stays the final judge;
 * this list only decides what the owner can pick (payments-business-country-047).
 */
export const BUSINESS_COUNTRIES: Readonly<Record<string, string>> = Object.freeze({
  AU: "Australia", AT: "Austria", BE: "Belgium", BR: "Brazil", BG: "Bulgaria", CA: "Canada",
  HR: "Croatia", CY: "Cyprus", CZ: "Czech Republic", DK: "Denmark", EE: "Estonia", FI: "Finland",
  FR: "France", DE: "Germany", GI: "Gibraltar", GR: "Greece", HK: "Hong Kong", HU: "Hungary",
  IE: "Ireland", IT: "Italy", JP: "Japan", LV: "Latvia", LI: "Liechtenstein", LT: "Lithuania",
  LU: "Luxembourg", MY: "Malaysia", MT: "Malta", MX: "Mexico", NL: "Netherlands", NZ: "New Zealand",
  NO: "Norway", PL: "Poland", PT: "Portugal", RO: "Romania", SG: "Singapore", SK: "Slovakia",
  SI: "Slovenia", ES: "Spain", SE: "Sweden", CH: "Switzerland", TH: "Thailand",
  AE: "United Arab Emirates", GB: "United Kingdom", US: "United States",
});

export function businessCountry(value: unknown): value is string {
  return typeof value === "string" && Object.hasOwn(BUSINESS_COUNTRIES, value);
}

/** Asks /v1/status to add `businessCountry`; older Workers ignore the header. */
export const BUSINESS_COUNTRY_HEADER = Object.freeze({ name: "X-Dinkus-Payments-Include", value: "business-country" });
