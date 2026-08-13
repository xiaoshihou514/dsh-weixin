# Contributing

Open an issue before starting a change that affects the iLink protocol, stored state, or Harness session behavior. Small fixes can go straight to a pull request.

Use Node.js 22.19 or later. Install dependencies and run the local checks:

```sh
npm install
npm test
npm run typecheck
npm run build
npm pack --dry-run
```

Tests must not call the live Weixin API. Use a local HTTP server or an injected `fetch` implementation, and never commit credentials or identifiers copied from a real account.

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/). Keep public documentation direct and specific. Explain protocol assumptions and design decisions in `docs/agent/` when they affect compatibility, security, or stored data.
