<p align="center"><img src="assets/logo.svg" width="160" alt="dsh-weixin logo"></p>
<h1 align="center">dsh-weixin</h1>

Use [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) from Weixin. Each allowed conversation gets its own Harness session and working directory.

dsh-weixin currently supports text messages. It keeps chat mappings across restarts, retries interrupted replies, and has commands for starting, stopping, and checking a session.

## Requirements

- Node.js 22.19 or later
- DeepSeek Harness 0.1.0-rc.5 or later
- A Weixin account that can complete the iLink bot QR flow

## Install

Clone this repository and install it into the Harness profile you use:

```sh
git clone https://github.com/xiaoshihou514/dsh-weixin.git
cd dsh-weixin
npm install
npm run build
dsh plugin --profile web add "$PWD"
```

Run the login command from the profile directory or this checkout:

```sh
npx dsh-weixin login
```

The command prints a QR link. Open or scan it with Weixin and confirm the login. Credentials are saved to `$DSH_HOME/weixin/account.json`; the bot token is not printed. On POSIX systems, dsh-weixin rejects credential and state files that are readable by other users.

## Configure access

Set at least one allowed Weixin user before starting Harness:

```sh
export WEIXIN_ALLOWED_USERS='wxid_alice,wxid_bob'
export WEIXIN_DSH_WORKSPACE='/absolute/path/to/project'
dsh --profile web
```

Direct messages are checked against `WEIXIN_ALLOWED_USERS`. Group messages require both an allowed sender and an allowed room:

```sh
export WEIXIN_ALLOWED_GROUPS='room-id-1,room-id-2'
```

Denied messages receive no reply. Treat every allowed user as someone who can operate dsh in the configured workspace.

## Commands

Send these as standalone Weixin messages:

- `/status` reports whether the conversation has an idle or running session.
- `/stop` cancels the active turn and clears queued work.
- `/new` closes the current live session. The next message starts a new one.

Other text becomes a normal Harness follow-up. Replies are sent after the turn ends. Long replies are split into 3,500-character chunks.

## Configuration

The bundled patch reads these environment variables:

| Variable | Purpose | Default |
| --- | --- | --- |
| `WEIXIN_ALLOWED_USERS` | Comma-separated sender ids | Required |
| `WEIXIN_ALLOWED_GROUPS` | Comma-separated room ids | No groups |
| `WEIXIN_DSH_WORKSPACE` | Agent working directory | Current directory |
| `WEIXIN_BOT_TOKEN` | Token supplied by a secret manager; takes precedence over the credential file | Saved credential |
| `WEIXIN_BOT_ACCOUNT_ID` | Override the saved bot account id | Saved credential |
| `WEIXIN_BOT_API_BASE` | Override the saved iLink API endpoint | Saved endpoint or `https://ilinkai.weixin.qq.com` |
| `WEIXIN_CREDENTIAL_PATH` | Credential file | `$DSH_HOME/weixin/account.json` |
| `WEIXIN_STATE_PATH` | Routing, cursor, duplicate-id, and outbox state | `$DSH_HOME/weixin/gateway-state.json` |

To set `retryDelayMs`, `emptyPollDelayMs`, or `maxMessageChars`, replace the complete `weixin` row in your profile's `cordis.patch.yml`. Harness patch rows replace their whole config instead of merging individual fields.

## Delivery behavior

The gateway writes completed replies to a private local outbox before sending them. It resumes that outbox after a restart. Delivery is at least once: a process crash immediately after Weixin accepts a chunk can cause that chunk to be sent again.

Run one dsh-weixin process for each Weixin account and state file. Sharing a state file between processes is unsupported.

## Development

```sh
npm test
npm run typecheck
npm run build
npm pack --dry-run
```

The tests cover both iLink response formats, QR login, private file handling, authorization, cursor recovery, stale context tokens, Unicode-safe splitting, and Cordis startup and shutdown.

Security reports should follow [SECURITY.md](SECURITY.md). Other changes are covered by [CONTRIBUTING.md](CONTRIBUTING.md).

[MIT](LICENSE)
