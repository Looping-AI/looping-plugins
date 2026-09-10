# AGENTS.md — working in `@dynamicagents/plugins`

`README.md` covers what a plugin is, which file you edit, how to write one and
how to test it. This file holds the conventions that are not about any one
plugin.

---

## Comments

This repo comments heavily, and that is deliberate: a lot of what is here was
expensive to learn and invisible in the code. The cost is that comments rot, so
they are held to the same bar as the code.

A comment states a **constraint, a measurement, or a coupling** — something that
changes a decision. Not what changed, not when, not what a previous version said;
`git log` owns that. In particular:

- **No changelog.** "This used to…", "removed in 0.8.2", "the design plan called
  for…", "this is not a reversal of…" are all history. Write the rule that
  survives it. A measurement is worth keeping; the date it was taken is not.
- **No package versions or dates** in prose. They are stale on the next bump and
  nothing checks them.
- **One home per fact.** Put the explanation in the file somebody edits when they
  change that behaviour, and a pointer everywhere else — comments here have
  `{@link file://../path/to.ts Name}` for exactly this. Four copies of the same
  paragraph in four files do not stay in step: they diverge, and then the reader
  cannot tell which one is current. This applies across the publish train too: a
  rule core enforces is explained in core, and pointed at from here.
- **No counts.** "the nine plugins", "the four families below", plugin counts,
  spec counts. Every one of these was wrong within a release. Name the thing, not
  how many there are.
- **Cross-file references name a real path**, and a path in a comment is
  checkable — so check it before you write it. Nothing in `check` verifies these
  for you here. A path into another repo of the train is not checkable from a
  consumer's checkout: name the module in prose instead of writing a path that
  resolves only in a full workspace.

If a comment is longer than the code it explains, ask what decision it is
protecting. Usually one paragraph of that is doing the work.

---

## Publishing

**Development lands on `next`; `main` is the released line.** A release is a merge
from `next` into `main` carrying a version bump, so a bump is a deliberate act at
release time rather than something that rides every merge.

A version bump reaching `main` is what ships it: on the first green Test run for
a commit carrying that version, `.github/workflows/release.yml` publishes it to
npm over OIDC and only then cuts the tag. The bump is the decision to ship. The workflow comments hold
the rest.

Core ships first. A version here whose peer range admits a core that is not yet
on the registry is one nobody can install.

**The core references say different things, and both are load-bearing.** The
`peerDependency` stays a semver range, because that is the only one a published
consumer installs against — a git ref there would name a moving branch in somebody
else's `node_modules`. The `devDependency` is what this repo builds and tests
against, so it is a git ref onto core's `next`, which is how a core change is
exercised here before it is released. It installs only because core's `prepare`
builds and because `allowScripts` in `package.json` lists core, which is what lets
npm run that `prepare` — drop either and every core subpath resolves to a missing
file. The workspace AGENTS.md has the why.

`verify:peer-ranges` still holds that range honest: it reads the **installed** copy,
and a git-installed core reports its real version. What it cannot see is that an
unreleased `next` still carries the last released version number, so during
development the installed core is that version plus whatever has landed since. That
is the cost of batching releases, and it is why the range is checked against the tree
rather than against the manifest.
