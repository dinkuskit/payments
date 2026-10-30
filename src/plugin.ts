import type { SandboxedPlugin } from "emdash/plugin";
import { createRegistryConnection, type RegistryConfig, safeResponse } from "./registry/connection.js";
import { renderSetupScreen } from "./registry/setup.js";

export type PaymentsPluginConfig = RegistryConfig;
export const PRODUCTION_STATUS_ENDPOINT = "https://payments.dinkuskit.com/v1/status";
const DEFAULT_CONFIG: PaymentsPluginConfig = Object.freeze({
  endpoint: { status: PRODUCTION_STATUS_ENDPOINT },
});

function buildConnection(ctx: {
  kv: Parameters<typeof createRegistryConnection>[0]["kv"];
  settings: Parameters<typeof createRegistryConnection>[0]["settings"];
  http?: Parameters<typeof createRegistryConnection>[0]["http"];
  site: Parameters<typeof createRegistryConnection>[0]["site"];
  plugin?: Parameters<typeof createRegistryConnection>[0]["plugin"];
}, config: RegistryConfig) {
  return createRegistryConnection({ ...ctx, config });
}

// A saved sign-in whose status could not be read in the same request.
function authorizedOr(result: Awaited<ReturnType<ReturnType<typeof createRegistryConnection>["exchange"]>>) {
  return result.state === "ready" && result.status === undefined ? { state: "authorized" } : result;
}

export function createPaymentsPlugin(config: PaymentsPluginConfig = DEFAULT_CONFIG): SandboxedPlugin {
  return {
  routes: {
    admin: {
      public: false,
      permission: "plugins:manage",
      methods: ["POST"],
      handler: async (routeCtx, ctx) => {
        if (!routeCtx.user) return renderSetupScreen({ state: "failed", message: "connection_unavailable" });
        const connection = buildConnection(ctx, config);
        const input = routeCtx.input && typeof routeCtx.input === "object" ? routeCtx.input as Record<string, unknown> : {};
        const user = routeCtx.user;
        const type = input.type;
        const actionId = input.action_id;
        try {
          // The business-country form sends the owner's choice with Set up Stripe.
          if (type === "form_submit" && actionId === "setup_processor") {
            const values = input.values && typeof input.values === "object" ? input.values as Record<string, unknown> : {};
            return renderSetupScreen(await connection.setupProcessor(user, values.businessCountry));
          }
          if (type === "block_action" && typeof actionId === "string") {
            if (actionId === "check_provider_identity") return renderSetupScreen(await connection.providerIdentity(routeCtx.user));
            if (actionId === "setup_processor") return renderSetupScreen(await connection.setupProcessor(routeCtx.user));
            if (actionId === "connect") return renderSetupScreen(await connection.start(routeCtx.user));
            if (actionId === "continue" || actionId === "check") return renderSetupScreen(authorizedOr(await connection.exchange(user)));
          }
          // DinkusKit's Approve sends the owner back to this page, so a pending
          // sign-in is checked on load; anything else is the usual status read.
          return renderSetupScreen(authorizedOr(await connection.exchange(user, { wait: false })));
        } catch {
          return renderSetupScreen({ state: "failed", message: "connection_unavailable" });
        }
      },
    },
    "store-proof": {
      public: true,
      methods: ["GET"],
      response: "raw",
      request: { body: "none" },
      handler: async (routeCtx, ctx) => {
        const query = routeCtx.input && typeof routeCtx.input === "object" ? routeCtx.input as Record<string, unknown> : {};
        if (Object.keys(query).length !== 1 || typeof query.connection_id !== "string") return safeResponse(400, { error: "invalid_request" });
        try {
          const receipt = await buildConnection(ctx, config).receipt(query.connection_id);
          return receipt ? safeResponse(200, receipt) : safeResponse(404, { error: "not_found" });
        } catch {
          return safeResponse(503, { error: "connection_unavailable" });
        }
      },
    },
  },
  };
}

const plugin: SandboxedPlugin = createPaymentsPlugin();
export default plugin;
