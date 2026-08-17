# Changelog

All notable changes to @entro314labs/release-kit.

## [Unreleased]

### Added

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
