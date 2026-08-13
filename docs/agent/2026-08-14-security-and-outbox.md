# Authorization, wire limits, and the outbound queue

## Authorization

An allowed group id no longer authorizes every member of that group. Group traffic must match both `allowedGroups` and `allowedUsers`; direct messages must match `allowedUsers`. The gateway still ignores denied traffic without replying.

## iLink wire handling

The client accepts the two text update forms observed in existing iLink integrations: top-level `msgs` and legacy `updates`. Remote API bases must use HTTPS. Plain HTTP is accepted only for loopback test servers. Requests have a 90-second deadline, redirects are rejected, response bodies are capped at 2 MiB, and HTTP error excerpts are capped at 500 characters.

## Outbound recovery

Completed answers are split and written to the private gateway state before the first send. The outbox records the next chunk after each accepted request and is drained before polling resumes after a restart. This provides at-least-once delivery: a crash after Weixin accepts a chunk but before the local state write may duplicate that chunk, but it will not silently lose the remaining answer.
