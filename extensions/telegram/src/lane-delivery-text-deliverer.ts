import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import type { TelegramInlineButtons } from "./button-types.js";
import type { TelegramDraftStream } from "./draft-stream.js";

export type LaneName = "answer" | "reasoning";

export type DraftLaneState = {
  stream: TelegramDraftStream | undefined;
  lastPartialText: string;
  hasStreamedMessage: boolean;
  finalized: boolean;
};

export type LaneDeliveryResult =
  | {
      kind: "stream-finalized";
      delivery: {
        content: string;
        messageId?: number;
      };
    }
  | { kind: "stream-updated" | "sent" | "retained" | "skipped" };

type CreateLaneTextDelivererParams = {
  lanes: Record<LaneName, DraftLaneState>;
  draftMaxChars: number;
  applyTextToPayload: (payload: ReplyPayload, text: string) => ReplyPayload;
  applyTextToFollowUpPayload?: (payload: ReplyPayload, text: string) => ReplyPayload;
  splitFinalTextForStream?: (text: string) => readonly string[];
  sendPayload: (payload: ReplyPayload) => Promise<boolean>;
  flushDraftLane: (lane: DraftLaneState) => Promise<void>;
  stopDraftLane: (lane: DraftLaneState) => Promise<void>;
  clearDraftLane: (lane: DraftLaneState) => Promise<void>;
  editStreamMessage: (params: {
    laneName: LaneName;
    messageId: number;
    text: string;
    buttons?: TelegramInlineButtons;
  }) => Promise<void>;
  log: (message: string) => void;
  markDelivered: () => void;
};

type DeliverLaneTextParams = {
  laneName: LaneName;
  text: string;
  payload: ReplyPayload;
  infoKind: string;
  buttons?: TelegramInlineButtons;
};

function result(
  kind: LaneDeliveryResult["kind"],
  delivery?: Extract<LaneDeliveryResult, { kind: "stream-finalized" }>["delivery"],
): LaneDeliveryResult {
  if (kind === "stream-finalized") {
    return { kind, delivery: delivery! };
  }
  return { kind };
}

function compactChunks(chunks: readonly string[]): string[] {
  const out: string[] = [];
  let whitespace = "";
  for (const chunk of chunks) {
    if (!chunk) {
      continue;
    }
    if (chunk.trim().length === 0) {
      whitespace += chunk;
      continue;
    }
    out.push(`${whitespace}${chunk}`);
    whitespace = "";
  }
  if (whitespace && out.length > 0) {
    out[out.length - 1] = `${out[out.length - 1]}${whitespace}`;
  }
  return out;
}

export function createLaneTextDeliverer(params: CreateLaneTextDelivererParams) {
  const followUpPayload = (payload: ReplyPayload, text: string) =>
    params.applyTextToFollowUpPayload
      ? params.applyTextToFollowUpPayload(payload, text)
      : params.applyTextToPayload(payload, text);

  const clearUnfinalizedStream = async (lane: DraftLaneState) => {
    if (!lane.stream || lane.finalized) {
      return;
    }
    await params.clearDraftLane(lane);
    lane.lastPartialText = "";
    lane.hasStreamedMessage = false;
  };

  const streamText = async (
    laneName: LaneName,
    lane: DraftLaneState,
    text: string,
    payload: ReplyPayload,
    isFinal: boolean,
    buttons?: TelegramInlineButtons,
  ): Promise<LaneDeliveryResult | undefined> => {
    const stream = lane.stream;
    if (!stream || text.length === 0 || payload.isError) {
      return undefined;
    }

    const chunks =
      text.length > params.draftMaxChars
        ? compactChunks(params.splitFinalTextForStream?.(text) ?? [])
        : [text];
    const [firstChunk, ...remainingChunks] = chunks;
    if (!firstChunk || firstChunk.length > params.draftMaxChars) {
      return undefined;
    }

    lane.lastPartialText = firstChunk;
    lane.hasStreamedMessage = true;
    lane.finalized = false;
    stream.update(firstChunk);
    if (isFinal) {
      await params.stopDraftLane(lane);
    } else {
      await params.flushDraftLane(lane);
    }

    const messageId = stream.messageId();
    if (typeof messageId !== "number") {
      if (isFinal && stream.sendMayHaveLanded?.()) {
        lane.finalized = true;
        params.markDelivered();
        return result("retained");
      }
      return undefined;
    }

    params.markDelivered();
    if (buttons) {
      try {
        await params.editStreamMessage({ laneName, messageId, text: firstChunk, buttons });
      } catch (err) {
        params.log(`telegram: ${laneName} stream button edit failed: ${String(err)}`);
      }
    }

    if (isFinal) {
      lane.finalized = true;
      for (const chunk of remainingChunks) {
        if (chunk.trim().length === 0) {
          continue;
        }
        await params.sendPayload(followUpPayload(payload, chunk));
      }
      return result("stream-finalized", { content: text, messageId });
    }

    return result("stream-updated");
  };

  return async ({
    laneName,
    text,
    payload,
    infoKind,
    buttons,
  }: DeliverLaneTextParams): Promise<LaneDeliveryResult> => {
    const lane = params.lanes[laneName];
    const reply = resolveSendableOutboundReplyParts(payload, { text });
    const isFinal = infoKind === "final";
    const streamed = !reply.hasMedia
      ? await streamText(laneName, lane, text, payload, isFinal, buttons)
      : undefined;
    if (streamed) {
      return streamed;
    }

    if (isFinal) {
      await clearUnfinalizedStream(lane);
    }

    const delivered = await params.sendPayload(params.applyTextToPayload(payload, text));
    if (delivered) {
      lane.finalized = true;
    }
    return delivered ? result("sent") : result("skipped");
  };
}
