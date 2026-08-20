#!/usr/bin/env node
/**
 * Drop-in atomic release for any JS/TS/Node project.
 *
 * Version bump → changelog roll → commit → annotated tag → push → registry publish →
 * GitHub release. It imports nothing but `node:*`, which is why the same file works
 * installed as a package, run through `npx`, or vendored into a project's `scripts/`.
 *
 *   pnpm add -D @entro314labs/release-kit    then "release": "release-kit"
 *   npx @entro314labs/release-kit            no install
 *   npx @entro314labs/release-kit --sync .   vendor it as scripts/release.mjs
 *
 *   release-kit                               release the version already in package.json
 *   release-kit 2.3.0                         release an explicit version
 *   release-kit minor                         bump from the current version
 *   release-kit prerelease --preid beta
 *   release-kit --dry-run                     print every step, execute nothing
 *   release-kit --help                        full flag list
 *
 * Two properties shape the design:
 *
 *  - Preflight accumulates. Every check runs and every failure is reported before it
 *    aborts once with the whole list, rather than stopping at the first problem.
 *  - Every step is idempotent. A run interrupted partway through (a publish timeout, a
 *    network failure) can be re-run: an already-written version, an existing tag at HEAD,
 *    an already-published version and an existing release are each detected and skipped.
 *    There is no cleanup step and no --resume flag.
 *
 * Configuration is optional. Defaults are the conventions (package.json version,
 * CHANGELOG.md, main branch, `v` tag prefix, npm publish); a release.config.json beside
 * package.json overrides only what differs. See CONFIG below.
 */

import { execFileSync, execSync } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline/promises'

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Defaults, overridden per-key by release.config.json.
 *
 * Command and message strings expand four tokens: %v version, %t tag, %n package name,
 * %d npm dist-tag.
 *
 *   tagPrefix       string   prepended to the version to form the tag
 *   branch          string   the only branch a release may run from; null to allow any
 *   remote          string   git remote to push to
 *   changelog       string   changelog path; null to disable changelog handling
 *   versionFile     string|object|null  where the project's version lives. Detected from
 *                            the repository when unset; null when it versions by tag alone
 *   versionFiles    array    further files whose version is kept in sync; each is a path
 *                            or { path, pattern }. Written even where versionFile is null,
 *                            which is how a language with no version of its own — a Go
 *                            module — keeps one in source. When neither this nor
 *                            versionFile is configured, a second root manifest and a
 *                            conventional version constant already on the same version are
 *                            detected and kept in step
 *   publish         string|string[]  publish command, or several for a project that
 *                            releases to more than one registry. Detected from the version
 *                            sources when unset, and only where unambiguous; null to
 *                            publish nothing
 *   commitMessage   string   release commit subject
 *   releaseTitle    string   GitHub release title
 *   assets          string[] files attached to the GitHub release
 *   notesFile       string   write the resolved release notes here, for a build tool that
 *                            takes them as a file (goreleaser --release-notes, and similar)
 *   notes           string   where release notes come from: "auto" tries the changelog,
 *                            then an assistant, then the commits; or force one of
 *                            changelog / assistant / commits / github
 *   hiddenTypes     string[] commit types to leave out of the notes; empty means report all
 *   ignoreCommits   string[] regexes for commits that are bookkeeping rather than change:
 *                            release commits, merges, work-in-progress, autosquash markers
 *   versioning      string   how `auto` derives a bump: "conventional", or
 *                            always-patch / always-minor / always-major to never infer
 *   verify          string   command run during preflight — a project's own gate (tests,
 *                            build). Non-zero aborts before anything mutates, instead of a
 *                            prepublishOnly hook failing after the commit, tag and push
 *   assistant       string|object  drafting CLI for commit messages and notes. A key of
 *                            ASSISTANTS, "auto" for the first available, or null. The
 *                            object form { tool, model, effort } also pins which model and
 *                            reasoning effort that CLI is invoked with.
 */
/**
 * The release pipeline, in the only order that is safe to run it. `steps` selects which of
 * these execute; it never reorders them — publishing before tagging, or pushing before
 * committing, is a mistake the tool should not let you express.
 *
 *   commit     commit a dirty working tree (opt-in; touches work that predates the release)
 *   version    write the version into the version source and versionFiles
 *   changelog  roll [Unreleased] into the version, or add drafted notes
 *   tag        annotated git tag carrying the release notes
 *   push       push the branch and the tag together
 *   publish    run the configured publish command(s), in order
 *   release    create the GitHub release
 *
 * `version` and `changelog` write files; those writes are persisted by a release commit
 * made automatically when either step runs.
 */
const STEPS = ['commit', 'version', 'changelog', 'tag', 'push', 'publish', 'release']

/**
 * All seven. `commit` is a conditional default: it no-ops on a clean tree, and on a dirty
 * tree it proceeds only when a drafting assistant is configured — otherwise preflight
 * still refuses the unclean tree. Opt out with `--skip commit` or a `steps` config.
 */
const DEFAULT_STEPS = [...STEPS]

const DEFAULTS = {
  steps: DEFAULT_STEPS,
  tagPrefix: 'v',
  branch: 'main',
  remote: 'origin',
  changelog: 'CHANGELOG.md',
  versionFile: undefined,
  versionFiles: [],
  publish: undefined,
  commitMessage: 'chore(release): %t',
  releaseTitle: '%t',
  assets: [],
  assistant: null,
  notesFile: null,
  versioning: 'conventional',
  notes: 'auto',
  hiddenTypes: [],
  ignoreCommits: [
    '^chore\\(release\\)',
    '^Merge (branch|pull request|remote)',
    '^wip\\b',
    '^(fixup|squash)!',
  ],
  verify: null,
}

/**
 * Prerelease identifiers that map to their own npm dist-tag. An identifier outside this
 * set has no safe home, so `distTagFor` refuses rather than letting a prerelease fall
 * through to `latest` and clobber the stable line.
 */
const KNOWN_CHANNELS = new Set(['alpha', 'beta', 'canary', 'next', 'nightly', 'rc'])

/**
 * How this script was invoked, so --help prints a command that actually works: the bin
 * name when it is installed as a package, `node <path>` when it is vendored as a file.
 */
const INVOCATION = process.argv[1]?.includes(`${sep}node_modules${sep}`)
  ? 'release-kit'
  : `node ${relative(process.cwd(), process.argv[1] ?? 'release.mjs') || 'release.mjs'}`

const USAGE = `
release-kit — tag, publish, and release a JS/TS/Node project.

  ${INVOCATION} [<version>|<bump>] [flags]

Target (optional; defaults to the version already in package.json):
  <x.y.z>              release this exact version
  patch minor major    bump from the current version
  prepatch preminor premajor prerelease
                       prerelease bump; needs --preid unless it can be inferred

Steps, in the fixed order they run. All but "commit" run by default:
  ${STEPS.join('  ')}

Subcommands (they check or copy, and never start a release):
  lint-commits [<range>]
                       check commit subjects against Conventional Commits
                       (default range: since the last tag)
  lint-commits --subject <text>
                       check one subject — a pull request title before it is squashed

Flags:
  --only <steps>       run only these steps, comma-separated
  --skip <steps>       run every step except these
  --commit             force the commit step on when a steps config removed it:
                       commit a dirty working tree with a
                       drafted Conventional Commits message instead of refusing to release
  --preid <id>         prerelease identifier (alpha, beta, rc, next, nightly, canary)
  --dist-tag <name>    override the npm dist-tag (default: derived from the version)
  --dry-run            print every step and execute nothing
  --yes, -y            skip the confirmation prompt
  --notes-file <path>  write the resolved release notes to a file for the next tool
  --notes <source>     where notes come from: auto, changelog, assistant, commits, github
  --assistant <name>   drafting CLI to use: auto, none, claude, codex
  --assistant-model <name>
                       model the assistant runs with (e.g. sonnet, opus)
  --assistant-effort <level>
                       reasoning effort the assistant runs with (low … max)
  --sync <dir>...      copy this script into other projects' scripts/ and exit
  --help, -h           show this

Config: release.config.json beside package.json overrides any of
  ${Object.keys(DEFAULTS).join(', ')}
`

// ─────────────────────────────────────────────────────────────────────────────
// OUTPUT
// ─────────────────────────────────────────────────────────────────────────────

const TTY = !!process.stdout.isTTY
const paint = (code, s) => (TTY ? `\u001B[${code}m${s}\u001B[0m` : s)
const bold = (s) => paint('1', s)
const dim = (s) => paint('2', s)
const green = (s) => paint('32', s)
const red = (s) => paint('31', s)
const yellow = (s) => paint('33', s)

let stepNumber = 0
const step = (title) => console.log(`\n${bold(`[${++stepNumber}] ${title}`)}`)
const ok = (message) => console.log(`  ${green('ok')}   ${message}`)
const warn = (message) => console.log(`  ${yellow('warn')} ${message}`)
const note = (message) => console.log(`  ${dim(message)}`)
const indent = (text) =>
  text
    .split('\n')
    .map((line) => `       ${line}`)
    .join('\n')

/**
 * Re-pad `git status --porcelain` entries so the two-column status code lines up. The
 * raw output is trimmed on capture, which strips the leading space off the first entry
 * only — ` M file` becomes `M file` while the rest keep theirs, misaligning the column.
 */
const formatStatus = (porcelain) =>
  porcelain
    .split('\n')
    .map((line) => {
      const entry = line.trim()
      const gap = entry.indexOf(' ')
      return gap === -1 ? entry : `${entry.slice(0, gap).padEnd(2)} ${entry.slice(gap + 1)}`
    })
    .join('\n')

function abort(message, title = 'RELEASE ABORTED') {
  console.log(`\n${red(bold(title))} — ${message}\n`)
  process.exit(1)
}

/**
 * A command failed after the release started mutating. The command has already printed its
 * own error to stderr, so say only what that does not: where it stopped, and that this is
 * resumable. Without this the process dies on an unhandled child-process error and buries
 * the real cause under a Node stack trace.
 */
function abortMidRelease(commandLine) {
  abort(
    `\`${commandLine}\` failed — see its output above.\n\n` +
      '  The release stopped partway through. Fix the cause and re-run the same command:\n' +
      '  the steps that already completed are detected and skipped.',
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// COMMANDS
// ─────────────────────────────────────────────────────────────────────────────

/** Read-only command → trimmed stdout. Throws on a non-zero exit. Always executes. */
function read(command, args) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

/**
 * Whether GitHub knows the key git signs with.
 *
 * Compares key material rather than fingerprints, so no extra process is spawned per key.
 *
 * @returns {boolean | null} null when it cannot be determined — gh missing, token without
 *   the scope to list signing keys, or no network. An unanswerable check is not a failure.
 */
function signingKeyRegistered(keyPath) {
  const local = readFileSync(keyPath, 'utf8').trim().split(/\s+/)[1]
  if (!local) return null
  const listed = tryRead('gh', ['api', 'user/ssh_signing_keys', '--jq', '.[].key'])
  if (listed === null) return null
  return listed.split('\n').some((key) => key.trim().split(/\s+/)[1] === local)
}

/** Read-only command → trimmed stdout, or null when it exits non-zero. */
function tryRead(command, args) {
  try {
    return read(command, args)
  } catch {
    return null
  }
}

/**
 * Whether a read-only command exits zero. Separate from `tryRead` because a command can
 * succeed while printing nothing, and "no output" must not read as "failed".
 */
const succeeds = (command, args) => tryRead(command, args) !== null

// ─────────────────────────────────────────────────────────────────────────────
// ASSISTANTS — optional CLIs that draft prose (commit messages, release notes)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Drafting tools, tried in this order when `assistant` is "auto". Each is a CLI that
 * reads a prompt on stdin and writes plain text to stdout. Supporting another harness is
 * one row here; nothing else in the file names a specific tool.
 */
const ASSISTANTS = {
  claude: {
    command: 'claude',
    args: ['-p'],
    probe: ['--version'],
    model: (m) => ['--model', m],
    effort: (e) => ['--effort', e],
  },
  codex: {
    command: 'codex',
    args: ['exec', '--skip-git-repo-check', '--sandbox', 'read-only'],
    probe: ['--version'],
    model: (m) => ['-m', m],
    effort: (e) => ['-c', `model_reasoning_effort="${e}"`],
    // `codex exec` streams session scaffolding (MCP notices, hook logs) to stdout, so the
    // answer is only clean when written to a file with --output-last-message.
    outputFile: (path) => ['--output-last-message', path],
  },
}

/** How long a draft may take before the release gives up and falls back. */
const DRAFT_TIMEOUT_MS = 180_000

/**
 * Lines a drafting tool may append that must never reach a commit message or release
 * notes: attribution for the tool itself, and the markdown fences models wrap output in.
 */
function cleanDraft(text) {
  return text
    .replace(/^\s*```[a-z]*\s*\n?/i, '')
    .replace(/\n?```\s*$/, '')
    .split('\n')
    .filter(
      (line) =>
        !/^\s*co-authored-by:/i.test(line) &&
        !/^\s*(🤖\s*)?generated with/i.test(line) &&
        !/^\s*signed-off-by:\s*claude/i.test(line),
    )
    .join('\n')
    .trim()
}

/**
 * Release notes carry two artefacts a commit message does not: stray code fences around
 * part of the output, and a trailing paragraph explaining the model's reasoning. Keep the
 * document only up to its last heading or list item; prose after that is commentary.
 */
function cleanNotes(text) {
  const lines = cleanDraft(text)
    .split('\n')
    .filter((line) => !/^\s*```/.test(line))
  let end = lines.length
  while (end > 0) {
    const line = lines[end - 1]
    if (!line.trim()) {
      end -= 1
      continue
    }
    // A heading, a bullet, or an indented continuation of a bullet: the document proper.
    if (/^\s*[-*+] /.test(line) || /^#{1,6} /.test(line) || /^\s+\S/.test(line)) break
    end -= 1
  }
  return lines.slice(0, end).join('\n').trim() || null
}

/**
 * Run the selected assistant against a prompt.
 *
 * Every failure mode — not installed, not authenticated, timed out, empty answer — returns
 * null rather than throwing. Drafting is a convenience; a release must never be blocked
 * because a text generator was unavailable.
 *
 * @returns {string | null} the cleaned draft, or null when unavailable
 */
function runAssistant(prompt) {
  if (!assistant) return null

  const args = [...assistant.args]
  if (assistantModel && assistant.model) args.push(...assistant.model(assistantModel))
  if (assistantEffort && assistant.effort) args.push(...assistant.effort(assistantEffort))

  // Tools whose stdout carries session scaffolding hand back the answer through a file.
  const answerFile = assistant.outputFile
    ? join(mkdtempSync(join(tmpdir(), 'release-kit-')), 'answer.md')
    : null
  if (answerFile) args.push(...assistant.outputFile(answerFile))

  try {
    const stdout = execFileSync(assistant.command, args, {
      input: prompt,
      encoding: 'utf8',
      timeout: DRAFT_TIMEOUT_MS,
      stdio: ['pipe', 'pipe', 'ignore'],
      maxBuffer: 10 * 1024 * 1024,
    })
    const answer = answerFile
      ? existsSync(answerFile)
        ? readFileSync(answerFile, 'utf8')
        : ''
      : stdout
    return cleanDraft(answer) || null
  } catch {
    return null
  }
}

/**
 * The repository's release tags that are reachable from HEAD, highest version first.
 *
 * `git describe --tags --abbrev=0` answers a different question — "the nearest tag of any
 * kind" — and it is wrong in two ways that were both observed. A repository carrying tags
 * that are not releases gets one of those as its baseline: a single rolling `latest-beta`
 * marker, which tauri-release-kit maintains for its update channels, made a release abort
 * with "no releasable commits since latest-beta". And "nearest ancestor" is not "latest
 * release": a patch tagged on top of a later minor drags the baseline backwards.
 *
 * Only tags carrying the configured prefix and a parseable version count, and they are
 * ordered by semver precedence rather than by position in the history. `--merged HEAD`
 * keeps a tag made on another branch out of this branch's history, and degrades correctly
 * in a shallow clone: a tag whose commit was not fetched is simply not listed.
 *
 * @returns {{name: string, version: string}[]}
 */
function releaseTags(prefix = config.tagPrefix ?? '') {
  const listed = tryRead('git', ['tag', '--list', `${prefix}*`, '--merged', 'HEAD']) ?? ''
  return listed
    .split('\n')
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => ({ name, version: name.slice(prefix.length) }))
    .filter(({ version }) => parseVersion(version))
    .sort((a, b) => compareVersions(b.version, a.version))
}

/**
 * The tag a release reads its history from.
 *
 * @param {{stable?: boolean}} [options] `stable` when the version being released has no
 *   prerelease identifier, which rolls the release candidates leading to it up into it:
 *   their work is what is shipping now, and reading from the last candidate describes only
 *   the gap between the last two candidates. Promoting `2.0.0-rc.2` to `2.0.0` that way
 *   produced empty notes, because the one commit in range was the release chore.
 *   Releasing a candidate keeps the full ordering, so each candidate's notes say what
 *   changed in that candidate rather than repeating the whole cycle.
 * @returns {string | null}
 */
function lastReleaseTag({ stable = false, prefix } = {}) {
  const tags = releaseTags(prefix)
  const eligible = stable ? tags.filter(({ version }) => !parseVersion(version).pre.length) : tags
  return eligible[0]?.name ?? null
}

/** Commit subjects since the last release tag, with release and merge commits filtered out. */
function commitsSinceLastTag(options) {
  const ignored = (config.ignoreCommits ?? []).map((pattern) => new RegExp(pattern, 'i'))
  const lastTag = lastReleaseTag(options)
  const range = lastTag ? `${lastTag}..HEAD` : 'HEAD'
  // %B is the whole message: bodies carry BREAKING CHANGE and Release-As footers. A record
  // separator keeps multi-line messages parseable when splitting the log back apart.
  // %h first, then the message: the hash is what links each bullet back to its commit.
  const raw = tryRead('git', ['log', `--format=%h%x1f%B%x1e`, range]) ?? ''
  const commits = raw
    .split('\u001E')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [hash, message = ''] = entry.split('\u001F')
      const [subject, ...rest] = message.split('\n')
      return { hash: hash.trim(), subject: subject.trim(), body: rest.join('\n').trim() }
    })
    // Bookkeeping rather than change: the previous release's own commit, merges that
    // duplicate the branch they bring in, and markers meant to be autosquashed away.
    .filter(({ subject }) => subject && !ignored.some((re) => re.test(subject)))
  const kept = withoutRevertedCommits(commits)
  return { lastTag, commits: kept, subjects: kept.map((c) => c.subject) }
}

/**
 * Conventional Commit types and the changelog heading each lands under.
 *
 * Every type is reported. release-please and goreleaser hide `chore`, `ci`, `docs` and the
 * rest by default, on the view that a reader upgrading does not care — but a changelog is a
 * record, and silently omitting work makes it a partial one. A project that wants the
 * shorter version lists the types to drop in `hiddenTypes`.
 */
const CHANGELOG_SECTIONS = [
  { type: 'feat', section: 'Features' },
  { type: 'fix', section: 'Bug Fixes' },
  { type: 'perf', section: 'Performance Improvements' },
  { type: 'revert', section: 'Reverts' },
  { type: 'deps', section: 'Dependencies' },
  { type: 'docs', section: 'Documentation' },
  { type: 'refactor', section: 'Code Refactoring' },
  { type: 'build', section: 'Build System' },
  { type: 'ci', section: 'Continuous Integration' },
  { type: 'test', section: 'Tests' },
  { type: 'style', section: 'Styles' },
  { type: 'chore', section: 'Miscellaneous Chores' },
]

/**
 * Parse a commit into the parts a release cares about.
 *
 * @returns {{type: string, scope: string|null, breaking: boolean, subject: string,
 *   releaseAs: string|null} | null} null when the subject is not Conventional Commits
 */
function parseCommit(subject, body = '', hash = '') {
  // Conventional Commits does not restrict the type to letters — `i18n:` and `a11y:` are
  // types people really use, and `[a-z]+` silently failed to parse them at all.
  const match = /^([a-z][a-z0-9-]*)(?:\(([^)]+)\))?(!)?: (.+)$/i.exec(subject)
  if (!match) return null
  const [, type, scope, bang, text] = match
  const shortHash = hash.slice(0, 7)
  // A breaking change is marked either by `!` in the header or a BREAKING CHANGE footer.
  const breaking = !!bang || /^BREAKING[ -]CHANGE:/m.test(body)
  // `Release-As: 1.2.3` in a commit body pins the next version, so the decision can live
  // in git history rather than on the command line.
  const releaseAs = /^Release-As:\s*v?(\S+)/im.exec(body)?.[1] ?? null
  // Issues this commit closes, so the notes can link them the way a reader expects.
  const closes = [...`${subject}\n${body}`.matchAll(CLOSES)].map((m) => m[1])
  // A BREAKING CHANGE footer usually explains the break far better than the subject does.
  const breakingNote =
    /^BREAKING[ -]CHANGE:\s*([\s\S]+?)(?=\n\n|$)/m.exec(body)?.[1]?.trim() ?? null
  return {
    type: type.toLowerCase(),
    scope: scope ?? null,
    breaking,
    subject: text,
    hash: shortHash,
    releaseAs,
    closes: [...new Set(closes)],
    breakingNote,
  }
}

/**
 * The bump implied by a set of commits, following release-please's default strategy:
 * a breaking change is major, a feature is minor, anything else is a patch.
 *
 * Below 1.0.0 that is usually wrong — a breaking change in a 0.x project conventionally
 * bumps the minor, not to 1.0.0 — so `preMajor` softens both by one level.
 *
 * @returns {{bump: string, breaking: string[], features: string[], releaseAs: string|null}}
 */
function inferBump(commits, currentVersion, strategy = 'conventional') {
  const parsed = commits.map((c) => parseCommit(c.subject, c.body, c.hash)).filter(Boolean)
  const releaseAs = parsed.find((c) => c.releaseAs)?.releaseAs ?? null
  const breaking = parsed.filter((c) => c.breaking).map((c) => c.subject)
  const features = parsed
    .filter((c) => !c.breaking && /^feat(ure)?$/.test(c.type))
    .map((c) => c.subject)

  if (strategy !== 'conventional') {
    return { bump: strategy.replace(/^always-/, ''), breaking, features, releaseAs }
  }

  const preMajor = currentVersion ? parseVersion(currentVersion)?.major === 0 : false
  let bump = 'patch'
  if (breaking.length) bump = preMajor ? 'minor' : 'major'
  else if (features.length) bump = 'minor'
  return { bump, breaking, features, releaseAs }
}

/**
 * Group commits into changelog sections, hiding the types that are not release notes.
 * Deterministic and offline: this is what a project gets without an assistant.
 *
 * @returns {string | null} markdown body, or null when nothing visible changed
 */
function changelogFromCommits(commits, links = null, hidden = []) {
  const parsed = commits.map((c) => parseCommit(c.subject, c.body, c.hash)).filter(Boolean)
  const lines = []

  /** One bullet: scope, text, a link to the commit, and any issues it closes. */
  const bullet = (commit, text) => {
    const scope = commit.scope ? `**${commit.scope}:** ` : ''
    const parts = []
    if (links && commit.hash) parts.push(`([${commit.hash}](${links.commit}/${commit.hash}))`)
    if (commit.closes.length) {
      const issues = commit.closes.map((n) => (links ? `[#${n}](${links.issue}/${n})` : `#${n}`))
      parts.push(`closes ${issues.join(', ')}`)
    }
    return `- ${scope}${text}${parts.length ? ` ${parts.join(', ')}` : ''}`
  }

  const breaking = parsed.filter((c) => c.breaking)
  if (breaking.length) {
    lines.push('### ⚠ BREAKING CHANGES', '')
    // The footer explains the break; the subject only says what changed.
    for (const c of breaking) lines.push(bullet(c, c.breakingNote ?? c.subject))
    lines.push('')
  }

  const known = new Set(CHANGELOG_SECTIONS.map((s) => s.type))
  const hiddenTypes = new Set(hidden)
  for (const { type, section } of CHANGELOG_SECTIONS) {
    if (hiddenTypes.has(type)) continue
    const inSection = parsed.filter(
      (c) => c.type === type || (type === 'feat' && c.type === 'feature'),
    )
    if (!inSection.length) continue
    lines.push(`### ${section}`, '')
    for (const c of inSection) lines.push(bullet(c, c.subject))
    lines.push('')
  }

  // A conventional type nobody anticipated — `security:`, `i18n:` — is still a change
  // someone made deliberately. Dropping it silently is how a security fix goes unmentioned.
  // The hidden types are excluded because hiding them is the point.
  const other = parsed.filter(
    (c) => !known.has(c.type) && c.type !== 'feature' && !hiddenTypes.has(c.type),
  )
  if (other.length) {
    lines.push('### Other Changes', '')
    for (const c of other) lines.push(bullet(c, c.subject))
    lines.push('')
  }

  return lines.length ? lines.join('\n').trim() : null
}

/**
 * Per-forge URL shapes and the words that close an issue, following
 * @semantic-release/release-notes-generator's hosts-config. The path segments genuinely
 * differ: Bitbucket uses /issue/ and /commits/ where GitHub uses /issues/ and /commit/.
 */
const HOSTS = {
  'github.com': { issue: 'issues', commit: 'commit' },
  'gitlab.com': { issue: 'issues', commit: 'commit' },
  'bitbucket.org': { issue: 'issue', commit: 'commits' },
}
const DEFAULT_HOST = { issue: 'issues', commit: 'commit' }

/** Words that mark an issue reference as closed by the commit. */
const CLOSES = /\b(?:close[sd]?|closing|fix(?:e[sd])?|fixing|resolve[sd]?|resolving)\s+#(\d+)/gi

/**
 * The repository behind `origin`, for building links.
 *
 * Handles both URL forms git uses: `https://host/owner/repo.git` and the SCP-like
 * `git@host:owner/repo.git`, which is not a URL and does not parse as one.
 *
 * @returns {{base: string, issue: string, commit: string} | null}
 */
function remoteLinks(remote) {
  const url = tryRead('git', ['remote', 'get-url', remote])
  if (!url) return null
  const scp = /^(?:[^@]+@)?([^:/]+):(.+?)(?:\.git)?$/.exec(url.replace(/^ssh:\/\//, ''))
  const web = /^[a-z+]+:\/\/(?:[^@]+@)?([^/]+)\/(.+?)(?:\.git)?$/i.exec(url)
  const [, host, path] = web ?? scp ?? []
  if (!host || !path) return null
  const shape = HOSTS[host.toLowerCase()] ?? DEFAULT_HOST
  return {
    base: `https://${host}/${path}`,
    issue: `https://${host}/${path}/${shape.issue}`,
    commit: `https://${host}/${path}/${shape.commit}`,
  }
}

/**
 * Drop commits that were reverted within the same release, and the reverts themselves —
 * neither belongs in notes describing what changed. A `git revert` records the reverted
 * hash in its body, which is what pairs them up.
 */
function withoutRevertedCommits(commits) {
  const reverted = new Set()
  for (const { body } of commits) {
    const match = /This reverts commit ([0-9a-f]{7,40})/i.exec(body ?? '')
    if (match) reverted.add(match[1].slice(0, 7))
  }
  if (!reverted.size) return commits
  return commits.filter(
    (c) => !reverted.has((c.hash ?? '').slice(0, 7)) && !/This reverts commit/i.test(c.body ?? ''),
  )
}

/**
 * Semver strings a drafted message names that the staged changes never touch. The prompt
 * forbids narrating versions, but a model can still read an unchanged `"version"` context
 * line and describe it as work — a draft once claimed "release v1.4.5" for a commit that
 * changed no version at all. Only added and removed lines are the change.
 */
function inventedVersions(message, changedLines) {
  const versions = message.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/g) ?? []
  return [...new Set(versions)].filter((version) => !changedLines.includes(version))
}

/**
 * A repository URL reduced to what identifies the repository: `git+` and protocol
 * prefixes, the `git@host:` shorthand, a trailing `.git` and letter case all vary between
 * package.json and a git remote without meaning a different repo.
 */
function normalizeRepoUrl(url) {
  if (!url) return null
  return url
    .trim()
    .replace(/^git\+/, '')
    .replace(/^git@([^:]+):/, 'https://$1/')
    .replace(/^ssh:\/\/git@/, 'https://')
    .replace(/^git:\/\//, 'https://')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '')
    .toLowerCase()
}

/**
 * A deterministic Conventional Commits message built from the staged file list — the
 * floor under the drafting assistant. A release is never blocked because a text
 * generator was unavailable or produced an unusable answer: the honest fallback is a
 * chore commit that names what it touches, with the full paths in the body.
 */
function fallbackCommitMessage(files) {
  const named = `chore: update ${files.map((file) => basename(file)).join(' and ')}`
  const subject =
    files.length > 0 && files.length <= 2 && named.length <= 72
      ? named
      : `chore: update ${files.length} files`
  const body = files.length > 2 ? files.map((file) => `- ${file}`).join('\n') : ''
  return body ? `${subject}\n\n${body}` : subject
}

/**
 * The types worth writing: every one has a changelog section of its own.
 *
 * Derived from CHANGELOG_SECTIONS rather than written out again, because the hand-kept
 * copy had already drifted — it omitted `deps`, so the drafter could never produce a
 * subject for the Dependencies section the changelog has always had.
 */
const CHANGELOG_TYPES = CHANGELOG_SECTIONS.map((s) => s.type)

/** The drafter's types plus `feature`, the alias `changelogFromCommits` folds into feat. */
const KNOWN_TYPES = new Set([...CHANGELOG_TYPES, 'feature'])
const CONVENTIONAL_RE = new RegExp(`^(${[...KNOWN_TYPES].join('|')})(\\([^)]+\\))?!?: .+`)

/**
 * Check commit subjects against the grammar the rest of this file reads.
 *
 * Two severities, because the two failures do not cost the same:
 *
 *  - A subject `parseCommit` cannot read is invisible. It contributes nothing to the
 *    inferred bump and never reaches the changelog, so the work simply disappears.
 *  - A type outside CHANGELOG_SECTIONS is merely unfiled: `changelogFromCommits` still
 *    prints it under "Other Changes". `security:` and `i18n:` warn rather than fail —
 *    refusing them would make this stricter than the tool it is meant to protect.
 *
 * Case is not one of the failures: `parseCommit` folds the type, so `Feat:` bumps and files
 * exactly as `feat:` does. The drafter is stricter about its own output than this is about
 * anybody's commits, and deliberately so.
 *
 * @param {{subject: string, hash?: string}[]} commits
 * @returns {{subject: string, hash: string, level: 'error'|'warn', reason: string}[]}
 */
function lintSubjects(commits) {
  const findings = []
  for (const { subject, hash = '' } of commits) {
    const parsed = parseCommit(subject)
    if (!parsed) {
      findings.push({
        subject,
        hash,
        level: 'error',
        reason: `not Conventional Commits — expected "<type>(<scope>): <description>" with type one of ${CHANGELOG_TYPES.join(', ')}`,
      })
    } else if (!KNOWN_TYPES.has(parsed.type)) {
      findings.push({
        subject,
        hash,
        level: 'warn',
        reason: `type "${parsed.type}" has no changelog section — it lands under "Other Changes"`,
      })
    }
  }
  return findings
}

/**
 * Draft a Conventional Commits message for the staged changes.
 *
 * @returns {string | null} a message whose subject is valid Conventional Commits, or null
 */
function draftCommitMessage() {
  const stat = tryRead('git', ['diff', '--cached', '--stat'])
  // Cap the diff: a large one wastes the context window and rarely improves the subject.
  const diff = tryRead('git', ['diff', '--cached', '--unified=1'])?.slice(0, 12_000)
  if (!stat) return null

  const prompt = [
    'Write a Conventional Commits message for these staged changes.',
    '',
    'Rules:',
    `- Subject: "<type>(<optional scope>): <description>" where type is one of ${CHANGELOG_TYPES.join(', ')}.`,
    '- Subject in the imperative mood, no trailing period, under 72 characters.',
    '- Add a body only if the change needs explanation; separate it with a blank line.',
    '- Output the raw commit message and nothing else: no markdown fences, no preamble.',
    '- Do NOT add Co-Authored-By, Signed-off-by, or any attribution or tool credit.',
    '- Describe only lines that are added or removed in the diff. Unchanged context lines',
    '  (including any version fields they show) are not part of this change.',
    '- Never mention version numbers, releases, or version bumps: the release tooling',
    '  handles versioning separately, and this commit is not the release.',
    '',
    'Files changed:',
    stat,
    '',
    'Diff:',
    diff ?? '(unavailable)',
  ].join('\n')

  const message = runAssistant(prompt)
  if (!message) return null
  const [subject] = message.split('\n')
  if (!CONVENTIONAL_RE.test(subject)) return null
  // The prompt forbids narrating versions; this is the deterministic backstop — the same
  // pattern as the citation check on drafted notes: validated, not trusted.
  const changedLines = (tryRead('git', ['diff', '--cached', '--unified=0']) ?? '')
    .split('\n')
    .filter((line) => /^[+-](?![+-])/.test(line))
    .join('\n')
  const invented = inventedVersions(message, changedLines)
  if (invented.length) {
    note(`draft rejected: it names ${invented.join(', ')}, which the staged changes never touch`)
    return null
  }
  return message
}

/**
 * Draft release notes from the commits since the last tag, in the changelog's own style.
 *
 * @returns {string | null} markdown body (no version heading), or null
 */
/**
 * Attach commit links to a drafted bullet's citation.
 *
 * The model is asked to end each bullet with the short hashes it covers. Models invent
 * plausible-looking hashes, so every citation is checked against the commits that actually
 * exist: real ones become links, invented ones are removed rather than published.
 *
 * @returns {string} the notes with citations resolved
 */
function linkCitedCommits(notes, commits, links) {
  const known = new Set(commits.map((c) => (c.hash ?? '').slice(0, 7)).filter(Boolean))
  return notes.replace(/\s*\(([0-9a-f]{7,40}(?:\s*,\s*[0-9a-f]{7,40})*)\)\s*$/gim, (_, cited) => {
    const real = [
      ...new Set(cited.split(/\s*,\s*/).map((h) => h.toLowerCase().slice(0, 7))),
    ].filter((h) => known.has(h))
    if (!real.length) return ''
    const rendered = links
      ? real.map((h) => `[${h}](${links.commit}/${h})`)
      : real.map((h) => `\`${h}\``)
    return ` (${rendered.join(', ')})`
  })
}

/**
 * Draft release notes from the commit log.
 *
 * @returns {string | null} markdown body (no version heading), or null
 */
function draftReleaseNotes(version, commits, lastTag, links) {
  if (!commits.length) return null

  const prompt = [
    `Write release notes for version ${version}.`,
    '',
    'Rules:',
    '- Group the changes under Keep a Changelog headings (`### Added`, `### Changed`,',
    '  `### Fixed`, `### Removed`), including only the headings that apply.',
    '- One bullet per user-visible change. Merge related commits into a single bullet.',
    '- End every bullet with the short hashes it covers, in parentheses: `(abc1234)` or',
    '  `(abc1234, def5678)` when merged. Copy them exactly from the list below and invent',
    '  nothing — a hash that is not in the list will be removed.',
    '- Omit internal chores: CI, linting, formatting, dependency bumps, version bumps.',
    '- Write for someone upgrading: say what changed for them, not which files moved.',
    '- Plain, factual language. No hype, no emoji, no concluding summary.',
    '- Output only the markdown body: no version heading, no code fences, no attribution.',
    '- Do NOT explain your reasoning or add any commentary before or after the notes.',
    '',
    `Commits since ${lastTag ?? 'the start of the project'}:`,
    ...commits.map((c) => `- ${(c.hash ?? '').slice(0, 7)} ${c.subject}`),
  ].join('\n')

  const drafted = runAssistant(prompt)
  if (!drafted) return null
  const cleaned = cleanNotes(drafted)
  return cleaned ? linkCitedCommits(cleaned, commits, links) : null
}

/** One-line rendering of an argv, so a multi-line arg (release notes) stays readable. */
const formatCommand = (command, args) =>
  [
    command,
    ...args.map((arg) => {
      const flat = String(arg).replace(/\s+/g, ' ').trim()
      return flat.length > 60 ? `${flat.slice(0, 57)}...` : flat
    }),
  ].join(' ')

/** Mutating command. Printed instead of executed under --dry-run. */
function mutate(command, args, options = {}) {
  const line = formatCommand(command, args)
  if (dryRun) {
    console.log(`  ${yellow('would run:')} ${line}`)
    return
  }
  console.log(`  ${dim(`$ ${line}`)}`)
  try {
    execFileSync(command, args, { stdio: ['pipe', 'inherit', 'inherit'], ...options })
  } catch {
    abortMidRelease(line)
  }
}

/**
 * Push the release commit and its tag as one transaction.
 *
 * `--follow-tags` and `--atomic` answer different questions: the first decides *which*
 * refs are sent, the second decides whether they land together. With only the first, a
 * server is free to accept the branch and reject the tag — which is precisely the split
 * this step exists to prevent, leaving a release commit on the remote with no tag, or a
 * tag with no commit behind it.
 *
 * Not every server implements the atomic capability, so a refusal on those grounds falls
 * back to the plain push. Nothing else does: a rejected non-fast-forward retried without
 * `--atomic` would push one ref and not the other, which is worse than failing.
 */
function pushBranchAndTag(branchRef) {
  const args = ['push', '--follow-tags', config.remote, branchRef]
  const atomic = ['push', '--follow-tags', '--atomic', config.remote, branchRef]
  const line = formatCommand('git', atomic)
  if (dryRun) {
    console.log(`  ${yellow('would run:')} ${line}`)
    return
  }
  console.log(`  ${dim(`$ ${line}`)}`)
  try {
    execFileSync('git', atomic, { stdio: ['pipe', 'inherit', 'pipe'] })
    return
  } catch (err) {
    const stderr = `${err.stderr ?? ''}`
    process.stderr.write(stderr)
    if (!/atomic/i.test(stderr)) abortMidRelease(line)
  }
  warn(
    `${config.remote} does not support atomic pushes — sending the branch and tag in one ` +
      'call, but not as one transaction',
  )
  mutate('git', args)
}

/**
 * Mutating shell command, for configured strings like `publish` that are written as a
 * whole command line rather than an argv. Shell metacharacters are the author's to own.
 */
function mutateShell(commandLine) {
  if (dryRun) {
    console.log(`  ${yellow('would run:')} ${commandLine}`)
    return
  }
  console.log(`  ${dim(`$ ${commandLine}`)}`)
  try {
    execSync(commandLine, { stdio: 'inherit' })
  } catch {
    abortMidRelease(commandLine)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SEMVER  (the subset a release needs: parse, compare, increment)
// ─────────────────────────────────────────────────────────────────────────────

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9a-z.-]+))?(?:\+[0-9a-z.-]+)?$/i

/** @returns {{major: number, minor: number, patch: number, pre: string[]} | null} */
function parseVersion(version) {
  const match = SEMVER_RE.exec(version)
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] ? match[4].split('.') : [],
  }
}

/** Precedence comparison per semver §11. @returns negative, 0, or positive. */
function compareVersions(a, b) {
  const x = parseVersion(a)
  const y = parseVersion(b)
  for (const part of ['major', 'minor', 'patch']) {
    if (x[part] !== y[part]) return x[part] - y[part]
  }
  // A version with a prerelease has lower precedence than one without.
  if (x.pre.length === 0 && y.pre.length === 0) return 0
  if (x.pre.length === 0) return 1
  if (y.pre.length === 0) return -1

  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i += 1) {
    const left = x.pre[i]
    const right = y.pre[i]
    if (left === undefined) return -1
    if (right === undefined) return 1
    if (left === right) continue
    const leftNumeric = /^\d+$/.test(left)
    const rightNumeric = /^\d+$/.test(right)
    if (leftNumeric && rightNumeric) return Number(left) - Number(right)
    // Numeric identifiers always have lower precedence than alphanumeric ones.
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
    return left < right ? -1 : 1
  }
  return 0
}

/**
 * Increment a version, matching `semver.inc` for the bumps a release uses.
 *
 * A major/minor/patch bump off a prerelease releases that prerelease's base version when
 * the base already satisfies the bump (1.2.3-beta.1 + patch → 1.2.3), which is what makes
 * "promote the release candidate" a plain `patch`.
 *
 * @param {string} version
 * @param {'major'|'minor'|'patch'|'premajor'|'preminor'|'prepatch'|'prerelease'} bump
 * @param {string | null | undefined} preid
 */
function incrementVersion(version, bump, preid) {
  const { major, minor, patch, pre } = parseVersion(version)
  const base = (m, n, p) => `${m}.${n}.${p}`

  switch (bump) {
    case 'major':
      if (pre.length && minor === 0 && patch === 0) return base(major, 0, 0)
      return base(major + 1, 0, 0)
    case 'minor':
      if (pre.length && patch === 0) return base(major, minor, 0)
      return base(major, minor + 1, 0)
    case 'patch':
      if (pre.length) return base(major, minor, patch)
      return base(major, minor, patch + 1)
    case 'premajor':
      return `${base(major + 1, 0, 0)}-${preid}.0`
    case 'preminor':
      return `${base(major, minor + 1, 0)}-${preid}.0`
    case 'prepatch':
      return `${base(major, minor, patch + 1)}-${preid}.0`
    case 'prerelease': {
      if (pre.length && pre[0] === preid && /^\d+$/.test(pre.at(-1))) {
        const next = [...pre]
        next[next.length - 1] = String(Number(next.at(-1)) + 1)
        return `${base(major, minor, patch)}-${next.join('.')}`
      }
      // Switching channel, or coming from a stable version: start the channel at .0.
      if (pre.length) return `${base(major, minor, patch)}-${preid}.0`
      return `${base(major, minor, patch + 1)}-${preid}.0`
    }
    default:
      throw new Error(`unknown bump: ${bump}`)
  }
}

/** The prerelease identifier of a version, or null when it is stable. */
function preidOf(version) {
  const { pre } = parseVersion(version)
  if (!pre.length) return null
  return /^\d+$/.test(pre[0]) ? null : pre[0].toLowerCase()
}

/**
 * The npm dist-tag a version publishes under.
 *
 *   1.2.3          → latest
 *   1.2.3-beta.4   → beta            (any identifier in KNOWN_CHANNELS)
 *   1.2.3-17512…   → canary          (an all-numeric prerelease is a timestamp)
 *   1.2.3-lol.0    → throws          (never silently falls through to latest)
 */
function distTagFor(version, explicitTag) {
  if (explicitTag) return explicitTag
  const { pre } = parseVersion(version)
  if (!pre.length) return 'latest'
  const label = String(pre[0]).toLowerCase()
  if (/^\d+$/.test(label)) return 'canary'
  if (KNOWN_CHANNELS.has(label)) return label
  throw new Error(
    `prerelease identifier "${label}" maps to no known dist-tag ` +
      `(${[...KNOWN_CHANNELS].sort().join(', ')}). Publishing it as "latest" would ` +
      `clobber the stable line — pass --tag <dist-tag> to choose one explicitly.`,
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// CHANGELOG
// ─────────────────────────────────────────────────────────────────────────────

const escapeRe = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The body of a changelog's section for one version, up to the next `##` heading or `---`
 * rule. Matches every common heading shape: `## [1.2.3] - 2026-08-17`, `## v1.2.3`,
 * `## 1.2.3 (2026-08-17)`.
 *
 * @returns {string | null} the section body, or null when there is no such section
 */
function changelogSection(text, version) {
  const heading = new RegExp(`^##\\s+\\[?v?${escapeRe(version)}\\]?(?![\\w.-])[^\\n]*$`, 'm')
  const match = heading.exec(text)
  if (!match) return null
  const rest = text.slice(match.index + match[0].length)
  const end = /^(?:## |---\s*$)/m.exec(rest)
  const body = (end ? rest.slice(0, end.index) : rest).trim()
  return body || null
}

/**
 * Version sections that sit above a newer one.
 *
 * Placement only keeps a changelog tidy going forward; a file already out of order stays
 * that way, and its disorder is invisible until a release lands somewhere surprising.
 *
 * @returns {string[]} the versions found out of order, newest-first order being expected
 */
function changelogOutOfOrder(text) {
  const versions = [...text.matchAll(/^## \[?v?(\d+\.\d+\.\d+(?:-[\w.]+)?)\]?/gm)].map((m) => m[1])
  return versions.filter((v, i) => i > 0 && compareVersions(versions[i - 1], v) < 0)
}

/** The `## ` heading offsets in a changelog, in file order. */
const sectionOffsets = (text) => [...text.matchAll(/^## .*$/gm)].map((m) => m.index)

/**
 * Place a version's section where it belongs: above the first section whose version is
 * lower, rather than wherever the file happens to start.
 *
 * Blindly inserting at the top is correct only while the file is already newest-first. A
 * changelog that drifts out of order once then stays that way, and every release makes it
 * worse — which is how a released version ends up sitting between two older ones.
 */
function insertChangelogSection(text, version, date, body) {
  const entry = `## [${version}] - ${date}\n\n${body}\n`
  for (const offset of sectionOffsets(text)) {
    const heading = /^## \[?v?([\d.]+(?:-[\w.]+)?)\]?/m.exec(
      text.slice(offset, text.indexOf('\n', offset)),
    )
    // An [Unreleased] heading has no version and always stays above the releases.
    if (!heading) continue
    if (compareVersions(version, heading[1]) > 0) {
      return `${text.slice(0, offset)}${entry}\n${text.slice(offset)}`
    }
  }
  const trimmed = text.trimEnd()
  return `${trimmed}\n\n${entry}`
}

/**
 * Promote `## [Unreleased]` to a released version and reopen an empty one above it.
 *
 * The section is lifted out and re-placed in version order, so a misplaced `[Unreleased]`
 * does not drag the new release into the middle of the file with it.
 *
 * @returns {string | null} the updated document, or null when there is nothing to roll
 */
function rollUnreleased(text, version, date) {
  // A heading for this version already exists — possibly with an empty body, which
  // `changelogSection` reports as absent. Rolling again would duplicate the heading.
  if (new RegExp(`^##\\s+\\[?v?${escapeRe(version)}\\]?(?![\\w.-])`, 'm').test(text)) return null

  const heading = /^##\s+\[?Unreleased\]?[^\n]*$/im
  const match = heading.exec(text)
  if (!match) return null

  // An empty [Unreleased] has nothing to promote; rolling it produces an empty section.
  const after = text.slice(match.index + match[0].length)
  const next = /^## /m.exec(after)
  const body = (next ? after.slice(0, next.index) : after).trim()
  if (!body) return null

  // Remove the section wherever it sits, then place the release by version.
  const withoutUnreleased = text.slice(0, match.index) + (next ? after.slice(next.index) : '')
  const placed = insertChangelogSection(`${withoutUnreleased.trimEnd()}\n`, version, date, body)

  // A fresh [Unreleased] belongs above every release, whatever the file looked like before.
  const first = sectionOffsets(placed)[0] ?? placed.length
  return `${placed.slice(0, first)}## [Unreleased]\n\n${placed.slice(first)}`
}

// ─────────────────────────────────────────────────────────────────────────────
// JSON FILES
// ─────────────────────────────────────────────────────────────────────────────

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))

/** The project's release.config.json, or {} when it has none. */
const readUserConfig = () =>
  existsSync('release.config.json') ? readJson('release.config.json') : {}

/**
 * Where a project keeps its version. The format is inferred from the file name, so the
 * common cases need nothing but a path:
 *
 *   *.json          the JSON `"version": "x.y.z"` field
 *   *.toml          the first `version = "x.y.z"` line — the `[package]` / `[project]`
 *                   table comes first in Cargo.toml and pyproject.toml
 *   anything else   the whole file is the version (a plain VERSION file)
 *
 * An explicit `pattern` overrides inference for formats not listed. Whatever the source,
 * it must capture the version in exactly one group, which is what gets replaced on write.
 */
const VERSION_PATTERNS = {
  json: /^\s*"version"\s*:\s*"([^"]*)"/m,
  toml: /^version\s*=\s*"([^"]*)"/m,
}

/** The project name in the same files, used for display and the registry lookup. */
const NAME_PATTERNS = {
  json: /^\s*"name"\s*:\s*"([^"]*)"/m,
  toml: /^name\s*=\s*"([^"]*)"/m,
}

/** @returns {string | null} the project name recorded beside the version */
function readNameFrom(entry) {
  const source = versionSource(entry)
  const kind = source.path.endsWith('.json')
    ? 'json'
    : source.path.endsWith('.toml')
      ? 'toml'
      : null
  if (!kind || !existsSync(source.path)) return null
  return NAME_PATTERNS[kind].exec(readFileSync(source.path, 'utf8'))?.[1] ?? null
}

/** Normalise a versionFile / versionFiles entry to { path, pattern }. */
const versionSource = (entry) => (typeof entry === 'string' ? { path: entry } : entry)

/**
 * A lockfile records a version for every dependency — hundreds of them — so the first
 * `version = "…"` in the file belongs to whichever crate sorts first, not to this project.
 * Rewriting it corrupts an unrelated dependency, silently. Scope to the named package block.
 */
function cargoLockPattern(lockPath) {
  const sibling = join(dirname(lockPath), 'Cargo.toml')
  const crate = existsSync(sibling) ? readNameFrom({ path: sibling }) : null
  if (!crate) {
    throw new Error(
      `${lockPath} lists every dependency's version, so it needs to know which package is ` +
        `yours.\n  No Cargo.toml beside it to read the name from — give an explicit ` +
        `pattern:\n  { "path": "${lockPath}", "pattern": "name = \\"<crate>\\"\\nversion = ` +
        `\\"(.+)\\"" }`,
    )
  }
  return new RegExp(`\\[\\[package\\]\\]\\nname = "${escapeRe(crate)}"\\nversion = "([^"]*)"`)
}

/** The regex for a source, or null when the whole file is the version. */
function patternFor({ path, pattern }) {
  if (pattern) return new RegExp(pattern, 'm')
  if (basename(path) === 'Cargo.lock') return cargoLockPattern(path)
  if (path.endsWith('.json')) return VERSION_PATTERNS.json
  if (path.endsWith('.toml')) return VERSION_PATTERNS.toml
  return null
}

/** @returns {string | null} the version recorded in a source file */
function readVersionFrom(entry) {
  const source = versionSource(entry)
  const text = readFileSync(source.path, 'utf8')
  const pattern = patternFor(source)
  if (!pattern) return text.trim() || null
  const match = pattern.exec(text)
  return match ? match[1] : null
}

/**
 * Replace the version in a source file, touching nothing else: only the captured range is
 * rewritten, so formatting, key order and comments all survive.
 *
 * @param {{dryRun?: boolean}} [options] report the change without making it
 * @returns {boolean} whether the file needed changing
 */
function writeVersionInto(entry, version, { dryRun = false } = {}) {
  const source = versionSource(entry)
  const text = readFileSync(source.path, 'utf8')
  const pattern = patternFor(source)

  let updated
  if (pattern) {
    const match = pattern.exec(text)
    if (!match) throw new Error(`${source.path} has no version matching ${pattern}`)
    const start = match.index + match[0].indexOf(match[1])
    updated = text.slice(0, start) + version + text.slice(start + match[1].length)
  } else {
    updated = `${version}\n`
  }

  if (updated === text) return false
  if (!dryRun) writeFileSync(source.path, updated)
  return true
}

// ─────────────────────────────────────────────────────────────────────────────
// ARGUMENTS
// ─────────────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2)
const BUMPS = new Set([
  'auto',
  'major',
  'minor',
  'patch',
  'premajor',
  'preminor',
  'prepatch',
  'prerelease',
])

const flag = (name) => argv.includes(name)
const option = (name) => {
  const index = argv.indexOf(name)
  return index === -1 ? undefined : argv[index + 1]
}

const dryRun = flag('--dry-run')
const assumeYes = flag('--yes') || flag('-y')
const onlySteps = option('--only')
const skippedSteps = option('--skip')
const explicitDistTag = option('--dist-tag')
const requestedPreid = option('--preid')
const autoCommit = flag('--commit')
const requestedNotesFile = option('--notes-file')
const requestedNotesSource = option('--notes')
const requestedAssistant = option('--assistant')
const requestedModel = option('--assistant-model')
const requestedEffort = option('--assistant-effort')

if (flag('--help') || flag('-h')) {
  console.log(USAGE)
  process.exit(0)
}

// --sync copies this file into other projects and exits; it touches no git state.
if (flag('--sync')) {
  const self = new URL(import.meta.url).pathname
  // Piped from stdin (`curl … | node -`) there is no file to copy: import.meta.url points
  // at a synthetic [eval] path. Say so instead of failing on a missing file.
  if (!existsSync(self)) {
    abort(
      '--sync copies this script from disk, and it was piped from stdin so there is no ' +
        'file to copy.\n  Run it from an installed copy instead: ' +
        'npx @entro314labs/release-kit --sync <dir>',
    )
  }
  const targets = argv.slice(argv.indexOf('--sync') + 1).filter((a) => !a.startsWith('-'))
  if (!targets.length) abort('--sync needs at least one project directory')

  const source = readFileSync(self, 'utf8')
  for (const target of targets) {
    const projectRoot = resolve(target)
    const destination = join(projectRoot, 'scripts', basename(self))
    if (destination === self) continue
    // Any directory can hold a vendored copy: a manifest is only needed to wire up a
    // script, which Rust, Python and Go projects do not have and do not need.
    if (!existsSync(projectRoot)) {
      warn(`${target}: no such directory — skipped`)
      continue
    }
    const current = existsSync(destination) ? readFileSync(destination, 'utf8') : null
    if (current === source) {
      note(`${target}: already up to date`)
      continue
    }
    if (!dryRun) {
      mkdirSync(join(projectRoot, 'scripts'), { recursive: true })
      writeFileSync(destination, source)
    }
    ok(`${target}: ${current === null ? 'installed' : 'updated'}${dryRun ? ' (dry run)' : ''}`)

    const manifestPath = join(projectRoot, 'package.json')
    if (existsSync(manifestPath)) {
      const scripts = readJson(manifestPath).scripts ?? {}
      if (!scripts.release) {
        warn(`${target}: add "release": "node scripts/${basename(self)}" to package.json`)
      }
    } else {
      note(`${target}: run it with \`node scripts/${basename(self)}\``)
    }
  }
  process.exit(0)
}

// lint-commits checks subjects and exits; like --sync it starts no release. It is handled
// before the positional parsing below because it takes a range, and a second positional is
// otherwise a mistake.
if (argv[0] === 'lint-commits') {
  const rest = argv.slice(1)
  const subjectAt = rest.indexOf('--subject')
  // This subcommand runs before `config` is bound, so it resolves its own.
  const lintConfig = { ...DEFAULTS, ...readUserConfig() }
  const ignored = lintConfig.ignoreCommits.map((pattern) => new RegExp(pattern, 'i'))

  let subjects
  let scope
  if (subjectAt !== -1) {
    // A squash merge takes its subject from the pull request title, which is therefore the
    // commit this repository will parse — and the one no commit-msg hook ever sees.
    const text = rest[subjectAt + 1]
    if (text === undefined) abort('--subject needs the text to check', 'COMMIT LINT FAILED')
    subjects = [{ hash: '', subject: text.trim() }]
    scope = null
  } else {
    if (!tryRead('git', ['rev-parse', '--show-toplevel'])) abort('not inside a git repository')
    const lastTag = lastReleaseTag({ prefix: lintConfig.tagPrefix ?? '' })
    const range =
      rest.find((arg) => !arg.startsWith('-')) ?? (lastTag ? `${lastTag}..HEAD` : 'HEAD')
    // Merges carry no prose of their own, and %s is enough: nothing here reads the body.
    const raw = tryRead('git', ['log', '--no-merges', '--format=%h%x1f%s', range])
    if (raw === null) {
      abort(
        `\`git log ${range}\` failed — is that a range in this repository?`,
        'COMMIT LINT FAILED',
      )
    }
    subjects = raw
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [hash, subject = ''] = line.split('\u001F')
        return { hash: hash.trim(), subject: subject.trim() }
      })
      // The bookkeeping `commitsSinceLastTag` drops for the same reason: a release commit,
      // a merge or an autosquash marker is nobody's prose to fix.
      .filter(({ subject }) => subject && !ignored.some((re) => re.test(subject)))
    scope = range
  }

  const findings = lintSubjects(subjects)
  for (const { hash, subject, level, reason } of findings) {
    const label = level === 'error' ? red('error') : yellow('warn')
    console.log(`  ${label} ${hash ? `${dim(hash)} ` : ''}${subject}\n        ${dim(reason)}`)
  }
  const errors = findings.filter((f) => f.level === 'error').length
  if (errors) {
    abort(
      `${errors} subject${errors === 1 ? '' : 's'} the changelog and the version bump cannot read`,
      'COMMIT LINT FAILED',
    )
  }
  const counted = `${subjects.length} subject${subjects.length === 1 ? '' : 's'}`
  const unfiled = findings.length ? `, ${findings.length} unfiled` : ''
  ok(`${scope ? `${scope}: ` : ''}${counted} valid${unfiled}`)
  process.exit(0)
}

/**
 * Options that consume the argument after them. Without this list a positional target is
 * found by guessing, and `--only tag,push` gets read as the version to release.
 */
const VALUE_OPTIONS = new Set([
  '--only',
  '--skip',
  '--preid',
  '--dist-tag',
  '--notes',
  '--notes-file',
  '--assistant',
  '--assistant-model',
  '--assistant-effort',
])

/** The version or bump target: the only argument that is neither a flag nor a flag's value. */
const positionals = []
for (let i = 0; i < argv.length; i += 1) {
  if (VALUE_OPTIONS.has(argv[i])) {
    i += 1
    continue
  }
  if (!argv[i].startsWith('-')) positionals.push(argv[i])
}
const target = positionals[0]
// A second positional is always a mistake, and silently ignoring it changes the release
// that runs — `release-kit auto assistant auto` must not quietly mean `release-kit auto`.
if (positionals.length > 1) {
  const extras = positionals.slice(1)
  const flagLike = extras.find((arg) => VALUE_OPTIONS.has(`--${arg}`))
  const hint = flagLike
    ? `\n  Flags are spelled with dashes: --${flagLike} ${extras[extras.indexOf(flagLike) + 1] ?? '<value>'}`
    : ''
  abort(`unexpected argument${extras.length > 1 ? 's' : ''}: ${extras.join(' ')}${hint}`)
}

// ─────────────────────────────────────────────────────────────────────────────
// SETUP
// ─────────────────────────────────────────────────────────────────────────────

const root = tryRead('git', ['rev-parse', '--show-toplevel'])
if (!root) abort('not inside a git repository')

// A release is scoped to the repository: the version, the tag and the push all belong to
// one git history, so the package released is the one at the git root. Refuse when invoked
// from a nested package instead — silently releasing the parent is the worse outcome.
const localManifest = resolve('package.json')
const rootManifest = join(root, 'package.json')
if (existsSync(localManifest) && localManifest !== rootManifest) {
  abort(
    `${relative(root, localManifest)} is a nested package, but a release covers the whole ` +
      `repository.\n\n  Running here would release ${
        existsSync(rootManifest) ? readJson(rootManifest).name : 'the repository root'
      } instead.\n` +
      '  release-kit handles one package per repository; it does not release workspace members.',
  )
}
process.chdir(root)

const userConfig = readUserConfig()
const config = { ...DEFAULTS, ...userConfig }
const unknownKeys = Object.keys(config).filter((key) => !(key in DEFAULTS))
if (unknownKeys.length) abort(`release.config.json has unknown keys: ${unknownKeys.join(', ')}`)

/**
 * Which steps run: config provides the baseline, --only replaces it, --skip subtracts, and
 * --commit forces the step on when a steps config removed it. Unknown names are an
 * error rather than a silent no-op.
 */
const parseStepList = (value) =>
  value
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)

/**
 * The project's current version and name. Both normally come from package.json, but the
 * only Node-specific thing about a release is publishing: `versionFile` points at whatever
 * file this project keeps its version in, and `null` means the repository versions by git
 * tag alone and the version has to be passed explicitly.
 */
const manifest = existsSync('package.json') ? readJson('package.json') : null

/**
 * Files that identify a repository, most definitive first. The first one present is where
 * the version is read from and written to. `go.mod` is absent because Go modules carry no
 * version — the tag is the version.
 */
const MANIFESTS = ['package.json', 'pyproject.toml', 'Cargo.toml', 'VERSION']

/** Where this project keeps its version, when the config does not say. */
function detectVersionFile() {
  for (const candidate of MANIFESTS) if (existsSync(candidate)) return candidate
  return null
}

/**
 * Manifests that name an ecosystem, so a second one present means a second registry. A
 * bare VERSION file is deliberately not one: it names nothing, and a repository keeping an
 * unrelated VERSION beside its manifest should not be told the two disagree.
 */
const ECOSYSTEM_MANIFESTS = ['package.json', 'pyproject.toml', 'Cargo.toml']

/**
 * Some repositories release one source tree to two ecosystems at once — a Tauri plugin is
 * a crate and an npm package, a maturin project is a crate and a wheel — and carry the
 * version in both manifests. Those bump together with no config.
 *
 * The safety rule is that they must already agree. Two manifests on different versions are
 * two independent version lines, and dragging one to the other's number is a silent, wrong
 * release; say so and touch nothing instead.
 *
 * @returns {string[]} further files to keep in step with the primary version source
 */
function detectCompanionFiles(primaryPath, primaryVersion) {
  const companions = []
  for (const candidate of ECOSYSTEM_MANIFESTS) {
    if (candidate === primaryPath || !existsSync(candidate)) continue
    const found = readVersionFrom({ path: candidate })
    if (found !== primaryVersion) {
      warn(
        `${candidate} is at ${found ?? 'no readable version'} while ${primaryPath} is at ` +
          `${primaryVersion}, so they are versioned separately — leaving ${candidate} alone.\n` +
          '       Add it to "versionFiles" in release.config.json to bump them together.',
      )
      continue
    }
    companions.push(candidate)
    // The lockfile pins the crate's own version too, so a bump leaves it stale.
    if (candidate === 'Cargo.toml' && existsSync('Cargo.lock')) companions.push('Cargo.lock')
  }
  return companions
}

/**
 * Where a language records no version of its own, a project that wants `--version` to work
 * keeps one in source instead: a Go module has only `go.mod`, which carries no version at
 * all, so the number lives in a `version.go` the tag is supposed to match.
 *
 * These mirror the tag rather than define it — `go get` resolves a tag, not a constant —
 * so they are detected as files to keep in step, never as the source of truth.
 *
 * A candidate is adopted only when it already carries the current version, the same rule
 * the companion manifests use. Here it does a second job: it rules out the `var Version =
 * "dev"` placeholder that a build replaces with -ldflags, which is not a version to bump
 * and is common enough that warning about it every release would be pure noise. Mismatches
 * are therefore skipped silently, unlike a manifest on its own version line.
 *
 * Anything outside this table is three lines of `versionFiles` config with a `pattern`;
 * this covers the convention that comes up without one.
 */
const VERSION_MIRRORS = [
  {
    // `const Version = "1.2.0"`, `var Version = "1.2.0"`, and the same inside a const
    // block or with an explicit `string` type.
    pattern: '^\\s*(?:const\\s+|var\\s+)?[Vv]ersion\\s*(?:string\\s*)?=\\s*"(.+)"',
    paths: ['version.go', 'internal/version/version.go', 'pkg/version/version.go'],
  },
]

/** @returns {{path: string, pattern: string}[]} source files already carrying `version` */
function detectVersionMirrors(version) {
  const found = []
  for (const { paths, pattern } of VERSION_MIRRORS) {
    for (const path of paths) {
      if (!existsSync(path)) continue
      if (readVersionFrom({ path, pattern }) === version) found.push({ path, pattern })
    }
  }
  return found
}

/**
 * The publish command implied by a project's manifest, but only where one ecosystem
 * obviously owns it. Python has several publishers (uv, twine, poetry, flit) and Go has
 * none, so those get nothing rather than a guess — publishing to the wrong registry is a
 * far worse failure than being asked to configure it.
 */
const PUBLISH_BY_MANIFEST = {
  'package.json': 'npm publish --tag %d',
  'Cargo.toml': 'cargo publish',
}

/**
 * A manifest that must not be published says so in itself. Detection honours that: a
 * private package or an unpublishable crate is one this repository releases by tag alone,
 * and detecting a command for it would attempt the one thing the manifest forbids.
 */
function detectablePublish(path) {
  if (basename(path) === 'package.json') return !readJson(path).private
  if (basename(path) === 'Cargo.toml') {
    const text = readFileSync(path, 'utf8')
    if (/^publish\s*=\s*false/m.test(text)) return false
    // A crate built only as a cdylib is a native extension module — what maturin and
    // napi-rs compile into a wheel or a .node — not a library anyone depends on from
    // crates.io. Its version travels with the package it is built into, which is why the
    // two match; publishing it to crates.io is the one thing nobody asked for.
    const crateTypes = /^crate-type\s*=\s*\[([^\]]*)\]/m.exec(text)?.[1]
    if (crateTypes?.includes('cdylib') && !crateTypes.includes('rlib')) return false
  }
  return true
}

// An explicit `versionFile: null` means "versions by tag" and must not be re-detected, so
// the distinction is between the key being absent and the key being set to null.
const configuredVersionFile = Object.hasOwn(userConfig, 'versionFile')
  ? userConfig.versionFile
  : detectVersionFile()
const versionFile = configuredVersionFile ? versionSource(configuredVersionFile) : null
// Only worth saying when it is not the conventional default.
if (
  !Object.hasOwn(userConfig, 'versionFile') &&
  versionFile &&
  versionFile.path !== 'package.json'
) {
  note(`version source: ${versionFile.path} (detected)`)
}

if (versionFile && !existsSync(versionFile.path)) {
  abort(`versionFile ${versionFile.path} does not exist`)
}

/**
 * Where a repository versions by tag alone — a Go module, a docs site — the latest tag is
 * the current version. Without this, `auto` and every bump have nothing to work from and
 * the version has to be typed out in full every time.
 */
function versionFromLastTag() {
  return releaseTags()[0]?.version ?? null
}

const currentVersion = versionFile ? readVersionFrom(versionFile) : versionFromLastTag()
if (versionFile && !currentVersion) {
  abort(`could not read a version from ${versionFile.path}`)
}
if (currentVersion && !parseVersion(currentVersion)) {
  abort(`${versionFile.path} version "${currentVersion}" is not semver`)
}

/** Used for display, the registry lookup, and the %n token. */
const goModule = existsSync('go.mod')
  ? (/^module\s+(\S+)/m.exec(readFileSync('go.mod', 'utf8'))?.[1] ?? null)
  : null
const projectName =
  manifest?.name ?? (versionFile ? readNameFrom(versionFile) : null) ?? goModule ?? basename(root)

/**
 * Manifests found beside the primary one that carry the same version. Detected only when
 * the project has said nothing about either key: a project that listed its own
 * `versionFiles` has already answered this question, and quietly appending to that answer
 * would release files it deliberately left out.
 */
const detecting =
  !!currentVersion &&
  !Object.hasOwn(userConfig, 'versionFile') &&
  !Object.hasOwn(userConfig, 'versionFiles')
const companionFiles = detecting
  ? [
      ...(versionFile ? detectCompanionFiles(versionFile.path, currentVersion) : []),
      ...detectVersionMirrors(currentVersion),
    ]
  : []
if (companionFiles.length) {
  config.versionFiles = companionFiles
  note(
    `also versioned in ${companionFiles.map((entry) => versionSource(entry).path).join(', ')} ` +
      '(detected)',
  )
}

/**
 * Every file the version is written into: the source of truth first, then the files kept
 * in step with it. A repository that versions by tag alone has no source of truth here and
 * may still have mirrors to write — a Go module's `version.go` is exactly that — so this
 * is what the version step works from, rather than `versionFile` being required.
 */
const versionTargets = [versionFile, ...config.versionFiles].filter(Boolean).map(versionSource)

// Same rule as versionFile: an explicit `publish: null` means "publish nothing" and is
// never re-detected. Unset means "work it out", and working it out can yield nothing.
if (!Object.hasOwn(userConfig, 'publish')) {
  // Preflight already reports "no publish command configured" when the step runs, so
  // there is nothing to say here — and `runs` is not resolved this early.
  //
  // Two manifests releasing in step means two registries: the npm command comes first
  // because it is the recoverable one — npm allows an unpublish for 72 hours, crates.io
  // never does — so a half-finished publish leaves the undoable half undone.
  const detected = [versionFile, ...companionFiles]
    .filter(Boolean)
    .map((entry) => versionSource(entry).path)
    .filter((path) => PUBLISH_BY_MANIFEST[basename(path)] && detectablePublish(path))
    .map((path) => PUBLISH_BY_MANIFEST[basename(path)])
  config.publish = detected.length ? detected : null
}

// Validate every name that was asked for, not just the ones that survive: a typo in
// --skip would otherwise delete nothing and silently run the step you meant to drop.
const requestedStepNames = [
  ...(onlySteps ? parseStepList(onlySteps) : []),
  ...(skippedSteps ? parseStepList(skippedSteps) : []),
  ...(Array.isArray(config.steps) ? config.steps : []),
]
const unknownSteps = [...new Set(requestedStepNames)].filter((name) => !STEPS.includes(name))
if (unknownSteps.length) {
  abort(`unknown step(s): ${unknownSteps.join(', ')}\n  Known steps: ${STEPS.join(', ')}`)
}

const steps = new Set(onlySteps ? parseStepList(onlySteps) : (config.steps ?? DEFAULT_STEPS))
if (skippedSteps) for (const name of parseStepList(skippedSteps)) steps.delete(name)
if (autoCommit) steps.add('commit')
const runs = (name) => steps.has(name)

/**
 * The drafting tool, resolved from --assistant then config. "auto" picks the first one
 * present on PATH; a named tool must be known and installed, otherwise it is an error
 * rather than a silent downgrade to no drafting.
 */
const assistantConfig =
  config.assistant && typeof config.assistant === 'object' ? config.assistant : {}
const assistantChoice =
  requestedAssistant ??
  (typeof config.assistant === 'string' ? config.assistant : assistantConfig.tool) ??
  'none'
const assistantModel = requestedModel ?? assistantConfig.model ?? null
const assistantEffort = requestedEffort ?? assistantConfig.effort ?? null
let assistantName = null
if (assistantChoice !== 'none' && assistantChoice !== null) {
  const candidates =
    assistantChoice === 'auto'
      ? Object.keys(ASSISTANTS)
      : [assistantChoice].filter((name) => {
          if (name in ASSISTANTS) return true
          abort(
            `unknown assistant "${name}" (known: ${Object.keys(ASSISTANTS).join(', ')}, auto, none)`,
          )
          return false
        })
  assistantName =
    candidates.find((name) => succeeds(ASSISTANTS[name].command, ASSISTANTS[name].probe)) ?? null
  if (!assistantName && assistantChoice !== 'auto') {
    abort(
      `assistant "${assistantChoice}" is configured but \`${ASSISTANTS[assistantChoice].command}\` is not on PATH`,
    )
  }
}
const assistant = assistantName ? ASSISTANTS[assistantName] : null

// ─────────────────────────────────────────────────────────────────────────────
// RESOLVE THE TARGET VERSION
// ─────────────────────────────────────────────────────────────────────────────

console.log(
  bold(`${projectName} release`) +
    (dryRun ? `  ${yellow('(dry run — nothing will execute)')}` : ''),
)

/** What `auto` inferred, kept so preflight can show the reasoning. */
let autoBump = null

let version
if (!target) {
  if (!currentVersion) {
    abort(
      'nothing to default to: this repository has no versionFile and no tag to read a ' +
        'version from.\n  Pass one explicitly: release-kit 1.2.3',
    )
  }
  version = currentVersion
} else if (target === 'auto') {
  if (!currentVersion) {
    abort(
      'auto has nothing to bump from: there is no versionFile and no tag to read a version ' +
        'from.\n  Pass the first version explicitly: release-kit 0.1.0',
    )
  }
  const { commits, lastTag } = commitsSinceLastTag()
  if (!commits.length) {
    abort(
      `no releasable commits since ${lastTag ?? 'the start of the project'} — nothing to release`,
    )
  }
  autoBump = inferBump(commits, currentVersion, config.versioning)
  if (autoBump.releaseAs) {
    if (!parseVersion(autoBump.releaseAs)) {
      abort(`Release-As: ${autoBump.releaseAs} in a commit is not a semver version`)
    }
    version = autoBump.releaseAs
  } else {
    version = incrementVersion(
      currentVersion,
      autoBump.bump,
      requestedPreid ?? preidOf(currentVersion),
    )
  }
} else if (BUMPS.has(target)) {
  if (!currentVersion) {
    abort(
      `a ${target} bump has nothing to bump from: no versionFile, and no tag to read a ` +
        'version from.\n  Pass the version explicitly instead.',
    )
  }
  const preid = requestedPreid ?? preidOf(currentVersion)
  if (target.startsWith('pre') && !preid) {
    abort(
      `a ${target} bump from a stable version needs --preid <${[...KNOWN_CHANNELS].sort().join('|')}>`,
    )
  }
  version = incrementVersion(currentVersion, target, preid)
} else if (parseVersion(target)) {
  version = target
} else {
  abort(`"${target}" is neither a semver version nor a bump (${[...BUMPS].join(', ')})`)
}

const tag = `${config.tagPrefix}${version}`
const isPrerelease = parseVersion(version).pre.length > 0
const bumping = versionTargets.length > 0 && version !== currentVersion && runs('version')

let distTag
try {
  distTag = distTagFor(version, explicitDistTag)
} catch (err) {
  abort(err.message)
}

const expandWith = (template, transform) =>
  template
    .replaceAll('%v', transform(version))
    .replaceAll('%t', transform(tag))
    .replaceAll('%n', transform(projectName))
    .replaceAll('%d', transform(distTag))

/** Expand tokens for a message or title, which never reaches a shell. */
const expand = (template) => expandWith(template, (value) => value)

/**
 * Expand tokens for the `publish` command line, which does reach a shell. The values are
 * single-quoted so a version or dist-tag carrying shell metacharacters (a crafted
 * package.json, a hand-typed `--tag`) is passed through as one literal argument.
 */
const shellQuote = (value) => `'${value.replaceAll("'", `'\\''`)}'`
const expandShell = (template) => expandWith(template, shellQuote)

/**
 * Registries whose preflight can be run, keyed by the first word of the publish command.
 * Each declares how that CLI answers "who am I" and "does this version already exist";
 * either may be null when the tool has no such notion. A publish command outside this
 * table (vsce, a shell pipeline) is run as written with no preflight — it cannot be
 * introspected, and guessing would invent failures.
 */
const REGISTRIES = {
  npm: { whoami: ['whoami'], published: (name, v) => ['view', `${name}@${v}`, 'version'] },
  pnpm: { whoami: ['whoami'], published: (name, v) => ['view', `${name}@${v}`, 'version'] },
  bun: {
    whoami: ['pm', 'whoami'],
    published: (name, v) => ['pm', 'view', `${name}@${v}`, 'version'],
  },
  // uv authenticates with a token from the environment rather than a logged-in session,
  // and skips duplicate uploads itself via --check-url, so there is no version lookup.
  uv: { env: ['UV_PUBLISH_TOKEN', 'UV_PUBLISH_PASSWORD'], login: 'set UV_PUBLISH_TOKEN' },
  // cargo has no "who am I": crates.io auth is a token, either in the environment or in
  // the credentials file `cargo login` writes. `cargo info` is the version lookup, and
  // exits non-zero for a version the index does not carry (cargo 1.82+).
  cargo: {
    env: ['CARGO_REGISTRY_TOKEN', 'CARGO_REGISTRIES_CRATES_IO_TOKEN'],
    credentials: [
      join(homedir(), '.cargo', 'credentials.toml'),
      join(homedir(), '.cargo', 'credentials'),
    ],
    login: 'run `cargo login`, or set CARGO_REGISTRY_TOKEN',
    published: (name, v) => ['info', `${name}@${v}`],
  },
  // For Go the tag is the release; `go list` warms the module proxy and doubles as the
  // check for whether this version is already resolvable.
  go: { published: (name, v) => ['list', '-m', `${name}@${v}`] },
}

/**
 * Which manifest records the name a registry knows this project by, when it is not the one
 * `projectName` came from. They are not always the same string: a Tauri plugin publishes as
 * `@tauri-apps/plugin-x` on npm and `tauri-plugin-x` on crates.io, so looking the crate up
 * under its npm name would report every version as unpublished.
 */
const NAME_MANIFEST_BY_CLI = { cargo: 'Cargo.toml' }

function registryName(cli) {
  const manifest = NAME_MANIFEST_BY_CLI[cli]
  if (!manifest) return projectName
  const source = versionTargets.find((entry) => basename(entry.path) === manifest)
  return (source && readNameFrom(source)) ?? projectName
}

/**
 * `publish` is one command or several, because one source tree can own a package in more
 * than one ecosystem. They run in the configured order.
 */
const publishList = config.publish == null ? [] : [config.publish].flat()
if (publishList.some((entry) => typeof entry !== 'string')) {
  abort('publish must be a command string, an array of command strings, or null')
}

/** Each publish command with the CLI it drives, that CLI's preflight row, and its name. */
const publishTargets = runs('publish')
  ? publishList.map((template) => {
      const command = expandShell(template)
      const cli = command.trim().split(/\s+/)[0]
      return { command, cli, registry: REGISTRIES[cli] ?? null, name: registryName(cli) }
    })
  : []

/** npm-family commands are the ones a `"private": true` package.json forbids. */
const NPM_CLIS = new Set(['npm', 'pnpm', 'bun'])

/**
 * CI publishing over OIDC ("trusted publishing") carries no token at all: `whoami` fails
 * while `publish` succeeds. Demanding a login there would abort a perfectly valid release.
 * GitHub Actions exposes the OIDC request variables; GitLab CI and CircleCI set
 * NPM_ID_TOKEN. See https://docs.npmjs.com/trusted-publishers
 */
const isTrustedPublishing =
  (process.env.GITHUB_ACTIONS === 'true' &&
    !!process.env.ACTIONS_ID_TOKEN_REQUEST_URL &&
    !!process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) ||
  !!process.env.NPM_ID_TOKEN

console.log(
  `  ${dim(`${currentVersion ?? '(no version file)'} → ${version}   tag ${tag}   dist-tag ${distTag}`)}`,
)
console.log(`  ${dim(`steps: ${STEPS.filter(runs).join(' → ')}`)}`)

// ─────────────────────────────────────────────────────────────────────────────
// PREFLIGHT — every check runs, then it aborts once with all of the failures
// ─────────────────────────────────────────────────────────────────────────────

step('Preflight')

const problems = []
const fail = (message) => {
  console.log(`  ${red('fail')} ${message}`)
  problems.push(message)
}

if (autoBump) {
  const reason = autoBump.releaseAs
    ? `Release-As: ${autoBump.releaseAs} in a commit`
    : autoBump.breaking.length
      ? `${autoBump.breaking.length} breaking change(s)`
      : autoBump.features.length
        ? `${autoBump.features.length} feature(s), no breaking changes`
        : 'no features or breaking changes'
  ok(`auto: ${autoBump.bump} — ${reason}`)
  for (const subject of [...autoBump.breaking, ...autoBump.features].slice(0, 5)) {
    console.log(dim(`       ${subject}`))
  }
}

if (bumping && currentVersion && compareVersions(version, currentVersion) <= 0) {
  fail(`${version} is not greater than the current version ${currentVersion}`)
} else if (bumping && currentVersion) {
  ok(`version ${currentVersion} → ${version}`)
} else if (bumping) {
  // No manifest and no tag to read a version from, but files to write one into.
  ok(`writing ${version} into ${versionTargets.map((source) => source.path).join(', ')}`)
} else if (versionFile) {
  ok(`releasing the version already in ${versionFile.path} (${version})`)
} else {
  ok(`releasing ${version} (no version file; the tag is the version)`)
}

const dirty = tryRead('git', ['status', '--porcelain'])
if (dirty === null) fail('could not read git status')
else if (dirty && runs('commit')) {
  const entries = dirty.split('\n')
  ok(`working tree has ${entries.length} change(s) — will be committed first`)
  console.log(dim(indent(formatStatus(dirty))))
  if (!assistant) {
    note(
      'no assistant configured: the commit message will name the files — ' +
        '`--assistant auto` drafts a real one',
    )
  }
  // One commit gets one subject. A change set spanning several top-level directories is
  // usually several pieces of work, and no honest Conventional Commits subject covers it.
  const areas = new Set(
    entries.map(
      (entry) => entry.trim().split(/\s+/).slice(1).join(' ').replaceAll('"', '').split('/')[0],
    ),
  )
  if (areas.size > 2) {
    warn(
      `these span ${areas.size} top-level paths (${[...areas].slice(0, 4).join(', ')}${areas.size > 4 ? ', …' : ''}), ` +
        'which is usually more than one piece of work.\n' +
        '       One commit gets one subject: consider committing them yourself, then ' +
        'releasing with --skip commit.',
    )
  }
} else if (dirty) {
  fail(`working tree is not clean:\n${indent(formatStatus(dirty))}`)
} else ok('working tree clean')

if (assistant) {
  const detail = [
    assistantModel && `model ${assistantModel}`,
    assistantEffort && `effort ${assistantEffort}`,
  ]
    .filter(Boolean)
    .join(', ')
  ok(`assistant: ${assistantName}${detail ? ` (${detail})` : ''}`)
  if (assistantModel && !assistant.model)
    warn(`${assistantName} takes no model flag — --assistant-model ignored`)
  if (assistantEffort && !assistant.effort)
    warn(`${assistantName} takes no effort flag — --assistant-effort ignored`)
}

const branch = tryRead('git', ['rev-parse', '--abbrev-ref', 'HEAD'])
// A detached HEAD has no branch to push, and reports itself as the literal "HEAD", which
// would otherwise be compared against config.branch and pushed as a ref of that name.
const detached = branch === 'HEAD'
if (!branch) fail('could not read the current branch')
else if (detached) {
  fail('HEAD is detached — a release needs a branch to push. Check one out first.')
} else if (config.branch && branch !== config.branch) {
  fail(`on '${branch}', expected '${config.branch}'`)
} else ok(`on ${branch}`)

// A shallow clone (CI checkouts default to depth 1) is only a problem when it truncates
// the history the release actually reads. Whether it does is checked after the fetch
// below, where the answer is most accurate.
const shallow = tryRead('git', ['rev-parse', '--is-shallow-repository']) === 'true'

if (!succeeds('git', ['remote', 'get-url', config.remote])) {
  fail(`no '${config.remote}' remote configured`)
} else {
  ok(`remote ${config.remote}`)
  // Fetch so the tag and behind-remote checks below see the real remote state.
  if (!succeeds('git', ['fetch', '--quiet', '--tags', config.remote])) {
    fail(`could not fetch from ${config.remote}`)
  } else if (branch && !detached) {
    const upstream = `${config.remote}/${branch}`
    if (!succeeds('git', ['rev-parse', '--verify', '--quiet', `refs/remotes/${upstream}`])) {
      note(`${upstream} does not exist yet — the push will create it`)
    } else {
      const behind = tryRead('git', ['rev-list', '--count', `HEAD..${upstream}`])
      if (behind === null) fail(`could not compare HEAD with ${upstream}`)
      else if (behind !== '0') fail(`${behind} commit(s) behind ${upstream} — pull first`)
      else ok(`up to date with ${upstream}`)
    }
  }
}

// If the previous release tag is reachable from HEAD, a shallow clone hides nothing the
// release reads — notes and `auto` see the whole span. No reachable tag means the history
// is provably truncated: `auto` would infer the bump from a fraction of the commits, so
// that is a failure; commit-derived notes merely come out partial, so that is a warning.
let shallowHidesHistory = false
if (shallow) {
  const reachableTag = lastReleaseTag()
  shallowHidesHistory = !reachableTag
  if (reachableTag) {
    ok(
      `shallow clone, but history back to ${reachableTag} is visible — notes and auto are complete`,
    )
  } else if (autoBump) {
    fail(
      'shallow clone hides the history `auto` infers the bump from — no previous tag is ' +
        'reachable.\n       Fetch full history: fetch-depth: 0 in CI, or git fetch --unshallow.',
    )
  } else {
    warn(
      'shallow clone: no previous tag is reachable, so notes drafted from commits will ' +
        'describe only the visible history. Fetch full history (fetch-depth: 0, or ' +
        'git fetch --unshallow).',
    )
  }
}

// The registry's "Repository" link comes from the manifest, not from git — a mismatch
// ships a broken link with every publish, and npm only warns after the fact.
if (existsSync('package.json')) {
  const repoField = readJson('package.json').repository
  const declared = typeof repoField === 'string' ? repoField : repoField?.url
  const remoteUrl = tryRead('git', ['remote', 'get-url', config.remote])
  if (declared && remoteUrl && /:\/\/|@/.test(declared)) {
    if (normalizeRepoUrl(declared) !== normalizeRepoUrl(remoteUrl)) {
      warn(
        `package.json repository is ${declared}, but ${config.remote} is ${remoteUrl} — ` +
          'the registry will link the wrong repository',
      )
    } else if (!/^git\+.*\.git$/.test(declared)) {
      note(`npm normalizes repository.url on publish — \`npm pkg fix\` writes that form`)
    }
  }
}

// Signing is configured per repository and inherited, never managed here — git already
// owns that. But a signing setup that cannot produce a signature fails at the commit step,
// after the version has been written, so it is worth catching before anything mutates.
const signsSomething = ['commit', 'version', 'changelog', 'tag'].some(runs)
const signingKeys = ['commit.gpgsign', 'tag.gpgsign'].filter(
  (key) => tryRead('git', ['config', '--get', key]) === 'true',
)
if (signsSomething && signingKeys.length) {
  const format = tryRead('git', ['config', '--get', 'gpg.format']) || 'openpgp'
  const signingKey = tryRead('git', ['config', '--get', 'user.signingkey'])
  const keyPath = signingKey?.replace(/^~/, homedir())
  if (!signingKey) {
    fail(`${signingKeys.join(' and ')} enabled but user.signingkey is not set`)
  } else if (format === 'ssh' && /^[~/.]/.test(signingKey) && !existsSync(keyPath)) {
    fail(
      `signing key ${signingKey} does not exist.\n` +
        '       Point user.signingkey at a key that is present, or disable signing for this ' +
        'run with `git -c commit.gpgsign=false -c tag.gpgsign=false`.',
    )
  } else {
    ok(`signing commits and tags (${format})`)
    // git signs happily with a key GitHub has never seen, which is how a repository fills
    // up with commits that are locally valid and permanently "Unverified". Only GitHub can
    // answer this, and only when the token carries the scope to list signing keys — so an
    // unanswerable check stays silent rather than guessing.
    if (format === 'ssh' && keyPath && existsSync(keyPath) && runs('release')) {
      const registered = signingKeyRegistered(keyPath)
      if (registered === false) {
        warn(
          'this signing key is not registered with GitHub, so the commits will show as ' +
            'Unverified.\n       Add it: gh ssh-key add ' +
            `${signingKey} --type signing`,
        )
      } else if (registered === true) {
        ok('signing key is registered with GitHub')
      }
    }
  }
}

const head = tryRead('git', ['rev-parse', 'HEAD'])
const taggedCommit = tryRead('git', ['rev-list', '-n', '1', tag])
if (!runs('tag')) {
  note('tag step not selected')
} else if (taggedCommit && bumping) {
  fail(`tag ${tag} already exists — release a different version`)
} else if (taggedCommit && taggedCommit !== head) {
  fail(`tag ${tag} already exists at ${taggedCommit.slice(0, 8)}, not at HEAD`)
} else if (taggedCommit) {
  ok(`tag ${tag} already exists at HEAD — will reuse it`)
} else {
  ok(`tag ${tag} is free`)
}

let releaseExists = false
if (!runs('release')) {
  note('release step not selected')
} else if (!succeeds('gh', ['--version'])) {
  fail('the GitHub CLI (`gh`) is not installed — https://cli.github.com')
} else if (!succeeds('gh', ['auth', 'status'])) {
  fail('`gh` is not authenticated — run `gh auth login`')
} else {
  ok(`gh authenticated (${tryRead('gh', ['api', 'user', '--jq', '.login']) || 'unknown user'})`)
  releaseExists = succeeds('gh', ['release', 'view', tag])
  if (releaseExists) note(`a GitHub release for ${tag} already exists — will skip that step`)
}

/** Whether one publish CLI can publish at all: OIDC, a token, or a live session. */
function checkCredentials({ cli, registry }) {
  if (isTrustedPublishing) {
    ok(`${cli}: trusted publishing (OIDC) — no token needed`)
    return
  }
  if (registry.env) {
    // Token auth: there is no session to interrogate, only credentials to find.
    const found = registry.env.find((name) => process.env[name])
    if (found) {
      ok(`${cli} credentials found (${found})`)
      return
    }
    const file = registry.credentials?.find((path) => existsSync(path))
    if (file) ok(`${cli} credentials found (${file})`)
    else fail(`${cli} has no publish credentials — ${registry.login}`)
    return
  }
  if (registry.whoami) {
    const user = tryRead(cli, registry.whoami)
    if (user === null) {
      // npm replaced long-lived tokens with two-hour sessions in December 2025, so the
      // usual cause is an expired session rather than a missing login.
      fail(
        `${cli} is not authenticated — run \`${cli} login\`. ` +
          'npm logins are two-hour sessions, so an earlier one may have expired.',
      )
    } else ok(`${cli} authenticated (${user || 'unknown user'})`)
  }
}

/** Commands whose version is already on the registry, so the publish step skips them. */
const alreadyPublished = new Set()
if (!publishTargets.length) {
  note(runs('publish') ? 'no publish command configured' : 'publish step not selected')
} else if (manifest?.private && publishTargets.some((target) => NPM_CLIS.has(target.cli))) {
  fail('package.json is private but an npm publish command is configured')
} else {
  // One CLI can appear more than once; interrogating it twice says the same thing twice.
  const authenticated = new Set()
  for (const target of publishTargets) {
    ok(`publish: ${target.command}`)
    if (!target.registry) continue
    if (!authenticated.has(target.cli)) {
      authenticated.add(target.cli)
      checkCredentials(target)
    }
    if (
      target.registry.published &&
      succeeds(target.cli, target.registry.published(target.name, version))
    ) {
      alreadyPublished.add(target.command)
      note(`${target.name}@${version} is already published — will skip \`${target.command}\``)
    }
  }
}

/** Say so when the changelog is not newest-first, since placement cannot repair it. */
function reportChangelogOrder(text) {
  const misplaced = changelogOutOfOrder(text)
  if (misplaced.length) {
    warn(
      `${config.changelog} is not in newest-first order (${misplaced.slice(0, 3).join(', ')}` +
        `${misplaced.length > 3 ? ', …' : ''} sit above a newer version).\n` +
        '       New sections are placed correctly, but the existing order is left alone.',
    )
  }
}

/**
 * Where the notes come from. "auto" walks the list — a hand-written changelog section beats
 * anything generated — while an explicit source forces one, because asking for a thing and
 * being given something else is worse than being told the thing is unavailable.
 */
const NOTE_SOURCES = ['auto', 'changelog', 'assistant', 'commits', 'github']
const notesSource = requestedNotesSource ?? config.notes ?? 'auto'
if (!NOTE_SOURCES.includes(notesSource)) {
  abort(`unknown notes source "${notesSource}". Known: ${NOTE_SOURCES.join(', ')}`)
}
if (notesSource === 'assistant' && !assistant) {
  abort(
    'notes are set to come from an assistant, but none is available.\n' +
      '  Add --assistant auto, or set "assistant" in release.config.json.',
  )
}

let notes = null
let rolledChangelog = null
let draftedNotes = null

/**
 * True when --commit still has to create a commit. Notes drafted before that commit would
 * describe an incomplete release, so drafting waits until the working tree is committed.
 */
const notesDeferred = !!(dirty && runs('commit'))

/**
 * Set only when preflight found nothing to release with and left the drafting to the
 * post-commit step. Deferral has to be recorded rather than re-derived from `notesDeferred`
 * there: a dirty tree is what makes drafting possible to defer, not what makes it necessary.
 * A hand-written changelog section has already answered the question, and re-drafting over
 * it would discard the notes the confirmation prompt showed and append a second section for
 * the same version.
 */
let notesPending = false

/**
 * Notes for a version, in descending order of how much they can be trusted:
 * an assistant's prose when one is configured, otherwise the commits grouped by
 * Conventional Commit type. Only when neither yields anything does GitHub generate them.
 */
function draftNotesFor(v) {
  // A stable release absorbs the candidates that led to it: their commits are what it
  // ships, and reading from the last candidate leaves the notes describing the gap
  // between two candidates rather than the release.
  const { lastTag, subjects, commits } = commitsSinceLastTag({ stable: !isPrerelease })
  if (!commits.length) return null

  // Notes are built from Conventional Commits, so anything not written that way is simply
  // absent from them. A squash-merge takes its subject from the pull request title, which
  // is where this usually goes wrong — and silently, since the release still succeeds.
  const unconventional = commits.filter((c) => !parseCommit(c.subject, c.body, c.hash)).length
  if (unconventional) {
    warn(
      `${unconventional} of ${commits.length} commit(s) are not Conventional Commits, so they ` +
        'will not appear in the notes.',
    )
  }
  // An explicitly named source wins over the assistant being merely available.
  if (!assistant || notesSource === 'commits')
    return changelogFromCommits(commits, remoteLinks(config.remote), config.hiddenTypes)
  if (shallowHidesHistory) {
    warn(
      `shallow clone: only ${subjects.length} commit(s) are visible, so the notes will ` +
        'describe part of the release. Check out with full history (fetch-depth: 0).',
    )
  }
  note(`drafting notes from ${subjects.length} commit(s) with ${assistantName}...`)
  return (
    draftReleaseNotes(v, commits, lastTag, remoteLinks(config.remote)) ??
    changelogFromCommits(commits, remoteLinks(config.remote), config.hiddenTypes)
  )
}
const changelogText =
  config.changelog && existsSync(config.changelog) ? readFileSync(config.changelog, 'utf8') : null
if (changelogText) reportChangelogOrder(changelogText)

// `github` means write nothing and let GitHub generate from the commit log.
if (notesSource === 'github') {
  note('notes will be generated by GitHub')
} else if (notesSource === 'changelog' && !changelogText) {
  fail(`notes are set to come from ${config.changelog}, which does not exist`)
} else {
  const wantsChangelog = notesSource === 'auto' || notesSource === 'changelog'

  // A section already written for this version is the most authoritative thing there is.
  if (wantsChangelog && changelogText) {
    notes = changelogSection(changelogText, version)
    if (notes) ok(`${config.changelog} has a ${version} section`)
  }

  // Otherwise promote [Unreleased], which is equally hand-written.
  if (!notes && wantsChangelog && changelogText) {
    rolledChangelog = rollUnreleased(changelogText, version, new Date().toISOString().slice(0, 10))
    if (rolledChangelog) {
      notes = changelogSection(rolledChangelog, version)
      ok(`${config.changelog}: [Unreleased] will become [${version}]`)
    }
  }

  // Generate, either because nothing was written or because a source was named.
  if (!notes) {
    if (notesDeferred) {
      notesPending = true
      ok(`release notes will be ${assistant ? 'drafted' : 'generated'} after the commit`)
    } else {
      draftedNotes = draftNotesFor(version)
      if (draftedNotes) {
        notes = draftedNotes
        ok(
          notesSource === 'commits' || !assistant
            ? 'release notes built from the commit log'
            : `release notes drafted by ${assistantName}`,
        )
      } else if (notesSource === 'auto') {
        warn(
          `no ${config.changelog ?? 'changelog'} section and nothing to draft from — GitHub will generate the notes`,
        )
      } else {
        fail(`notes are set to come from "${notesSource}", which produced nothing`)
      }
    }
  }
}

for (const asset of config.assets) {
  if (existsSync(asset)) ok(`asset ${asset}`)
  else fail(`asset ${asset} does not exist`)
}

// Reusing a tag is the resume path, and a resume writes nothing. If this run would still
// produce a commit, that commit moves HEAD past the tag and the release ends up tagged at
// the wrong revision — which is silent until someone checks out the tag.
if (taggedCommit && runs('tag') && (bumping || rolledChangelog)) {
  fail(
    `tag ${tag} already exists at HEAD, but this run would still commit ` +
      `${[bumping && 'a version bump', rolledChangelog && 'a changelog entry'].filter(Boolean).join(' and ')}.\n` +
      '       That commit would leave the tag behind HEAD. Release a new version, or use ' +
      '--only with the steps that remain.',
  )
}

// The project's own gate, run while nothing has mutated. Without this, a prepublishOnly
// hook is the gate — and it fails at the publish step, after the commit, tag and push.
if (config.verify) {
  note(`running verify: ${config.verify}`)
  try {
    execSync(config.verify, { stdio: 'pipe', encoding: 'utf8' })
    ok(`verify passed: ${config.verify}`)
  } catch (err) {
    const tail = `${err.stdout ?? ''}${err.stderr ?? ''}`.trim().split('\n').slice(-12).join('\n')
    fail(`verify failed: ${config.verify}\n${indent(tail)}`)
  }
}

if (problems.length) {
  const summary = `${problems.length} preflight check(s) failed:\n  - ${problems.join('\n  - ')}`
  if (!dryRun) abort(summary)
  console.log(
    `\n  ${yellow('dry run: the above would abort here — showing the remaining steps anyway')}`,
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// CONFIRM
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Stage the working tree and draft its commit message before the confirmation prompt, so
 * what gets approved is the message that will actually be written. Staging is the first
 * mutation, and it is undone if the release is declined — `git add` touches only the index,
 * never the working tree, so restoring it is exact.
 */
let commitMessage = null
let didStage = false
if (dirty && runs('commit') && !dryRun) {
  step('Stage the working tree')
  mutate('git', ['add', '--all'])
  didStage = true
  commitMessage = assistant ? draftCommitMessage() : null
  if (!commitMessage) {
    // No assistant, or its draft was unusable: never block on a text generator. The
    // deterministic floor is a chore commit that names what it touches.
    if (assistant) {
      note(`${assistantName} produced no usable message — falling back to a generated one`)
    }
    const files =
      tryRead('git', ['diff', '--cached', '--name-only'])?.split('\n').filter(Boolean) ?? []
    commitMessage = fallbackCommitMessage(files)
  }
  console.log(indent(commitMessage))
}

if (!assumeYes && !dryRun && process.stdin.isTTY) {
  if (notes) console.log(`\n${bold('Release notes')}\n${indent(notes)}`)
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  let answer = ''
  try {
    answer = await rl.question(`\nRelease ${bold(tag)} of ${projectName}? [y/N] `)
  } catch {
    // Ctrl+C or Ctrl+D at the prompt rejects the question. That is a decline, not a
    // crash — without this it exits on an unhandled AbortError and a stack trace.
  } finally {
    rl.close()
  }
  if (!/^y(es)?$/i.test(answer.trim())) {
    // Leave the index exactly as it was found.
    if (didStage) mutate('git', ['reset', '--quiet'])
    abort('cancelled')
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// RELEASE
// ─────────────────────────────────────────────────────────────────────────────

const staged = []

if (dirty && runs('commit')) {
  step('Commit the working tree')
  if (dryRun) console.log(`  ${yellow('would run:')} git commit -m <drafted at run time>`)
  else mutate('git', ['commit', '-m', commitMessage])

  // Now that the commit exists it is part of the release, so the notes can describe it.
  if (notesPending && !dryRun) {
    draftedNotes = draftNotesFor(version)
    if (draftedNotes) notes = draftedNotes
  }
}

if (bumping) {
  step(`Write version ${version}`)
  for (const source of versionTargets) {
    if (!existsSync(source.path)) abort(`versionFiles entry ${source.path} does not exist`)
    if (writeVersionInto(source, version, { dryRun })) {
      staged.push(source.path)
      console.log(`  ${dryRun ? yellow('would write') : dim('wrote')} ${source.path}`)
    }
  }
  // A package-lock.json embeds the root version twice, so it goes stale on a bump.
  if (existsSync('package-lock.json')) {
    mutate('npm', ['install', '--package-lock-only', '--ignore-scripts', '--silent'])
    staged.push('package-lock.json')
  }
}

if (rolledChangelog && runs('changelog')) {
  step(`Roll ${config.changelog} to ${version}`)
  if (dryRun) console.log(`  ${yellow('would write')} ${config.changelog}`)
  else writeFileSync(config.changelog, rolledChangelog)
  staged.push(config.changelog)
} else if (runs('changelog') && draftedNotes && config.changelog && existsSync(config.changelog)) {
  step(`Add the drafted ${version} section to ${config.changelog}`)
  if (dryRun) console.log(`  ${yellow('would write')} ${config.changelog}`)
  else {
    writeFileSync(
      config.changelog,
      insertChangelogSection(
        readFileSync(config.changelog, 'utf8'),
        version,
        new Date().toISOString().slice(0, 10),
        draftedNotes,
      ),
    )
  }
  staged.push(config.changelog)
}

if (staged.length) {
  step('Commit')
  mutate('git', ['add', '--', ...staged])
  mutate('git', ['commit', '-m', expand(config.commitMessage)])
}

/**
 * Hand the notes to whatever builds and publishes next. goreleaser, cargo-dist and similar
 * take release notes as a file and then own the GitHub release themselves.
 *
 * The notes are also in the annotated tag, but reading them back with `%(contents)` embeds
 * the signature when tags are signed — this writes the text itself, with no such trap.
 */
const notesFile = requestedNotesFile ?? config.notesFile
if (notesFile) {
  step(`Write release notes to ${notesFile}`)
  if (dryRun) console.log(`  ${yellow('would write')} ${notesFile}`)
  else writeFileSync(notesFile, `${notes ?? `${projectName} ${tag}`}\n`)
}

if (runs('tag') && !taggedCommit) {
  step(`Annotated tag ${tag}`)
  // The notes become the tag annotation too, so a CI release workflow can read them
  // straight off the tag instead of re-deriving them. --cleanup=verbatim is required:
  // git's default strips every line starting with '#', which would silently eat the
  // markdown headings out of the notes.
  mutate('git', [
    'tag',
    '-a',
    tag,
    '--cleanup=verbatim',
    '-m',
    `${notes ?? `${projectName} ${tag}`}\n`,
  ])
}

if (runs('push')) {
  step(`Push branch and tag to ${config.remote}`)
  pushBranchAndTag(branch ?? 'HEAD')
}

for (const target of publishTargets) {
  if (alreadyPublished.has(target.command)) continue
  step(
    `Publish ${target.name} (${target.cli}${NPM_CLIS.has(target.cli) ? `, dist-tag ${distTag}` : ''})`,
  )
  mutateShell(target.command)
}

if (runs('release') && !releaseExists) {
  step(`GitHub release ${tag}`)
  const args = [
    'release',
    'create',
    tag,
    '--title',
    expand(config.releaseTitle),
    isPrerelease ? '--prerelease' : '--latest',
    // Notes arrive on stdin, so there is no temp file and nothing to escape.
    ...(notes ? ['--notes-file', '-'] : ['--generate-notes']),
    ...config.assets,
  ]
  mutate('gh', args, notes ? { input: `${notes}\n` } : {})
}

/**
 * Hand the result back to whatever is orchestrating this. GitHub Actions reads key=value
 * pairs from $GITHUB_OUTPUT, so a workflow can gate later steps on what actually happened
 * rather than re-deriving it from the repository.
 */
function emitOutputs() {
  const file = process.env.GITHUB_OUTPUT
  if (!file || dryRun) return
  const releaseUrl = runs('release')
    ? (tryRead('gh', ['release', 'view', tag, '--json', 'url', '--jq', '.url']) ?? '')
    : ''
  const outputs = {
    version,
    tag,
    name: projectName,
    'dist-tag': distTag,
    steps: STEPS.filter(runs).join(','),
    published: String(publishTargets.some((target) => !alreadyPublished.has(target.command))),
    'release-url': releaseUrl,
  }
  try {
    appendFileSync(
      file,
      `${Object.entries(outputs)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n')}\n`,
    )
    note(`wrote ${Object.keys(outputs).length} outputs to $GITHUB_OUTPUT`)
  } catch {
    // Outputs are a convenience; never fail a completed release over them.
  }
}

emitOutputs()

console.log(
  `\n${green(bold(dryRun ? 'Dry run complete — nothing was changed.' : `Released ${tag}`))}`,
)
if (dryRun) note('Run the same command without --dry-run to execute.')
