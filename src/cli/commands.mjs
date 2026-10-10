// Command implementations for dinkus-payments. Each one calls the hosted
// Payments API through the shared client and shapes the result for the kernel.
// Payment rules stay in the service; this file only validates input and formats.
import { createReadStream } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { CliError, EXIT, sanitizeTerminal, usageError, validateEndpoint } from "./kernel.mjs";
import { BINDING_RECIPIENT, KNOWN_STATES, TOKEN_ENV, createPaymentsClient, readToken } from "../client/payments-client.mjs";

const NAME = "dinkus-payments";
const SITE_ID = /^[\x21-\x7e]{1,200}$/;
const REFERENCE = /^[^\x00-\x1f\x7f]{1,200}$/;
const LIMIT = /^(?:[1-9][0-9]?|100)$/;
// The hosted API refuses checkout bodies over 128 KiB (MAX_CHECKOUT_BODY_BYTES in src/hosted/http.ts).
const MAX_REQUEST_BYTES = 128 * 1024;

// ---------------------------------------------------------------------------
// Context, credential and client

function sourceOf(ctx, key) {
	if (ctx.flags[key] !== undefined) return `--${key}`;
	const envName = ctx.spec.envMap?.[key];
	if (envName && ctx.env[envName]) return envName;
	return `config "${key}"`;
}

function resolveEndpoint(ctx) {
	const text = ctx.config.resolve("endpoint");
	if (text === undefined || text === "") {
		throw usageError('No Payments endpoint. Pass --endpoint <url>, set DINKUS_PAYMENTS_ENDPOINT, or add "endpoint" to a config profile.', "missing_endpoint");
	}
	if (typeof text !== "string") throw usageError(`${sourceOf(ctx, "endpoint")} must be a URL string.`, "invalid_endpoint");
	return validateEndpoint(text, sourceOf(ctx, "endpoint"));
}

function resolveSite(ctx) {
	const siteId = ctx.config.resolve("site");
	if (siteId === undefined || siteId === "") {
		throw usageError('No site. Pass --site <id>, set DINKUS_PAYMENTS_SITE, or add "site" to a config profile.', "missing_site");
	}
	if (typeof siteId !== "string" || !SITE_ID.test(siteId)) {
		throw usageError(`${sourceOf(ctx, "site")} must be 1-200 printable characters with no spaces.`, "invalid_site");
	}
	return siteId;
}

function bindingArgument(ctx) {
	const bindingRef = ctx.args["binding-ref"];
	if (!REFERENCE.test(bindingRef)) throw usageError("<binding-ref> must be 1-200 characters with no control characters.", "invalid_binding_ref");
	return bindingRef;
}

// The credential is read last, after every local usage check has passed.
function paymentsClient(ctx, { endpoint, siteId }) {
	// A project config file comes with the working directory, so it must not
	// decide which host receives the token. Every Payments request carries it.
	if (ctx.config.source("endpoint") === "project") {
		throw new CliError(
			"untrusted_endpoint",
			`Refusing to send ${TOKEN_ENV} to an endpoint from project config. Pass --endpoint or set DINKUS_PAYMENTS_ENDPOINT.`,
			{ exit: EXIT.blocked },
		);
	}
	return createPaymentsClient({
		endpoint,
		siteId,
		token: readToken(ctx.env),
		timeoutMs: ctx.timeoutMs,
		fetchImpl: ctx.fetchImpl,
		signal: ctx.signal,
	});
}

// A 409 business answer becomes a "rejected" result (exit 1); every other
// failure keeps its exit code and carries the resolved context.
async function inContext(context, work) {
	try {
		return await work();
	} catch (error) {
		if (!(error instanceof CliError)) throw error;
		if (error.outcome === "rejected") {
			return {
				outcome: "rejected",
				context,
				rejection: { code: error.code, message: error.message },
				human: `rejected: ${error.code} (${error.message})`,
				plain: [[["code", error.code], ["message", error.message]]],
				exit: EXIT.failure,
			};
		}
		error.details = { ...error.details, context: error.details?.context ?? context };
		throw error;
	}
}

// ---------------------------------------------------------------------------
// Formatting helpers

function table(headers, rows) {
	if (rows.length === 0) return "(none)";
	const widths = headers.map((header, index) => Math.max(header.length, ...rows.map((row) => String(row[index] ?? "").length)));
	const line = (cells) => cells.map((cell, index) => String(cell ?? "").padEnd(widths[index])).join("  ").trimEnd();
	return [line(headers), ...rows.map(line)].join("\n");
}

const isoFromMs = (ms) => (Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? new Date(ms).toISOString() : String(ms));
const isoFromSeconds = (seconds) => isoFromMs(seconds * 1000);

function money(value) {
	if (!value) return "";
	if (value.currency !== "USD") return `${value.currency} ${value.minor} minor units`;
	const digits = value.minor.padStart(3, "0");
	return `USD ${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

// ---------------------------------------------------------------------------
// Connection state guidance (states from src/hosted/connection.ts)

const GUIDANCE = {
	disconnected: {
		next: "connect",
		text: `No payment connection exists for this site. Preview onboarding with '${NAME} connect --dry-run'.`,
		effect: "create_binding",
		plan: "create a new binding for this site, start provider account creation, and return a one-use onboarding link",
	},
	connecting: {
		next: "connect",
		text: `Account creation started but is not confirmed. '${NAME} connect' retries it under the same binding.`,
		effect: "retry_account_creation",
		plan: "retry account creation under the existing binding and idempotency identity, then return a one-use onboarding link if it succeeds",
	},
	setup_required: {
		next: "connect",
		text: `Provider onboarding is not finished. '${NAME} connect' returns a fresh one-use onboarding link.`,
		effect: "issue_onboarding_link",
		plan: "issue a fresh one-use onboarding link for the existing account",
	},
	action_required: {
		next: "connect",
		text: `The provider needs more information from the merchant. '${NAME} connect' returns a fresh one-use onboarding link.`,
		effect: "issue_onboarding_link",
		plan: "issue a fresh one-use onboarding link for the existing account",
	},
	ready: {
		next: "none",
		text: "No action needed. New checkout can use this binding.",
		effect: "no_change",
		plan: "re-verify the account and return ready without a link; nothing changes",
	},
	checking: {
		next: "retry_status",
		text: "The provider could not verify the account, so new checkout is refused. Retry status later.",
		effect: "recheck_provider",
		plan: "re-check the provider and return a one-use onboarding link only if setup is still needed",
	},
	recovery_required: {
		next: "escalate",
		text: "Account creation was not confirmed within the 23-hour retry window. A human operator must recover this binding; connect will not create a new account.",
		effect: "no_change_recovery_required",
		plan: "make no change, because the creation retry window has passed and the binding needs human recovery",
	},
};

function guidance(state) {
	if (KNOWN_STATES.includes(state)) return GUIDANCE[state];
	return {
		next: "unknown",
		text: `This client does not recognize state "${state}". Check for a newer ${NAME}.`,
		effect: "unknown",
		plan: `do something this client cannot predict for state "${state}"`,
		warning: { code: "unrecognized_state", message: `The service reported state "${state}", which this client does not know.` },
	};
}

const connectionOf = ({ state, mode, bindingRef }) => ({ state, mode, ...(bindingRef !== undefined ? { bindingRef } : {}) });

function connectionLines(siteId, connection) {
	const lines = [`site: ${siteId}`, `state: ${connection.state} (${connection.mode} mode)`, `binding: ${connection.bindingRef ?? "none"}`];
	if (connection.mode === "test" && connection.state === "ready") lines.push("note: test-mode readiness is not permission to accept live payments.");
	return lines;
}

// ---------------------------------------------------------------------------
// status

export async function status(ctx) {
	const endpoint = resolveEndpoint(ctx);
	const siteId = resolveSite(ctx);
	const context = { siteId };
	return inContext(context, async () => {
		const connection = connectionOf(await paymentsClient(ctx, { endpoint, siteId }).status());
		const guide = guidance(connection.state);
		return {
			context,
			data: { clientVersion: ctx.spec.version, connection, nextAction: guide.next },
			warnings: guide.warning ? [guide.warning] : undefined,
			human: [...connectionLines(siteId, connection), `next: ${guide.text}`].join("\n"),
			plain: [[
				["clientVersion", ctx.spec.version],
				["state", connection.state],
				["mode", connection.mode],
				["bindingRef", connection.bindingRef ?? ""],
				["nextAction", guide.next],
			]],
		};
	});
}

// ---------------------------------------------------------------------------
// connect (mutation: dry run, typed confirmation, unknown outcome)

function connectPreview(context, current, { interactive = false } = {}) {
	const connection = connectionOf(current);
	const guide = guidance(connection.state);
	const human = [
		interactive ? "preview: nothing has been sent yet." : "dry run: nothing was sent.",
		...connectionLines(context.siteId, connection),
		`connect would: ${guide.plan}.`,
	];
	if (!interactive) human.push(`to connect: rerun without --dry-run and type the site id, or pass --no-input --confirm ${context.siteId}`);
	return {
		outcome: "preview",
		context,
		data: { connection, effect: guide.effect, summary: `connect would ${guide.plan}.` },
		confirmation: { value: context.siteId },
		warnings: guide.warning ? [guide.warning] : undefined,
		human: human.join("\n"),
		plain: [[
			["state", connection.state],
			["mode", connection.mode],
			["bindingRef", connection.bindingRef ?? ""],
			["effect", guide.effect],
			["confirmation", context.siteId],
		]],
	};
}

function connectUnknown(context, error) {
	return {
		outcome: "unknown",
		context,
		unknown: { reason: error.code, next: `${NAME} status` },
		human: `outcome: unknown (${error.code})`,
		notes: [
			error.message,
			`connect was sent but its result is unknown. It is safe to repeat: it resumes the same binding and never creates a second one. Check '${NAME} status' first.`,
		],
		exit: error.exit,
	};
}

function connectCommitted(context, receipt) {
	const connection = connectionOf(receipt);
	const onboarding = receipt.url !== undefined ? { url: receipt.url, expiresAt: receipt.expiresAt } : undefined;
	const guide = guidance(connection.state);
	const nextAction = onboarding ? "open_onboarding_link" : guide.next;
	const human = connectionLines(context.siteId, connection);
	if (onboarding) {
		human.push(`onboarding link (one use, expires ${isoFromMs(onboarding.expiresAt)}):`, onboarding.url);
	} else {
		human.push(`next: ${guide.text}`);
	}
	return {
		outcome: "committed",
		context,
		receipt: { connection, ...(onboarding ? { onboarding } : {}), nextAction },
		warnings: guide.warning ? [guide.warning] : undefined,
		human: human.join("\n"),
		notes: onboarding ? ["Open the onboarding link only as the merchant for this site. It is single-use; do not share, log or store it."] : undefined,
		plain: [[
			["state", connection.state],
			["mode", connection.mode],
			["bindingRef", connection.bindingRef ?? ""],
			["url", onboarding?.url ?? ""],
			["expiresAt", onboarding?.expiresAt ?? ""],
			["nextAction", nextAction],
		]],
	};
}

export async function connect(ctx) {
	const dryRun = ctx.flags["dry-run"] === true;
	const confirm = ctx.flags.confirm;
	if (dryRun && confirm !== undefined) throw usageError("--dry-run and --confirm cannot be combined. Preview first, then confirm.");
	const endpoint = resolveEndpoint(ctx);
	const siteId = resolveSite(ctx);
	const context = { siteId };
	if (!dryRun && confirm === undefined && ctx.flags["no-input"]) {
		throw new CliError("confirmation_required", `connect with --no-input needs --confirm <site-id>. Run '${NAME} connect --dry-run' first to see what it would do.`, { exit: EXIT.blocked, details: { context } });
	}
	if (!dryRun && confirm === undefined && !ctx.interactive) {
		throw new CliError("confirmation_required", "connect needs a typed confirmation, but stdin is not a terminal. Pass --no-input --confirm <site-id>; nothing was sent.", { exit: EXIT.blocked, details: { context } });
	}
	if (!dryRun && confirm !== undefined && confirm !== siteId) {
		throw new CliError("confirmation_mismatch", "--confirm does not match the resolved site id; nothing was sent.", { exit: EXIT.blocked, details: { context } });
	}
	return inContext(context, async () => {
		const payments = paymentsClient(ctx, { endpoint, siteId });
		if (dryRun) return connectPreview(context, await payments.status());
		if (confirm === undefined) {
			const preview = connectPreview(context, await payments.status(), { interactive: true });
			ctx.io.stderr.write(`${sanitizeTerminal(preview.human)}\n`);
			const answer = await ctx.prompt(`Type the site id (${siteId}) to connect, or anything else to cancel: `);
			if (answer !== siteId) throw new CliError("not_confirmed", "Not confirmed; nothing was sent.", { exit: EXIT.blocked });
		}
		let receipt;
		ctx.lifecycle.sending = true;
		try {
			receipt = await payments.connect();
		} catch (error) {
			// After the send, no answer, a 5xx, or an unreadable answer leaves the
			// result unknown. 4xx answers mean the service refused it.
			if (error instanceof CliError && (error.exit === EXIT.unavailable || error.exit === EXIT.contract)) return connectUnknown(context, error);
			throw error;
		} finally {
			ctx.lifecycle.sending = false;
		}
		return connectCommitted(context, receipt);
	});
}

// ---------------------------------------------------------------------------
// binding show

export async function bindingShow(ctx) {
	const endpoint = resolveEndpoint(ctx);
	const siteId = resolveSite(ctx);
	const bindingRef = bindingArgument(ctx);
	const context = { siteId, bindingRef };
	return inContext(context, async () => {
		const binding = await paymentsClient(ctx, { endpoint, siteId }).existingBinding(bindingRef);
		const recipient = BINDING_RECIPIENT[binding.providerId];
		return {
			context,
			data: binding,
			human: [
				`binding: ${binding.bindingRef}`,
				`provider: ${binding.providerId}`,
				`${binding.providerId === "stripe" ? "account" : "merchant"}: ${binding[recipient]}`,
				`mode: ${binding.mode}`,
			].join("\n"),
			plain: [[
				["bindingRef", binding.bindingRef],
				["providerId", binding.providerId],
				[recipient, binding[recipient]],
				["mode", binding.mode],
			]],
		};
	});
}

// ---------------------------------------------------------------------------
// checkout lookup

async function readLimited(stream, label) {
	const chunks = [];
	let size = 0;
	try {
		for await (const chunk of stream) {
			const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
			size += bytes.length;
			if (size > MAX_REQUEST_BYTES) throw usageError(`${label} is larger than 128 KiB, the most Payments accepts.`, "invalid_request");
			chunks.push(bytes);
		}
	} catch (error) {
		if (error instanceof CliError) throw error;
		throw usageError(`Cannot read ${label} (${error?.code ?? "read failed"}).`, "invalid_request");
	}
	return Buffer.concat(chunks).toString("utf8");
}

async function readPaymentRequest(ctx, from) {
	let text;
	let label;
	if (from === "-") {
		label = "--request - (stdin)";
		const stdin = ctx.stdin ?? process.stdin;
		if (stdin.isTTY && ctx.flags["no-input"]) {
			throw usageError("--request - reads stdin, but stdin is a terminal and --no-input is set. Pipe the JSON in or pass a file.", "input_required");
		}
		if (stdin.isTTY) ctx.io.stderr.write("Reading the PaymentRequest JSON from stdin; finish with Ctrl-D.\n");
		text = await readLimited(stdin, label);
	} else {
		label = `--request ${from}`;
		text = await readLimited(createReadStream(resolvePath(ctx.cwd, from)), label);
	}
	text = text.replace(/^﻿/, "");
	let request;
	try {
		request = JSON.parse(text);
	} catch {
		throw usageError(`${label} is not valid JSON.`, "invalid_request");
	}
	if (request === null || typeof request !== "object" || Array.isArray(request)) {
		throw usageError(`${label} must be a JSON object (a Commerce PaymentRequest).`, "invalid_request");
	}
	for (const key of ["attemptId", "bindingRef"]) {
		if (typeof request[key] !== "string" || !REFERENCE.test(request[key])) {
			throw usageError(`${label} needs a string "${key}" of 1-200 characters.`, "invalid_request");
		}
	}
	return { text, request };
}

const OUTCOME_NOTES = {
	unknown: "Payments could not prove a state for this attempt. Lookup never creates a session.",
	"not-created": "Payments reports that no provider session was created for this attempt.",
	"expired-unpaid": "The session expired and the provider proved that no payment was taken.",
};

export async function checkoutLookup(ctx) {
	const endpoint = resolveEndpoint(ctx);
	const siteId = resolveSite(ctx);
	const { text, request } = await readPaymentRequest(ctx, ctx.flags.request);
	const context = { siteId, bindingRef: request.bindingRef, attemptId: request.attemptId };
	return inContext(context, async () => {
		const result = await paymentsClient(ctx, { endpoint, siteId }).checkoutLookup(text, request.attemptId);
		const session = result.session;
		const human = [`payment outcome: ${result.outcome}`, `attempt: ${request.attemptId}`];
		if (result.total) human.push(`total: ${money(result.total)}`);
		if (session) {
			human.push(`session: ${session.sessionId}`, `created: ${isoFromSeconds(session.createdAt)}`, `expires: ${isoFromSeconds(session.expiresAt)}`, `redirect: ${session.redirectUrl}`);
		}
		if (result.paymentId) human.push(`payment: ${result.paymentId}`);
		if (OUTCOME_NOTES[result.outcome]) human.push(`note: ${OUTCOME_NOTES[result.outcome]}`);
		return {
			context,
			data: result,
			human: human.join("\n"),
			plain: [[
				["attemptId", request.attemptId],
				["paymentOutcome", result.outcome],
				["totalCurrency", result.total?.currency ?? ""],
				["totalMinor", result.total?.minor ?? ""],
				["sessionId", session?.sessionId ?? ""],
				["redirectUrl", session?.redirectUrl ?? ""],
				["createdAt", session?.createdAt ?? ""],
				["expiresAt", session?.expiresAt ?? ""],
				["paymentId", result.paymentId ?? ""],
			]],
		};
	});
}

// ---------------------------------------------------------------------------
// wakes list

export async function wakesList(ctx) {
	const endpoint = resolveEndpoint(ctx);
	const siteId = resolveSite(ctx);
	const bindingRef = bindingArgument(ctx);
	const limitText = ctx.flags.limit;
	if (limitText !== undefined && !LIMIT.test(limitText)) throw usageError("--limit must be a whole number from 1 to 100.", "invalid_limit");
	const limit = limitText === undefined ? undefined : Number(limitText);
	const context = { siteId, bindingRef };
	return inContext(context, async () => {
		const wakes = await paymentsClient(ctx, { endpoint, siteId }).listWakes(bindingRef, limit);
		return {
			context,
			data: { bindingRef, wakes },
			human: wakes.length === 0
				? `No unacknowledged wakes for binding ${bindingRef}.`
				: table(["EVENT", "ATTEMPT", "GENERATION", "WOKE AT"], wakes.map((wake) => [wake.eventId, wake.attemptId, wake.deliveryGeneration, isoFromMs(wake.wokeAt)])),
			plain: wakes.map((wake) => [
				["eventId", wake.eventId],
				["attemptId", wake.attemptId],
				["bindingRef", wake.bindingRef],
				["deliveryGeneration", wake.deliveryGeneration],
				["wokeAt", wake.wokeAt],
			]),
		};
	});
}
