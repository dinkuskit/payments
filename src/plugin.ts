import type { SandboxedPlugin } from "emdash/plugin";
import { unavailableStatusProjection } from "./registry/status.js";

function adminPage() {
  const projection = unavailableStatusProjection();
  return {
    blocks: [
      { type: "header", text: "Payments" },
      {
        type: "banner",
        title: "Status unavailable",
        description: projection.message,
        variant: "alert",
      },
      {
        type: "section",
        text: "Payment setup has not been checked.",
      },
      {
        type: "fields",
        fields: [
          { label: "Availability", value: "Unavailable" },
          { label: "Mode", value: "Not checked" },
          { label: "Connection state", value: "Not checked" },
        ],
      },
    ],
  };
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
