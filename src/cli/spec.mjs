// dinkus-payments command tree. The contract is docs/CLI-SPEC.md; this file
// only binds that surface to the shared kernel and the command modules.
import { readFileSync } from "node:fs";
import { bindingShow, checkoutLookup, connect, status, wakesList } from "./commands.mjs";

const { version } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));

const ADMIN = "Needs a payments:admin token.";
const CHECKOUT = "Needs a payments:checkout token.";

export const spec = {
	name: "dinkus-payments",
	version,
	description: "Inspect a site's DinkusKit Payments connection and checkout state through its authenticated API.",
	schema: "dinkuskit.payments.cli/v1",
	configName: "payments",
	docs: "https://github.com/dinkuskit/payments/blob/main/docs/CLI-SPEC.md",
	envMap: {
		endpoint: "DINKUS_PAYMENTS_ENDPOINT",
		profile: "DINKUS_PAYMENTS_PROFILE",
		site: "DINKUS_PAYMENTS_SITE",
	},
	globals: {
		endpoint: { type: "string", value: "<url>", description: "Payments service base URL (https; http only for localhost). Never includes credentials." },
		site: { type: "string", value: "<id>", description: "Site id, sent as x-dinkus-site. Required for every service call." },
	},
	environment: [
		["DINKUS_PAYMENTS_TOKEN", "Bearer token (required). status and connect need payments:admin; binding, checkout and wakes need payments:checkout. Never a flag or config value."],
		["DINKUS_PAYMENTS_ENDPOINT", "Default --endpoint."],
		["DINKUS_PAYMENTS_SITE", "Default --site."],
		["DINKUS_PAYMENTS_PROFILE", "Default --profile."],
		["XDG_CONFIG_HOME", "User config: $XDG_CONFIG_HOME/dinkuskit/payments/config.json (project: .dinkuskit/payments.json)."],
	],
	examples: [
		"dinkus-payments --endpoint https://payments.example.invalid --site site_demo status",
		"dinkus-payments --site site_demo connect --dry-run",
		"dinkus-payments --site site_demo connect --no-input --confirm site_demo --json",
		"dinkus-payments --site site_demo checkout lookup --request - --json < payment-request.json",
		"dinkus-payments --site site_demo wakes list stripe_binding_demo --limit 10 --plain",
	],
	tree: {
		commands: {
			status: {
				summary: "Show the site's payment connection state and next action.",
				usage: "status",
				description: `Reads GET /v1/status. ${ADMIN} Shows state, mode, binding reference and what to do next.`,
				examples: ["dinkus-payments --site site_demo status", "dinkus-payments --site site_demo status --json"],
				run: status,
			},
			connect: {
				summary: "Start or resume provider onboarding (mutation; confirm with the site id).",
				usage: "connect (--dry-run | [--no-input] --confirm <site-id>)",
				description: [
					`Sends POST /v1/connect with no body. ${ADMIN}`,
					"It creates the site's binding on first use, or resumes it, and may return a one-use onboarding link.",
					"--dry-run only reads GET /v1/status and says what connect would do. A real run asks you to type the",
					"site id, or needs --confirm <site-id>. A lost answer is reported as outcome unknown (exit 3); connect",
					"is safe to repeat because it always resumes the same binding.",
				].join("\n"),
				flags: {
					"dry-run": { type: "boolean", description: "Read status and say what connect would do; send nothing." },
					confirm: { type: "string", value: "<site-id>", description: "Connect without a prompt only if this equals the resolved site id." },
				},
				examples: [
					"dinkus-payments --site site_demo connect --dry-run",
					"dinkus-payments --site site_demo connect",
					"dinkus-payments --site site_demo connect --no-input --confirm site_demo --json",
				],
				run: connect,
			},
			binding: {
				summary: "Read stored payment bindings.",
				commands: {
					show: {
						summary: "Show the stored recipient for a binding.",
						usage: "binding show <binding-ref>",
						description: `Reads GET /v1/existing-binding. ${CHECKOUT} This is the recipient kept for existing attempts, even if new checkout is not ready; use status for readiness.`,
						args: [{ name: "binding-ref" }],
						examples: ["dinkus-payments --site site_demo binding show stripe_binding_demo"],
						run: bindingShow,
					},
				},
			},
			checkout: {
				summary: "Read checkout payment state.",
				commands: {
					lookup: {
						summary: "Look up the payment outcome for a Commerce PaymentRequest (read-only).",
						usage: "checkout lookup --request <file|->",
						description: [
							`Sends POST /v1/checkout/lookup. ${CHECKOUT} Lookup never creates a checkout session.`,
							"--request names a file holding the exact PaymentRequest JSON object, or - for stdin. The bytes are",
							"sent unchanged after the CLI checks that they are a JSON object with attemptId and bindingRef.",
						].join("\n"),
						flags: {
							request: { type: "string", value: "<file|->", required: true, description: "PaymentRequest JSON file, or - to read stdin." },
						},
						examples: [
							"dinkus-payments --site site_demo checkout lookup --request payment-request.json",
							"cat payment-request.json | dinkus-payments --site site_demo checkout lookup --request - --json",
						],
						run: checkoutLookup,
					},
				},
			},
			wakes: {
				summary: "Read payment wakes waiting for Commerce reconciliation.",
				commands: {
					list: {
						summary: "List unacknowledged payment wakes for a binding (read-only).",
						usage: "wakes list <binding-ref> [--limit <1-100>]",
						description: `Reads GET /v1/checkout/wakes. ${CHECKOUT} Listing does not consume or acknowledge wakes; Commerce acknowledges them after reconciliation.`,
						args: [{ name: "binding-ref" }],
						flags: {
							limit: { type: "string", value: "<1-100>", description: "Most wakes to return (service default 25)." },
						},
						examples: ["dinkus-payments --site site_demo wakes list stripe_binding_demo --limit 10"],
						run: wakesList,
					},
				},
			},
		},
	},
};
