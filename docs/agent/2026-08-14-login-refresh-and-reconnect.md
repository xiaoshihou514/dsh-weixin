# Login refresh and reconnect

The embedded login page previously stopped polling when iLink returned `expired` and required a manual page refresh. Status polling also used `setInterval` around an iLink long poll, creating overlapping browser requests even though the server serialized them. The page now polls immediately and schedules the next request only after the previous one finishes. On expiry, the server obtains a replacement QR session and asks the browser to reload the newly rendered code automatically.

A completed login writes a new credential. The original callback called an idempotent gateway starter, which deliberately returned when a gateway already existed; reconnecting could therefore report success while the running gateway retained the previous credential. The login callback now disposes the old gateway and starts a new instance from the credential just written. Initial boot still uses the idempotent starter directly.
