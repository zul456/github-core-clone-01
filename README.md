# github-core-clone-01 — a GitHub-compatible git forge

[![make.fun bounty](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![make.fun rank](https://make.fun/badge/github-core-clone-01/zul456/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![make.fun reward](https://make.fun/badge/github-core-clone-01/zul456/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01)

A standalone, GitHub-compatible git forge in a single process. No outside
service, no proxy, no git binary: git object storage, packfiles, and the
smart-HTTP protocols are implemented from scratch in TypeScript (Node 22,
stdlib only).

## Surfaces

- **Git smart HTTP** at `/{owner}/{repo}.git` — upload-pack protocol v2
  (incl. `ls-refs`), receive-pack v0 with `report-status` / `side-band-64k` /
  `delete-refs`, fast-forward enforcement per ref.
- **REST v3** under `/api/v3` — repositories, branches, commits, refs,
  contents, labels, issues, pull requests (incl. squash merge onto the
  default branch).
- **GraphQL v4** at `/api/graphql` — the documents `gh` and
  `github-mcp-server` send, incl. introspection, connections with cursors,
  and batched operation bodies.
- **MCP** at `/mcp` — JSON-RPC 2.0 over Streamable HTTP, `server/discover`
  era (2026-07-28) with the legacy `initialize` fallback; tools
  `create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request`, `merge_pull_request`, all on the same store as REST.

## Run

```sh
node --experimental-strip-types main.ts
```

Requires Node >= 22.18. The entry binds an ephemeral port, registers it with
`$MAKEFUN_ENV_URL`, then polls `/done` until the trial ends and exits 0.

## Determinism

Nothing observable derives from the wall clock or unseeded randomness.
Commit timestamps and created/updated dates come from `MAKEFUN_TRIAL_NOW`
plus a deterministic counter; request ids come from a counter; ids are
sequential. Two runs over the same request sequence leave byte-identical
state.
