# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Arg-z/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Arg-z/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

Standalone Node.js 22 GitHub-compatible git forge built with the standard library only. Serves git smart HTTP (`upload-pack` protocol v2/v0, `receive-pack` v0 with `report-status` and `side-band-64k`), GitHub REST v3 under `/api/v3`, GraphQL v4 at `/api/graphql`, and MCP JSON-RPC 2.0 at `/mcp` over an in-memory object, ref, issue, and pull-request store with deterministic timestamps and 3-way merge.

## Run it

```sh
node --experimental-strip-types main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=izcariot&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
