# Deferred work

Findings from the pre-merge review of the `/computer` and `/repo` plugins that were
deliberately **not** fixed in that pass. Each says what it is, where it is, and what
was eventually decided — enough to pick up cold.

**R1–R7 are now closed.** Two came out inverted from how they were written, and both
say so under their own heading rather than quietly: R3's symlink guard was deleted
instead of extended, and R6's fold was reversed into a split. P0, P0a, P0b and S1 are
records rather than tasks and are unchanged.

What was fixed in the original pass, for context. The security pass: the shell
wrapper split (`withShell` / `withShellTranscript`), `owner`/`repo` sanitisation in
`parseRepo`, symlink resolution ahead of the `.git` guard (since deleted — R3),
folding the isolated git dir into the command that uses it, and the
`ComputerConfig.env` / egress documentation. The
correctness pass that followed closed **C2–C7**: `/repo` now catches at the seam
where `exec` is run rather than letting a replaced container leave as a tool error,
`repo_clone` refuses a URL that names no repository, a push whose upstream config
fails says so, `sb_write` counts characters, the env thunk is read once per command,
and `computerExec`'s deliberate omission of `ComputerConfig.env` is written down.

---

## P0 — Worker-side git: what the spike measured

Answered, so nobody re-asks. Context: the credentialed half of `/repo` is moving out
of the container onto `@cloudflare/computer/git` (isomorphic-git, Worker-side, over the
workspace VFS), which deletes the clean room. These were the four things that could
have stopped it.

**1. `@platformatic/vfs` loads under workerd.** It is the optional peer the git
adapter needs, it is CommonJS, and it statically `require`s `node:sqlite` — which
`nodejs_compat` does not provide. It imports anyway; nothing touches the sqlite
provider on our path. Added to `looping-starter`'s dependencies.

**2. Git works over a DO-SQLite-backed provider.** `init` / `add` / `commit` / `log`
against a `Workspace` built on `ctx.storage`, in the vitest pool. Note `add` takes
`paths: string[]`, not isomorphic-git's `filepath`.

**3. Clone from workerd is cheap — this was the risk that did not materialise.**
`depth:1, singleBranch:true, noTags:true`, wall-clock in the pool:

| repo                     | files | time    |
| ------------------------ | ----- | ------- |
| `octocat/Hello-World`    | 1     | 790 ms  |
| `honojs/hono`            | 485   | 1115 ms |
| `cloudflare/workers-sdk` | 5456  | 5553 ms |

A 5,456-file monorepo in 5.5 s wall-clock, most of it network. The fear was that
SHA-1 and inflate in JS would blow the 30 s CPU limit; it is not close. Raising
`limits.cpu_ms` is still worth doing as headroom, not as a fix.

**4. "Does a Worker-side write reach the container?" was never open.** `sb_write` and
`sb_edit` already write through `ws.fs.writeFile` on the Worker side, and the
container reads those edits when it runs the build. That is the coder's entire
editing loop, in production, today. A Worker-side clone writes through the same
door.

---

## P0a — `verify-isolation.mjs` was not measuring dynamic imports

Found while sizing the change above, and **independent of it** — this was already
true.

`scripts/verify-isolation.mjs` built with `splitting` off, so esbuild parsed every
module reached through a dynamic `import()` (they appear in `metafile.inputs`, so the
_isolation_ half of the check was always correct) and then dropped them from the
output it weighed. Anything lazy-loaded was invisible to the ceiling.

The scale of the miss: wiring `@cloudflare/computer/git` into the coder moved the real
`wrangler deploy` bundle from 4250 KiB to 5052 KiB, and the script reported no change
at all.

Fixed by turning `splitting` on **and** building one entry point at a time — splitting
across all three at once would also hoist shared code into one chunk, counting it once
instead of once per entry, which would silently redefine every ceiling in the file.

Honest numbers, and what they revealed:

| agent      | as measured before | measured honestly           | after the git client |
| ---------- | ------------------ | --------------------------- | -------------------- |
| reactive   | 3373               | **3687** (ceiling was 3613) | 3687                 |
| proactive  | 1558               | 1605                        | 1605                 |
| arc-player | 2867               | 2974                        | 2974                 |
| coder      | 4016               | **4310** (ceiling was 4199) | **4918**             |

Two agents were already over their ceilings and the build was green. Both ceilings
re-baselined at the file's usual ~8% headroom, with the coder's split in its comment
between the +111 KiB it already carried and the +608 KiB the git client adds.

---

## P0b — two things found while doing the above

**`npm run link:local` is broken in `looping-starter`, and was before any of
this.** `package.json` asks for `@loopingai/plugins@^0.4.0`, `package-lock.json`
still pins the published `0.3.0`, and `0.4.0` is not on the registry — so the
`npm install` of the packed tarballs cannot resolve a tree and exits 1. Verified
by stashing every local change and running it clean. Nothing here depends on it
(the built `dist/` was rsynced into `node_modules` instead), but the next person
to run it will lose time.

**The first credentialed git call in a fresh isolate costs ~4.7 s.**
`@cloudflare/computer/git` pulls isomorphic-git and the `@platformatic/vfs`
adapter through dynamic `import()`, so the first operation pays for both; every
one after it is ~6 ms. Harmless against a clone, and invisible except that it
made two tests pass alone and time out at the default 5 s when the suite ran
together. Pinned with an explicit timeout and a comment in
`looping-starter/test/coder-git.spec.ts` rather than hidden by raising the global
one.

---

## S1 — no repository scope, only host scope

**Decided against for now, not overlooked.**

`allowedHosts` bounds which _host_ a clone or push may target, which is what stops
the forge token being offered to an attacker's server. Nothing bounds which
_repository_ inside that host: `repo_clone` clones anything the token can read,
`repo_open_pr` opens a pull request on anything it can write, and `repo_push` pushes
to whatever `origin` the checkout names — a checkout whose `dir` the model chooses
and whose remote a co-installed shell tool can set, since `origin()` re-checks only
the host.

The reason not to fix it in the plugin: bounding repositories is a property of how
the operator scoped `GITHUB_TOKEN`, not a decision this layer should make. Filing a
pull request against a dependency, or pushing to a personal repository, are ordinary
things to want and a dev-level allowlist would block them.

The consequence is documented in `src/repo/README.md` — the token should be
fine-grained, because nothing below it narrows its reach. If this is revisited, the
shape is an optional `allowedRepos?: string[]` on `RepoConfig` (exact `owner/repo`
or `owner/*`), unrestricted by default, checked in `repo_clone`, `repo_push` against
the resolved origin, and `repo_open_pr`.

Cheaper now than when this was written. The credential is produced in exactly one
place — the `onAuth` callback in `CoderWorkspaceDO`, which already refuses a host
it does not recognise — so a repository check has somewhere obvious to live. The
better fix is still upstream of this plugin: a GitHub App minting installation
tokens scoped to one repository with a 1 h TTL, handed to that same callback.

The three tools added since (`repo_issue_view`, `repo_pr_view`,
`repo_pr_comment`) deliberately do **not** widen this: they resolve `owner/repo`
from the checkout's own origin rather than taking a URL, so they reach nothing
`repo_push` could not already reach.

---

## R1 — split `src/computer/index.ts` — **done**

1,904 lines became five files under `src/computer/`, so `verify-exports.mjs`
check #6 is still satisfied and the subpath's public surface is unchanged —
`index.ts` re-exports what it used to declare, the way it already re-exports
`./install.js`.

| file        | what is in it                                                                       |
| ----------- | ----------------------------------------------------------------------------------- |
| `paths.ts`  | the two lists, their two notes, `guardPath`                                         |
| `render.ts` | `truncateOutput`, `packBlocks`, `renderGrepMatches`, `renderResult`, the humanisers |
| `read.ts`   | `readBounded`, `readWindow`, `pathExists`, `collectVisible`, `listingNote`          |
| `gate.ts`   | `needsDependencies`, `installGate`, `execLostNote`                                  |
| `index.ts`  | config, the shell wrappers, `buildComputerTools`, `computerExec`, `computer`        |

One deviation from the plan above: `listingNote` went to `read.ts`, not
`render.ts`. It consumes `VisiblePage`, which belongs with `collectVisible`, and
filing it under rendering would have bought a `render → read` type import for
nothing.

**Specs: only the describes that need no workspace stub moved** — 8 of 21, into
`render.spec.ts` and `gate.spec.ts`, plus a new `paths.spec.ts` that drives
`guardPath` directly now that it is a pure function. `index.spec.ts` keeps every
tool test, including the `.git` refusals: those assert the _wiring_ — that each
tool calls the guard — which a unit test of the guard cannot replace. It ends at
1,261 lines rather than 1,743, and that is the honest ceiling on this split.

The coder bundle went 4945 → 4942 KiB against `verify:isolation`, measured by
building `HEAD` into a scratch tree and comparing. A split into more modules
should be size-neutral; this one is, and the 3 KiB is R3's deletion.

---

## R2 — split `src/repo/index.ts` — **done**

The `clean-room.ts` half was already gone by deletion (below, kept as a record).
The `url.ts` half is now done, and R6 sent a second file with it:

- `url.ts` — `repoLocation`, `parseRepo`, `isForgeName`, `UNSAFE_BRANCH`,
  `PROTECTED_BRANCHES`, and `DEFAULT_ALLOWED_HOSTS`, which moved here from the
  constants block because it is an input to `parseRepo` and "which hosts may be
  named" is the file's whole subject. `url.spec.ts` takes the `parseRepo` cases
  and adds exhaustive ones for the two branch guards.
- `checkout.ts` — `refreshCheckout`, `resolveDefaultBranch`, `GitRunners`. See R6.

`index.ts` is 1,451 lines from 1,683 and re-exports `parseRepo`, which a host
uses to derive a per-repository workspace name.

### The original R2, kept as a record

It asked for a `clean-room.ts` holding `CREDENTIAL_HELPER`, `credentialConfig`,
`cleanConfig`, `CREDENTIALED_ENV`, `CREATE_ROOM`, `ASSERT_ROOM`, the stage
markers, `fetchOrigin` and `pushBranch` — "the security core deserves a file
whose specs are only about it". All of it is gone: credentialed git does not run
in the container any more, so `fetchOrigin` and `pushBranch` are two lines each
over `RepoConfig.git` and the other seven symbols do not exist.

---

## R3 — one path guard for all six file tools — **done by deletion**

R3 asked for `sb_ls`, `sb_grep` and `sb_exists` to be moved onto `guardPath`, so
that a symlink into `.git` is refused everywhere rather than only on read, write
and edit. **The symlink half was deleted instead, and the remaining string checks
were then applied to all six.** The asymmetry is gone, and it cost no round trips
— it removed three.

**Why the symlink resolution went.** It is anti-evasion, and the evader it was
written against cannot exist here. Its comment named "a host that hands out the
file tools without a shell", but `buildComputerTools` returns all seven tools as
one `ToolSet` and core's granularity is the tool _family_ — `SANDBOX_FAMILY`,
filtered per family in `looping-core/src/contract/validation.ts` — not individual
tool names. Every agent holding `sb_read` holds `sb_exec`, which reads
`.git/config`, writes `.git/hooks/pre-commit` and runs `git remote set-url`
without needing a link at all.

**What was measured before deciding, so nobody re-derives it.** In
`@cloudflare/computer`'s VFS, `find()`'s `walk()` recurses only where
`child.type === "dir"` and `grep()`'s `filesUnder()` yields only
`type === "file"`; a symlink is its own node type with no dirents beneath it. So
a hostile repo shipping `link -> .git` puts **one** entry in a listing, never a
`.git` subtree — the pollution R3 implied was never reachable. The one case that
is: naming the link _as the root_, which `resolveInode` follows, so
`sb_ls("…/link", recursive)` walks inside `.git` and yields paths reading
`link/HEAD` that the string filter does not match. Disclosure, model-initiated,
and of files that hold no credential since git moved to the Worker. Declined,
not overlooked: it costs an `lstat` per call on the two busiest read tools.

**What survived, and is not the same thing.** `collectVisible`'s `.git` filter in
the recursive `sb_ls` and `sb_grep` arms is untouched. That is cost and noise, not
security: without it an unbounded grep of `/workspace` streams every loose object
through the isolate, and a recursive listing at a repo root returns a page of
`.git` and nothing else, because `.git` sorts first.

**When this comes back.** If an agent is ever given the file tools without
`sb_exec` — a reviewing parent, a shell-less reviewer — the hostile-repo symlink
is live again, and the write path is the half to restore: `.git/config` is an
input to the credentialed push (`repo_push` reads it through `git remote get-url
origin`), and a planted hook still runs under container-side `repo_commit`.
Resolve every ancestor, `lstat`ing the prefixes in parallel so the cost is one
round trip rather than one per segment.

Deleted with it: `linkTarget`, `normalizePath`, and the 200-line
`through a symlink` spec block.

---

## R4 — one error wrapper per plugin — **done**

`inWorkspace(gerund, subject, body)` inside `buildComputerTools` opens the
workspace and owns the catch; the six file tools lost their `try`/`catch` and
their `using ws` line. `sb_exec` keeps its bespoke catch, as R4 said it should —
it recognises `EEXEC_LOST`, logs, and carries the install warning through the
failure path.

`/repo` is unchanged and still is not the model for this: it catches where the
command is run, because every tool there already has a failure branch that says
what it was doing.

---

## R5 — extract `defaultBranch(dir)` in `/repo` — **done**

`resolveDefaultBranch(plain, dir)` in `checkout.ts`, called by `refreshCheckout`
and `repo_push`.

It returns `{ branch?, unreachable? }` rather than `string | undefined`, and that
is the half a plain extraction would have lost. `repo_push` stands its
default-branch and empty-branch guards down on a _failed_ read — "this repository
has no `origin/HEAD`, so there is nothing to protect" — which is a fair reading of
an answer and a terrible reading of silence. `refreshCheckout` could not tell the
two apart before, because `GitRunners.plain` was typed more narrowly than the
function passed to it; it now says "could not read the default branch" and names
the container failure.

---

## R6 — fold `refreshCheckout` into `buildRepoTools` — **reversed**

Not done, and deliberately the opposite: it moved _out_ of `index.ts` into
`checkout.ts`, and gained `checkout.spec.ts`.

R6's argument was that the seam buys nothing — one caller, no direct unit test.
The second half is a reason to write the test, not to delete the seam that
permits one, and the first ignores where it would land: `buildRepoTools` is
~1,000 lines, so folding would have made the largest function in the package
longer while R1 and R2 were breaking two files up for exactly the opposite
reason. `GitRunners` is two members now, not the six R6 remembers.

Its own file also keeps it off the public API. `index.ts` _is_ the subpath entry,
so exporting `refreshCheckout` there to make it testable would have widened what
the package promises.

`checkout.spec.ts` covers what only a direct test can reach: a dirty tree refused
without `fetch` or `reset` running, a `status` that failed treated as no answer
rather than a clean tree, a directory holding another repository, and an
unreachable container told apart from a repository with no default branch.

---

## R7 — the enforced `truncateOutput` duplication — **pinned, not removed**

`verify-exports.mjs` is untouched. Widening check #6 with a second permitted root
would weaken the promise the package is built on to save fifteen
honestly-commented lines, and the rule is right about its target.

What the rule cannot do is keep the two copies honest, so
`test/truncate-parity.spec.ts` does: it imports both and asserts they answer
identically, including on the `half < 1` edge that was a real defect in one of
them. It lives under `test/` because it belongs to neither plugin and because
that directory is excluded from `tsconfig.build.json` — a spec reaching across
two plugins is safe precisely because it can never ship. Verified to fail by
rewording one copy's marker.
