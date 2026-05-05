import { describe, expect, it } from "vitest";
import { resolveDurableInboundReplyToId } from "./durable-delivery.js";

describe("durable inbound reply delivery", () => {
  it("preserves explicit null reply targets instead of falling back to context ids", () => {
    expect(
      resolveDurableInboundReplyToId({
        replyToId: null,
        payload: { text: "plain reply" },
        ctxPayload: {
          CommandAuthorized: true,
          ReplyToIdFull: "context-full-reply",
          ReplyToId: "context-reply",
        },
      }),
    ).toBeNull();
  });

  it("falls back to payload and context reply targets when no explicit null is provided", () => {
    expect(
      resolveDurableInboundReplyToId({
        payload: { text: "payload reply", replyToId: "payload-reply" },
        ctxPayload: {
          CommandAuthorized: true,
          ReplyToIdFull: "context-full-reply",
          ReplyToId: "context-reply",
        },
      }),
    ).toBe("payload-reply");

    expect(
      resolveDurableInboundReplyToId({
        payload: { text: "context reply" },
        ctxPayload: {
          CommandAuthorized: true,
          ReplyToIdFull: "context-full-reply",
          ReplyToId: "context-reply",
        },
      }),
    ).toBe("context-full-reply");
  });
});
