# External bundle runtime imports

## Install-test finding

The first release candidate declared Harness packages as peers and imported three of them at runtime. A profile knows how to resolve the plugin entry itself, but Node resolves that entry's imports from the plugin package tree. Harness-owned peer packages are not installed there. Marking the peers optional removed installation warnings but made a plain import fail.

## Decision

Harness package imports are now type-only. The plugin keeps local implementations for three small public-contract adapters:

- brand a string as `SessionId`;
- create an immutable identified user text message;
- register the two scoped model-selection listeners used by direct Agent drivers.

The local model-selection adapter follows the current Harness helper behavior and is covered by type checking against the public event and message contracts. This avoids installing a second copy of Harness or Cordis while keeping compile-time compatibility checks.

`@deepseek-ai/schemastery` remains a normal runtime dependency because the exported Cordis `Config` value uses it directly.
