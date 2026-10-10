import { describe, expect, it, vi } from "vitest";
import { createAuthorizeNetFetchTransport } from "../../src/authorize-net/checkout.js";

describe("Authorize.net transport in workerd", () => {
  it("applies one deadline to the response body without crossing AbortSignal over RPC", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({
      start(controller) {
        setTimeout(() => {
          controller.enqueue(new TextEncoder().encode("{}"));
          controller.close();
        }, 30);
      },
    }), { status: 200 })));
    try {
      const transport = createAuthorizeNetFetchTransport({
        endpoint: "https://apitest.authorize.net/xml/v1/request.api",
        timeoutMs: 10,
      });
      await expect(transport.request({})).rejects.toThrow("authorize_net_timeout");
      expect(fetch).toHaveBeenCalledWith(
        "https://apitest.authorize.net/xml/v1/request.api",
        expect.objectContaining({ method: "POST" }),
      );
      expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1]).not.toHaveProperty("signal");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
