---
summary: "Grand refactor plan for plugin message lifecycle, durable sends, receipts, and SDK cleanup"
read_when:
  - Planning plugin or channel message lifecycle work
  - Refactoring channel receive, send, preview, reply, or durable delivery paths
  - Designing or reviewing plugin SDK channel-message APIs
title: "Plugin refactor plan"
---

# Plugin Refactor Plan

The current plugin channel surface is functional, but it exposes too many
concepts to plugin authors and keeps too many delivery decisions in channel
callers. The target is one message lifecycle:

```text
receive context -> route and record -> agent turn -> send context
send context -> durable intent -> render batch -> live preview/edit -> final send -> receipt commit
```

Core owns orchestration, durability, queueing, receipts, hooks, preview state,
retry policy, and compatibility bridges. Plugins own native transport details,
native rendering, target normalization, account state, authorization facts, and
platform-specific side effects.

## Outcomes

- New plugin authors learn one channel-message API instead of reply dispatch,
  reply payload, turn kernel, outbound runtime, draft stream, and direct-DM
  helper surfaces.
- Durable final delivery is capability-gated by exact side effects, not inferred
  from the presence of `sendText`.
- Legacy compatibility entry points remain behavior-preserving while they route
  through a smaller internal lifecycle.
- Every adapter-declared delivery capability is backed by a contract test.
- Receipts become the bridge for preview finalization, edits, deletes, duplicate
  suppression, and recovery.

## Invariants

- A durable final send must create the durable intent before platform I/O.
- No legacy fallback is allowed after a durable intent or delivery decision
  exists.
- `unsupported` is a pre-intent result only. `failed` and suppressed sends are
  terminal.
- Hook cancellation is terminal and must not fall through to caller-owned
  delivery.
- Generic durable delivery is enabled only when the adapter declares every
  side-effect capability required by the payload and delivery options.
- Final delivery must return receipts for every visible platform message id.
- Crash after platform send and before receipt commit enters
  `unknown_after_send`; blind replay is allowed only for adapters that explicitly
  declare at-least-once replay as an acceptable policy.
- Reply, quote, thread, live preview, and system-origin semantics are message
  metadata. They are not separate API roots.

## Target Modules

Add the internal core under `src/channels/message/*`:

- `types.ts`: normalized message, target, relation, origin, receipt, send
  result, and compatibility result types.
- `capabilities.ts`: derive durable-final requirements from payload, relation,
  live mode, and channel extras.
- `send.ts`: begin durable intent, render/project batch, send/edit/delete,
  commit receipt, classify failure.
- `receive.ts`: normalize, classify, dedupe, route, record, dispatch, commit
  receive, platform ack policy.
- `live.ts`: preview/progress/edit/finalize/cancel lifecycle.
- `state.ts`: durable intents, receipts, active claims, recovery, idempotency,
  and `unknown_after_send`.
- `contracts.ts`: adapter contract suites for every declared capability.
- `reply-pipeline.ts`: compatibility assembly for reply prefixes, model
  selection callbacks, typing callbacks, and payload transforms while old
  buffered dispatchers are still being cut over.

Public SDK target:

```typescript
import { defineChannelMessageAdapter } from "openclaw/plugin-sdk/channel-message";
```

Compatibility wrappers stay:

- `runtime.channel.turn.*`
- core-owned `replyPipeline` assembly for legacy buffered dispatchers
- `dispatchInboundReplyWithBase`
- `recordInboundSessionAndDispatchReply`
- direct-DM helpers
- existing outbound runtime helpers

New plugin docs should steer authors to `plugin-sdk/channel-message` after the
surface exists.

## Send Context

Target send context:

```typescript
type MessageSendContext = {
  id: string;
  channel: string;
  accountId?: string;
  message: ChannelMessage;
  intent: DurableSendIntent;
  attempt: number;
  signal: AbortSignal;
  previousReceipt?: MessageReceipt;
  preview?: LiveMessageState;
  render(): Promise<RenderedMessageBatch>;
  previewUpdate(rendered: RenderedMessageBatch): Promise<LiveMessageState>;
  send(rendered: RenderedMessageBatch): Promise<MessageReceipt>;
  edit(receipt: MessageReceipt, rendered: RenderedMessageBatch): Promise<MessageReceipt>;
  delete(receipt: MessageReceipt): Promise<void>;
  commit(receipt: MessageReceipt): Promise<void>;
  fail(error: unknown): Promise<void>;
};
```

Preferred orchestration:

```typescript
await messages.withSendContext(message, async (ctx) => {
  const rendered = await ctx.render();
  if (ctx.preview?.canFinalizeInPlace) {
    return await ctx.edit(ctx.preview.receipt, rendered);
  }
  return await ctx.send(rendered);
});
```

The current durable final reply helper becomes a compatibility bridge into this
context. It should stop owning policy once send contexts exist.

## Capability Derivation

Durable-final requirements must be derived in one place:

```typescript
deriveDurableFinalDeliveryRequirements({
  payload,
  replyToId,
  threadId,
  silent,
  payloadTransport,
  extraCapabilities,
});
```

Channels may add native extras:

- Telegram: native selected quote, topic/thread, silent errors, payload
  transport.
- WhatsApp: text-only durable path and message-sending hooks.
- iMessage: media, reply target, self-echo cache through send dependency.
- Tlon: model signature rendering and participated-thread recording.
- Slack/Discord/Matrix/Mattermost: live preview/finalization, thread anchors,
  edits, and redactions.

The bridge should not let each caller hand-author a capability map from scratch.

## Receipts

Replace internal `messageIds?: string[]` with a real receipt:

```typescript
type MessageReceipt = {
  primaryPlatformMessageId?: string;
  platformMessageIds: string[];
  parts: MessageReceiptPart[];
  threadId?: string;
  replyToId?: string;
  editToken?: string;
  deleteToken?: string;
  sentAt: number;
  raw?: unknown;
};
```

Keep compatibility conversion at old edges. New send/lifecycle code should pass
receipts end to end.

## Migration Phases

1. Add `src/channels/message` skeleton with types, capability derivation, and
   compatibility conversion helpers. Route existing durable final delivery
   through it with no behavior change.
2. Add `plugin-sdk/channel-message` as a narrow public facade for stable
   message-lifecycle contracts and helpers.
3. Replace hand-authored durable capability maps in bundled plugins with shared
   derivation plus channel-owned extras.
4. Introduce receipt conversion internally while preserving old
   `ChannelDeliveryResult` at compatibility edges.
5. Move text/media/card/voice/presentation projection into
   `RenderedMessageBatch` and store that batch plan in durable intents.
6. Move Telegram, Discord, Slack, Mattermost, Matrix, and Teams preview logic
   into `live` adapters.
7. Introduce receive contexts and explicit ack policies. Telegram polling offset
   moves from accepted-at-begin toward after-record or after-durable-send.
8. Cut over extensions one at a time:
   iMessage, WhatsApp, Telegram, Slack, Discord, Matrix, Mattermost, Teams, then
   lower-complexity channels.
9. Deprecate old public reply/turn surfaces after bundled plugins and tracked
   third-party compatibility paths use the new channel-message facade.

## Adapter Contract Tests

Every declared capability needs executable proof:

- `text`: sends text and returns a receipt.
- `media`: sends media and all media ids are represented in the receipt.
- `payload`: rich payload path preserves presentation/channel data semantics.
- `replyTo`: native reply target is passed through.
- `thread`: native topic/thread target is passed through.
- `silent`: notification suppression reaches the transport.
- `nativeQuote`: selected quote metadata reaches the transport.
- `messageSendingHooks`: cancellation is terminal and content rewrites apply.
- `batch`: multi-unit projected batches are replayable as one durable plan.
- `reconcileUnknownSend`: unknown-after-send can resolve without blind replay.
- `afterSendSuccess` / `afterCommit`: channel-local side effects run once.

## Extension Cutover Notes

- iMessage: keep sent-message echo cache as an after-send side effect. Do not
  enable durable delivery without this effect.
- WhatsApp: message-sending cancellation must remain terminal. Text-only durable
  migration stays until media fallback has batch receipts.
- Telegram: selected quotes, silent errors, topics, stale previews, and payload
  rendering all need declared capabilities before generic delivery is used.
- Tlon: model signature rendering and participated-thread recording must move
  into render/send/finalize hooks before durable generic delivery.
- Discord, Slack, Matrix, Mattermost, and Teams: migrate live preview and final
  delivery together so preview cleanup and final receipts do not drift.
- Low-complexity channels can use a direct text/media send adapter once their
  reply/thread semantics are covered by contract tests.

## Success Criteria

- No bundled extension hand-authors generic durable-final requirement maps
  except for native extras.
- No channel calls `deliverDurableInboundReplyPayload` directly after the
  send-context bridge is available.
- `plugin-sdk/channel-message` is documented and covered by package export
  checks.
- `pnpm check:changed`, `pnpm build`, and plugin SDK export checks pass.
- At least iMessage, WhatsApp, and Telegram durable final paths use the shared
  capability derivation in the first implementation slice.

## Current Branch Status

Implemented in the current refactor branch:

- `src/channels/message` now owns message lifecycle types, durable-final
  requirement derivation, rendered batch planning, receipt helpers, live preview
  finalization helpers, receive contexts, and capability contract helpers.
- `plugin-sdk/channel-message` exposes the new lifecycle facade while legacy
  reply/turn helpers remain as explicitly deprecated compatibility aliases.
- Bundled durable final paths use shared capability derivation, with native
  extras still supplied by owners that need them.
- Generic durable fallback now preflights outbound support before enqueueing and
  treats durable no-send/cancelled results as terminal.
- Receipts are the preferred internal bridge. Compatibility result edges still
  expose `ChannelDeliveryResult.messageIds`, derived from normalized receipts.
- WhatsApp send and reply delivery results now derive visible ids from
  receipts/keys; parallel owner-local `messageIds` fields were removed from
  the WhatsApp send result shapes.
- Live-capable bundled adapters have capability proof tests; receive ack policy
  declarations now have proof helpers. All message adapters have an explicit
  receive policy: Telegram and LINE declare staged acknowledgement policies,
  while adapters whose platform acknowledgement remains plugin/protocol-owned
  default to `manual`.
- Generic live preview finalizers can retain ambiguous failed final edits
  without sending a duplicate fallback, which is the required seam for Telegram
  stale/ambiguous preview parity.
- Telegram lane final edits now route through
  `defineFinalizableLivePreviewAdapter(...)` and
  `deliverWithFinalizableLivePreviewAdapter(...)`, with finalizer capabilities
  and contract proofs declared on the Telegram message adapter.
- Parallel owner-local send result `messageIds` have been removed or renamed to
  platform-specific batch ids. Remaining `messageIds` are inbound replay/dedupe
  keys or the shared `ChannelDeliveryResult` compatibility edge.
- Bundled plugins and gateway callers now use `createChannelMessageReplyPipeline`
  or the `recordChannelMessageReplyDispatch` compatibility alias. The old
  `createChannelTurnReplyPipeline` name remains exported only as an explicitly
  deprecated public compatibility surface.
- Legacy reply/turn SDK names carry deprecation guidance and docs steer new
  channel code to the message adapter plus receive/send lifecycle helpers. The
  old inbound reply dispatch names remain importable but now delegate to the
  channel-message implementations.

Receive policy audit:

- Telegram declares `after_agent_dispatch` plus `after_receive_record` because
  polling offsets can be persisted after handler dispatch, and the receiver now
  uses `createMessageReceiveContext(...)`.
- LINE declares `after_agent_dispatch` plus `after_receive_record` because the
  webhook handler can hold the HTTP response until event dispatch succeeds, and
  verification/no-event requests can acknowledge after receive-record parsing.
- BlueBubbles, Google Chat, Nextcloud Talk, Synology Chat, Zalo, Slack, Discord,
  Mattermost, Microsoft Teams, QQ Bot, IRC, Signal, iMessage, Tlon, Twitch,
  WhatsApp, Feishu, Matrix, and Zalo Personal use the default `manual` receive
  policy. Their current inbound paths either have no platform acknowledgement to
  defer, acknowledge HTTP/webhook/socket delivery before asynchronous
  processing, or require a protocol interaction response that is not equivalent
  to durable receive acknowledgement.

Compatibility status:

- Old public reply/turn entry points stay as deprecated compatibility wrappers
  for tracked third-party callers and direct-DM helpers. The refactor is
  complete for bundled and gateway runtime paths once the broad gates pass.
