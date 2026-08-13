<p align="center"><img src="assets/logo.svg" width="160" alt="dsh-weixin logo"></p>
<h1 align="center">dsh-weixin</h1>
<p align="center"><strong>DeepSeek Harness: Weixin</strong></p>

在微信中使用[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。

> **Pre-alpha.** Clock ticking. Stay tuned.

## Current capabilities

- One isolated dsh agent session per allowed Weixin conversation
- Text prompts and completed assistant responses
- `/new`, `/stop`, and `/status` gateway commands
- Direct-message and group allowlists (deny by default)
- Weixin `context_token` handling and duplicate message suppression

## Install from this checkout

The plugin is a DeepSeek Harness bundle. Build it, then add it to the profile you want to control:

```sh
npm install
npm run build
dsh plugin --profile web add /absolute/path/to/dsh-weixin
```

Configure credentials and access before starting dsh:

```sh
export WEIXIN_BOT_TOKEN='your iLink bot token'
export WEIXIN_BOT_ACCOUNT_ID='your iLink bot id'
export WEIXIN_ALLOWED_USERS='wxid_alice,wxid_bob'
# Optional: comma-separated room ids. Groups remain disabled when omitted.
export WEIXIN_ALLOWED_GROUPS='room-id-1'
export WEIXIN_DSH_WORKSPACE='/absolute/path/to/project'

dsh --profile web
```

`WEIXIN_BOT_API_BASE` optionally overrides the default `https://ilinkai.weixin.qq.com` endpoint. Never put the bot token in `cordis.patch.yml` or commit it to the repository.

[MIT](LICENSE)
