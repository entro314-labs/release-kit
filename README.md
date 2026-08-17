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
| [🔁 What a release does](#-what-a-release-does)                         | the seven steps, notes, dist-tags       |
| [✅ Preflight](#-preflight)                                             | what is checked before anything mutates |
| [♻️ Recovering from a failed run](#️-recovering-from-a-failed-run)       | why re-running is safe                  |
| [⚙️ Configuration](#️-configuration)                                     | `release.config.json`, publishing, auth |
| [🔄 Keeping vendored copies in sync](#-keeping-vendored-copies-in-sync) | `--sync`                                |
| [📋 Requirements](#-requirements)                                       | Node, `git`, `gh`                       |

## 📦 Install

**As a devDependency** — the normal choice. Updates arrive through your package manager.

```sh
pnpm add -D @entro314labs/release-kit
```

```json
{
  "scripts": {
    "release": "release-kit"
  }
}
```

**Without installing** — for a one-off release, or a project you do not want to add a
dependency to:

```sh
npx @entro314labs/release-kit --dry-run
```

**Vendored** — for a project that should not depend on the registry it is about to publish
to, or one that needs releases to work offline. `--sync` copies the file into
`scripts/release.mjs`:

```sh
npx @entro314labs/release-kit --sync .
```

```json
{
  "scripts": {
    "release": "node scripts/release.mjs"
  }
}
```

All three run the same file. Zero-config works on the conventions below; add a
[`release.config.json`](#️-configuration) only for what differs.

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

| Flag               | Effect                                                                     |
| ------------------ | -------------------------------------------------------------------------- |
| `--dry-run`        | Print every step, execute nothing. Preflight still runs and still reports. |
| `--yes`, `-y`      | Skip the confirmation prompt.                                              |
| `--preid <id>`     | Prerelease identifier: `alpha`, `beta`, `rc`, `next`, `nightly`, `canary`. |
| `--tag <dist-tag>` | Override the npm dist-tag. Always wins over the derived one.               |
| `--skip-publish`   | Do not publish to the registry.                                            |
| `--skip-release`   | Do not create the GitHub release.                                          |
| `--sync <dir>...`  | Copy this script into other projects and exit. Touches no git state.       |
| `--help`, `-h`     | Full flag list.                                                            |

## 🔁 What a release does

Steps that do not apply are skipped silently — a project with no changelog, or with
`publish` disabled, simply has fewer steps.

1. **Write the version** into `package.json` and any configured `versionFiles`. The value
   is replaced in place, so key order, indentation, and trailing newline all survive. A
   `package-lock.json` is resynced, because it embeds the root version twice.
2. **Roll the changelog**: `## [Unreleased]` becomes `## [x.y.z] - YYYY-MM-DD`, with a
   fresh empty `## [Unreleased]` reopened above it for the next cycle — the
   [Keep a Changelog](https://keepachangelog.com/) convention.
3. **Commit** the files that actually changed.
4. **Tag**, annotated, with the release notes as the annotation — so a CI workflow can
   read the notes straight off the tag instead of re-deriving them.
5. **Push** with `git push --follow-tags`, which sends the commit and the tag in one
   call. Pushing them separately is how a tag ends up on the remote without its commit.
6. **Publish** to the registry.
7. **Create the GitHub release**, marked `--latest` or `--prerelease`.

### Release notes

Notes resolve in this order:

1. The `CHANGELOG.md` section for the version being released. Every common heading shape
   is recognised: `## [1.2.3] - 2026-08-17`, `## v1.2.3`, `## 1.2.3 (2026-08-17)`. The
   section ends at the next `##` heading or `---` rule.
2. The `## [Unreleased]` section, if the version has no section of its own — this is the
   same content that step 2 above is about to promote.
3. Otherwise GitHub generates them from the commits since the previous tag.

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
`npm install` picks it up. Pass `--tag <dist-tag>` to choose a channel explicitly.

## ✅ Preflight

Every check runs and every failure is reported before it aborts once with the whole list,
rather than stopping at the first problem.

- The target version is greater than the current one
- Working tree is clean
- On the configured branch
- The remote exists, is reachable, and the branch is not behind it
- The tag is free — or already exists at `HEAD`, in which case it is reused
- `gh` is installed and authenticated
- The publishing CLI is authenticated, and the version is not already on the registry
- Configured release assets exist
- A changelog section for the version exists _(a warning, not a failure — it falls back
  to generated notes)_

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

## ⚙️ Configuration

`release.config.json`, beside `package.json`. Every key is optional; unknown keys abort
rather than being silently ignored.

| Key             | Default                  | Meaning                                                      |
| --------------- | ------------------------ | ------------------------------------------------------------ |
| `tagPrefix`     | `"v"`                    | Prepended to the version to form the tag                     |
| `branch`        | `"main"`                 | The only branch a release may run from; `null` allows any    |
| `remote`        | `"origin"`               | Git remote to push to                                        |
| `changelog`     | `"CHANGELOG.md"`         | Changelog path; `null` disables changelog handling           |
| `versionFiles`  | `[]`                     | Extra JSON files whose top-level `"version"` is kept in sync |
| `publish`       | `"npm publish --tag %d"` | Publish command; `null` skips publishing                     |
| `commitMessage` | `"chore(release): %t"`   | Release commit subject                                       |
| `releaseTitle`  | `"%t"`                   | GitHub release title                                         |
| `assets`        | `[]`                     | Files attached to the GitHub release                         |

Command and message strings expand four tokens: `%v` version, `%t` tag, `%n` package
name, `%d` npm dist-tag. In the `publish` command line the substituted values are
shell-quoted, so a version carrying shell metacharacters is passed through as one literal
argument.

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
pnpm release minor --commit --assistant claude --model sonnet --effort low
```

| Tool     | Invocation   | Model     | Effort                       |
| -------- | ------------ | --------- | ---------------------------- |
| `claude` | `claude -p`  | `--model` | `--effort` (low … max)       |
| `codex`  | `codex exec` | `-m`      | `-c model_reasoning_effort=` |

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

- **`--commit`** stages the working tree, drafts a Conventional Commits message for the
  staged diff, and commits — instead of refusing to release. The subject is validated
  against the Conventional Commits grammar; an answer that does not parse is rejected rather
  than committed. Attribution lines (`Co-Authored-By`, `Generated with`) are stripped, so
  the tool never signs your commits.
- **Release notes** are drafted from the commits since the last tag when `CHANGELOG.md` has
  no section for the version. They are written into the changelog, used as the tag
  annotation, and posted as the GitHub release body — the same "written once, lands in three
  places" path a hand-written section takes.

With `--commit`, notes are drafted _after_ that commit lands, so they describe the change it
just made. Merge, release, `WIP` and `fixup!`/`squash!` commits are excluded from the prompt.

### Adding another tool

One row in `ASSISTANTS` in `release.mjs`: the command, the args that make it read a prompt on
stdin, and how it spells model and effort. Tools whose stdout carries session scaffolding
declare `outputFile` and the answer is read from there instead.

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

- Node 18+ (uses `node:readline/promises` and `Array.prototype.at`)
- `git`
- `gh`, authenticated — only when creating GitHub releases
- Whatever the `publish` command needs — for the default, a live `npm login` session
  (two hours) or an OIDC trusted-publishing environment

## 🤝 Contributing

The tool releases itself, so a change ships the same way it would in any consuming project:
add a `## [Unreleased]` entry to `CHANGELOG.md`, then run `pnpm release <bump>` from a clone.

## 📄 License

MIT
