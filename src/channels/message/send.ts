import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import type { OutboundDeliveryResult } from "../../infra/outbound/deliver-types.js";
import {
  deliverOutboundPayloads,
  type DeliverOutboundPayloadsParams,
  type OutboundDeliveryIntent,
} from "../../infra/outbound/deliver.js";
import { createLiveMessageState, markLiveMessagePreviewUpdated } from "./live.js";
import { createMessageReceiptFromOutboundResults } from "./receipt.js";
import { createRenderedMessageBatch } from "./rendered-batch.js";
import type {
  DurableMessageSendIntent,
  LiveMessageState,
  MessageDurabilityPolicy,
  MessageReceipt,
  MessageSendContext,
  RenderedMessageBatch,
} from "./types.js";

export type DurableMessageBatchSendParams = Omit<
  DeliverOutboundPayloadsParams,
  "onDeliveryIntent" | "payloads" | "queuePolicy"
> & {
  payloads: ReplyPayload[];
  attempt?: number;
  signal?: AbortSignal;
  previousReceipt?: MessageReceipt;
};

export type DurableMessageBatchSendResult =
  | {
      status: "sent";
      results: OutboundDeliveryResult[];
      receipt: MessageReceipt;
      deliveryIntent?: OutboundDeliveryIntent;
    }
  | {
      status: "suppressed";
      results: [];
      receipt: MessageReceipt;
      deliveryIntent?: OutboundDeliveryIntent;
      reason: "no_visible_result";
    }
  | { status: "failed"; error: unknown };

const neverAbortedSignal = new AbortController().signal;

function toDurableMessageIntent(
  intent: OutboundDeliveryIntent,
  renderedBatch: RenderedMessageBatch<ReplyPayload>,
): DurableMessageSendIntent<ReplyPayload> {
  return {
    id: intent.id,
    channel: intent.channel,
    to: intent.to,
    ...(intent.accountId ? { accountId: intent.accountId } : {}),
    durability: intent.queuePolicy === "required" ? "required" : "best_effort",
    renderedBatch,
  };
}

export type DurableMessageSendContextParams = DurableMessageBatchSendParams & {
  durability?: Exclude<MessageDurabilityPolicy, "disabled">;
  preview?: LiveMessageState<ReplyPayload>;
  onPreviewUpdate?: (
    rendered: RenderedMessageBatch<ReplyPayload>,
    state: LiveMessageState<ReplyPayload>,
  ) => Promise<LiveMessageState<ReplyPayload>> | LiveMessageState<ReplyPayload>;
  onEditReceipt?: (
    receipt: MessageReceipt,
    rendered: RenderedMessageBatch<ReplyPayload>,
  ) => Promise<MessageReceipt> | MessageReceipt;
  onDeleteReceipt?: (receipt: MessageReceipt) => Promise<void> | void;
  onCommitReceipt?: (receipt: MessageReceipt) => Promise<void> | void;
  onSendFailure?: (error: unknown) => Promise<void> | void;
};

export type DurableMessageSendContext = MessageSendContext<
  ReplyPayload,
  DurableMessageBatchSendResult
>;

export async function withDurableMessageSendContext<T>(
  params: DurableMessageSendContextParams,
  run: (ctx: DurableMessageSendContext) => Promise<T>,
): Promise<T> {
  let deliveryIntent: OutboundDeliveryIntent | undefined;
  const {
    attempt,
    durability,
    onDeleteReceipt,
    onEditReceipt,
    onCommitReceipt,
    onPreviewUpdate,
    onSendFailure,
    payloads,
    preview,
    previousReceipt,
    signal,
    ...deliveryParams
  } = params;
  let liveState = preview ?? createLiveMessageState<ReplyPayload>();
  const ctx: DurableMessageSendContext = {
    id: `${params.channel}:${params.to}`,
    channel: params.channel,
    to: params.to,
    ...(params.accountId ? { accountId: params.accountId } : {}),
    durability: durability ?? "required",
    attempt: attempt ?? 1,
    signal: signal ?? neverAbortedSignal,
    ...(previousReceipt ? { previousReceipt } : {}),
    preview: liveState,
    render: async (): Promise<RenderedMessageBatch<ReplyPayload>> =>
      createRenderedMessageBatch(payloads),
    previewUpdate: async (rendered): Promise<LiveMessageState<ReplyPayload>> => {
      liveState = onPreviewUpdate
        ? await onPreviewUpdate(rendered, liveState)
        : markLiveMessagePreviewUpdated(liveState, rendered);
      ctx.preview = liveState;
      return liveState;
    },
    send: async (rendered): Promise<DurableMessageBatchSendResult> => {
      try {
        const results = await deliverOutboundPayloads({
          ...deliveryParams,
          payloads: rendered.payloads,
          renderedBatchPlan: rendered.plan,
          queuePolicy: "required",
          onDeliveryIntent: (intent) => {
            deliveryIntent = intent;
            ctx.intent = toDurableMessageIntent(intent, rendered);
          },
        });
        const receipt = createMessageReceiptFromOutboundResults({
          results,
          threadId: params.threadId == null ? undefined : String(params.threadId),
          replyToId: params.replyToId ?? undefined,
        });
        if (results.length === 0) {
          return {
            status: "suppressed",
            results: [],
            receipt,
            ...(deliveryIntent ? { deliveryIntent } : {}),
            reason: "no_visible_result",
          };
        }
        return {
          status: "sent",
          results,
          receipt,
          ...(deliveryIntent ? { deliveryIntent } : {}),
        };
      } catch (error: unknown) {
        return { status: "failed", error };
      }
    },
    edit: async (receipt, rendered): Promise<MessageReceipt> => {
      if (!onEditReceipt) {
        throw new Error("message send context edit is not configured");
      }
      const editedReceipt = await onEditReceipt(receipt, rendered);
      liveState = {
        ...liveState,
        receipt: editedReceipt,
        lastRendered: rendered,
      };
      ctx.preview = liveState;
      return editedReceipt;
    },
    delete: async (receipt) => {
      if (!onDeleteReceipt) {
        throw new Error("message send context delete is not configured");
      }
      await onDeleteReceipt(receipt);
    },
    commit: async (receipt) => {
      await onCommitReceipt?.(receipt);
    },
    fail: async (error) => {
      await onSendFailure?.(error);
    },
  };

  try {
    const result = await run(ctx);
    return result;
  } catch (error: unknown) {
    await ctx.fail(error);
    throw error;
  }
}

export async function sendDurableMessageBatch(
  params: DurableMessageSendContextParams,
): Promise<DurableMessageBatchSendResult> {
  return await withDurableMessageSendContext(params, async (ctx) => {
    const rendered = await ctx.render();
    const result = await ctx.send(rendered);
    if (result.status !== "failed") {
      await ctx.commit(result.receipt);
    } else {
      await ctx.fail(result.error);
    }
    return result;
  });
}
