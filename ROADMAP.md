# Roadmap

Candidates for future work, ordered by evidence rather than ambition. Everything in
"Known defects" was observed failing or misbehaving in real use; everything below that is a
judgement call and says so.

Nothing here is committed to or scheduled.

## Known defects

Each of these was reproduced, not inferred.

### `--commit` bundles an entire working tree into one commit

It runs `git add --all` and writes a single Conventional Commits subject. Observed against
a Go repository with 9 changed files spanning four concerns, and a Python one with 31. No
honest subject covers that, and the commit is unreviewable afterwards.

Options, roughly in order of cost: refuse above a threshold and say why; group by top-level
directory and write one commit per group; or stage interactively. The first is honest and
cheap, the second is the one people would actually want, and the third duplicates
`git add -p`.

### The drafted commit message is not shown before you approve

The confirmation prompt runs before staging, and the message is drafted from the staged
diff — so with `--commit` you approve a release without seeing the commit message it will
write. Fixing it means either drafting twice (once for preview, once for real) or moving
the prompt after staging, which changes what "confirm" means.

### `--sync` refuses non-Node projects

It skips any directory without a `package.json`, which predates language support. A Rust or
Go project cannot vendor the script even though it runs there perfectly well. The check
should be for a git repository, not a manifest — and the "add a `release` script" hint only
applies where a manifest exists.

### The codex backend is unverified end-to-end

`codex exec`'s flags, stdin behaviour and `--output-last-message` were verified against the
installed CLI, and the integration is exercised against a stub that reproduces its noisy
stdout. But no real `codex` call has ever been made through it — the account hit its usage
limit during development. Treat it as untested until someone runs a release with it.

## Missing infrastructure

### The package ships no tests

Six suites exist — semver arithmetic differentially tested against the real `semver`
package, changelog extraction, draft sanitising, notes cleanup, bump inference, changelog
rolling — plus an integration harness that builds throwaway repositories with a real bare
remote and stubbed `gh`/`npm`. All of it lives outside the repository, which means none of
it protects anyone but the person who wrote it.

Moving it in is the single highest-value item here. It is also the prerequisite for
everything else on this page: a release tool with no reproducible tests is a bad place to
accept contributions.

### No CI

There is no workflow running the check gate or those tests. The tool now emits GitHub
Actions outputs and documents a CI recipe it does not itself use.

### Windows is untested

Never run there. One `execSync` invokes the configured `publish` command through a shell,
which is `cmd.exe` on Windows, so any publish command with shell syntax behaves differently.
Path handling uses `node:path` throughout, so it may well work — but "may well" is the
honest description.

## Considered and declined

Recorded so they are not rediscovered as ideas.

| Idea                                              | Why not                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Release PR workflow, as release-please does       | Needs a bot identity, a persistent branch, and CI to own the process. Adopting it means becoming release-please, and this would be the worse implementation. The value here is that one file run by hand produces a release.                                                                    |
| Monorepo / manifest mode                          | Releasing a nested package is currently a hard refusal, added after it silently released the parent instead. Reversing that is a product decision, not a feature.                                                                                                                               |
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
