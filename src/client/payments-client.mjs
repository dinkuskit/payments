// Authenticated client for the hosted Payments service API (src/hosted/http.ts).
// It owns headers, status mapping, and response-shape checks so that CLI
// commands only format results. It holds no payment rules of its own.
import { CliError, EXIT, createHttp, httpFailure } from "../cli/kernel.mjs";

export const TOKEN_ENV = "DINKUS_PAYMENTS_TOKEN";
export const SCOPE = Object.freeze({ admin: "payments:admin", checkout: "payments:checkout" });

// Closed unions from src/hosted/connection.ts and src/commerce/checkout-port.ts.
export const KNOWN_STATES = Object.freeze([
	"disconnected", "connecting", "setup_required", "ready", "checking", "action_required", "recovery_required",
]);
const MODES = new Set(["test", "live"]);
// Each provider stores its own recipient field on a binding (src/hosted/connection.ts).
export const BINDING_RECIPIENT = Object.freeze({ stripe: "stripeAccountId", authorize_net: "authorizeNetMerchantId" });
const PAYMENT_OUTCOMES = new Set(["unknown", "open", "paid", "expired-unpaid", "not-created"]);

// Server-side messages are codes only; these explain the 409 business answers.
const REJECTIONS = {
	binding_not_found: "No such binding exists for this site.",
	payments_not_ready: "Payments is not ready for new checkout on this binding.",
	binding_mismatch: "The request's binding does not match the stored attempt.",
	request_mutation: "The request differs from the stored attempt. Lookup answers only for the exact original request.",
	invalid_pricing: "The request's pricing snapshot failed validation.",
	wake_association_mismatch: "A stored wake does not match this site's binding. Escalate to a human operator.",
};

const FORBIDDEN = {
	connection_owner_mismatch: "this site's payment connection belongs to a different account or mode. The CLI cannot change ownership; escalate to a human operator.",
};

export function readToken(env) {
	const token = env[TOKEN_ENV];
	if (token === undefined || token === "") {
		throw new CliError("missing_credential", `${TOKEN_ENV} is not set. Export a Payments access token in it; tokens are never read from flags or config files.`, { exit: EXIT.blocked });
	}
	if (!/^[\x21-\x7e]+$/.test(token)) {
		throw new CliError("invalid_credential", `${TOKEN_ENV} must hold one bearer token with no spaces or line breaks.`, { exit: EXIT.blocked });
	}
	return token;
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isText = (value, max = 2000) => typeof value === "string" && value.length > 0 && value.length <= max;

function contract(what, detail) {
	return new CliError("malformed_response", `${what}: the service returned a response outside the contract (${detail}).`, { exit: EXIT.contract });
}

function assertStatus(body, what) {
	if (!isObject(body)) throw contract(what, "expected an object");
	if (!isText(body.state, 100)) throw contract(what, "state");
	if (!MODES.has(body.mode)) throw contract(what, "mode");
	if (body.bindingRef !== undefined && !isText(body.bindingRef, 200)) throw contract(what, "bindingRef");
}

function assertOnboardingLink(body, what) {
	if (body.url === undefined && body.expiresAt === undefined) return;
	if (typeof body.url !== "string" || !Number.isFinite(body.expiresAt)) throw contract(what, "onboarding link");
	let url;
	try {
		url = new URL(body.url);
	} catch {
		throw contract(what, "onboarding link");
	}
	if (url.protocol !== "https:" || url.username || url.password) throw contract(what, "onboarding link");
}

function assertMoney(value, what, field) {
	if (!isObject(value) || !isText(value.currency, 10) || typeof value.minor !== "string" || !/^(0|[1-9][0-9]*)$/.test(value.minor)) {
		throw contract(what, field);
	}
}

function assertPaymentOutcome(body, what, attemptId) {
	if (!isObject(body) || !PAYMENT_OUTCOMES.has(body.outcome)) throw contract(what, "outcome");
	if (body.outcome === "unknown") return;
	if (body.attemptId !== attemptId) throw contract(what, "attemptId does not match the request");
	if (body.outcome === "not-created") return;
	assertMoney(body.total, what, "total");
	const session = body.session;
	if (!isObject(session) || !isText(session.sessionId, 500) || typeof session.redirectUrl !== "string" ||
		!Number.isSafeInteger(session.createdAt) || !Number.isSafeInteger(session.expiresAt)) {
		throw contract(what, "session");
	}
	if (body.outcome === "paid" && !isText(body.paymentId, 500)) throw contract(what, "paymentId");
}

function assertWakes(body, what, bindingRef, limit) {
	if (!Array.isArray(body)) throw contract(what, "expected an array");
	if (body.length > limit) throw contract(what, `more than ${limit} wakes`);
	for (const wake of body) {
		if (!isObject(wake) || !/^evt_[A-Za-z0-9]+$/.test(String(wake.eventId)) || !isText(wake.attemptId, 200) ||
			wake.bindingRef !== bindingRef || !Number.isSafeInteger(wake.deliveryGeneration) || wake.deliveryGeneration < 1 ||
			!Number.isFinite(wake.wokeAt)) {
			throw contract(what, "wake");
		}
	}
}

export function createPaymentsClient({ endpoint, siteId, token, timeoutMs, fetchImpl, signal }) {
	const request = createHttp({
		baseUrl: endpoint,
		headers: { authorization: `Bearer ${token}`, "x-dinkus-site": siteId },
		timeoutMs,
		// Never forward the bearer token to a redirect target.
		fetchImpl: (url, init) => fetchImpl(url, { ...init, redirect: "manual" }),
		signal,
	});

	function failure(response, { what, path, scope }) {
		// Payments answers { error: "code" }; also accept { error: { code } } like the kernel.
		const error = response.json?.error;
		const errorCode = error && typeof error === "object" ? error.code : error;
		const code = typeof errorCode === "string" ? errorCode : `http_${response.status}`;
		if (response.status >= 300 && response.status < 400) {
			return new CliError("redirect_refused", `${what}: the service answered with a redirect (HTTP ${response.status}). Credentials are never sent to a redirect target; check --endpoint.`, { exit: EXIT.contract });
		}
		if (response.status === 401) {
			return new CliError(code, `${what}: the service rejected the credential (${code}). Check that ${TOKEN_ENV} is current, carries the ${scope} scope, and was issued for site ${siteId}.`, { exit: EXIT.blocked });
		}
		if (response.status === 403 && FORBIDDEN[code]) {
			return new CliError(code, `${what}: ${FORBIDDEN[code]}`, { exit: EXIT.blocked });
		}
		if (response.status === 404 && response.json !== undefined) {
			return new CliError(code, `${what}: the service at ${endpoint} does not serve ${path} (${code}). Check --endpoint and the service version.`, { exit: EXIT.failure });
		}
		if (response.status === 405) {
			return new CliError(code, `${what}: the service does not accept this request method for ${path}; the CLI and service disagree on the API.`, { exit: EXIT.contract });
		}
		if (response.status === 409 && typeof errorCode === "string") {
			const message = REJECTIONS[code] ?? `The service refused the request (${code}).`;
			return new CliError(code, message, { exit: EXIT.failure, outcome: "rejected" });
		}
		return httpFailure(response, what);
	}

	async function call(method, path, { what, scope, query, body }) {
		const response = await request(method, path, { query, body });
		if (!response.ok) throw failure(response, { what, path, scope });
		if (response.json === undefined || response.json === null || typeof response.json !== "object") {
			throw contract(what, "not a JSON object or array");
		}
		return response.json;
	}

	return {
		async status() {
			const body = await call("GET", "/v1/status", { what: "status", scope: SCOPE.admin });
			assertStatus(body, "status");
			return body;
		},
		// No body and no query: the service derives everything from the token.
		async connect() {
			const body = await call("POST", "/v1/connect", { what: "connect", scope: SCOPE.admin });
			assertStatus(body, "connect");
			assertOnboardingLink(body, "connect");
			return body;
		},
		async existingBinding(bindingRef) {
			const what = "binding show";
			const body = await call("GET", "/v1/existing-binding", { what, scope: SCOPE.checkout, query: { bindingRef } });
			if (!isObject(body) || body.bindingRef !== bindingRef) throw contract(what, "bindingRef does not match the request");
			const recipient = Object.hasOwn(BINDING_RECIPIENT, body.providerId) ? BINDING_RECIPIENT[body.providerId] : undefined;
			if (!recipient || !isText(body[recipient], 200) || !MODES.has(body.mode)) throw contract(what, "binding fields");
			return body;
		},
		// `requestText` is sent byte-for-byte; `attemptId` checks the answer.
		async checkoutLookup(requestText, attemptId) {
			const what = "checkout lookup";
			const body = await call("POST", "/v1/checkout/lookup", { what, scope: SCOPE.checkout, body: requestText });
			assertPaymentOutcome(body, what, attemptId);
			return body;
		},
		async listWakes(bindingRef, limit) {
			const what = "wakes list";
			const body = await call("GET", "/v1/checkout/wakes", { what, scope: SCOPE.checkout, query: { bindingRef, limit } });
			assertWakes(body, what, bindingRef, limit ?? 100);
			return body;
		},
	};
}
