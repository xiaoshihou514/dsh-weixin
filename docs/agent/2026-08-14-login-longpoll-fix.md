# Login fix: status long-poll timeout and binding takeover

## Root cause of "登录不上去"

The iLink server long-polls `GET /ilink/bot/get_qrcode_status`. For an
unscanned QR it holds the connection for about 30 seconds before answering
`{"ret":0,"status":"wait"}` (measured: 30.6s). The login helper applied a
30-second `AbortSignal.timeout` to every request, so every status poll was
aborted by our own deadline right as the server was about to answer. The CLI
flow then crashed on the AbortError, and the Web flows kept reporting
"暂时无法连接" forever — a successful scan could never be observed.

## Fixes

- `src/login.ts`: `get_qrcode_status` now uses a 45-second request timeout
  (longer than the server hold), and a client-side timeout or transient
  network error is treated as "still waiting" so the caller keeps polling —
  the same resilience as the Reasonix adapter (continue on poll error) and the
  official `@tencent-weixin/openclaw-weixin` plugin (return `wait` on timeout).
  A caller-provided abort still propagates.
- All login requests advertise the same `2.2.0` channel-generation headers as
  the polling protocol in `src/protocol.ts`, instead of a different version.

## Taking over an existing Reasonix binding

A Weixin account that already scanned into another bot (e.g. Reasonix) must be
transferable to this plugin through a normal QR login; the plugin must never
start polling with a saved foreign token on its own.

- `startLogin` POSTs `get_bot_qrcode` with `local_token_list` containing every
  bot token this machine owns (`collectLocalBotTokens()`: dsh-weixin's own
  credential plus saved Reasonix accounts). The server uses that list to
  attribute the scanned binding to this client.
- When the server answers `binded_redirect`, the scanned account is already
  bound to a token this machine declared. The login flow adopts that
  credential (`adoptBoundCredential()`), persists it as the plugin's own
  credential, and connects — the previous owner (Reasonix) no longer owns the
  binding. This is the same model as the official OpenClaw plugin, which treats
  `binded_redirect` as a successful re-login of the same instance.
- If the server instead issues a fresh binding (`confirmed`), the new token is
  saved and the old binding is replaced.

## Verification

- `npm run typecheck` passes.
- `npm test` passes 37 tests, including long-poll timeout tolerance, caller
  abort propagation, `local_token_list` reporting of saved Reasonix tokens,
  `binded_redirect` takeover, and a plugin-level test proving a saved Reasonix
  account alone never starts the gateway.
- Live smoke test: `startLoginSession` fetches a QR (POST, 2.2.0) and the
  first `pollLoginSession` completes after ~30.6s with `waiting` instead of
  being aborted.
