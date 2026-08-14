# Weixin identity and default agent composition

The earlier session naming change conflated two identities. Harness sessions created for this transport are titled `微信`; `DeepSeek` belongs to the Weixin protocol client identity.

Tencent's current iLink client sends the upstream application identity in `base_info.bot_agent` on every authenticated API request. The public protocol does not expose a separate profile-name mutation endpoint. This plugin therefore sends `DeepSeek` as `bot_agent` consistently across polling, replies, typing, and media requests. It does not claim to edit the user's Weixin profile.

Harness keeps model-facing tools in agent preset scope rather than the global tool registry. Creating or resuming a session without joining a preset consequently produces a valid agent with an empty tool catalog. The gateway now mounts `ctx.agentPresets` without an explicit id during agent setup, selecting the deployment's configured default (the shipped Web profile uses `standard`). Before forwarding a message, it selects the `workspace-write` permission preset. If the selected agent preset provides the optional scoped `planMode` service, the gateway switches it off; presets such as `minimal` omit that service entirely and are already default-mode-only, so absence is a no-op rather than a configuration error.

The workspace remains the configured home-directory default. Existing durable sessions retain their original workspace and composition; `/new` creates a replacement using the current defaults.
