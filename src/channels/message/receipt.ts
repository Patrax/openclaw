import type {
  MessageReceipt,
  MessageReceiptPartKind,
  MessageReceiptSourceResult,
} from "./types.js";

function resolveReceiptMessageId(result: MessageReceiptSourceResult): string | undefined {
  return (
    result.messageId ||
    result.chatId ||
    result.channelId ||
    result.roomId ||
    result.conversationId ||
    result.toJid ||
    result.pollId
  );
}

export function createMessageReceiptFromOutboundResults(params: {
  results: readonly MessageReceiptSourceResult[];
  kind?: MessageReceiptPartKind;
  threadId?: string;
  replyToId?: string;
  sentAt?: number;
}): MessageReceipt {
  const parts = params.results.flatMap((result, index) => {
    const platformMessageId = resolveReceiptMessageId(result);
    if (!platformMessageId) {
      return [];
    }
    return [
      {
        platformMessageId,
        kind: params.kind ?? "unknown",
        index,
        ...(params.threadId ? { threadId: params.threadId } : {}),
        ...(params.replyToId ? { replyToId: params.replyToId } : {}),
        raw: result,
      },
    ];
  });
  const platformMessageIds = parts.map((part) => part.platformMessageId);
  return {
    ...(platformMessageIds[0] ? { primaryPlatformMessageId: platformMessageIds[0] } : {}),
    platformMessageIds,
    parts,
    ...(params.threadId ? { threadId: params.threadId } : {}),
    ...(params.replyToId ? { replyToId: params.replyToId } : {}),
    sentAt: params.sentAt ?? Date.now(),
    raw: params.results,
  };
}

export function listMessageReceiptPlatformIds(receipt: MessageReceipt): string[] {
  return Array.from(
    new Set(receipt.platformMessageIds.map((messageId) => messageId.trim()).filter(Boolean)),
  );
}

export function resolveMessageReceiptPrimaryId(receipt: MessageReceipt): string | undefined {
  const primary = receipt.primaryPlatformMessageId?.trim();
  if (primary) {
    return primary;
  }
  return listMessageReceiptPlatformIds(receipt)[0];
}
