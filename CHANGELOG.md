# Changelog

All notable changes to @entro314labs/release-kit.

## [Unreleased]

## [2.6.0] - 2026-08-18

### Fixed

- **Sections are placed by version, not by position.** A release was inserted above the
  first heading in the file and `[Unreleased]` was rolled where it stood, both of which are
  only correct while the changelog is already newest-first. Once a file drifted out of
  order it stayed that way and every release made it worse — which is how a released 2.5.0
  ended up between 2.3.3 and 2.4.0 in this project's own changelog. A misplaced
  `[Unreleased]` is now lifted back to the top rather than dragging the release into the
  middle of the file with it.
- **A changelog that is not newest-first is reported.** Placement keeps a file tidy going
  forward but cannot repair existing disorder, and that disorder is otherwise invisible
  until a release lands somewhere surprising.

### Added

- **A count of commits that will not appear in the notes.** Notes are built from
  Conventional Commits, so anything written another way is simply absent — and the release
  still succeeds, so nobody notices. A squash-merge takes its subject from the pull request
  title, which is where this usually goes wrong.
- **Drafted release notes link to their commits.** The deterministic notes already did; the
  assistant's did not. It is now given the short hashes and asked to cite the ones each
  bullet covers, and every citation is checked against the commits that actually exist —
  models invent plausible-looking hashes, and a link to a commit that is not there is worse
  than no link, so unrecognised ones are removed.

## [2.5.0] - 2026-08-18

### Features

- **version:** read the current version from the latest tag when there is no file ([3871709](https://github.com/entro314-labs/release-kit/commit/3871709))
- **notes:** collect unanticipated commit types instead of dropping them ([28b2cd1](https://github.com/entro314-labs/release-kit/commit/28b2cd1))

## [2.4.0] - 2026-08-18

### Added

- **A test suite, in the repository.** 63 tests across 6 suites run by `node --test`, with
  no framework: version arithmetic differentially checked against the real `semver` package,
  changelog reading and rolling, commit parsing and bump inference, draft sanitising,
  version-file rewriting, and end-to-end releases against real repositories with a real bare
  remote. `pnpm test` runs them and `pnpm check` gates on them. They had been living outside
  the repository, where they protected nobody and were eventually lost.
- **CI.** Format, lint and tests on Linux, macOS and Windows.

### Added

- **An "Other Changes" section** collects conventional types outside the table —
  `security:`, `i18n:` — which were previously dropped without a word. A security fix going
  unmentioned in release notes is the failure worth preventing. Deliberately hidden types
  (`chore`, `ci`, `docs`, `style`, `refactor`, `test`, `build`) stay hidden.
- **A `Dependencies` section** for `deps:` commits.
- **The current version is read from the latest tag** where a repository has no version
  file. A Go module versions by tag alone, so `auto` and every bump previously had nothing
  to work from and the version had to be typed out in full each time.

### Fixed

- **A commit type containing digits now parses.** The type pattern was `[a-z]+`, so `i18n:`
  and `a11y:` failed to parse as Conventional Commits at all and their commits vanished from
  the notes entirely.

### Changed

- **`writeVersionInto` takes `dryRun` as a parameter** rather than reading a module-level
  flag declared further down the file. Writing the tests surfaced the dependency.

## [2.3.3] - 2026-08-17

### Added

- `notesFile` option to write the generated release notes to a file, so build tools can pick them up when they own the artifacts and the GitHub release.

### Changed

- Generated release notes now link commit hashes and issue references using the detected forge's URL format, use the `BREAKING CHANGE` footer text in place of the commit subject when present, and exclude commits that were reverted within the same release.

### Fixed

- Publishing now uses the command matching the detected manifest (`npm` for `package.json`, `cargo` for `Cargo.toml`, none otherwise) instead of always running `npm publish`, so zero-config releases of non-Node projects no longer attempt an npm publish.
- The drafted commit message is shown before the confirmation prompt, and declining now restores the index.
- A change set spanning more than two top-level paths is called out before committing, since one commit gets one subject.
- `--sync` no longer requires a `package.json`, so non-Node projects can vendor the script.

## [2.3.2] - 2026-08-17

### Fixed

- **A version that already has a changelog heading is never rolled again.** An empty
  `## [Unreleased]` was promoted into an empty version section, and because an empty section
  reads as "no section", the next release rolled it again and produced a duplicate heading.
- **An empty `[Unreleased]` is no longer rolled at all**, so a release with nothing recorded
  leaves no empty section behind.
- **Reusing an existing tag while still producing a commit is refused.** Resuming a release
  reuses the tag at `HEAD`, but if the run would also commit a version bump or changelog
  entry, that commit moves `HEAD` past the tag and the release ends up tagged at the wrong
  revision — silently, until someone checks out the tag.

## [2.3.1] - 2026-08-17

### Added

- **The signing key is checked against GitHub.** git signs happily with a key GitHub has
  never seen, which is how a repository fills with locally-valid commits that stay
  permanently "Unverified". When `gh` can list the account's signing keys they are compared;
  when it cannot — `gh` absent, token without the scope, no network — the check stays
  silent. A warning, never a failure: an unverified commit is cosmetic.

### Fixed

- **Two warnings still named the pre-2.0 flags.** An assistant that takes no model or effort
  flag reported `--model`/`--effort` rather than `--assistant-model`/`--assistant-effort`.

## [2.3.0] - 2026-08-17

### Added

- **`release-kit auto` derives the version from Conventional Commits**, following
  release-please's default strategy: breaking is major, `feat:` is minor, everything else is
  a patch, softened below `1.0.0` where a breaking change bumps the minor instead of jumping
  to `1.0.0`. It reports the bump and the commits behind it before acting.
- **`Release-As: 2.0.0` in a commit body pins the version**, so the decision can live in git
  history rather than on the command line.
- **`versioning`** accepts `always-patch`, `always-minor` and `always-major` for projects
  that deliberately never infer.
- **Release notes are grouped by commit type without an assistant.** Commits are collected
  under Features, Bug Fixes, Performance Improvements and Reverts, with breaking changes
  first and chores, CI, docs and tests hidden. This sits above the assistant and GitHub's
  generated notes, so useful notes no longer depend on having a drafting CLI installed.

## [2.2.2] - 2026-08-17

### Added

- **The version source is detected when unconfigured.** With no `versionFile` set it looks
  for `package.json`, `pyproject.toml`, `Cargo.toml`, then `VERSION`, so a Python or Rust
  project needs no configuration to release. Previously it insisted on `package.json` and
  aborted in any repository without one. An explicit `versionFile: null` is still honoured
  and never re-detected.

## [2.2.1] - 2026-08-17

### Added

- **GitHub Actions outputs.** A completed release writes `version`, `tag`, `name`,
  `dist-tag`, `steps`, `published` and `release-url` to `$GITHUB_OUTPUT`, so later steps can
  act on the result instead of re-deriving it. Nothing is written on a dry run, and an
  unwritable path never fails a release that already succeeded.
- **A shallow clone is called out.** CI checkouts default to depth 1, which hides the
  history release notes are drafted from — the release was correct but the notes silently
  described a fraction of the work.

### Documentation

- **A detached HEAD is a preflight failure** rather than a confusing branch mismatch. Tag
  and pull-request checkouts leave no branch to push; it previously compared the literal
  "HEAD" against the configured branch and reported being up to date with `origin/HEAD`.

## [2.2.0] - 2026-08-17

### Added

- **Signing is checked before anything mutates.** With `commit.gpgsign` or `tag.gpgsign`
  enabled, a key that git cannot load previously failed at the commit step — after the
  version had already been written. Preflight now verifies the key resolves, using git's own
  config resolution, and says how to disable signing for one run if it does not.

### Documentation

- The flag table, config table and preflight list were audited against the code and had
  drifted: `--commit` and the three assistant flags were undocumented, `steps`,
  `versionFile`, `versioning` and `assistant` were missing from the config table,
  `versionFiles` still claimed JSON-only, and `"publish": null` was still described as
  "skips publishing" rather than "no command configured".
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
