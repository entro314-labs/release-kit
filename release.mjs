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
import { basename, join, relative, resolve, sep } from 'node:path'
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
 *                            or { path, pattern }
 *   publish         string   publish command; null to skip publishing entirely
 *   commitMessage   string   release commit subject
 *   releaseTitle    string   GitHub release title
 *   assets          string[] files attached to the GitHub release
 *   versioning      string   how `auto` derives a bump: "conventional", or
 *                            always-patch / always-minor / always-major to never infer
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
 *   version    write the version into package.json and versionFiles
 *   changelog  roll [Unreleased] into the version, or add drafted notes
 *   tag        annotated git tag carrying the release notes
 *   push       push the branch and the tag together
 *   publish    run the configured publish command
 *   release    create the GitHub release
 *
 * `version` and `changelog` write files; those writes are persisted by a release commit
 * made automatically when either step runs.
 */
const STEPS = ['commit', 'version', 'changelog', 'tag', 'push', 'publish', 'release']

/** Everything but `commit`, which is opt-in because it commits work you did not stage. */
const DEFAULT_STEPS = STEPS.filter((name) => name !== 'commit')

const DEFAULTS = {
  steps: DEFAULT_STEPS,
  tagPrefix: 'v',
  branch: 'main',
  remote: 'origin',
  changelog: 'CHANGELOG.md',
  versionFile: undefined,
  versionFiles: [],
  publish: 'npm publish --tag %d',
  commitMessage: 'chore(release): %t',
  releaseTitle: '%t',
  assets: [],
  assistant: null,
  versioning: 'conventional',
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

Flags:
  --only <steps>       run only these steps, comma-separated
  --skip <steps>       run every step except these
  --commit             add the opt-in commit step: commit a dirty working tree with a
                       drafted Conventional Commits message instead of refusing to release
  --preid <id>         prerelease identifier (alpha, beta, rc, next, nightly, canary)
  --dist-tag <name>    override the npm dist-tag (default: derived from the version)
  --dry-run            print every step and execute nothing
  --yes, -y            skip the confirmation prompt
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

function abort(message) {
  console.log(`\n${red(bold('RELEASE ABORTED'))} — ${message}\n`)
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

/** Commit subjects since the last tag, with release and merge commits filtered out. */
function commitsSinceLastTag() {
  const lastTag = tryRead('git', ['describe', '--tags', '--abbrev=0'])
  const range = lastTag ? `${lastTag}..HEAD` : 'HEAD'
  // %B is the whole message: bodies carry BREAKING CHANGE and Release-As footers. A record
  // separator keeps multi-line messages parseable when splitting the log back apart.
  const raw = tryRead('git', ['log', `--format=%B%x1e`, range]) ?? ''
  const commits = raw
    .split('\u001e')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [subject, ...rest] = entry.split('\n')
      return { subject: subject.trim(), body: rest.join('\n').trim() }
    })
    .filter(
      ({ subject }) =>
        subject &&
        !/^chore\(release\)/i.test(subject) &&
        !/^Merge (branch|pull request|remote)/i.test(subject) &&
        !/^wip\b/i.test(subject) &&
        !/^(fixup|squash)!/.test(subject),
    )
  return { lastTag, commits, subjects: commits.map((c) => c.subject) }
}

/**
 * Conventional Commit types and the changelog heading each lands under, following
 * release-please's defaults. Types marked hidden are real changes but not release notes:
 * a reader upgrading does not need to know the CI config moved.
 */
const CHANGELOG_SECTIONS = [
  { type: 'feat', section: 'Features' },
  { type: 'fix', section: 'Bug Fixes' },
  { type: 'perf', section: 'Performance Improvements' },
  { type: 'revert', section: 'Reverts' },
  { type: 'docs', section: 'Documentation', hidden: true },
  { type: 'style', section: 'Styles', hidden: true },
  { type: 'refactor', section: 'Code Refactoring', hidden: true },
  { type: 'test', section: 'Tests', hidden: true },
  { type: 'build', section: 'Build System', hidden: true },
  { type: 'ci', section: 'Continuous Integration', hidden: true },
  { type: 'chore', section: 'Miscellaneous Chores', hidden: true },
]

/**
 * Parse a commit into the parts a release cares about.
 *
 * @returns {{type: string, scope: string|null, breaking: boolean, subject: string,
 *   releaseAs: string|null} | null} null when the subject is not Conventional Commits
 */
function parseCommit(subject, body = '') {
  const match = /^([a-z]+)(?:\(([^)]+)\))?(!)?: (.+)$/i.exec(subject)
  if (!match) return null
  const [, type, scope, bang, text] = match
  // A breaking change is marked either by `!` in the header or a BREAKING CHANGE footer.
  const breaking = !!bang || /^BREAKING[ -]CHANGE:/m.test(body)
  // `Release-As: 1.2.3` in a commit body pins the next version, so the decision can live
  // in git history rather than on the command line.
  const releaseAs = /^Release-As:\s*v?(\S+)/im.exec(body)?.[1] ?? null
  return { type: type.toLowerCase(), scope: scope ?? null, breaking, subject: text, releaseAs }
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
  const parsed = commits.map((c) => parseCommit(c.subject, c.body)).filter(Boolean)
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
function changelogFromCommits(commits) {
  const parsed = commits.map((c) => parseCommit(c.subject, c.body)).filter(Boolean)
  const lines = []

  const breaking = parsed.filter((c) => c.breaking)
  if (breaking.length) {
    lines.push('### ⚠ BREAKING CHANGES', '')
    for (const c of breaking) lines.push(`- ${c.scope ? `**${c.scope}:** ` : ''}${c.subject}`)
    lines.push('')
  }

  for (const { type, section, hidden } of CHANGELOG_SECTIONS) {
    if (hidden) continue
    const inSection = parsed.filter(
      (c) => c.type === type || (type === 'feat' && c.type === 'feature'),
    )
    if (!inSection.length) continue
    lines.push(`### ${section}`, '')
    for (const c of inSection) lines.push(`- ${c.scope ? `**${c.scope}:** ` : ''}${c.subject}`)
    lines.push('')
  }

  return lines.length ? lines.join('\n').trim() : null
}

const CONVENTIONAL_TYPES = 'build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test'
const CONVENTIONAL_RE = new RegExp(`^(${CONVENTIONAL_TYPES})(\\([^)]+\\))?!?: .+`)

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
    `- Subject: "<type>(<optional scope>): <description>" where type is one of ${CONVENTIONAL_TYPES.split('|').join(', ')}.`,
    '- Subject in the imperative mood, no trailing period, under 72 characters.',
    '- Add a body only if the change needs explanation; separate it with a blank line.',
    '- Output the raw commit message and nothing else: no markdown fences, no preamble.',
    '- Do NOT add Co-Authored-By, Signed-off-by, or any attribution or tool credit.',
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
  return CONVENTIONAL_RE.test(subject) ? message : null
}

/**
 * Draft release notes from the commits since the last tag, in the changelog's own style.
 *
 * @returns {string | null} markdown body (no version heading), or null
 */
function draftReleaseNotes(version, subjects, lastTag) {
  if (!subjects.length) return null

  const prompt = [
    `Write release notes for version ${version}.`,
    '',
    'Rules:',
    '- Group the changes under Keep a Changelog headings (`### Added`, `### Changed`,',
    '  `### Fixed`, `### Removed`), including only the headings that apply.',
    '- One bullet per user-visible change. Merge related commits into a single bullet.',
    '- Omit internal chores: CI, linting, formatting, dependency bumps, version bumps.',
    '- Write for someone upgrading: say what changed for them, not which files moved.',
    '- Plain, factual language. No hype, no emoji, no concluding summary.',
    '- Output only the markdown body: no version heading, no code fences, no attribution.',
    '- Do NOT explain your reasoning or add any commentary before or after the notes.',
    '',
    `Commit subjects since ${lastTag ?? 'the start of the project'}:`,
    ...subjects.map((s) => `- ${s}`),
  ].join('\n')

  const drafted = runAssistant(prompt)
  return drafted ? cleanNotes(drafted) : null
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
 * Rewrite a `## [Unreleased]` heading as the released version, and open a fresh
 * `## [Unreleased]` above it for the next cycle.
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
  const rest = text.slice(match.index + match[0].length)
  const body = (/^## /m.exec(rest) ? rest.slice(0, /^## /m.exec(rest).index) : rest).trim()
  if (!body) return null
  const released = `## [Unreleased]\n\n## [${version}] - ${date}`
  return text.slice(0, match.index) + released + text.slice(match.index + match[0].length)
}

/**
 * Insert a section for a version above the newest existing one, so drafted notes are kept
 * in the changelog rather than only reaching the tag and the GitHub release.
 */
function insertChangelogSection(text, version, date, body) {
  const entry = `## [${version}] - ${date}\n\n${body}\n`
  const firstSection = /^## /m.exec(text)
  if (!firstSection) return `${text.trimEnd()}\n\n${entry}`
  return `${text.slice(0, firstSection.index)}${entry}\n${text.slice(firstSection.index)}`
}

// ─────────────────────────────────────────────────────────────────────────────
// JSON FILES
// ─────────────────────────────────────────────────────────────────────────────

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))

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

/** The regex for a source, or null when the whole file is the version. */
function patternFor({ path, pattern }) {
  if (pattern) return new RegExp(pattern, 'm')
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
 * @returns {boolean} whether the file needed changing
 */
function writeVersionInto(entry, version) {
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
    if (!existsSync(join(projectRoot, 'package.json'))) {
      warn(`${target}: no package.json — skipped`)
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
    const scripts = readJson(join(projectRoot, 'package.json')).scripts ?? {}
    if (!scripts.release) {
      warn(`${target}: add "release": "node scripts/${basename(self)}" to package.json`)
    }
  }
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
  '--assistant',
  '--assistant-model',
  '--assistant-effort',
])

/** The version or bump target: the first argument that is neither a flag nor a flag's value. */
const target = (() => {
  for (let i = 0; i < argv.length; i += 1) {
    if (VALUE_OPTIONS.has(argv[i])) {
      i += 1
      continue
    }
    if (!argv[i].startsWith('-')) return argv[i]
  }
  return undefined
})()

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

const userConfig = existsSync('release.config.json') ? readJson('release.config.json') : {}
const config = { ...DEFAULTS, ...userConfig }
const unknownKeys = Object.keys(config).filter((key) => !(key in DEFAULTS))
if (unknownKeys.length) abort(`release.config.json has unknown keys: ${unknownKeys.join(', ')}`)

/**
 * Which steps run: config provides the baseline, --only replaces it, --skip subtracts, and
 * --commit adds the opt-in step. Unknown names are an error rather than a silent no-op.
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
 * Where this project keeps its version, when the config does not say. Checked in order of
 * how definitively each file identifies a repository. `go.mod` resolves to null because Go
 * modules carry no version — the tag is the version.
 */
function detectVersionFile() {
  for (const candidate of ['package.json', 'pyproject.toml', 'Cargo.toml', 'VERSION']) {
    if (existsSync(candidate)) return candidate
  }
  return null
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

const currentVersion = versionFile ? readVersionFrom(versionFile) : null
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
      'this repository has no versionFile, so there is no version to default to.\n' +
        '  Pass one explicitly: release-kit 1.2.3',
    )
  }
  version = currentVersion
} else if (target === 'auto') {
  if (!currentVersion) {
    abort('auto needs a versionFile to bump from. Pass a version explicitly instead.')
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
    abort(`a ${target} bump needs a versionFile to bump from. Pass a version explicitly instead.`)
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
const bumping = !!versionFile && version !== currentVersion && runs('version')

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

const publishCommand = runs('publish') && config.publish ? expandShell(config.publish) : null

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
  // For Go the tag is the release; `go list` warms the module proxy and doubles as the
  // check for whether this version is already resolvable.
  go: { published: (name, v) => ['list', '-m', `${name}@${v}`] },
}

const publishCli = publishCommand?.trim().split(/\s+/)[0]
const registry = publishCli ? REGISTRIES[publishCli] : null

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

if (bumping && compareVersions(version, currentVersion) <= 0) {
  fail(`${version} is not greater than the current version ${currentVersion}`)
} else if (bumping) {
  ok(`version ${currentVersion} → ${version}`)
} else if (versionFile) {
  ok(`releasing the version already in ${versionFile.path} (${version})`)
} else {
  ok(`releasing ${version} (no version file; the tag is the version)`)
}

const dirty = tryRead('git', ['status', '--porcelain'])
if (dirty === null) fail('could not read git status')
else if (dirty && runs('commit')) {
  ok(`working tree has ${dirty.split('\n').length} change(s) — will be committed first`)
  console.log(dim(indent(formatStatus(dirty))))
} else if (dirty) {
  fail(`working tree is not clean:\n${indent(formatStatus(dirty))}`)
} else ok('working tree clean')

if (runs('commit') && !assistant) {
  fail(
    'the commit step needs a drafting assistant to write the message. Configure one with ' +
      '`--assistant auto`, or set "assistant" in release.config.json.',
  )
} else if (assistant) {
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

// A shallow clone (CI checkouts default to depth 1) hides the history that release notes
// and the last-tag lookup are derived from. It still releases correctly; the notes just
// silently describe a fraction of the work, so say so before that happens.
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

let alreadyPublished = false
if (!publishCommand) {
  note(runs('publish') ? 'no publish command configured' : 'publish step not selected')
} else if (manifest?.private) {
  fail('package.json is private but a publish command is configured')
} else if (!registry) {
  ok(`publish: ${publishCommand}`)
} else {
  if (isTrustedPublishing) {
    ok('trusted publishing (OIDC) — no token needed')
  } else if (registry.env) {
    // Token-in-the-environment auth: there is no session to interrogate, only credentials.
    const found = registry.env.find((name) => process.env[name])
    if (found) ok(`${publishCli} credentials found (${found})`)
    else fail(`${publishCli} has no publish credentials — ${registry.login}`)
  } else if (registry.whoami) {
    const user = tryRead(publishCli, registry.whoami)
    if (user === null) {
      // npm replaced long-lived tokens with two-hour sessions in December 2025, so the
      // usual cause is an expired session rather than a missing login.
      fail(
        `${publishCli} is not authenticated — run \`${publishCli} login\`. ` +
          'npm logins are two-hour sessions, so an earlier one may have expired.',
      )
    } else ok(`${publishCli} authenticated (${user || 'unknown user'})`)
  }

  if (registry.published) {
    alreadyPublished = succeeds(publishCli, registry.published(projectName, version))
    if (alreadyPublished) {
      note(`${projectName}@${version} is already published — will skip the publish step`)
    }
  }
}

// Notes: the changelog section for this version, else a draft, else GitHub generates them.
let notes = null
let rolledChangelog = null
let draftedNotes = null

/**
 * True when --commit still has to create a commit. Notes drafted before that commit would
 * describe an incomplete release, so drafting waits until the working tree is committed.
 */
const notesDeferred = !!(dirty && runs('commit') && assistant)

/**
 * Notes for a version, in descending order of how much they can be trusted:
 * an assistant's prose when one is configured, otherwise the commits grouped by
 * Conventional Commit type. Only when neither yields anything does GitHub generate them.
 */
function draftNotesFor(v) {
  const { lastTag, subjects, commits } = commitsSinceLastTag()
  if (!commits.length) return null
  if (!assistant) return changelogFromCommits(commits)
  if (shallow) {
    warn(
      `shallow clone: only ${subjects.length} commit(s) are visible, so the notes will ` +
        'describe part of the release. Check out with full history (fetch-depth: 0).',
    )
  }
  note(`drafting notes from ${subjects.length} commit(s) with ${assistantName}...`)
  return draftReleaseNotes(v, subjects, lastTag) ?? changelogFromCommits(commits)
}
if (config.changelog && existsSync(config.changelog)) {
  const text = readFileSync(config.changelog, 'utf8')
  notes = changelogSection(text, version)
  if (notes) {
    ok(`${config.changelog} has a ${version} section`)
  } else {
    rolledChangelog = rollUnreleased(text, version, new Date().toISOString().slice(0, 10))
    if (rolledChangelog) {
      notes = changelogSection(rolledChangelog, version)
      ok(`${config.changelog}: [Unreleased] will become [${version}]`)
    } else {
      draftedNotes = notesDeferred ? null : draftNotesFor(version)
      if (notesDeferred) {
        ok(`${config.changelog}: a ${version} section will be drafted after the commit`)
      } else if (draftedNotes) {
        notes = draftedNotes
        ok(`${config.changelog}: a ${version} section will be drafted by ${assistantName}`)
      } else {
        warn(
          `${config.changelog} has no ${version} or [Unreleased] section — GitHub will generate the notes`,
        )
      }
    }
  }
} else {
  // No changelog file at all: there is nothing to roll, but notes can still be drafted for
  // the tag annotation and the GitHub release.
  notes = notesDeferred ? null : draftNotesFor(version)
  if (notesDeferred) ok('release notes will be drafted after the commit')
  else if (notes) ok(`release notes drafted by ${assistantName}`)
  else if (config.changelog) note(`no ${config.changelog} — GitHub will generate the notes`)
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
  if (!/^y(es)?$/i.test(answer.trim())) abort('cancelled')
}

// ─────────────────────────────────────────────────────────────────────────────
// RELEASE
// ─────────────────────────────────────────────────────────────────────────────

const staged = []

if (dirty && runs('commit')) {
  step('Commit the working tree')
  mutate('git', ['add', '--all'])
  // Draft after staging: the message describes what is staged, not what happens to be
  // in the tree. Under --dry-run nothing was staged, so there is nothing to describe.
  const message = dryRun ? null : draftCommitMessage()
  if (!message && !dryRun) {
    abort(
      `${assistantName} could not draft a Conventional Commits message for the staged changes.\n\n` +
        '  Commit them yourself and re-run, or run without --commit.',
    )
  }
  console.log(indent(message ?? '<drafted at run time>'))
  mutate('git', ['commit', '-m', message ?? 'chore: working tree'])

  // Now that the commit exists it is part of the release, so the notes can describe it.
  if (notesDeferred && !dryRun) {
    draftedNotes = draftNotesFor(version)
    if (draftedNotes) notes = draftedNotes
  }
}

if (bumping) {
  step(`Write version ${version}`)
  for (const entry of [versionFile, ...config.versionFiles]) {
    const source = versionSource(entry)
    if (!existsSync(source.path)) abort(`versionFiles entry ${source.path} does not exist`)
    if (writeVersionInto(source, version)) {
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
  // --follow-tags sends the commit and the tag in one call; pushing them separately is how
  // a tag ends up on the remote without its commit, or a release without its tag.
  mutate('git', ['push', '--follow-tags', config.remote, branch ?? 'HEAD'])
}

if (publishCommand && !alreadyPublished) {
  step(`Publish to the registry (dist-tag ${distTag})`)
  mutateShell(publishCommand)
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
    published: String(!!publishCommand && !alreadyPublished),
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
