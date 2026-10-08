import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { runCli } from "../../src/cli/kernel.mjs";
import { spec } from "../../src/cli/spec.mjs";

// Synthetic credential: it must never appear in any output.
const TOKEN = "synthetic.payments-cli.token.must-not-print";
const ENDPOINT = "https://payments.example.invalid";
const SITE = "site_demo";
const BINDING = "stripe_binding_demo";
const BIN = fileURLToPath(new URL("../../bin/dinkus-payments.mjs", import.meta.url));
const { version } = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));

let scratch;
let emptyDir;
before(async () => {
	scratch = await mkdtemp(join(tmpdir(), "dinkus-payments-cli-"));
	emptyDir = join(scratch, "empty");
	await mkdir(emptyDir);
});
after(async () => {
	await rm(scratch, { recursive: true, force: true });
});

const reply = (status, body) => () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function fakeFetch(routes = {}) {
	const calls = [];
	const impl = async (url, init) => {
		const call = { method: init.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: init.headers, body: init.body, redirect: init.redirect };
		calls.push(call);
		const route = routes[`${init.method} ${url.pathname}`];
		if (!route) return reply(404, { error: "not_found" })();
		return route(call, init);
	};
	impl.calls = calls;
	return impl;
}

async function run(argv, { routes, fetchImpl, env = {}, cwd = emptyDir, stdin, stdinIsTTY = false, lifecycle = {} } = {}) {
	const fetch = fetchImpl ?? fakeFetch(routes);
	const out = [];
	const err = [];
	const code = await runCli(spec, {
		argv,
		env: { DINKUS_PAYMENTS_TOKEN: TOKEN, DINKUS_PAYMENTS_ENDPOINT: ENDPOINT, HOME: scratch, XDG_CONFIG_HOME: join(scratch, "xdg"), ...env },
		cwd,
		stdout: { write: (text) => out.push(text) },
		stderr: { write: (text) => err.push(text) },
		stdin,
		stdinIsTTY,
		fetchImpl: fetch,
		lifecycle,
	});
	const stdout = out.join("");
	const stderr = err.join("");
	assert.ok(!stdout.includes(TOKEN) && !stderr.includes(TOKEN), "the credential must never be printed");
	return {
		code,
		stdout,
		stderr,
		calls: fetch.calls ?? [],
		json() {
			assert.ok(stdout.endsWith("\n"), "JSON output ends with one newline");
			assert.equal(stdout.trimEnd().split("\n").length, 1, "stdout holds exactly one JSON document");
			return JSON.parse(stdout);
		},
	};
}

const ready = { "GET /v1/status": reply(200, { state: "ready", mode: "test", bindingRef: BINDING }) };

// ---------------------------------------------------------------------------
// Help and version

test("help works at every depth, ignores other arguments, and never calls the service", async () => {
	const cases = [
		[["--help"], "dinkus-payments 0.0.0"],
		[["help"], "Commands:"],
		[["help", "wakes"], "dinkus-payments wakes - "],
		[["status", "--help"], "dinkus-payments status - "],
		[["connect", "-h"], "--confirm <site-id>"],
		[["binding", "--help"], "binding show"],
		[["binding", "show", "--help"], "binding show <binding-ref>"],
		[["checkout", "--help"], "checkout lookup"],
		[["checkout", "lookup", "--help"], "--request <file|->"],
		[["wakes", "list", "--limit", "0", "--bogus", "--help"], "--limit <1-100>"],
	];
	for (const [argv, expected] of cases) {
		const result = await run(argv);
		assert.equal(result.code, 0, argv.join(" "));
		assert.ok(result.stdout.includes("Usage:"), argv.join(" "));
		assert.ok(result.stdout.includes(expected), `${argv.join(" ")} shows ${expected}`);
		assert.equal(result.stderr, "");
		assert.equal(result.calls.length, 0);
	}
});

test("help names the token scope each command needs", async () => {
	const root = await run(["--help"]);
	assert.match(root.stdout, /DINKUS_PAYMENTS_TOKEN .*status and connect need payments:admin; binding, checkout and wakes need payments:checkout/);
	for (const [path, scope] of [[["status"], "payments:admin"], [["connect"], "payments:admin"], [["binding", "show"], "payments:checkout"], [["checkout", "lookup"], "payments:checkout"], [["wakes", "list"], "payments:checkout"]]) {
		assert.ok((await run([...path, "--help"])).stdout.includes(`Needs a ${scope} token.`), path.join(" "));
	}
});

test("--version prints only the package version at every depth", async () => {
	for (const argv of [["--version"], ["status", "--version"], ["binding", "show", BINDING, "--version"]]) {
		const result = await run(argv);
		assert.equal(result.code, 0);
		assert.equal(result.stdout, `${version}\n`);
		assert.equal(result.stderr, "");
		assert.equal(result.calls.length, 0);
	}
});

test("a missing or unknown command is a usage error on stderr", async () => {
	const missing = await run([]);
	assert.equal(missing.code, 2);
	assert.equal(missing.stdout, "");
	assert.match(missing.stderr, /Missing command/);
	const unknown = await run(["wakes", "ack", BINDING]);
	assert.equal(unknown.code, 2);
	assert.match(unknown.stderr, /Unknown command "wakes ack"/);
});

// ---------------------------------------------------------------------------
// Transport, context and output modes

test("status sends the bearer token and site header and reads GET /v1/status", async () => {
	const result = await run(["--site", SITE, "status", "--json"], { routes: ready });
	assert.equal(result.code, 0);
	assert.deepEqual(result.json(), {
		schema: "dinkuskit.payments.cli/v1",
		command: "status",
		outcome: "ok",
		context: { siteId: SITE },
		data: { clientVersion: version, connection: { state: "ready", mode: "test", bindingRef: BINDING }, nextAction: "none" },
	});
	assert.equal(result.calls.length, 1);
	const [call] = result.calls;
	assert.equal(call.method, "GET");
	assert.equal(call.path, "/v1/status");
	assert.deepEqual(call.query, {});
	assert.equal(call.body, undefined);
	assert.equal(call.headers.authorization, `Bearer ${TOKEN}`);
	assert.equal(call.headers["x-dinkus-site"], SITE);
	assert.equal(call.redirect, "manual", "credentials never follow a redirect");
});

test("status human output shows state, mode, binding and the action needed", async () => {
	const result = await run(["--site", SITE, "status"], { routes: { "GET /v1/status": reply(200, { state: "action_required", mode: "test", bindingRef: BINDING }) } });
	assert.equal(result.code, 0);
	assert.match(result.stdout, /^site: site_demo\nstate: action_required \(test mode\)\nbinding: stripe_binding_demo\nnext: .*connect/);
	assert.equal(result.stderr, "");
	const escalate = await run(["--site", SITE, "status", "--json"], { routes: { "GET /v1/status": reply(200, { state: "recovery_required", mode: "test", bindingRef: BINDING }) } });
	assert.equal(escalate.json().data.nextAction, "escalate");
});

test("an unrecognized state is reported with a warning, not guessed", async () => {
	const result = await run(["--site", SITE, "status", "--json"], { routes: { "GET /v1/status": reply(200, { state: "paused", mode: "test" }) } });
	assert.equal(result.code, 0);
	const document = result.json();
	assert.equal(document.data.nextAction, "unknown");
	assert.equal(document.warnings[0].code, "unrecognized_state");
});

test("plain output is one stable record with escaped tabs, newlines and backslashes", async () => {
	const result = await run(["--site", SITE, "status", "--plain"], { routes: { "GET /v1/status": reply(200, { state: "ready", mode: "test", bindingRef: "a\tb\nc\\d" }) } });
	assert.equal(result.code, 0);
	assert.equal(result.stdout, `schema=dinkuskit.payments.cli/v1\tcommand=status\toutcome=ok\tclientVersion=${version}\tstate=ready\tmode=test\tbindingRef=a\\tb\\nc\\\\d\tnextAction=none\n`);
});

test("service text cannot drive the terminal in human output or the connect preview", async () => {
	const hostile = { "GET /v1/status": reply(200, { state: "ready", mode: "test", bindingRef: "stripe_\u001b[2Jdemo" }), "POST /v1/connect": reply(200, { state: "ready", mode: "test", bindingRef: BINDING }) };
	const human = await run(["--site", SITE, "status"], { routes: hostile });
	assert.ok(!human.stdout.includes("\u001b"));
	assert.match(human.stdout, /binding: stripe_\\u001b\[2Jdemo/);
	const preview = await run(["--site", SITE, "connect"], { routes: hostile, stdin: Readable.from([`${SITE}\n`]), stdinIsTTY: true });
	assert.equal(preview.code, 0);
	assert.ok(!preview.stderr.includes("\u001b"));
});

test("site and endpoint resolve from flags, environment and config files in that order", async () => {
	const project = join(scratch, "project");
	await mkdir(join(project, ".dinkuskit"), { recursive: true });
	await writeFile(join(project, ".dinkuskit", "payments.json"), JSON.stringify({ endpoint: "https://config.example.invalid", site: "site_config", profiles: { other: { site: "site_profile" } } }));
	const noEnvEndpoint = { DINKUS_PAYMENTS_ENDPOINT: "" };

	const fromConfig = await run(["status", "--json"], { routes: ready, cwd: project, env: noEnvEndpoint });
	assert.equal(fromConfig.json().context.siteId, "site_config");
	assert.equal(fromConfig.calls[0].headers["x-dinkus-site"], "site_config");
	assert.equal(fromConfig.calls[0].headers.authorization, `Bearer ${TOKEN}`);

	const fromProfile = await run(["--profile", "other", "status", "--json"], { routes: ready, cwd: project, env: noEnvEndpoint });
	assert.equal(fromProfile.json().context.siteId, "site_profile");

	const fromEnv = await run(["status", "--json"], { routes: ready, cwd: project, env: { DINKUS_PAYMENTS_SITE: "site_env" } });
	assert.equal(fromEnv.json().context.siteId, "site_env");

	const fromFlag = await run(["--site", SITE, "status", "--json"], { routes: ready, cwd: project, env: { DINKUS_PAYMENTS_SITE: "site_env" } });
	assert.equal(fromFlag.json().context.siteId, SITE);
});

test("config files that hold a token are rejected before any request", async () => {
	const project = join(scratch, "secret-project");
	await mkdir(join(project, ".dinkuskit"), { recursive: true });
	await writeFile(join(project, ".dinkuskit", "payments.json"), JSON.stringify({ site: SITE, token: "not-allowed-here" }));
	const result = await run(["status"], { routes: ready, cwd: project });
	assert.equal(result.code, 2);
	assert.match(result.stderr, /non-secret metadata only/);
	assert.ok(!result.stderr.includes("not-allowed-here"));
	assert.equal(result.calls.length, 0);
});

test("every service command requires a site and an endpoint", async () => {
	for (const argv of [["status"], ["connect", "--dry-run"], ["binding", "show", BINDING], ["wakes", "list", BINDING], ["checkout", "lookup", "--request", "-"]]) {
		const noSite = await run(argv, { routes: ready });
		assert.equal(noSite.code, 2, argv.join(" "));
		assert.match(noSite.stderr, /No site\. Pass --site <id>/);
		assert.equal(noSite.calls.length, 0);
	}
	const noEndpoint = await run(["--site", SITE, "status"], { routes: ready, env: { DINKUS_PAYMENTS_ENDPOINT: "" } });
	assert.equal(noEndpoint.code, 2);
	assert.match(noEndpoint.stderr, /No Payments endpoint/);
	const plainHttp = await run(["--site", SITE, "--endpoint", "http://payments.example.invalid", "status"], { routes: ready });
	assert.equal(plainHttp.code, 2);
	assert.match(plainHttp.stderr, /--endpoint must use https/);
	const credentialed = await run(["--site", SITE, "status"], { routes: ready, env: { DINKUS_PAYMENTS_ENDPOINT: "https://user:pass@payments.example.invalid" } });
	assert.equal(credentialed.code, 2);
	assert.match(credentialed.stderr, /DINKUS_PAYMENTS_ENDPOINT must not contain credentials/);
	const badSite = await run(["--site", "site demo", "status"], { routes: ready });
	assert.equal(badSite.code, 2);
	assert.equal(badSite.calls.length, 0);
});

test("a missing or malformed token exits 4 and names only the variable", async () => {
	const missing = await run(["--site", SITE, "status", "--json"], { routes: ready, env: { DINKUS_PAYMENTS_TOKEN: "" } });
	assert.equal(missing.code, 4);
	assert.equal(missing.json().error.code, "missing_credential");
	assert.match(missing.stderr, /DINKUS_PAYMENTS_TOKEN is not set/);
	assert.equal(missing.calls.length, 0);
	const spaced = await run(["--site", SITE, "status"], { routes: ready, env: { DINKUS_PAYMENTS_TOKEN: "two words-secret-part" } });
	assert.equal(spaced.code, 4);
	assert.ok(!spaced.stderr.includes("secret-part"));
	assert.equal(spaced.calls.length, 0);
});

test("errors go to stderr in human mode and to one JSON document in --json mode", async () => {
	const routes = { "GET /v1/status": reply(503, { error: "payments_service_unavailable" }) };
	const human = await run(["--site", SITE, "status"], { routes });
	assert.equal(human.code, 3);
	assert.equal(human.stdout, "");
	assert.match(human.stderr, /^dinkus-payments: status: service unavailable \(payments_service_unavailable\)\.\n$/);
	const machine = await run(["--site", SITE, "status", "--json"], { routes });
	assert.equal(machine.code, 3);
	const document = machine.json();
	assert.equal(document.outcome, "error");
	assert.deepEqual(document.context, { siteId: SITE });
	assert.equal(document.error.code, "payments_service_unavailable");
	const plain = await run(["--site", SITE, "status", "--plain"], { routes });
	assert.equal(plain.stdout, "schema=dinkuskit.payments.cli/v1\tcommand=status\toutcome=error\tcode=payments_service_unavailable\tmessage=status: service unavailable (payments_service_unavailable).\n");
});

// ---------------------------------------------------------------------------
// Exit-code mapping

test("HTTP and transport results map to the shared exit codes", async () => {
	// AbortSignal.timeout does not hold the event loop open; a real socket would.
	const timeout = async (url, init) => new Promise((_, reject) => {
		const socket = setInterval(() => {}, 1000);
		init.signal.addEventListener("abort", () => {
			clearInterval(socket);
			reject(init.signal.reason);
		});
	});
	const cases = [
		["ok", reply(200, { state: "ready", mode: "test", bindingRef: BINDING }), 0, "ok"],
		["400", reply(400, { error: "unexpected_input" }), 1, "error"],
		["404", reply(404, { error: "not_found" }), 1, "error"],
		["401", reply(401, { error: "unauthorized" }), 4, "error"],
		["403", reply(403, { error: "connection_owner_mismatch" }), 4, "error"],
		["500", reply(500, { error: "wake_failed" }), 3, "error"],
		["503 html", reply(503, "<html>down</html>"), 3, "error"],
		["network", () => { throw new TypeError("fetch failed"); }, 3, "error"],
		["timeout", timeout, 3, "error"],
		["200 non-JSON", reply(200, "<html>ok</html>"), 5, "error"],
		["200 off-contract", reply(200, { status: "ready" }), 5, "error"],
		["200 bad mode", reply(200, { state: "ready", mode: "production" }), 5, "error"],
		["302 redirect", () => new Response(null, { status: 302, headers: { location: "https://elsewhere.example.invalid/" } }), 5, "error"],
		["405", reply(405, { error: "method_not_allowed" }), 5, "error"],
	];
	for (const [label, route, exit, outcome] of cases) {
		const result = await run(["--site", SITE, "--timeout", "50ms", "status", "--json"], { routes: { "GET /v1/status": route } });
		assert.equal(result.code, exit, label);
		assert.equal(result.json().outcome, outcome, label);
	}
	const unauthorized = await run(["--site", SITE, "status"], { routes: { "GET /v1/status": reply(401, { error: "unauthorized" }) } });
	assert.match(unauthorized.stderr, /DINKUS_PAYMENTS_TOKEN is current, carries the payments:admin scope, and was issued for site site_demo/);
	const usage = await run(["--site", SITE, "status", "--json", "--plain"]);
	assert.equal(usage.code, 2);
});

test("a 409 business answer is outcome rejected with exit 1", async () => {
	const routes = { "GET /v1/existing-binding": reply(409, { error: "binding_not_found" }) };
	const machine = await run(["--site", SITE, "binding", "show", "stripe_missing", "--json"], { routes });
	assert.equal(machine.code, 1);
	const document = machine.json();
	assert.equal(document.outcome, "rejected");
	assert.deepEqual(document.context, { siteId: SITE, bindingRef: "stripe_missing" });
	assert.equal(document.rejection.code, "binding_not_found");
	assert.equal(document.error, undefined);
	const plain = await run(["--site", SITE, "binding", "show", "stripe_missing", "--plain"], { routes });
	assert.match(plain.stdout, /^schema=dinkuskit\.payments\.cli\/v1\tcommand=binding\.show\toutcome=rejected\tcode=binding_not_found\tmessage=/);
	const nested = await run(["--site", SITE, "binding", "show", "stripe_missing", "--json"], { routes: { "GET /v1/existing-binding": reply(409, { error: { code: "binding_not_found" } }) } });
	assert.equal(nested.code, 1);
	assert.equal(nested.json().rejection.code, "binding_not_found");
	const malformed = await run(["--site", SITE, "binding", "show", "stripe_missing"], { routes: { "GET /v1/existing-binding": reply(409, "conflict") } });
	assert.equal(malformed.code, 5);
});

// ---------------------------------------------------------------------------
// connect

const connectRoutes = (connectRoute = reply(200, { state: "setup_required", mode: "test", bindingRef: BINDING, url: "https://connect.stripe.com/setup/s/demo", expiresAt: 1_791_500_300_000 })) => ({
	"GET /v1/status": reply(200, { state: "disconnected", mode: "test" }),
	"POST /v1/connect": connectRoute,
});

test("connect --dry-run only reads status and returns the confirmation value", async () => {
	const result = await run(["--site", SITE, "connect", "--dry-run", "--json"], { routes: connectRoutes() });
	assert.equal(result.code, 0);
	assert.deepEqual(result.calls.map((call) => `${call.method} ${call.path}`), ["GET /v1/status"]);
	const document = result.json();
	assert.equal(document.outcome, "preview");
	assert.equal(document.data.effect, "create_binding");
	assert.deepEqual(document.confirmation, { value: SITE });
	const human = await run(["--site", SITE, "connect", "--dry-run"], { routes: connectRoutes() });
	assert.match(human.stdout, /^dry run: nothing was sent\./);
	assert.match(human.stdout, /--no-input --confirm site_demo/);
});

test("connect fails closed under --no-input and on a mismatched confirmation", async () => {
	for (const argv of [["connect", "--no-input"], ["connect", "--no-input", "--confirm", "site_other"], ["connect", "--confirm", "site_other"]]) {
		const result = await run(["--site", SITE, ...argv], { routes: connectRoutes() });
		assert.equal(result.code, 4, argv.join(" "));
		assert.equal(result.calls.length, 0, "nothing is read or sent");
	}
	const combined = await run(["--site", SITE, "connect", "--dry-run", "--confirm", SITE], { routes: connectRoutes() });
	assert.equal(combined.code, 2);
	assert.equal(combined.calls.length, 0);
});

test("connect without a TTY or --confirm contacts nothing", async () => {
	const result = await run(["--site", SITE, "connect"], { routes: connectRoutes() });
	assert.equal(result.code, 4);
	assert.deepEqual(result.calls, []);
	assert.match(result.stderr, /Pass --no-input --confirm <site-id>; nothing was sent\./);
	assert.equal(result.stdout, "");
});

test("connect --no-input --confirm sends one bodyless POST and marks the send", async () => {
	const lifecycle = { sending: false };
	let sendingDuringPost;
	const routes = connectRoutes();
	const post = routes["POST /v1/connect"];
	routes["POST /v1/connect"] = (call, init) => {
		sendingDuringPost = lifecycle.sending;
		return post(call, init);
	};
	const result = await run(["--site", SITE, "connect", "--no-input", "--confirm", SITE, "--json"], { routes, lifecycle });
	assert.equal(result.code, 0);
	assert.equal(sendingDuringPost, true);
	assert.equal(lifecycle.sending, false);
	assert.deepEqual(result.calls.map((call) => `${call.method} ${call.path}`), ["POST /v1/connect"]);
	assert.equal(result.calls[0].body, undefined);
	assert.deepEqual(result.calls[0].query, {});
	assert.equal(result.calls[0].headers["x-dinkus-site"], SITE);
	const document = result.json();
	assert.equal(document.outcome, "committed");
	assert.deepEqual(document.receipt, {
		connection: { state: "setup_required", mode: "test", bindingRef: BINDING },
		onboarding: { url: "https://connect.stripe.com/setup/s/demo", expiresAt: 1_791_500_300_000 },
		nextAction: "open_onboarding_link",
	});
	assert.match(result.stderr, /single-use/);
	const human = await run(["--site", SITE, "connect", "--confirm", SITE], { routes: connectRoutes() });
	assert.match(human.stdout, /onboarding link \(one use, expires 2026-\d\d-\d\dT[\d:.]+Z\):\nhttps:\/\/connect\.stripe\.com\/setup\/s\/demo\n$/);
});

test("connect asks for the typed site id on a TTY and sends only on a match", async () => {
	const confirmed = await run(["--site", SITE, "connect"], { routes: connectRoutes(), stdin: Readable.from([`${SITE}\n`]), stdinIsTTY: true });
	assert.equal(confirmed.code, 0);
	assert.deepEqual(confirmed.calls.map((call) => call.method), ["GET", "POST"]);
	assert.match(confirmed.stderr, /^preview: nothing has been sent yet\./);
	assert.match(confirmed.stderr, /Type the site id \(site_demo\) to connect/);
	const declined = await run(["--site", SITE, "connect"], { routes: connectRoutes(), stdin: Readable.from(["yes\n"]), stdinIsTTY: true });
	assert.equal(declined.code, 4);
	assert.deepEqual(declined.calls.map((call) => call.method), ["GET"]);
	assert.match(declined.stderr, /Not confirmed; nothing was sent\./);
});

test("end of input at the connect prompt refuses without sending, and no TTY never prompts", async () => {
	const closed = await run(["--site", SITE, "connect"], { routes: connectRoutes(), stdin: Readable.from([]), stdinIsTTY: true });
	assert.equal(closed.code, 4);
	assert.deepEqual(closed.calls.map((call) => call.method), ["GET"]);
	assert.match(closed.stderr, /Input ended before confirmation; nothing was sent\./);
	const piped = await run(["--site", SITE, "connect"], { routes: connectRoutes(), stdin: Readable.from([`${SITE}\n`]), stdinIsTTY: false });
	assert.equal(piped.code, 4);
	assert.equal(piped.calls.length, 0);
});

test("connect reports an unknown outcome when the answer is lost after the send", async () => {
	const cases = [
		["network", () => { throw new TypeError("socket hang up"); }, 3, "service_unreachable"],
		["503", reply(503, { error: "payments_service_unavailable" }), 3, "payments_service_unavailable"],
		["malformed", reply(200, "not json"), 5, "malformed_response"],
		["non-https link", reply(200, { state: "setup_required", mode: "test", bindingRef: BINDING, url: "http://connect.example.invalid/x", expiresAt: 1 }), 5, "malformed_response"],
	];
	for (const [label, route, exit, reason] of cases) {
		const result = await run(["--site", SITE, "connect", "--no-input", "--confirm", SITE, "--json"], { routes: connectRoutes(route) });
		assert.equal(result.code, exit, label);
		const document = result.json();
		assert.equal(document.outcome, "unknown", label);
		assert.equal(document.unknown.reason, reason, label);
		assert.ok(!result.stdout.includes("connect.example.invalid"), "an off-contract link is never printed");
		assert.match(result.stderr, /safe to repeat/);
	}
	const refused = await run(["--site", SITE, "connect", "--no-input", "--confirm", SITE, "--json"], { routes: connectRoutes(reply(403, { error: "connection_owner_mismatch" })) });
	assert.equal(refused.code, 4);
	assert.equal(refused.json().outcome, "error");
	assert.match(refused.stderr, /escalate to a human operator/);
});

// ---------------------------------------------------------------------------
// binding show, checkout lookup, wakes list

test("binding show reads the existing binding and checks it matches", async () => {
	const binding = { bindingRef: BINDING, providerId: "stripe", stripeAccountId: "acct_demo", mode: "test" };
	const result = await run(["--site", SITE, "binding", "show", BINDING, "--json"], { routes: { "GET /v1/existing-binding": reply(200, binding) } });
	assert.equal(result.code, 0);
	assert.deepEqual(result.calls[0].query, { bindingRef: BINDING });
	assert.deepEqual(result.json().data, binding);
	const human = await run(["--site", SITE, "binding", "show", BINDING], { routes: { "GET /v1/existing-binding": reply(200, binding) } });
	assert.equal(human.stdout, "binding: stripe_binding_demo\nprovider: stripe\naccount: acct_demo\nmode: test\n");
	const swapped = await run(["--site", SITE, "binding", "show", BINDING], { routes: { "GET /v1/existing-binding": reply(200, { ...binding, bindingRef: "stripe_other" }) } });
	assert.equal(swapped.code, 5);
	const tooLong = await run(["--site", SITE, "binding", "show", "x".repeat(201)]);
	assert.equal(tooLong.code, 2);
	assert.equal(tooLong.calls.length, 0);
});

const paymentRequest = {
	attemptId: "att_demo",
	bindingRef: BINDING,
	lines: [{ catalogItemId: "item_demo", quantity: 1, name: "Demo item", unitPrice: { currency: "USD", minor: "1200" } }],
	total: { currency: "USD", minor: "1200" },
	paymentMethods: ["card"],
	paymentWindow: { minSeconds: 1800, maxSeconds: 1860 },
};
const openOutcome = {
	outcome: "open",
	attemptId: "att_demo",
	total: { currency: "USD", minor: "1200" },
	session: { sessionId: "cs_test_demo", redirectUrl: "https://checkout.stripe.com/c/pay/cs_test_demo", createdAt: 1_791_500_000, expiresAt: 1_791_501_860 },
};

test("checkout lookup sends the request file byte-for-byte and formats the outcome", async () => {
	const file = join(scratch, "payment-request.json");
	const bytes = `${JSON.stringify(paymentRequest, null, 2)}\n`;
	await writeFile(file, bytes);
	const routes = { "POST /v1/checkout/lookup": reply(200, openOutcome) };
	const result = await run(["--site", SITE, "checkout", "lookup", "--request", file, "--json"], { routes });
	assert.equal(result.code, 0);
	assert.equal(result.calls[0].body, bytes);
	assert.equal(result.calls[0].headers["content-type"], "application/json");
	const document = result.json();
	assert.deepEqual(document.context, { siteId: SITE, bindingRef: BINDING, attemptId: "att_demo" });
	assert.deepEqual(document.data, openOutcome);
	const human = await run(["--site", SITE, "checkout", "lookup", "--request", file], { routes, cwd: scratch });
	assert.match(human.stdout, /^payment outcome: open\nattempt: att_demo\ntotal: USD 12\.00\nsession: cs_test_demo\n/);
	const relative = await run(["--site", SITE, "checkout", "lookup", "--request", "payment-request.json", "--plain"], { routes, cwd: scratch });
	assert.match(relative.stdout, /\tattemptId=att_demo\tpaymentOutcome=open\ttotalCurrency=USD\ttotalMinor=1200\tsessionId=cs_test_demo\t/);
	const unknown = await run(["--site", SITE, "checkout", "lookup", "--request", file], { routes: { "POST /v1/checkout/lookup": reply(200, { outcome: "unknown" }) } });
	assert.equal(unknown.code, 0);
	assert.match(unknown.stdout, /payment outcome: unknown\n.*never creates/s);
});

test("checkout lookup validates the request locally before sending", async () => {
	const write = async (name, text) => {
		const file = join(scratch, name);
		await writeFile(file, text);
		return file;
	};
	const cases = [
		[await write("array.json", "[]"), /must be a JSON object/],
		[await write("null.json", "null"), /must be a JSON object/],
		[await write("broken.json", "{ attemptId:"), /is not valid JSON/],
		[await write("no-attempt.json", JSON.stringify({ bindingRef: BINDING })), /needs a string "attemptId"/],
		[join(scratch, "missing.json"), /Cannot read --request .*missing\.json \(ENOENT\)/],
	];
	for (const [file, message] of cases) {
		const result = await run(["--site", SITE, "checkout", "lookup", "--request", file], { routes: { "POST /v1/checkout/lookup": reply(200, openOutcome) } });
		assert.equal(result.code, 2, file);
		assert.match(result.stderr, message);
		assert.equal(result.calls.length, 0);
	}
	const noFlag = await run(["--site", SITE, "checkout", "lookup"]);
	assert.equal(noFlag.code, 2);
	assert.match(noFlag.stderr, /requires --request/);
});

test("checkout lookup maps service answers to exit codes", async () => {
	const file = join(scratch, "request-for-codes.json");
	await writeFile(file, JSON.stringify(paymentRequest));
	const cases = [
		[reply(409, { error: "request_mutation" }), 1, "rejected"],
		[reply(400, { error: "invalid_request" }), 1, "error"],
		[reply(403, { error: "connection_owner_mismatch" }), 4, "error"],
		[reply(200, { outcome: "maybe" }), 5, "error"],
		[reply(200, { ...openOutcome, attemptId: "att_other" }), 5, "error"],
	];
	for (const [route, exit, outcome] of cases) {
		const result = await run(["--site", SITE, "checkout", "lookup", "--request", file, "--json"], { routes: { "POST /v1/checkout/lookup": route } });
		assert.equal(result.code, exit);
		assert.equal(result.json().outcome, outcome);
	}
});

test("wakes list is read-only, validates --limit, and prints one plain record per wake", async () => {
	const wakes = [
		{ eventId: "evt_demo1", attemptId: "att_demo", bindingRef: BINDING, deliveryGeneration: 1, wokeAt: 1_791_500_100_000 },
		{ eventId: "evt_demo2", attemptId: "att_demo2", bindingRef: BINDING, deliveryGeneration: 2, wokeAt: 1_791_500_200_000 },
	];
	const routes = { "GET /v1/checkout/wakes": reply(200, wakes) };
	const result = await run(["--site", SITE, "wakes", "list", BINDING, "--limit", "10", "--plain"], { routes });
	assert.equal(result.code, 0);
	assert.deepEqual(result.calls.map((call) => `${call.method} ${call.path}`), ["GET /v1/checkout/wakes"]);
	assert.deepEqual(result.calls[0].query, { bindingRef: BINDING, limit: "10" });
	const lines = result.stdout.trimEnd().split("\n");
	assert.equal(lines.length, 2);
	assert.equal(lines[0], `schema=dinkuskit.payments.cli/v1\tcommand=wakes.list\toutcome=ok\teventId=evt_demo1\tattemptId=att_demo\tbindingRef=${BINDING}\tdeliveryGeneration=1\twokeAt=1791500100000`);
	const defaults = await run(["--site", SITE, "wakes", "list", BINDING, "--json"], { routes });
	assert.deepEqual(defaults.calls[0].query, { bindingRef: BINDING });
	assert.deepEqual(defaults.json().data, { bindingRef: BINDING, wakes });
	const human = await run(["--site", SITE, "wakes", "list", BINDING], { routes });
	assert.match(human.stdout, /^EVENT +ATTEMPT +GENERATION +WOKE AT\nevt_demo1 +att_demo +1 +2026-/);
	const empty = await run(["--site", SITE, "wakes", "list", BINDING], { routes: { "GET /v1/checkout/wakes": reply(200, []) } });
	assert.equal(empty.stdout, `No unacknowledged wakes for binding ${BINDING}.\n`);
	for (const limit of ["0", "101", "abc", "1.5", "010"]) {
		const invalid = await run(["--site", SITE, "wakes", "list", BINDING, "--limit", limit], { routes });
		assert.equal(invalid.code, 2, limit);
		assert.equal(invalid.calls.length, 0);
	}
	const foreign = await run(["--site", SITE, "wakes", "list", BINDING], { routes: { "GET /v1/checkout/wakes": reply(200, [{ ...wakes[0], bindingRef: "stripe_other" }]) } });
	assert.equal(foreign.code, 5);
	const tooMany = await run(["--site", SITE, "wakes", "list", BINDING, "--limit", "1"], { routes });
	assert.equal(tooMany.code, 5);
	const missing = await run(["--site", SITE, "wakes", "list", BINDING], { routes: { "GET /v1/checkout/wakes": reply(409, { error: "binding_not_found" }) } });
	assert.equal(missing.code, 1);
});

// ---------------------------------------------------------------------------
// The real executable

function spawnBin(argv, { env = {}, input } = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [BIN, ...argv], {
			env: { PATH: process.env.PATH, HOME: scratch, XDG_CONFIG_HOME: join(scratch, "xdg"), ...env },
			cwd: emptyDir,
			stdio: ["pipe", "pipe", "pipe"],
		});
		const out = [];
		const err = [];
		child.stdout.on("data", (chunk) => out.push(chunk));
		child.stderr.on("data", (chunk) => err.push(chunk));
		child.on("error", reject);
		child.on("close", (code) => resolve({ code, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() }));
		child.stdin.end(input ?? "");
	});
}

test("the bin entrypoint prints the version", async () => {
	const result = await spawnBin(["--version"]);
	assert.equal(result.code, 0);
	assert.equal(result.stdout, `${version}\n`);
	assert.equal(result.stderr, "");
});

test("the bin reads a piped PaymentRequest from stdin and calls a local service", async () => {
	const seen = [];
	const server = createServer(async (request, response) => {
		let body = "";
		for await (const chunk of request) body += chunk;
		seen.push({ method: request.method, url: request.url, authorization: request.headers.authorization, site: request.headers["x-dinkus-site"], body });
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify({ ...openOutcome, attemptId: JSON.parse(body).attemptId }));
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const input = JSON.stringify(paymentRequest);
		const result = await spawnBin(["--site", SITE, "checkout", "lookup", "--request", "-", "--json"], {
			env: { DINKUS_PAYMENTS_TOKEN: TOKEN, DINKUS_PAYMENTS_ENDPOINT: `http://127.0.0.1:${server.address().port}` },
			input,
		});
		assert.equal(result.code, 0, result.stderr);
		assert.equal(result.stderr, "");
		assert.ok(!result.stdout.includes(TOKEN));
		assert.equal(JSON.parse(result.stdout).data.outcome, "open");
		assert.deepEqual(seen, [{ method: "POST", url: "/v1/checkout/lookup", authorization: `Bearer ${TOKEN}`, site: SITE, body: input }]);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
});
