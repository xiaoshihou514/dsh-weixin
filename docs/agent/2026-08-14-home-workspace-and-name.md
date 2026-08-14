# Home workspace and Weixin agent name

Weixin-created sessions now default to the operating-system home directory instead of the process launch directory. The bundle no longer reads `WEIXIN_DSH_WORKSPACE`, so ordinary installations consistently use `~` regardless of where Harness was started.

When a Weixin chat attaches to or creates a Harness session, the plugin uses the required `sessionTitle` service to pin its visible title. This note originally selected `DeepSeek`; the follow-up identity correction in `2026-08-14-weixin-identity-and-default-agent.md` changes the Harness title to `微信` and reserves `DeepSeek` for the Weixin protocol identity.

An existing persisted session keeps the working directory recorded when it was created. Sending `/new` once in that chat discards its mapping; the next message creates a session rooted at the home directory and titled `微信`.
