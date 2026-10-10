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
}, config: RegistryConfig) {
  return createRegistryConnection({ ...ctx, config });
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
        const type = input.type;
        const actionId = input.action_id;
        try {
          if (type === "block_action" && typeof actionId === "string") {
            if (actionId === "connect") return renderSetupScreen(await connection.start(routeCtx.user));
            if (actionId === "continue") {
              const result = await connection.exchange(routeCtx.user);
              return renderSetupScreen(result.state === "ready" ? await connection.status(routeCtx.user) : result);
            }
            if (actionId === "check") {
              const result = await connection.exchange(routeCtx.user);
              return renderSetupScreen(result.state === "ready" ? await connection.status(routeCtx.user) : result);
            }
          }
          return renderSetupScreen(await connection.status(routeCtx.user));
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
