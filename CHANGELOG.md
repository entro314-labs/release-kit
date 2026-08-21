# Changelog

All notable changes to @entro314labs/release-kit.

## [Unreleased]

## [2.9.0] - 2026-08-21

### Fixed

- **The last release was resolved from the nearest tag rather than the highest version
  tag.** `git describe --tags --abbrev=0` answers a different question, and it was wrong
  twice over. A tag that is not a release became the baseline: one rolling `latest-beta`
  marker — the kind `tauri-release-kit` maintains for its update channels — made a release
  abort with "no releasable commits since latest-beta", hiding every commit since the real
  last release. And "nearest ancestor" is not "latest release": a patch tagged on top of a
  later minor dragged the baseline backwards, so a tag-only repository read the wrong
  current version. The last release is now the highest version tag carrying the configured
  prefix that is reachable from `HEAD`.

- **Promoting a release candidate shipped empty notes.** Releasing `2.0.0` after
  `2.0.0-rc.1` and `-rc.2` read history from rc.2, leaving the only commit in range the
  release chore — which is ignored — so the tag annotation and the GitHub release carried
  no record of the features that _were_ 2.0.0. A stable release now reads from the last
  stable tag and absorbs the candidates that led to it. Releasing a candidate is unchanged:
  each one's notes still say what changed in that candidate.

- **The branch and tag were not pushed atomically.** `--follow-tags` decides which refs are
  sent; `--atomic` decides whether they land together. Without it a server may accept the
  branch and reject the tag — the split the step exists to prevent. A server without the
  capability falls back with a warning; nothing else does, since retrying a rejected
  non-fast-forward non-atomically would push one ref and not the other.

- **Changelog headings were dead link references.** `## [1.2.3]` renders as literal
  bracketed text without a `[1.2.3]: <url>` definition, and none were ever written. Every
  bracketed heading in the document now gets one, so a changelog that never had them is
  repaired in one release. Labels that are not headings are left alone.

- **A `versionFiles` entry with no version in it crashed the release with a raw stack
  trace, halfway through writing the others.** This is the configuration
  `tauri-release-kit` documents: a Tauri per-OS overlay carries only the keys it overrides,
  so it has no `version`, and listing one aborted after other files had already changed. A
  file matched by a glob is now skipped — a glob says "every file of this shape", and some
  of them legitimately carry no version — and a file named on purpose fails preflight,
  before anything mutates, saying what to do about it.

- **Listing a file in `versionFiles` that was not a version file replaced its contents with
  the version.** The whole-file mode is right for a `VERSION` file and catastrophic for a
  README. A file that is not already just a version now aborts with what to do instead.

### Added

- **`release-kit next [<target>]`** prints the version that target would release and stops.
  Only the version reaches stdout, so `VERSION=$(release-kit next auto)` gets a clean
  answer; everything the release would narrate goes to stderr. It is a modifier on the
  ordinary target resolution rather than a mode of its own, so `next auto` infers the bump
  through exactly the code the release uses.

- **Version markers.** A comment on the line that carries the number says which of a file's
  numbers is the version, so a README install line, a badge URL, a Dockerfile tag or an
  AppStream `<release>` tag can be kept in step without writing a regex per file:
  `x-release-kit-version`, with `-major`, `-minor`, `-patch`, `-date` and `-version-date`
  for a piece of it, and
  `x-release-kit-start-<scope>` … `x-release-kit-end` for a run of lines. Reading and
  writing share one resolver, so they cannot disagree about where a file's version lives:
  an explicit `pattern` wins, then markers, then the shape the extension implies, then the
  whole file.

- **Globs in `versionFiles`.** A path may contain `*`, matching within one path segment, so
  the per-platform configs a desktop app carries need not be written out one by one. A
  pattern matching nothing aborts rather than skipping quietly. The version source itself
  is never globbed.

- **Lifecycle hooks** — `beforeVersion`, `afterVersion`, `beforePublish`, `afterPublish`,
  `afterRelease` — for work that has to happen between the release's own steps. Command
  lines taking the same tokens `publish` does; a non-zero exit aborts the release where it
  happened. `afterVersion` stages whatever it changed, so a file regenerated from the
  version rides in the release commit rather than being left behind. `afterPublish` runs
  only when a publish actually happened. An unknown hook name aborts.

- **`npm-shrinkwrap.json` and `uv.lock` are refreshed** alongside `package-lock.json`, each
  through the tool that owns it and scoped to the manifest this release wrote, so a
  lockfile for a component the release is not versioning stays out of the release commit. A
  missing tool warns rather than aborting.

- **Cargo workspaces.** A workspace root carries no `[package]` of its own, so `Cargo.lock`
  handling refused it. It now resolves the members that inherit the version with
  `version.workspace = true` and rewrites a block for each, leaving members pinned to their
  own number alone.

- **A New Contributors section** in commit-derived notes, naming anyone whose first commit
  to the repository is in this release. Derived from the git history rather than a forge
  API, so it needs no token and works offline; a GitHub noreply address yields the account
  handle. Skipped on a first release, where everyone would be new.

- **The publish preflight points at provenance** when publishing over OIDC. The flag is not
  added to the command — npm generates provenance for a trusted publish on its own, and
  forcing it fails for a private package or a registry that cannot receive one.

### Changed

- **Node 22 is the documented floor**, matching what `engines` has always declared and what
  CI has always tested. The README claimed Node 18, which reached end of life in April 2025.

### Added

- **One repository releasing to two registries.** Some projects are one source tree with a
  manifest in two ecosystems — a Tauri plugin is a crate and its npm bindings, a maturin
  project is a crate and a wheel — and both manifests carry the same version. With no
  config, a second root manifest (`package.json`, `pyproject.toml`, `Cargo.toml`, plus
  `Cargo.lock` beside a crate) is now detected and bumped in step, and `publish` takes an
  array so both registries are published to on one release. Detection only pairs manifests
  that **already agree on the version**: two manifests on different numbers are two
  independent release lines, and dragging one to the other's number is a silent, wrong
  release — that case warns and is left alone. A project that wrote its own `versionFile`
  or `versionFiles` is never extended.

  The detected npm command runs before the detected cargo one, because npm allows an
  unpublish for 72 hours and crates.io never does: a publish that fails part-way through
  must not already have made the permanent half.

- **crates.io preflight.** `cargo` is now a row in the registry table: credentials are
  found in `CARGO_REGISTRY_TOKEN`, `CARGO_REGISTRIES_CRATES_IO_TOKEN` or the file
  `cargo login` writes, and `cargo info <crate>@<version>` decides whether this version is
  already on the index, so a re-run skips it rather than failing. The lookup uses the name
  from `Cargo.toml` rather than the package name: a plugin is `@tauri-apps/plugin-x` on
  npm and `tauri-plugin-x` on crates.io, and asking crates.io about the npm name reports
  every version as unpublished.

- **Languages that record no version of their own.** A Go module has only `go.mod`, which
  carries no version at all, so a project that wants `--version` to work keeps the number
  in source and expects the tag to match. `version.go`, `internal/version/version.go` and
  `pkg/version/version.go` are now detected and kept in step with the tag, with no config:
  `const Version`, `var Version` and `var Version string` are all read. As with the
  companion manifests, a file is adopted only when it **already carries the current
  version** — which also rules out the `var Version = "dev"` placeholder a build replaces
  with `-ldflags`. A mismatch here is skipped silently rather than warned about, because
  a placeholder is a normal thing to find, not a mistake. Anything outside that convention
  is still three lines of `versionFiles` config with a `pattern`.

### Fixed

- **`versionFiles` was silently ignored by any repository that versions by tag.** The
  `version` step required a `versionFile` before it would write anything, and a repository
  with `"versionFile": null` has none by definition. The step was listed, selected and
  reported as run; it wrote nothing. A Go module configured to keep its version in
  `version.go` released every tag pointing at a commit that still carried the previous
  number, with no warning at any point. The version step now works from every file it has
  been given, whether or not one of them is the source of truth.

### Changed

- **A manifest that forbids publishing no longer has a publish command detected for it.**
  A `"private": true` package.json previously detected `npm publish` and then failed
  preflight for being private; a crate with `publish = false` detected `cargo publish`.
  Both are now read as "this repository releases by tag alone" and get no command. A crate
  built only as a `cdylib` is read the same way: that is a native extension module — what
  maturin and napi-rs compile into a wheel or a `.node` — so its version is synced but it
  is never published to crates.io. An explicitly configured npm publish for a private
  package still fails preflight, since that is a stated intent that cannot be met.

### Fixed

- **A dirty tree discarded a hand-written changelog section and released a re-draft
  instead.** Drafting is deferred past the commit so the notes can describe it, but the
  post-commit step decided to re-draft from the dirty tree alone rather than from whether
  preflight had actually deferred. When `CHANGELOG.md` already held a section for the
  version, preflight took it — printing `CHANGELOG.md has a <version> section` and showing
  it at the confirmation prompt — and then the commit step overwrote it. The tag annotation
  and the GitHub release carried notes nobody approved, and the drafted section was appended
  to `CHANGELOG.md` beside the hand-written one, leaving two sections for the same version.
  Deferral is now recorded when preflight defers, so an existing section survives the
  commit. Introduced in 2.8.0 for every release with a dirty tree; before that it needed a
  configured assistant.

- **`release-train` inferred bumps from a different grammar than the release it drives.**
  `bumpFromCommits` carried its own regexes, narrower than `parseCommit` in three ways: a
  type had to be `[a-z]+`, so `i18n!:` and `a11y!:` were not read as breaking; the match
  was case-sensitive, so `Feat:` was not a feature; and `BREAKING CHANGE` matched anywhere
  in the message, so a body saying "this is not a BREAKING CHANGE" planned a major. A train
  that infers a different bump than the release-kit run it delegates to plans a version it
  will not produce. The two files share no module — importing release.mjs releases — so the
  copy stays, but it is now a faithful one, pinned by tests.

## [2.8.0] - 2026-08-20

### Changed

- **A dirty tree without an assistant is committed with a generated message instead of
  refusing.** The default commit step required a drafting assistant, which blocked plain
  `release-kit auto` on any dirty tree — violating the rule that a release is never
  blocked because a text generator was unavailable. The deterministic floor is a `chore:`
  commit naming the changed files (full paths in the body); an assistant upgrades it to a
  drafted message, and an unusable draft now falls back to the generated one instead of
  aborting after staging. `--skip commit` still restores the hard refusal, and
  commit-derived release notes are now generated after the commit so they include it.

### Added

- **`lint-commits`** — a subcommand that checks commit subjects against the parser the
  release itself uses, so a commit gate and the changelog can never disagree about the
  grammar. `lint-commits [<range>]` checks a range (default: since the last tag);
  `lint-commits --subject <text>` checks one subject, which is how a pull request title
  gets validated before a squash merge turns it into the commit the notes are built from —
  the one case no local commit-msg hook can see. A subject the release cannot read fails;
  a type with no changelog section only warns, because those are still printed under
  _Other Changes_.
- **`verify`** — a config key naming the project's own gate (`"verify": "pnpm check"`),
  run during preflight. A failing gate now aborts while nothing has mutated, instead of a
  `prepublishOnly` hook failing at the publish step — after the commit, the tag and the
  push.
- **The repository URL is checked against the git remote.** A `package.json` `repository`
  pointing at a different repo than the remote ships a broken "Repository" link with every
  publish, and npm only warns after the fact; preflight now warns before, and hints at
  `npm pkg fix` when only the URL format differs.

### Changed

- **`deps:` is a type the drafter can produce.** The list of types in the commit-drafting
  prompt was maintained by hand and had drifted from `CHANGELOG_SECTIONS`, omitting `deps`
  — so an assistant could never write a subject for the Dependencies section the changelog
  has always had. Both are now derived from that one table.
- **The shallow-clone check is predictive instead of blanket.** A shallow clone with the
  previous release tag reachable hides nothing the release reads, and now passes with an
  `ok`. One with no reachable tag provably truncates history: that fails `auto` (the bump
  would be inferred from a fraction of the commits) and warns otherwise, both with the
  `git fetch --unshallow` / `fetch-depth: 0` fix named.

### Fixed

- **Drafted commit messages no longer narrate unchanged context lines.** The drafting
  prompt now tells the assistant that context lines — including the version fields they
  often show — are not part of the change, and that version numbers and release
  bookkeeping are never its to describe. A draft had claimed "release v1.4.5" for a
  commit that changed no version at all, because the unchanged `"version"` field was
  visible in the diff context. A deterministic backstop now enforces it: a draft naming
  a version the staged changes never touch is rejected rather than committed — the same
  validated-not-trusted pattern as the citation check on drafted notes.

## [2.7.0] - 2026-08-18

### Changed

- **The `commit` step is now a default step** rather than opt-in behind `--commit`. It
  still no-ops on a clean tree, and on a dirty tree it proceeds only when a drafting
  assistant is configured — without one, preflight refuses the unclean tree as before,
  now with a hint that an assistant would commit it automatically. So
  `release-kit auto --assistant auto` releases a dirty tree end to end. Opt out with
  `--skip commit` or a `steps` config; `--commit` remains as a way to force the step on
  when a config removed it.
- **Extra positional arguments abort instead of being silently ignored.**
  `release-kit auto assistant auto` used to quietly run as `release-kit auto` with no
  assistant; it now aborts and points at the flag spelling (`--assistant auto`).
- **Every commit type is reported.** `chore`, `ci`, `docs`, `style`, `refactor`, `test` and
  `build` were hidden, following release-please and goreleaser. But a changelog is a record,
  and silently omitting work makes it a partial one. A project that wants the shorter
  version lists the types to drop in `hiddenTypes`.
- **The commits treated as bookkeeping are configurable** through `ignoreCommits`, rather
  than fixed. The defaults are unchanged: the previous release's own commit, merges that
  duplicate the branch they bring in, and `wip`/`fixup!`/`squash!` markers.

### Added

- **`release-train`** — a second bin, `train.mjs`, orchestrating multi-package releases in
  dependency order across a monorepo or a workspace of sibling git repositories, with
  release-kit as the per-package worker. Membership comes from `train.config.json`; order,
  versions and the dependency graph are derived from the package manifests. Includes
  registry-aware planning (an unpublished manifest version is released as-is; a manifest
  behind the registry refuses), cascade bumps for dependents, internal range rewriting,
  whole-train preflight, `seed-tags` for cold starts, and an optional train summary with
  an assistant-drafted announcement. Prototype: planning phases and `seed-tags` work;
  execution is not wired up yet. Design and usage in TRAIN.md.
- **`--notes <source>`** forces where release notes come from — `changelog`, `assistant`,
  `commits` or `github` — instead of walking the priority list. A named source that produces
  nothing is an error rather than a quiet fall-through. `--assistant` names the tool;
  `--notes` names the source, so making an assistant available no longer leaves it unused
  behind a populated `[Unreleased]`.

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
