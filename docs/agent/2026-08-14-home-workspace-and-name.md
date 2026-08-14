# Home workspace and Weixin agent name

Weixin-created sessions now default to the operating-system home directory instead of the process launch directory. The bundle no longer reads `WEIXIN_DSH_WORKSPACE`, so ordinary installations consistently use `~` regardless of where Harness was started.

When a Weixin chat attaches to or creates a Harness session, the plugin uses the required `sessionTitle` service to pin its visible title to `DeepSeek`. Pinning prevents the automatic first-prompt title generator from replacing the name.

An existing persisted session keeps the working directory recorded when it was created. Sending `/new` once in that chat discards its mapping; the next message creates a session rooted at the home directory and titled `DeepSeek`.
