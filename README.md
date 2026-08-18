<div align="center">

# 🚀 release-kit

**Single-file, zero-dependency release automation for JS/TS/Node projects.**

`version bump` → `changelog` → `commit` → `annotated tag` → `push` → `publish` → `GitHub release`

[![npm](https://img.shields.io/npm/v/@entro314labs/release-kit?logo=npm&color=cb3837)](https://www.npmjs.com/package/@entro314labs/release-kit)
[![downloads](https://img.shields.io/npm/dm/@entro314labs/release-kit?color=cb3837)](https://www.npmjs.com/package/@entro314labs/release-kit)
[![unpacked size](https://img.shields.io/npm/unpacked-size/@entro314labs/release-kit?color=blueviolet)](https://www.npmjs.com/package/@entro314labs/release-kit?activeTab=code)
[![dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](#-requirements)
[![node](https://img.shields.io/badge/node-%E2%89%A5%2018-339933?logo=node.js&logoColor=white)](#-requirements)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

</div>

`release.mjs` imports nothing but `node:*`. No dependencies, no build step, no config
required — the file _is_ the tool. That is why it can be installed as a package, run
straight from the registry, or vendored into a project as a plain file, with no difference
in behaviour between them.

```console
$ pnpm release minor

acme-toolkit release
  2.4.0 → 2.5.0   tag v2.5.0   dist-tag latest

[1] Preflight
  ok   version 2.4.0 → 2.5.0
  ok   working tree clean
  ok   on main
  ok   remote origin
  ok   up to date with origin/main
  ok   tag v2.5.0 is free
  ok   gh authenticated (octocat)
  ok   npm authenticated (octocat)
  ok   CHANGELOG.md: [Unreleased] will become [2.5.0]

[2] Write version 2.5.0
[3] Roll CHANGELOG.md to 2.5.0
[4] Commit
[5] Annotated tag v2.5.0
[6] Push branch and tag to origin
[7] Publish to the registry (dist-tag latest)
[8] GitHub release v2.5.0

Released v2.5.0
```

## Contents

|                                                                         |                                         |
| ----------------------------------------------------------------------- | --------------------------------------- |
| [📦 Install](#-install)                                                 | package, `npx`, or vendored file        |
| [⚡ Usage](#-usage)                                                     | targets, bumps, flags                   |
| [🧩 Steps](#-steps)                                                     | the seven steps and how to select them  |
| [📚 Libraries versus apps](#-libraries-versus-apps)                     | which steps you want, and why           |
| [🤖 Assistant](#-assistant-optional)                                    | optional AI drafting                    |
| [🌍 Any language](#-any-language)                                       | Rust, Python, tag-only, anything        |
| [🚂 Release trains](#-release-trains)                                   | monorepos and multi-repo workspaces     |
| [✅ Preflight](#-preflight)                                             | what is checked before anything mutates |
| [♻️ Recovering from a failed run](#️-recovering-from-a-failed-run)       | why re-running is safe                  |
| [⚙️ Configuration](#️-configuration)                                     | `release.config.json`, publishing, auth |
| [🔄 Keeping vendored copies in sync](#-keeping-vendored-copies-in-sync) | `--sync`                                |
| [📋 Requirements](#-requirements)                                       | Node, `git`, `gh`                       |

## 📦 Install

Pick by what the project is, not by preference.

### Node projects — devDependency

Pins the version, so every machine and CI run behave identically.

```sh
pnpm add -D @entro314labs/release-kit
```

```json
{ "scripts": { "release": "release-kit" } }
```

### Non-Node projects — global install

A Rust, Python or Go repository has no manifest to hang a devDependency on, so install it
once and use it everywhere.

```sh
npm i -g @entro314labs/release-kit
release-kit minor
```

### CI, any language — pinned npx

No global state to drift, no install step, and the version is explicit in the command.

```sh
npx @entro314labs/release-kit@2.3.0 minor --yes
```

### Vendored — no registry at release time

For a project that should not depend on the registry it is about to publish to, or that
needs releases to work offline. The file is self-contained, so a copy is a complete install.

```sh
npx @entro314labs/release-kit --sync .        # writes scripts/release.mjs
```

```json
{ "scripts": { "release": "node scripts/release.mjs" } }
```

### Piped — nothing installed at all

`release.mjs` runs straight from stdin, arguments and all. Useful for a one-off release on a
machine you do not want to install anything on.

```sh
curl -fsSL https://raw.githubusercontent.com/entro314-labs/release-kit/v2.3.0/release.mjs \
  | node - minor --yes
```

Pin the URL to a tag, never `main`: piping an unpinned remote script into an interpreter
means whatever is at that URL runs against your repository and your credentials. `--sync` is
the one thing that does not work this way — copying itself needs a file on disk.

> **All five paths run the same file and need Node 18+.** That includes the Rust, Python and
> Go projects: `release-kit` is a Node program regardless of what it is releasing.

Zero-config works on the conventions below; add a [`release.config.json`](#️-configuration)
only for what differs.

## ⚡ Usage

```sh
pnpm release                      # release the version already in package.json
pnpm release 2.3.0                # release an explicit version
pnpm release minor                # bump from the current version
pnpm release prerelease --preid beta
pnpm release -- --dry-run         # print every step, execute nothing
pnpm release -- --help
```

The target is optional. With no target it releases whatever version `package.json`
already says — which is the mode to use when a version bump landed in an earlier commit.

| `auto` | derived from the Conventional Commits since the last tag |

`auto` follows release-please's rules: a breaking change (`!` or a `BREAKING CHANGE:`
footer) is a major, a `feat:` is a minor, anything else is a patch. Below `1.0.0` that is
softened — a breaking change bumps the minor rather than jumping to `1.0.0`. A commit body
containing `Release-As: 2.0.0` pins the version outright. It always prints what it inferred
and why before doing anything. Set `"versioning"` to `always-patch`, `always-minor` or
`always-major` to never infer.

| Target                               | From `1.2.3`                                     | From `2.0.0-beta.1` |
| ------------------------------------ | ------------------------------------------------ | ------------------- |
| _(none)_                             | `1.2.3`                                          | `2.0.0-beta.1`      |
| `patch`                              | `1.2.4`                                          | `2.0.0`             |
| `minor`                              | `1.3.0`                                          | `2.0.0`             |
| `major`                              | `2.0.0`                                          | `2.0.0`             |
| `prerelease`                         | `1.2.4-beta.0`                                   | `2.0.0-beta.2`      |
| `prepatch` / `preminor` / `premajor` | `1.2.4-beta.0` / `1.3.0-beta.0` / `2.0.0-beta.0` | same                |
| `2.5.0`                              | `2.5.0`                                          | `2.5.0`             |

A `major`/`minor`/`patch` bump off a prerelease releases that prerelease's base version
when the base already satisfies the bump, so promoting a release candidate is a plain
`patch`. The arithmetic matches [`semver.inc`](https://github.com/npm/node-semver#functions)
exactly, and precedence follows the [SemVer spec](https://semver.org/#spec-item-11).

Prerelease bumps need `--preid` unless the current version already carries one to infer.

### Flags

| Flag                         | Effect                                                                     |
| ---------------------------- | -------------------------------------------------------------------------- |
| `--only <steps>`             | Run only these steps, comma-separated.                                     |
| `--skip <steps>`             | Run every step except these.                                               |
| `--commit`                   | Force the `commit` step on when a `steps` config removed it.               |
| `--dry-run`                  | Print every step, execute nothing. Preflight still runs and still reports. |
| `--yes`, `-y`                | Skip the confirmation prompt.                                              |
| `--preid <id>`               | Prerelease identifier: `alpha`, `beta`, `rc`, `next`, `nightly`, `canary`. |
| `--dist-tag <name>`          | Override the npm dist-tag. Always wins over the derived one.               |
| `--assistant <name>`         | Drafting CLI: `auto`, `none`, `claude`, `codex`.                           |
| `--assistant-model <name>`   | Model the assistant runs with.                                             |
| `--assistant-effort <level>` | Reasoning effort the assistant runs with.                                  |
| `--sync <dir>...`            | Copy this script into other projects and exit. Touches no git state.       |
| `--help`, `-h`               | Full flag list.                                                            |

## 🧩 Steps

A release is seven named steps. They always run in this order — `steps` selects which of
them execute, it never reorders them.

| Step        | Default | What it does                                                                                    |
| ----------- | ------- | ----------------------------------------------------------------------------------------------- |
| `commit`    | on\*    | Commit a dirty working tree with a drafted message ([assistant](#-assistant-optional) required) |
| `version`   | on      | Write the version into `package.json` and `versionFiles`                                        |
| `changelog` | on      | Roll `[Unreleased]` into the version, or add drafted notes                                      |
| `tag`       | on      | Annotated git tag carrying the release notes                                                    |
| `push`      | on      | Push the branch and tag together (`--follow-tags`)                                              |
| `publish`   | on      | Run the configured `publish` command                                                            |
| `release`   | on      | Create the GitHub release                                                                       |

\* `commit` is a conditional default: it no-ops on a clean tree, and on a dirty tree it
proceeds only when a drafting [assistant](#-assistant-optional) is configured — without
one, preflight still refuses the unclean tree (with a hint), exactly as before. So
`release-kit auto --assistant auto` releases a dirty tree end to end: stage, drafted
commit, then the rest of the pipeline. Opt out with `--skip commit` or a `steps` config.

`version` and `changelog` write files; those writes are persisted by a release commit made
automatically when either step runs.

```sh
release-kit minor --skip publish            # everything but publish
release-kit --only tag,push,release         # a version already committed elsewhere
release-kit minor --skip commit             # never touch uncommitted work
```

Or fix it per project, and just run `release-kit minor`:

```json
{ "steps": ["version", "changelog", "tag", "push", "release"] }
```

`steps` decides **what** runs. Every other key describes **how** a step behaves — `publish`
is the command, `changelog` is the file. A step whose configuration is `null` runs as a
no-op and says so, rather than silently meaning "skip".

### Release notes

Notes resolve in this order:

1. The `CHANGELOG.md` section for the version being released. Every common heading shape
   is recognised: `## [1.2.3] - 2026-08-17`, `## v1.2.3`, `## 1.2.3 (2026-08-17)`. The
   section ends at the next `##` heading or `---` rule.
2. The `## [Unreleased]` section, if the version has no section of its own — this is the
   same content that step 2 above is about to promote.
3. The commits grouped by Conventional Commit type — Features, Bug Fixes, Performance
   Improvements, Reverts, with breaking changes first and chores, CI and docs hidden. Each
   bullet links to its commit, and `closes #12` / `fixes #34` in a message becomes a link to
   the issue. A `BREAKING CHANGE:` footer is used in place of the subject, since it explains
   the break. A commit reverted within the same release drops out along with its revert.
   All deterministic and needing nothing installed, so decent notes are the default rather
   than something that requires an assistant.
4. Otherwise GitHub generates them from the commits since the previous tag.

`--notes <source>` forces one instead of walking that list: `changelog`, `assistant`,
`commits`, or `github`. A named source that produces nothing is an error rather than a
quiet fall-through — asking for one thing and being given another is worse than being told
it is unavailable.

`--assistant` names the _tool_; `--notes` names the _source_. Making an assistant available
does not make it preferred, because a hand-written changelog entry should still win.

The same text becomes the tag annotation, the GitHub release body, and (when rolled) the
changelog entry. It is written once and lands in three places.

### npm dist-tags

The [dist-tag](https://docs.npmjs.com/cli/commands/npm-dist-tag) is derived from the
version, never guessed:

| Version                | dist-tag                                                      |
| ---------------------- | ------------------------------------------------------------- |
| `1.2.3`                | `latest`                                                      |
| `1.2.3-beta.4`         | `beta` (any of `alpha` `beta` `canary` `next` `nightly` `rc`) |
| `3.0.0-1751023456789`  | `canary` (an all-numeric prerelease is a timestamp)           |
| `1.2.3-experimental.0` | **refuses to release**                                        |

The refusal is deliberate: an unrecognised prerelease identifier has no safe channel, and
falling through to `latest` would put a prerelease on the stable line where every
`npm install` picks it up. Pass `--dist-tag <name>` to choose a channel explicitly.

## ✅ Preflight

Every check runs and every failure is reported before it aborts once with the whole list,
rather than stopping at the first problem.

- The target version is greater than the current one — and for `auto`, which bump the
  commits imply and why
- Working tree is clean, or listed for commit when the `commit` step runs
- On the configured branch, and not on a detached HEAD
- The remote exists, is reachable, and the branch is not behind it
- The tag is free — or already exists at `HEAD`, in which case it is reused
- `gh` is installed and authenticated
- Commit and tag signing can actually sign, and the key is one GitHub will accept
- The publishing CLI is authenticated, and the version is not already published
- Configured release assets exist
- A shallow clone is reported, since it truncates the history notes come from _(warning)_
- A changelog section for the version exists _(warning — it falls back to generated notes)_

Under `--dry-run` the failures are reported and then the remaining steps are shown anyway,
so you can see the whole plan without fixing the blockers first.

## ♻️ Recovering from a failed run

Re-run the same command. Every step is idempotent:

| Already done            | What happens                   |
| ----------------------- | ------------------------------ |
| Version written         | No diff to stage, so no commit |
| Tag exists at `HEAD`    | Reused, not recreated          |
| Commit and tag pushed   | Push is a no-op                |
| Version on the registry | Publish skipped                |
| GitHub release exists   | Release skipped                |

So a run that dies at the publish step (2FA timeout, flaky network) picks up exactly where
it stopped. There is no cleanup step, no `--resume`, and nothing to remember.

The one case that is not recoverable by re-running is a tag that exists at a _different_
commit than `HEAD`. That is a genuine conflict, and it aborts rather than guessing.

## 🌍 Any language

Only one step is Node-specific: `publish`. Committing, changelog rolling, tagging, pushing
and GitHub releases are the same everywhere, so `versionFile` points at wherever a project
keeps its version and the rest works unchanged.

| Project                        | Config                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------- |
| Node (npm)                     | nothing — `package.json` and `npm publish` are the defaults                     |
| Node (pnpm / bun)              | `{"publish": "pnpm publish --tag %d"}` or `{"publish": "bun publish --tag %d"}` |
| Rust                           | `{"versionFile": "Cargo.toml", "publish": "cargo publish"}`                     |
| Python                         | `{"versionFile": "pyproject.toml", "publish": "uv publish"}`                    |
| Go                             | `{"versionFile": null, "publish": "go list -m %n@%t"}` — the tag is the release |
| Anything with a `VERSION` file | `{"versionFile": "VERSION", "publish": null}`                                   |
| Versioned only by tag          | `{"versionFile": null}`, then `release-kit 1.2.3`                               |

The publish step also gets a preflight when the command is one it recognises:

| Publish command | Authentication                        | Already published?                  |
| --------------- | ------------------------------------- | ----------------------------------- |
| `npm` / `pnpm`  | `whoami`                              | `view <name>@<version>`             |
| `bun`           | `bun pm whoami`                       | `bun pm view <name>@<version>`      |
| `uv`            | `UV_PUBLISH_TOKEN` in the environment | none — `uv` skips duplicates itself |
| `go`            | none needed                           | `go list -m <module>@<tag>`         |

Anything else runs as written with no preflight. The project name comes from the manifest —
`name` in `package.json`, `Cargo.toml` or `pyproject.toml`, `module` in `go.mod` — falling
back to the repository directory.

`publish` is detected too, but only where one ecosystem obviously owns it: `package.json`
gets `npm publish`, `Cargo.toml` gets `cargo publish`. Python has several publishers (uv,
twine, poetry, flit) and Go has none, so those get nothing rather than a guess — publishing
to the wrong registry is a far worse failure than being asked to configure it.

With no `versionFile` configured it is detected from the repository — `package.json`,
`pyproject.toml`, `Cargo.toml`, then `VERSION` — so most projects need no config for it at
all. Set it explicitly to override, or to `null` for a repository that versions by tag.

The format is inferred from the file name: `.json` reads the `"version"` field, `.toml`
reads the first `version = "x.y.z"` line, and any other file is treated as containing just
the version. Only the version itself is rewritten, so comments and formatting survive — and
because the TOML match is anchored to the start of a line, a dependency's
`serde = { version = "1.0" }` is left alone.

**Lockfiles are scoped automatically.** A `Cargo.lock` records a version for every
dependency — hundreds of them — so matching the first `version = "…"` would rewrite an
unrelated crate. Listing one rewrites only the `[[package]]` block whose name matches the
crate in the sibling `Cargo.toml`; with no sibling to read, it refuses rather than guesses.

For anything else, give a pattern with one capture group around the version. `versionFiles`
takes the same entries, so several files stay in sync across formats:

```json
{
  "versionFile": { "path": "version.go", "pattern": "^const Version = \"(.+)\"" },
  "versionFiles": [{ "path": "Chart.yaml", "pattern": "^version: (.+)$" }]
}
```

A desktop app usually carries the same version in a lot of places at once — a workspace
manifest, per-platform bundle configs, a crate manifest and its lockfile. They stay in step
in one release, across three formats, with no scripting:

```json
{
  "versionFiles": [
    "apps/desktop/package.json",
    "apps/desktop/src-tauri/tauri.conf.json",
    "apps/desktop/src-tauri/tauri.macos.conf.json",
    "apps/desktop/src-tauri/tauri.windows.conf.json",
    "apps/desktop/src-tauri/tauri.linux.conf.json",
    "apps/desktop/src-tauri/Cargo.toml",
    "apps/desktop/src-tauri/Cargo.lock"
  ],
  "publish": null,
  "steps": ["version", "changelog", "tag", "push"]
}
```

Stopping at `push` because the tag is what triggers the build pipeline — see
[Libraries versus apps](#-libraries-versus-apps).

The project name comes from the manifest when there is one (`name` in `package.json`,
`Cargo.toml` or `pyproject.toml`), and falls back to the repository directory.

## 🚂 Release trains

Interdependent packages — a monorepo, or a plain folder of sibling git repositories —
release with the second bin in this package:

```sh
release-train --dry-run     # plan + whole-train preflight, execute nothing
```

`train.mjs` derives the dependency graph and publish order from the package manifests
(never from declared config), releases dependencies before dependents with release-kit as
the per-package worker, rewrites internal ranges, and refuses the whole train before
anything mutates if any package would fail. A `train.config.json` declares only which
directories are members. Design, configuration and the full pipeline are in
[TRAIN.md](TRAIN.md). Prototype status: planning, preflight and `seed-tags` work;
execution is not wired up yet.

## ⚙️ Configuration

`release.config.json`, beside `package.json`. Every key is optional; unknown keys abort
rather than being silently ignored.

| Key             | Default                  | Meaning                                                      |
| --------------- | ------------------------ | ------------------------------------------------------------ |
| `steps`         | all but `commit`         | Which steps run; the order is fixed                          |
| `tagPrefix`     | `"v"`                    | Prepended to the version to form the tag                     |
| `branch`        | `"main"`                 | The only branch a release may run from; `null` allows any    |
| `remote`        | `"origin"`               | Git remote to push to                                        |
| `changelog`     | `"CHANGELOG.md"`         | Changelog path; `null` for a project without one             |
| `versionFile`   | detected                 | Where the version lives; `null` versions by tag alone        |
| `versionFiles`  | `[]`                     | Further files kept in sync; a path or `{ path, pattern }`    |
| `publish`       | `"npm publish --tag %d"` | Publish command; `null` means none is configured             |
| `versioning`    | `"conventional"`         | How `auto` infers; or `always-patch` / `-minor` / `-major`   |
| `assistant`     | `null`                   | Drafting CLI: a name, `"auto"`, or `{ tool, model, effort }` |
| `commitMessage` | `"chore(release): %t"`   | Release commit subject                                       |
| `releaseTitle`  | `"%t"`                   | GitHub release title                                         |
| `assets`        | `[]`                     | Files attached to the GitHub release                         |

Command and message strings expand four tokens: `%v` version, `%t` tag, `%n` package
name, `%d` npm dist-tag. In the `publish` command line the substituted values are
shell-quoted, so a version carrying shell metacharacters is passed through as one literal
argument.

### Continuous integration

Non-interactive by default: the confirmation prompt is skipped when stdin is not a TTY, and
`gh` picks up `GITHUB_TOKEN` on its own. Pass `--yes` to be explicit.

```yaml
- uses: actions/checkout@v5
  with:
    fetch-depth: 0 # release notes and the last-tag lookup need real history
- id: release
  run: npx @entro314labs/release-kit@2.3.0 minor --yes
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
- run: echo "shipped ${{ steps.release.outputs.tag }} ${{ steps.release.outputs.release-url }}"
```

On success it writes to `$GITHUB_OUTPUT`, so later steps can act on what happened instead of
re-deriving it: `version`, `tag`, `name`, `dist-tag`, `steps`, `published`, `release-url`.
Nothing is written on a dry run, and an unwritable `$GITHUB_OUTPUT` never fails a release
that already completed.

Two upstream habits make commit-derived notes trustworthy, and neither is release-kit's job:

- **Gate the release on CI, and guard against forks.** Trigger on `workflow_run` after your
  check workflow succeeds, with `if: github.repository_owner == 'your-org'` so a fork never
  tries to release.
- **Validate pull request titles.** A squash-merge takes its subject from the PR title, so
  that title becomes the commit the notes are built from.
  [`amannn/action-semantic-pull-request`](https://github.com/amannn/action-semantic-pull-request)
  enforces it. Without something like it, work silently goes missing from release notes —
  release-kit says how many commits are not Conventional Commits, but it cannot fix them
  after the fact.

Three things CI does that are worth knowing about:

- **`fetch-depth: 0`.** The default checkout is a shallow clone, which hides the history
  release notes are drafted from. It still releases correctly, but the notes describe a
  fraction of the work, so a shallow clone is called out as a warning.
- **Detached HEAD.** Tag and pull-request checkouts leave no branch to push, which is a
  preflight failure rather than a confusing push error.
- **Signing.** Runners have no signing key, so disable it for the run rather than shipping
  keys around: `git -c commit.gpgsign=false -c tag.gpgsign=false`.

### Signing

Signing is git's, not this tool's: commits and tags are made with plain `git commit` and
`git tag`, so they are signed exactly when `commit.gpgsign` and `tag.gpgsign` say to, with
whatever key `user.signingkey` resolves to. There is no key handling here to get wrong.

What it does add is a preflight check, because an unusable key otherwise fails at the commit
step with the version already written. For CI, where a signing key usually is not present,
disable signing for that run rather than configuring keys:

```sh
git -c commit.gpgsign=false -c tag.gpgsign=false release-kit minor --yes
```

For commits to show as **Verified** on GitHub, the SSH key must be registered as a _signing_
key in your account, which is a separate list from authentication keys.

### Publishing and authentication

The registry preflight (`whoami`, the already-published lookup) runs with whichever CLI the
`publish` command names, so a pnpm project is checked with pnpm:

```json
{
  "publish": "pnpm publish --tag %d"
}
```

`npm` and `pnpm` are both understood. Any other publish command — `vsce publish`, a shell
pipeline — is run as written with no registry preflight, because there is nothing reliable
to introspect.

Two npm behaviours are handled automatically:

- **`npm login` issues a two-hour session**, not a durable token. Classic tokens were
  [permanently revoked in December 2025](https://github.blog/changelog/2025-12-09-npm-classic-tokens-revoked-session-based-auth-and-cli-token-management-now-available/).
  A login from earlier in the day has expired, and
  the preflight failure says so rather than implying you never logged in.
- **[Trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC) carries no token
  at all.** In GitHub Actions with
  `id-token: write`, or GitLab CI/CircleCI with `NPM_ID_TOKEN`, `whoami` fails while
  `publish` succeeds. That environment is detected and the auth check is skipped, so a
  valid CI release is not aborted over a missing token it does not need.

### Examples

A VS Code extension, published to the marketplace rather than npm:

```json
{
  "publish": "vsce publish"
}
```

A browser extension with a separate manifest and a built artifact:

```json
{
  "versionFiles": ["src/manifest.json"],
  "publish": null,
  "assets": ["build.zip"],
  "changelog": null
}
```

A project releasing off a non-default branch with a different tag scheme:

```json
{
  "branch": "release",
  "tagPrefix": "release-",
  "commitMessage": "release: %n %v"
}
```

## 🤖 Assistant (optional)

An assistant is an AI CLI already installed on your machine. When one is configured,
release-kit can write the Conventional Commits message for a dirty working tree and draft
release notes from the commit log. It is **off by default**, and every failure — not
installed, not authenticated, timed out, unusable answer — falls back to the behaviour you
already have. A release is never blocked because a text generator was unavailable.

```sh
pnpm release minor --commit --assistant claude --assistant-model sonnet --assistant-effort low
```

| Tool     | Invocation   | Model               | Effort                           |
| -------- | ------------ | ------------------- | -------------------------------- |
| `claude` | `claude -p`  | `--assistant-model` | `--assistant-effort` (low … max) |
| `codex`  | `codex exec` | `-m`                | `-c model_reasoning_effort=`     |

Configure it once instead:

```json
{
  "assistant": { "tool": "claude", "model": "sonnet", "effort": "low" }
}
```

`"assistant": "auto"` picks the first tool found on PATH; `"claude"` is shorthand for
`{ "tool": "claude" }`. Naming a tool that is not installed is an error rather than a silent
downgrade, so a configured pipeline fails loudly; `"auto"` degrades quietly by design.

### What it does

- **A dirty working tree is committed instead of refusing to release.** The tree is
  staged, a Conventional Commits message is drafted for the staged diff, and the commit is
  made — by default, whenever an assistant is configured (`--skip commit` opts out). The subject is validated
  against the Conventional Commits grammar; an answer that does not parse is rejected rather
  than committed. Attribution lines (`Co-Authored-By`, `Generated with`) are stripped, so
  the tool never signs your commits.
- **Release notes** are drafted from the commits since the last tag when `CHANGELOG.md` has
  no section for the version. Each bullet ends with a link to the commits it covers: the
  assistant is given the short hashes and asked to cite them, and every citation is checked
  against the commits that actually exist. Models invent plausible-looking hashes, so an
  unrecognised one is removed rather than published as a link to nothing. They are written into the changelog, used as the tag
  annotation, and posted as the GitHub release body — the same "written once, lands in three
  places" path a hand-written section takes.

With `--commit`, notes are drafted _after_ that commit lands, so they describe the change it
just made. Merge, release, `WIP` and `fixup!`/`squash!` commits are excluded from the prompt.

### Adding another tool

One row in `ASSISTANTS` in `release.mjs`: the command, the args that make it read a prompt on
stdin, and how it spells model and effort. Tools whose stdout carries session scaffolding
declare `outputFile` and the answer is read from there instead.

## 📚 Libraries versus apps

Publishing splits in two, and which one you are decides the `steps` you want.

**A library, package or tool publishes its source.** The registry receives what is already
in the repository — `npm publish`, `cargo publish`, `uv publish` — and there is nothing to
build first. release-kit does the whole thing:

```json
{}
```

Defaults are already correct: version → changelog → tag → push → publish → release.

**An app has to be built before anything can be published.** Binaries, installers, bundles,
container images: the artifact does not exist until something makes it. That build belongs
to a build tool, and it changes where release-kit stops.

### Apps with a simple build

If the build runs before the release and leaves files on disk, release-kit can attach them
itself. Nothing else is needed:

```json
{ "assets": ["dist/app-macos.zip", "dist/app-linux.tar.gz"], "publish": null }
```

Preflight fails if a listed asset is missing, so a release cannot quietly ship without its
binaries.

### Apps with a real build pipeline

goreleaser, cargo-dist and electron-builder build for many targets and create the GitHub
release themselves, with the artifacts attached. That is their job. release-kit's work ends
at the pushed tag:

```json
{ "steps": ["version", "changelog", "tag", "push"], "notesFile": "dist-notes.md" }
```

Nothing after `push` — no `publish`, no `release`. The tag push is the handoff, and it is
what triggers the build workflow:

```yaml
on:
  push:
    tags: ['v*']

jobs:
  build:
    steps:
      - uses: actions/checkout@v5
        with: { fetch-depth: 0 }
      - run: goreleaser release --clean --release-notes dist-notes.md
```

A Go project has no version file at all — the tag is the version — so it is
`"versionFile": null` and the version is passed explicitly, or inferred with `auto`:

```sh
release-kit auto      # bump from the commits, tag, push; goreleaser takes it from there
```

**Only one of the two should write release notes.** goreleaser groups conventional commits
itself; `--release-notes` makes it use yours instead and skip its own generation. Leaving
both on means the notes in the GitHub release and the notes in your `CHANGELOG.md` are
generated by different code from the same commits, and they drift.

**Do not leave `release` in `steps` here.** goreleaser creates the GitHub release itself; if
release-kit has already created one for that tag, goreleaser fails. Exactly one of them
should own it, and it should be the one attaching the binaries.

`notesFile` exists for this handoff: goreleaser's `--release-notes` takes a file and skips
its own changelog generation. The notes are also in the annotated tag, but reading them back
with `git tag --format='%(contents)'` embeds the signature when tags are signed, which then
appears in your published release notes. `notesFile` writes the text itself.

### Both at once

A project can be both — a Rust crate that also ships binaries, say. Publish the library from
release-kit and let the build tool handle the binaries and the release:

```json
{ "publish": "cargo publish", "steps": ["version", "changelog", "tag", "push", "publish"] }
```

## 🔄 Keeping vendored copies in sync

Installed as a dependency, updates come from your package manager and there is nothing to
sync. For projects using the vendored file, `--sync` pushes the current version out — to
one project or to many at once:

```sh
npx @entro314labs/release-kit --sync ../project-a ../project-b
```

It reports `installed`, `updated`, or `already up to date` per target, creates `scripts/`
if missing, skips directories with no `package.json`, and warns when a target lacks the
`release` npm script. It runs before any git resolution, so it works from anywhere,
including a directory that is not a repository.

## 📋 Requirements

- **Node 18+ — including for Rust, Python and Go projects.** `release-kit` is a Node
  program whatever it releases; there is no standalone binary.
- `git`
- `gh`, authenticated — only when creating GitHub releases
- Whatever the `publish` command needs — for the default, a live `npm login` session
  (two hours) or an OIDC trusted-publishing environment

## 🗺 Roadmap

Known defects, missing infrastructure, and the ideas that were considered and declined —
with the reasoning — are in [ROADMAP.md](ROADMAP.md).

## 🤝 Contributing

```sh
pnpm install
pnpm test     # 63 tests, node --test, no framework
pnpm check    # format + lint + tests, the same gate CI runs
```

`test/` holds unit suites for the pure functions and an integration suite that builds real
throwaway repositories with a real bare remote and stubbed `gh`/`npm`. The integration tests
pin defects found in use, so a name like "refuses to reuse a tag while still producing a
commit" is describing something that actually happened.

The tool releases itself, so a change ships the same way it would in any consuming project:
add a `## [Unreleased]` entry to `CHANGELOG.md`, then run `pnpm release <bump>` from a clone.

## 📄 License

MIT
