import { describe, expect, it } from "vitest";
import {
  createMessageReceiptFromOutboundResults,
  listMessageReceiptPlatformIds,
  resolveMessageReceiptPrimaryId,
} from "./receipt.js";

describe("createMessageReceiptFromOutboundResults", () => {
  it("builds a multi-part receipt from outbound delivery results", () => {
    const receipt = createMessageReceiptFromOutboundResults({
      results: [
        { channel: "telegram", messageId: "m1" },
        { channel: "telegram", messageId: "m2" },
      ],
      kind: "text",
      threadId: "topic-1",
      replyToId: "reply-1",
      sentAt: 123,
    });

    expect(receipt).toEqual(
      expect.objectContaining({
        primaryPlatformMessageId: "m1",
        platformMessageIds: ["m1", "m2"],
        threadId: "topic-1",
        replyToId: "reply-1",
        sentAt: 123,
      }),
    );
    expect(receipt.parts).toEqual([
      expect.objectContaining({ platformMessageId: "m1", kind: "text", index: 0 }),
      expect.objectContaining({ platformMessageId: "m2", kind: "text", index: 1 }),
    ]);
  });

  it("uses alternate platform ids when messageId is unavailable", () => {
    const receipt = createMessageReceiptFromOutboundResults({
      results: [{ channel: "whatsapp", messageId: "", toJid: "jid-1" }],
      sentAt: 123,
    });

    expect(receipt.primaryPlatformMessageId).toBe("jid-1");
    expect(receipt.platformMessageIds).toEqual(["jid-1"]);
  });

  it("normalizes receipt ids for compatibility edges", () => {
    const receipt = {
      primaryPlatformMessageId: " ",
      platformMessageIds: [" m1 ", "", "m1", "m2"],
      parts: [],
      sentAt: 123,
    };

    expect(listMessageReceiptPlatformIds(receipt)).toEqual(["m1", "m2"]);
    expect(resolveMessageReceiptPrimaryId(receipt)).toBe("m1");
  });
});
