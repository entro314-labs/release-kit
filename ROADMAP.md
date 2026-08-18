# Roadmap

Candidates for future work, ordered by evidence rather than ambition. Everything in
"Known defects" was observed failing or misbehaving in real use; everything below that is a
judgement call and says so.

Nothing here is committed to or scheduled.

## Known defects

Each of these was reproduced, not inferred.

### The codex backend is unverified end-to-end

`codex exec`'s flags, stdin behaviour and `--output-last-message` were verified against the
installed CLI, and the integration is exercised against a stub that reproduces its noisy
stdout. But no real `codex` call has ever been made through it — the account hit its usage
limit during development. Treat it as untested until someone runs a release with it.

## Resolved

- **The package shipped no tests.** 63 tests across 6 suites now live in `test/`, run by
  `node --test` with no framework: version arithmetic differentially checked against the real
  `semver` package, changelog reading and rolling, commit parsing and bump inference, draft
  sanitising, version-file rewriting including the `Cargo.lock` scoping hazard, and
  end-to-end releases against real repositories with a real bare remote and stubbed
  `gh`/`npm`. `pnpm test` runs them; `pnpm check` gates on them. The integration suite pins
  the defects found in use rather than the happy path: a tag left behind `HEAD`, a changelog
  rolled twice, a misspelled `--skip` silently ignored, a flag value read as the release
  target, a Python project reaching for npm.
- **No CI.** `.github/workflows/check.yml` runs format, lint and tests on Linux, macOS and
  Windows.
- **`--commit` bundling a whole working tree into one commit.** It still stages everything,
  but the change set is now shown before the prompt and a spread across more than two
  top-level paths is called out as probably more than one piece of work. Splitting commits
  automatically was rejected: it duplicates `git add -p` and guesses at intent.
- **The drafted commit message not being visible before approval.** Staging and drafting now
  happen before the prompt, so the message shown is the one that will be written. Declining
  runs `git reset`, restoring the index exactly — `git add` touches only the index, never the
  working tree.
- **`--sync` refusing non-Node projects.** It now requires a directory rather than a
  manifest, and only suggests wiring up a `release` script where a `package.json` exists.

## Missing infrastructure

### Windows is untested

Never run there by hand. One `execSync` invokes the configured `publish` command through a
shell, which is `cmd.exe` on Windows, so any publish command with shell syntax behaves
differently. It is now in the CI matrix, which will say whether the rest holds — that is a
signal, not a claim.

## Expansion

Requested directions. Several are smaller than they look, because `publish` is already an
arbitrary command — `cargo publish`, `twine upload` and `goreleaser release` all run today.
What is missing is per-tool _preflight_, and recipes for the tools that overlap.

### A GitHub Action

A composite action wrapping the CLI, so a workflow is one `uses:` rather than a `run:` with
a pinned `npx`. Cheap to build. It should come after the repository has CI and tests of its
own, since an action is a second surface to keep working.

### Preflight for more registries

Each registry is a row in `REGISTRIES` declaring how its CLI answers "am I authenticated"
and "does this version exist". Publishing already works without a row; the row buys the
early failure and the skip-if-already-published behaviour.

| Target        | Publish                               | Auth                                     | Already published                           |
| ------------- | ------------------------------------- | ---------------------------------------- | ------------------------------------------- |
| cargo         | `cargo publish`                       | `CARGO_REGISTRY_TOKEN`, or `cargo login` | crates.io API, or `cargo publish --dry-run` |
| Python wheels | `uv publish` _(done)_, `twine upload` | `TWINE_API_TOKEN` for twine              | PyPI JSON API                               |
| RubyGems      | `gem push`                            | `~/.gem/credentials`                     | `gem list --remote --exact`                 |
| NuGet         | `dotnet nuget push`                   | `--api-key`                              | registry API                                |
| Docker / OCI  | `docker push`                         | `docker login`                           | manifest inspect                            |

Two corrections to the original list, so they are not built as stated:

- **pip is not a publish target.** pip installs; PyPI receives. `uv publish` and
  `twine upload` are the two publishers, and `uv` is already supported.
- **winget is not a registry push.** `wingetcreate` opens a pull request against
  `microsoft/winget-pkgs`. That is a submission workflow, not a publish command, and it
  belongs with the build-and-publish tools below rather than in this table.

### Detecting more project files

Currently detected: `package.json`, `pyproject.toml`, `Cargo.toml`, `VERSION`, plus the
module path from `go.mod`. Candidates: `build.gradle`, `pom.xml`, `*.csproj`, `*.gemspec`,
`mix.exs`, `pubspec.yaml`, `composer.json`, `deno.json`, `setup.cfg`.

Worth being clear about the value: the `pattern` escape hatch already handles every one of
these in three lines of config. Detection buys zero-config, not capability, and each format
is a pattern to keep correct as that ecosystem changes its conventions. Adding the ones
people actually use beats adding the long tail.

### Tools that build and publish for you

Resolved as a documented handoff rather than a feature — see "Libraries versus apps"
in the README. release-kit stops at the pushed tag; goreleaser, cargo-dist and similar own
building and the GitHub release. `notesFile` was added so they can consume the notes without
the `%(contents)` signature trap.

What remains: a worked, tested example per tool. Only the goreleaser shape has been reasoned
through against its actual flags; cargo-dist and electron-builder are assumed to be similar
and have not been checked.

### Attaching artifacts built by other Actions

Already possible: a completed release writes `tag` and `release-url` to `$GITHUB_OUTPUT`, so
a later job can `gh release upload ${{ steps.release.outputs.tag }} …`. The `assets` config
covers files that exist before the release runs; anything built afterwards uploads to the
tag. What is missing is worked examples, and guidance on which of the two orderings to use.

## Considered and declined

Recorded so they are not rediscovered as ideas.

| Idea                                              | Why not                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Release PR workflow, as release-please does       | Needs a bot identity, a persistent branch, and CI to own the process. Adopting it means becoming release-please, and this would be the worse implementation. The value here is that one file run by hand produces a release.                                                                    |
| Monorepo / manifest mode                          | Resolved by `train.mjs` (TRAIN.md) rather than a mode: the orchestrator is the one caller that knows which nested directory it means. `release-kit` invoked directly on a nested package keeps the hard refusal, added after it silently released the parent instead.                           |
| An OAuth app for GitHub                           | `gh` already is one, with device flow, keychain storage, enterprise hosts and scope refresh. Rebuilding that in a dependency-free file means doing it worse, and asking users to authorise a new third party rather than the `gh` they already trust.                                           |
| Importing signing keys from environment variables | Writing a private key to disk from an environment variable is a footgun: persisted file, wrong permissions, easy to leak into logs. `webfactory/ssh-agent` and `crazy-max/ghaction-import-gpg` do it properly.                                                                                  |
| A compiled binary, to drop the Node requirement   | Would genuinely help Rust, Python and Go users, who currently must install Node. But it ends the "one file you can read, vendor, and pipe into `node`" property, and adds a build and release matrix. Worth revisiting only if non-Node adoption makes the Node requirement the actual blocker. |

## Open questions

Things that need investigation before they could even be scoped.

- **Forges other than GitHub.** The `release` step is `gh` and nothing else. GitLab and Gitea
  have their own CLIs and release APIs. Whether that is a step-level abstraction or simply
  out of scope is undecided; nobody has asked for it.
- **Prerelease promotion.** Cutting `2.0.0-rc.1` works, and promoting it to `2.0.0` is a
  plain `patch`. Whether the dist-tag should then move, and whether prior release candidates
  should be marked superseded, has not been thought through.
- **Assistant cost.** Each drafting call allows 180 seconds and a release can make two.
  There is no budget, no token accounting, and no way to cap spend.
- **How much the deterministic changelog reduces the case for an assistant.** Grouping
  commits by type produces decent notes with nothing installed. It is not obvious how much
  the assistant adds on top, and that is worth measuring before building more around it.
