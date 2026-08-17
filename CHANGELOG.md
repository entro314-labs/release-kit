# Changelog

All notable changes to @entro314labs/release-kit.

## [Unreleased]

## [2.2.0] - 2026-08-17

### Added

- **GitHub Actions outputs.** A completed release writes `version`, `tag`, `name`,
  `dist-tag`, `steps`, `published` and `release-url` to `$GITHUB_OUTPUT`, so later steps can
  act on the result instead of re-deriving it. Nothing is written on a dry run, and an
  unwritable path never fails a release that already succeeded.
- **A shallow clone is called out.** CI checkouts default to depth 1, which hides the
  history release notes are drafted from — the release was correct but the notes silently
  described a fraction of the work.
- **Signing is checked before anything mutates.** With `commit.gpgsign` or `tag.gpgsign`
  enabled, a key that git cannot load previously failed at the commit step — after the
  version had already been written. Preflight now verifies the key resolves, using git's own
  config resolution, and says how to disable signing for one run if it does not.

### Fixed

- **A detached HEAD is a preflight failure** rather than a confusing branch mismatch. Tag
  and pull-request checkouts leave no branch to push; it previously compared the literal
  "HEAD" against the configured branch and reported being up to date with `origin/HEAD`.
- **`--sync` no longer crashes when the script is piped from stdin.** Copying itself needs a
  file on disk, and `import.meta.url` points at a synthetic `[eval]` path when piped, so it
  failed on a missing file with a raw stack trace. It now explains the situation.

### Documentation

- Install is organised by what the project is — devDependency for Node, global for
  non-Node, pinned `npx` for CI — plus vendored and piped for the cases that want no
  registry or no install at all. Node 18+ is called out as a requirement even for Rust,
  Python and Go projects, since there is no standalone binary.

## [2.1.0] - 2026-08-17

### Added

- Publish preflight checks now support bun, uv, and Go projects alongside npm and pnpm. Authentication and already-published checks are run with the tool that does the publishing: uv uses token-based authentication from the environment and skips duplicate versions itself, and for Go the release tag is checked via `go list`. The project name can now also be read from `go.mod`.
- The release version can be sourced from any file, not just `package.json`: `versionFile` points at wherever a project keeps its version, with the format inferred from the file name and a pattern option for anything else. `versionFiles` accepts the same entries to keep several files in sync, and `versionFile: null` supports repositories versioned by tag alone.

## [2.0.0] - 2026-08-17

### Added

- **Publish preflight for bun, uv and Go**, alongside npm and pnpm. Each ecosystem declares
  how its CLI answers "who am I" and "does this version exist", so the checks fit the tool
  actually publishing: `bun pm whoami`, a `UV_PUBLISH_TOKEN` in the environment for uv, and
  `go list -m` for Go, where the tag is the release. A publish command outside that set runs
  as written with no preflight.
- **Works in any language, not just Node.** `versionFile` points at wherever a project keeps
  its version; the format is inferred from the file name (`.json`, `.toml`, or a plain file
  holding just the version), with a `pattern` escape hatch for anything else. `versionFiles`
  accepts the same entries, so several files stay in sync across formats. `"versionFile":
null` suits repositories versioned by git tag alone, where the version is passed
  explicitly. Only `publish` was ever Node-specific, and it has always been a configurable
  command.

- **Optional AI assistant**, off by default, for two jobs: writing the Conventional Commits
  message for a dirty working tree (`--commit`) and drafting release notes from the commit
  log when the changelog has no section for the version. Drafted notes are written into the
  changelog, used as the tag annotation, and posted as the GitHub release body.
- **`claude` and `codex` supported**, each with `--model` and `--effort` passed through in
  that tool's own spelling, settable per-invocation or as `{ tool, model, effort }` in
  `release.config.json`. Adding another CLI is one row in `ASSISTANTS`.
- **Attribution is stripped** from every draft: `Co-Authored-By`, `Generated with` and
  tool-signed `Signed-off-by` lines never reach a commit, tag or changelog. A human
  `Signed-off-by` is preserved.
- **Drafts are validated, not trusted.** A commit subject that does not parse as
  Conventional Commits is rejected rather than committed, and notes are truncated at their
  last heading or list item so trailing model commentary and stray code fences are dropped.
- Every assistant failure — missing, unauthenticated, timed out, unusable answer — falls
  back to the previous behaviour. Naming a tool that is not installed is a loud error;
  `"auto"` degrades quietly.

### Changed

- **Steps are now one uniform concept.** The pipeline is seven named steps — `commit`,
  `version`, `changelog`, `tag`, `push`, `publish`, `release` — selected with `--only` and
  `--skip`, or a `steps` array in `release.config.json`. Previously four of the seven were
  reachable, each by a different mechanism: a negative flag, a config null, or a positive
  flag. `version`, `tag` and `push` could not be turned off at all.
- **`steps` decides what runs; every other key describes how a step behaves.** `"publish":
null` now means "no publish command configured" rather than "skip publishing", and the
  step no-ops with a note. Use `--skip publish` or omit it from `steps` to skip it.
- The order of steps is fixed. `steps` is a set, not a sequence: publishing before tagging
  or pushing before committing is not expressible.

### Removed

- **`--skip-publish` and `--skip-release`** — use `--skip publish,release`.

### Renamed

- **`--tag` is now `--dist-tag`.** It sets the npm dist-tag, and collided with `tagPrefix`
  and the git tag that most people mean by "tag".
- **`--model` and `--effort` are now `--assistant-model` and `--assistant-effort`**, since
  they configure the drafting assistant rather than anything about the release.

### Fixed

- **A flag's value could be mistaken for the release target.** Arguments were scanned for
  the first bare word, excluding known option values by identity, so `--only tag,push`
  was read as a version to release. Options that take a value are now declared, and the
  argument after them is never treated as the target.
- **A misspelled step name was silently ignored.** `--skip pubish` deleted nothing and
  published anyway. Requested step names are now validated before they are applied.

## [1.0.3] - 2026-08-17

### Fixed

- **Refuse to run from a nested package.** A release covers a whole repository — the
  version, the tag and the push all belong to one git history — so the package released is
  the one at the git root. Invoked from a workspace member or any subdirectory carrying its
  own `package.json`, it previously resolved to the git root and released the parent
  package instead. It now aborts and names the package it would have released. A
  subdirectory without its own `package.json` still resolves to the root as before.

## [1.0.1] - 2026-08-17

### Added

- **Initial release.** A single zero-dependency file that takes a JS/TS/Node project from a
  version number to a published GitHub release: version bump → changelog roll → commit →
  annotated tag → push → registry publish → GitHub release.
- **Accumulating preflight.** Every check runs and every failure is reported before it
  aborts once with the whole list, rather than stopping at the first problem.
- **Idempotent steps.** An already-written version, an existing tag at `HEAD`, an
  already-published version and an existing GitHub release are each detected and skipped, so
  a run that stops partway through is recovered by re-running it. No cleanup step and no
  `--resume` flag.
- **Clean aborts.** A command that fails mid-release reports which command failed and that
  re-running resumes, instead of surfacing an unhandled child-process error.
- **`--dry-run`** that walks the same code path and prints `would run: <cmd>` for every
  mutation rather than executing it.
- **Version arithmetic** covering `major`/`minor`/`patch`, `premajor`/`preminor`/`prepatch`/
  `prerelease` and explicit versions, matching `semver.inc` semantics.
- **npm dist-tag resolution** derived from the version, which refuses to release a
  prerelease whose identifier maps to no known channel rather than letting it fall through
  to `latest` and clobber the stable line.
- **Release notes** taken from the matching `CHANGELOG.md` section, falling back to the
  `[Unreleased]` section and then to GitHub's generated notes. The same text becomes the tag
  annotation, so CI can read it off the tag.
- **Registry preflight that follows the publish command**, checking `whoami` and the
  already-published lookup with whichever of npm or pnpm actually publishes, and skipping
  both for a publish command it cannot introspect.
- **Trusted publishing (OIDC) awareness.** GitHub Actions with `id-token: write`, and GitLab
  CI/CircleCI with `NPM_ID_TOKEN`, publish without a token at all — `whoami` fails there
  while `publish` succeeds. That environment is detected so a valid CI release is not
  aborted over a token it does not need.
- **`release.config.json`** for per-project differences: `tagPrefix`, `branch`, `remote`,
  `changelog`, `versionFiles`, `publish`, `commitMessage`, `releaseTitle`, `assets`. Unknown
  keys abort rather than being silently ignored.
- **`--sync`** to vendor the script into projects that should not depend on the registry
  they are about to publish to.
