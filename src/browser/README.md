# `@loopingai/plugins/browser`

Read the web, via Cloudflare Browser Rendering Quick Actions.

```ts
import { browser } from "@loopingai/plugins/browser";

browser({ binding: env.BROWSER });
```

Four tools — `browser_markdown`, `browser_extract`, `browser_links`,
`browser_scrape` — offered to the **main agent** and available to a subagent recipe as the
`browser` tool family. Both, because both want them: a main agent reads a page to answer
directly, a delegated research subtask reads a dozen.

## Config

| Field      | Default            |                                                                                                                                                   |
| ---------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `binding`  | —                  | The `BROWSER` binding. **Paid plan.**                                                                                                             |
| `maxChars` | `20000`            | Per-result ceiling. Lower than the SDK's 50,000: a page that fills a small model's context costs it the conversation it was reading the page for. |
| `actions`  | text-returning set | `content` (raw HTML) stays opt-in — large, and rarely what a model wants.                                                                         |
| `options`  | —                  | Cookies, auth headers, viewport. Host-supplied; never exposed to the model.                                                                       |

## wrangler.jsonc

```jsonc
{
  "browser": { "binding": "BROWSER" }
}
```

`wrangler dev` needs `"remote": true` to reach it.
