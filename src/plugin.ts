import type { SandboxedPlugin } from "emdash/plugin";
import { unavailableStatusProjection } from "./registry/status.js";
import { renderSetupScreen } from "./registry/setup.js";

function adminPage() {
  return renderSetupScreen(unavailableStatusProjection());
}

const plugin: SandboxedPlugin = {
  routes: {
    admin: {
      public: false,
      permission: "plugins:manage",
      methods: ["POST"],
      handler: async () => adminPage(),
    },
  },
};

export default plugin;
