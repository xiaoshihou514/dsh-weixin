# Initial design: Weixin remote control

## Context

DeepSeek Harness is a Cordis plugin tree. Out-of-tree extensions are distributed as bundles whose patch inserts plugin rows into a profile. The public `agents` service creates and drives agents, while `session/event` exposes durable output. This makes an in-process gateway preferable to modifying the agent loop or supervising a second CLI process.

Reasonix's Weixin adapter demonstrates the iLink API details: bearer token authentication, `getupdates` long polling, `sendmessage`, per-conversation `context_token`, and the `2.2.0` channel metadata. Its broader bot runtime also demonstrates allowlists and per-chat session routing.

## Decisions

- Ship one npm bundle containing a Cordis plugin and `cordis.patch.yml`.
- Consume only public Harness services: `agents`, `agentDefaultModel`, and `sessions`.
- Keep one live Harness agent per Weixin chat. Ordinary messages become agent follow-ups; `/new`, `/stop`, and `/status` remain gateway commands and do not enter model context.
- Forward the last durable `assistant/message` after `turn/end`. Durable events are the authority, avoiding partial stream fragments and ensuring tools finish before the response is sent.
- Deny all inbound traffic unless a user or group identifier is explicitly allowlisted. Tokens are read from a named environment variable and are never accepted in bundle configuration.
- Abort long polling and dispose owned agent handles when the plugin unloads.
- Start with text messages. QR login, media, persisted chat/session mappings, and interactive tool approvals are follow-up capabilities.

## Known risks and follow-ups

- iLink is new and its public stability guarantees are unclear. Protocol code is isolated in `src/protocol.ts` so API changes do not affect Harness orchestration.
- Context tokens and chat mappings currently live in memory. A restart creates new sessions; persistence must use an atomic local store or a Harness-owned persistence extension.
- Sending failures from the session event listener need an observable retry queue; the initial implementation reports polling failures but does not yet retain outbound messages.
- The gateway currently uses the profile's default model and host-level tool composition. Preset selection should become explicit before supporting multiple remote personas.
