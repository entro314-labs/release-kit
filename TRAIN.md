# release-train

Orchestrated releases for a set of interdependent packages, in dependency order, using
release-kit as the per-package worker. One command releases a "train": every package that
changed, plus every package that depends on one that did, each with its own version bump,
changelog, tag, push, publish and GitHub release.

Ships in this package as `train.mjs` — a second self-contained, `node:*`-only file beside
`release.mjs`, installed as the `release-train` bin. Same design contract as release-kit:
readable, vendorable, zero dependencies.

**Status: prototype.** Discovery, graph derivation, registry-aware change detection,
cascade, planning, whole-train preflight, `seed-tags`, and the train summary work.
Execution (running release-kit per package) is not implemented yet — `train` without
`--dry-run` says so and exits.

```sh
release-train graph                  # print the derived dependency graph and topo order
release-train --dry-run              # full plan + whole-train preflight, execute nothing
release-train --dry-run --all       # plan every member, not just changed ones
release-train --dry-run <id>...     # plan these packages and their dependents
release-train seed-tags             # baseline tags at each HEAD (--dry-run to preview)
release-train --summary <path>      # write the train summary; --assistant drafts on top
release-train --offline             # no network: registry checks skipped, tags not pushed
release-train --config <path>       # config elsewhere than ./train.config.json
```

## Problem

A single package release is solved (release-kit). What is not solved is the shape where
package B depends on package A, so releasing A implies:

1. publish A first,
2. move B onto A's new version,
3. release B — and repeat transitively for anything that depends on B.

Doing this by hand means remembering the order, editing dependency ranges, and hoping the
registry has A before B publishes. Existing tools (changesets, Lerna, Nx Release) solve it
only for a single git repository. Nothing mainstream solves it for a workspace of sibling
git repositories, which is the second topology this design covers.

## Relationship to release-kit

release-train is an **orchestrator, not a release tool**. It never bumps a version, writes
a changelog, tags, pushes or publishes itself — it decides _which_ packages release, _in
what order_, rewrites internal dependency ranges, and then runs release-kit once per
package with the right working directory. Everything release-kit already guarantees
(accumulate-then-abort preflight, idempotent steps, notes resolution, per-ecosystem
publish) is inherited per package, unchanged.

This split is deliberate:

- release-kit keeps its hard refusal to release a nested package when invoked directly —
  the refusal exists because it once silently released the parent. The orchestrator is the
  one caller that knows which nested directory it means, and says so explicitly.
- Each package keeps its own `release.config.json`. The orchestrator does not know what
  npm, cargo or uv are; the package's own config does.
- The orchestrator stays small enough to hold to the same standard as release-kit: one
  readable file, `node:*` imports only.

## Principles

1. **Derive, never declare.** Publish order is a projection of the dependency graph, and
   the graph already exists in the package manifests. A declared order duplicates that
   truth and drifts; a derived order cannot. The same goes for versions: the manifest is
   the truth, no config file stores a copy of it. (Validated empirically: the entrolytics
   ecosystem's `versions.json` stored versions and a declared-dependencies field — every
   sampled version had drifted from its manifest, and the dependencies field was never
   populated at all.)
2. **Config declares membership, nothing else that changes per release.** Which
   directories are part of the train is a fact discovery cannot always get right (stale
   folders, docs repos, private apps). Order, versions and the graph are always derived.
3. **Whole-train preflight before anything mutates.** There is no cross-package
   transaction on npm or across git repositories. The compensation is release-kit's
   accumulate-then-abort preflight, widened to every package in the plan: all failures
   from all packages are reported in one list, and nothing is touched until the list is
   empty.
4. **Idempotency is the resume mechanism.** Because dependencies publish before
   dependents, an interrupted train never leaves a published package depending on an
   unpublished version. Re-running the same command skips completed packages (release-kit
   already skips written versions, existing tags, published versions, existing releases)
   and continues from the first incomplete one. No state file, no `--resume`.
5. **Independent versions.** Each package bumps by its own history. Lockstep ("global
   version") is not offered: in practice it decays into drift the moment one package needs
   a patch the others do not (observed in the wild), and it forces empty releases.

## Topologies

Two topologies, one model.

**Single-repo workspace (monorepo).** One git repository, packages under globs
(`packages/*`, `src/app/*`), usually a pnpm/npm/bun workspace. One release commit for the
whole train, one tag per released package.

**Meta-workspace (multi-repo).** A plain folder — not itself a git repository — containing
sibling git repositories, each with its own remote, branch, history and (possibly) its own
nested packages. Each package releases as a full release-kit run in its owning repo: its
own commit, tag, push, publish, GitHub release.

**The unit model that covers both:** a _package_ (the publish unit, a directory with a
manifest) belongs to an _owning repo_ (the git unit, found by walking up to the nearest
`.git`). A repo may own many packages; in a monorepo, one repo owns all of them; in a
meta-workspace most repos own exactly one, but a nested monorepo inside a meta-workspace
is just a repo that owns several. Nothing in the pipeline branches on topology — only on
"which repo owns this package", which decides where the commit and tag land.

## Configuration

`train.config.json` at the workspace root. Membership and policy only — no versions, no
dependencies, no order.

```json
{
  "packages": [
    "packages/*",
    { "path": "sdks/react", "id": "react-sdk" },
    { "path": "apps/dashboard", "publish": false }
  ],
  "rangePolicy": "caret",
  "registryWait": { "timeout": 300, "interval": 5 }
}
```

| Key            | Default   | Meaning                                                                                       |
| -------------- | --------- | --------------------------------------------------------------------------------------------- |
| `packages`     | required  | Paths or globs. An entry is a string or `{ path, id?, publish? }`.                            |
| `rangePolicy`  | `"caret"` | How rewritten internal ranges are written: `caret`, `tilde`, `exact`, or `preserve`.          |
| `registryWait` | as shown  | How long to poll the registry for a just-published dependency before releasing its dependent. |

- `id` names the package in output and on the command line; defaults to the manifest name.
- `publish: false` keeps a package in the graph (its changes still cascade to dependents,
  its version still bumps) but skips registry publishing — for apps.
- In a workspace with `pnpm-workspace.yaml` / `workspaces` globs, `packages` may be
  omitted and is taken from there.
- Everything per-package — publish command, changelog path, version files, assistant —
  lives in that package's own `release.config.json`, exactly as standalone release-kit
  reads it. The orchestrator adds nothing to it and overrides nothing in it.
- Unknown keys abort, as in release-kit.

## Pipeline

```
discover → graph → detect changes → cascade → plan → preflight (whole train) → execute → report
```

**Discover.** Resolve `packages` globs to directories, read each manifest (name, version,
dependencies), find each package's owning repo. A membership entry whose path does not
exist is a preflight failure, not a silent skip.

**Graph.** An internal dependency is a manifest dependency (`dependencies`,
`peerDependencies`, `optionalDependencies`) whose name matches another member package.
`devDependencies` do not create publish-order edges — they never appear in the published
artifact — but a devDependency change still marks the dependent as changed. Cycles through
publish-order edges abort with the cycle printed; there is no order that releases a cycle.

**Detect changes.** Two sources, and the registry outranks the commits.

_The registry._ One lookup per npm package (`npm view <name> versions`, cached) classifies
the manifest version:

| State     | Meaning                                                                                                  | Consequence                                                                                                                                                       |
| --------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `current` | manifest version is the registry's latest                                                                | normal — bump from commits                                                                                                                                        |
| `pending` | manifest version is not published (a committed-but-unreleased bump, or a package never published at all) | released **as-is**: the pending version is the release, it joins the set even with zero new commits, and dependents' rewrites target it. Nothing is skipped over. |
| `behind`  | the registry has a newer version than the manifest                                                       | preflight **failure** — the tree is behind what shipped; sync it, never guess                                                                                     |
| `unknown` | lookup failed, or `--offline`                                                                            | warning — pending/collision checks not performed                                                                                                                  |

`pending` is common in the wild (both reference workspaces had them: versions bumped and
committed, publish never ran or failed) and is precisely the case a "bump then publish"
tool gets wrong by bumping past the version that never shipped.

_The commits._ Per package: full commit messages (subjects **and** bodies, so
`BREAKING CHANGE:` footers count) in the owning repo touching the package's path since the
package's last release tag. Tag scheme is `<name>@<version>` per package (the
changesets/release-please convention) when a repo owns more than one package, and plain
`v<version>` when it owns exactly one — which keeps single-package repos identical to
standalone release-kit. A package with no release tag yet is _cold_ (see Cold start).

**Cascade.** Any member that depends on a package in the release set joins the set with at
least a patch bump, transitively. This is what makes the new dependency version actually
reach consumers. Each package's own bump is derived by release-kit's `auto` from its
path-scoped commits; the cascade only raises "no release" to "patch", it never lowers.

**Plan.** Topological sort of the release set. The plan is printed before anything runs:
each package, its current → next version, its bump reason (commits, cascade, or explicit),
which internal ranges will be rewritten, and the order. `--dry-run` stops here — after
preflight, so the whole plan and every blocker are visible together, matching release-kit.

**Preflight (whole train).** For every package in the plan, before anything mutates
anywhere:

| Check                                                                                  | Scope       |
| -------------------------------------------------------------------------------------- | ----------- |
| Working tree clean                                                                     | per repo    |
| On the configured branch, not detached                                                 | per repo    |
| Remote reachable, branch not behind it                                                 | per repo    |
| Release tag free (or already at `HEAD`, reusable)                                      | per package |
| Planned version not already on the registry                                            | per package |
| Manifest not _behind_ the registry (a newer version was published than the tree knows) | per package |
| Publish CLI authenticated                                                              | per package |
| `gh` authenticated                                                                     | once        |
| Every internal range will, after rewriting, match the version being published          | per edge    |
| A `workspace:` range's target is a member of the train                                 | per edge    |
| Membership paths exist and carry a manifest                                            | per entry   |
| No publish-order cycles                                                                | once        |

One failure anywhere aborts the entire train before any package releases. This is the
whole safety story for the meta-workspace, where no transaction exists — so it is
deliberately strict: one dirty repo out of thirty blocks all thirty.

**Execute.** In topo order, per package:

1. Rewrite internal dependency ranges in this package's manifest to the versions its
   dependencies just released, per `rangePolicy`. Skipped entirely for `workspace:`
   ranges — the package manager rewrites those at publish time, which is the preferred
   setup inside a workspace.
2. Run release-kit in the package directory: bump, changelog, release commit (the range
   rewrite rides in it), tag, push, publish, GitHub release — whatever that package's
   `steps` say.
3. If any member still to come depends on this package: poll the registry
   (`npm view name@version` or the ecosystem equivalent) until the new version is
   visible or `registryWait.timeout` elapses. Registries have replication lag; a
   dependent that publishes or installs too early fails spuriously.

In a monorepo, step 2's commits per package would produce commit noise; there the
orchestrator batches: all version/changelog/range writes land in one release commit, then
tags, one push, then publishes in topo order with the same waits.

**Report.** What released at which version, what was skipped and why, and — on failure —
exactly which packages completed, so the resume story ("run it again") is verifiable.

## Failure and resume

| Died at                            | State                                     | Re-run does                                           |
| ---------------------------------- | ----------------------------------------- | ----------------------------------------------------- |
| Preflight                          | Nothing mutated anywhere                  | Everything, after you fix the reported list           |
| Mid-package (e.g. publish timeout) | That package partially released           | release-kit's own idempotency finishes it             |
| Between packages                   | Earlier packages fully released           | Skips them (tag exists, version published), continues |
| Registry wait timeout              | Dependency published, dependent untouched | Wait resumes; registry has had more time              |

The invariant throughout: at no point does a published package depend on an unpublished
version, because dependencies always complete first.

## Cold start

A package with no release tag cannot compute "commits since last tag". Options, chosen per
run, not configured:

- `train seed-tags` — create `<name>@<manifest version>` (or `v<version>`) at each repo's
  current `HEAD`, push tags, release nothing. The next train has a baseline. This is the
  right move for an existing ecosystem whose versions are already published.
- `--all` — treat every member as changed and release everything once.

Seeding refuses, per member and without touching it, when:

- the manifest version is not on the registry — tagging a commit as "released 2.4.2" when
  2.4.2 never shipped would make the baseline a lie. A pending version is _released_ by
  the train (as-is), then it has a real tag;
- the manifest is behind the registry — sync the tree first;
- the manifest file has uncommitted changes — the version on disk may not be the version
  at `HEAD`, so the tag would point at the wrong commit;
- there is no manifest version (go, tag-only projects) or the registry cannot be reached —
  nothing can vouch for the baseline; seed those by hand.

`seed-tags --dry-run` previews every action; `--offline` creates tags without pushing.

## Cross-ecosystem notes

The orchestrator's graph is built from npm-style manifests today. Non-npm members still
participate:

- **Rust**: `Cargo.toml` versions and `cargo publish`, both already handled per package.
  What the orchestrator would additionally need is the range rewrite: a crate depending on
  a sibling by `path` also carries a `version` for it, and crates.io rejects a publish
  whose path dependency has no version — so the dependent's manifest must move to the
  dependency's new number before it publishes. release-please's `cargo-toml.ts` is the
  worked reference: it rewrites `version` under `dependencies`, `dev-dependencies`,
  `build-dependencies` and every `target.<cfg>` table, skipping entries with no `path`
  (a real crates.io dependency, not a sibling) and no `version` (a path-only dependency,
  which needs nothing). Workspace inheritance moves the problem rather than removing it:
  `version.workspace = true` in a member points at `[workspace.package]`, which is one
  place to rewrite instead of many. Not built in `release.mjs`, where a single package has
  no internal ranges to rewrite and the code would have no caller.

- **Go**: no manifest version; the tag is the release. release-kit already handles it
  (`versionFile: null`). It has no npm-visible dependents, so no registry wait.
- **Python / PHP**: `pyproject.toml` / `composer.json` versions, publish via the package's
  own configured command; Packagist releases _are_ the pushed tag.
- Cross-ecosystem dependency edges (a Python package tracking an npm package's version)
  are out of scope for ordering; they version independently.

## CLI

Two commands and four flags; modes are commands, modifiers are flags.

```sh
train                    # plan + preflight + release everything that changed (or is pending)
train --dry-run          # plan + preflight, execute nothing
train react-sdk          # release this package and its dependents only
train --all              # every member, cold start or forced full train
train seed-tags          # establish baseline tags, release nothing (--dry-run to preview)
train graph              # print the derived graph and topo order
train --offline          # no network: registry checks skipped, tags not pushed
train --config <path>    # config file elsewhere than ./train.config.json
```

Flag rules, mirroring release-kit's posture:

- Unknown flags abort — a typo must never silently change behaviour.
- `--all` and explicit package ids conflict and abort; `graph` takes neither.
- `--dry-run` composes with everything: it is always "show me, touch nothing".
- `--offline` degrades honestly: the plan says which checks were skipped, and seed-tags
  skips npm members it cannot verify rather than guessing.
- Deliberately absent: a `--bump <type>` override (forcing one bump across packages is
  lockstep by the back door; release one package explicitly instead and let derivation do
  the rest) and a declared-order override (see Considered and declined). `--yes` arrives
  with execution, matching release-kit. A `--json` plan output for CI is the one addition
  under consideration — release-kit writes `$GITHUB_OUTPUT`, and the train's equivalent is
  a machine-readable plan.

## Considered and declined

| Idea                                        | Why not                                                                                                                                           |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Declared release order in config            | Duplicates the graph, drifts, cannot express independence or verify itself. The graph is already in the manifests.                                |
| Versions stored in a central file           | A copy of the manifest that goes stale. Observed failing in a real ecosystem within weeks. The manifest is the version.                           |
| Lockstep / global version                   | Decays into drift the first time one package needs a solo patch; forces empty releases of unchanged packages.                                     |
| Changeset intent files                      | A second workflow to learn and enforce. Conventional Commits already carry the intent, and release-kit's `auto` already reads them per path.      |
| Parallel publishing of independent packages | Real wall-clock win, real interleaved-output and rate-limit cost. Sequential is comprehensible; revisit only if train duration becomes a problem. |
| Baking orchestration into release.mjs       | Would grow the single file past readability and reopen the nested-package refusal for every standalone user. Two small files beat one large one.  |

## Open questions

- **Monorepo commit batching** — the batched single-commit path shares release-kit's steps
  but reorders when the commit happens; whether that is a release-kit flag
  (`--no-commit`, commit handled by caller) or orchestrator-side sequencing needs a
  decision before implementation.
- **GitHub releases in a multi-package repo** — `gh release create` per tag works; whether
  the nested-package changelog path (`packages/x/CHANGELOG.md`) needs anything from
  release-kit beyond cwd-relative resolution needs verification.
- **Partial trains and humans** — `train react-sdk` releases a package and its dependents,
  but _not_ its dependencies. If a dependency has unreleased changes, is that a warning or
  a refusal?
- **Private registries / scoped auth per package** — preflight currently assumes one
  registry identity per publish CLI; per-package `.npmrc` scoping needs a pass.
