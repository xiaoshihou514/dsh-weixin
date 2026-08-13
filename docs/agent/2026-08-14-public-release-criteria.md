# Public release criteria

Version 0.1.0 is ready for public use when every item below has reproducible evidence.

## Installation

- `npm ci`, build, tests, and type checking pass from a clean checkout.
- `npm pack` contains the bundle patch, compiled entry points, CLI, types, license, and README.
- The tarball installs through `dsh plugin --profile web add` into a fresh profile.
- `dsh --profile web --dump-config` includes the `weixin` row from the installed bundle.
- The installed CLI runs through the profile's generated executable shim.

## Runtime

- QR login follows regional redirects and stores credentials without printing the token.
- A Cordis lifecycle test starts polling and proves disposal stops it.
- Both observed iLink text update formats are covered.
- Direct and group authorization defaults deny access. A group requires both an allowed room and an allowed sender.
- Poll cursors, context tokens, duplicate ids, chat mappings, and pending replies survive restart.
- Sessions flush before replies are delivered. Send failures retry without advancing the delivered sequence.
- Requests use TLS for remote endpoints, reject redirects, time out, and cap response size.

## Operations

- The README documents setup, commands, configuration, authorization, delivery semantics, and the single-process state restriction.
- Security reporting and contribution instructions are present.
- CI runs the clean-install verification commands on pushes and pull requests.
- The production dependency audit has no known vulnerabilities at release preparation time.

## Evidence on 2026-08-14

The local suite passes 16 tests across protocol, QR login, storage, authorization, text splitting, Harness adapters, and assembled Cordis lifecycle behavior. `npm audit --omit=dev` reports zero vulnerabilities. A packed `dsh-weixin@0.1.0` tarball installed into a new temporary Web profile with no peer warnings, appeared in `--dump-config`, imported successfully, and exposed a working `dsh-weixin --help` shim. A live request to the public iLink QR-start endpoint returned the expected `qrcode`, `qrcode_img_content`, and `ret` fields; no login was completed and no credential was created.
