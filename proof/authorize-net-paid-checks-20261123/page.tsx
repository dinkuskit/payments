import { createRoot } from "react-dom/client";
import { BlockRenderer } from "@emdash-cms/blocks";
import { renderSetupScreen } from "../../src/registry/setup.ts";
import { decodeStatus } from "../../src/registry/status.ts";

// Synthetic values only: an Authorize.net TEST store whose checkout Authorize.net paid twice.
const status = decodeStatus({
  state: "ready", mode: "test", bindingRef: "binding-synthetic",
  connectionEvidence: { provider: "authorize_net", mode: "test", result: "unsupported" },
  paidTwice: [{ transactionIds: ["60020981676", "60020981677"], total: { currency: "USD", minor: "4500" }, at: Date.UTC(2026, 10, 23, 15, 4) }],
});
const screen = renderSetupScreen({ state: "ready", status: { availability: "available", status, message: "Payments status checked." } });
(window as unknown as { blocks: unknown }).blocks = screen.blocks;
createRoot(document.getElementById("root")!).render(
  <div style={{ maxWidth: 960, margin: "0 auto", padding: 24 }}><BlockRenderer blocks={screen.blocks as never} onAction={() => {}} /></div>,
);
