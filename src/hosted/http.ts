import type { Principal, createConnectionService } from "./connection.js";

export function createHostedHandler(options: {
  authenticate(request: Request, scope: "payments:admin" | "payments:checkout"): Promise<Principal>;
  service(principal: Principal): Pick<ReturnType<typeof createConnectionService>, "connect" | "status" | "checkoutBinding">;
}) {
  const respond = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
  return async (request: Request): Promise<Response> => {
    const { pathname, searchParams } = new URL(request.url);
    const methods: Record<string, string> = { "/v1/connect": "POST", "/v1/status": "GET", "/v1/checkout-binding": "GET" };
    if (!methods[pathname]) return respond({ error: "not_found" }, 404);
    if (request.method !== methods[pathname]) return respond({ error: "method_not_allowed" }, 405);
    let principal: Principal;
    try { principal = await options.authenticate(request, pathname === "/v1/checkout-binding" ? "payments:checkout" : "payments:admin"); }
    catch { return respond({ error: "unauthorized" }, 401); }
    try {
      const service = options.service(principal);
      if (pathname === "/v1/connect") {
        // No caller-controlled account, mode, return URL, or provider selection.
        // This endpoint has no request body and therefore never buffers one.
        if (request.body !== null || searchParams.size) return respond({ error: "unexpected_input" }, 400);
        return respond(await service.connect(principal));
      }
      if (pathname === "/v1/status") {
        if (searchParams.size) return respond({ error: "unexpected_input" }, 400);
        return respond(await service.status(principal));
      }
      const refs = searchParams.getAll("bindingRef");
      if (refs.length !== 1 || searchParams.size !== 1 || refs[0].length < 1 || refs[0].length > 200) return respond({ error: "invalid_binding" }, 400);
      const binding = await service.checkoutBinding(principal, refs[0]);
      return binding ? respond(binding) : respond({ error: "payments_not_ready" }, 409);
    } catch (error) {
      if (error instanceof Error && error.message === "connection_owner_mismatch") return respond({ error: "forbidden" }, 403);
      return respond({ error: "service_unavailable" }, 503);
    }
  };
}
