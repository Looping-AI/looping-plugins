# `@loopingai/plugins/workspace`

A durable file store for long subagent runs, and the model-facing tools over it.

```ts
import { workspace } from "@loopingai/plugins/workspace";

workspace();
```

Two independent halves:

- **`workspaceBacking`** gives every subagent execution a real file store, backed by the
  executing facet's own SQLite. Applies whether or not a recipe asks for tools.
- **the `workspace` tool family** (`ws_read` / `ws_write` / `ws_list`) puts that store in
  front of the _model_, for a recipe that names `workspace` in its `toolFamilies`.

Core already owns the `WorkspaceHandle` interface, the per-file and file-count caps, and
`makeWorkspaceHandle` which enforces them. What it deliberately does not own is a backend:
the only good one is `@cloudflare/shell`, which is experimental, and an agent that never
delegates file work should not carry it. So it ships here as an **optional peer** — and this
is its only import surface in the package.

Install it alongside:

```bash
npm install @cloudflare/shell
```

An agent that installs no workspace plugin still starts; core falls back to
`memoryWorkspaceBacking`.

## wrangler.jsonc

Nothing. Shell backs the workspace with the Durable Object's own SQLite, which every DO
already has — so unlike every other plugin here, there is no binding to declare.
