# Changelog

All notable changes to @entro314labs/release-kit.

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
