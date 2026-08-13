# Implementation log: first usable gateway

## Completed

- Added the installable `dsh.bundle` manifest and Cordis patch.
- Added an iLink HTTP client for `getupdates` and `sendmessage` with protocol headers, normalized numeric/string message ids, context tokens, API error reporting, and stale-context retry.
- Added a lifecycle-owned gateway that routes one allowlisted chat to one Harness Agent, forwards durable completed responses, and supports `/new`, `/stop`, and `/status`.
- Added strict TypeScript compilation, focused protocol tests, a package artifact allowlist, and build-on-git-install support.

## Verification

- `npm run build`
- `npm test`
- `npm run typecheck`
- `npm pack --dry-run`

The package dry run contains only the license, README, patch, compiled JavaScript/type declarations/maps, and manifest. The initial sandboxed package check could not write npm's home-directory cache (`EROFS`); rerunning with cache access succeeded. This was an environment restriction, not an implementation failure.

## Remaining work

- Exercise a real account against iLink and capture any protocol drift.
- Add QR-code login and a mode that stores credentials with user-only filesystem permissions.
- Persist chat-to-session and context-token state across restarts.
- Add a bounded outbound retry queue and approval/user-question interaction over Weixin.
- Add media upload/download after defining size, MIME, and workspace safety policies.
