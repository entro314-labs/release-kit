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
 * Two properties matter more than the feature list:
 *
 *  - Preflight accumulates. Every check runs, every failure is reported, then it aborts
 *    once. You fix all of it in one pass instead of rediscovering the next problem after
 *    each retry.
 *  - Every step is idempotent. A run that dies halfway (publish 2FA timeout, flaky
 *    network) can be re-run: an already-written version, an existing tag at HEAD, an
 *    already-published version and an existing release are each detected and skipped.
 *    There is no cleanup step and no --resume flag to remember.
 *
 * Configuration is optional. Defaults are the conventions (package.json version,
 * CHANGELOG.md, main branch, `v` tag prefix, npm publish); a release.config.json beside
 * package.json overrides only what differs. See CONFIG below.
 */

import { execFileSync, execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
 *   versionFiles    string[] extra JSON files whose top-level "version" is kept in sync
 *   publish         string   publish command; null to skip publishing entirely
 *   commitMessage   string   release commit subject
 *   releaseTitle    string   GitHub release title
 *   assets          string[] files attached to the GitHub release
 */
const DEFAULTS = {
  tagPrefix: 'v',
  branch: 'main',
  remote: 'origin',
  changelog: 'CHANGELOG.md',
  versionFiles: [],
  publish: 'npm publish --tag %d',
  commitMessage: 'chore(release): %t',
  releaseTitle: '%t',
  assets: [],
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

Flags:
  --preid <id>         prerelease identifier (alpha, beta, rc, next, nightly, canary)
  --tag <dist-tag>     override the npm dist-tag (default: derived from the version)
  --dry-run            print every step and execute nothing
  --yes, -y            skip the confirmation prompt
  --skip-publish       do not publish to the registry
  --skip-release       do not create the GitHub release
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
 * only — ` M file` becomes `M file` while the rest keep theirs, and the column bends.
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
  const heading = /^##\s+\[?Unreleased\]?[^\n]*$/im
  const match = heading.exec(text)
  if (!match) return null
  const released = `## [Unreleased]\n\n## [${version}] - ${date}`
  return text.slice(0, match.index) + released + text.slice(match.index + match[0].length)
}

// ─────────────────────────────────────────────────────────────────────────────
// JSON FILES
// ─────────────────────────────────────────────────────────────────────────────

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))

/**
 * Write a top-level "version" into a JSON file without reformatting the rest of it: the
 * value is replaced in place, so key order, indentation and trailing newline all survive.
 *
 * @returns {boolean} whether the file needed changing
 */
function writeVersionInto(path, version) {
  const text = readFileSync(path, 'utf8')
  const field = /^(\s*"version"\s*:\s*)"[^"]*"/m
  if (!field.test(text)) throw new Error(`${path} has no top-level "version" field`)
  const updated = text.replace(field, `$1"${version}"`)
  if (updated === text) return false
  if (!dryRun) writeFileSync(path, updated)
  return true
}

// ─────────────────────────────────────────────────────────────────────────────
// ARGUMENTS
// ─────────────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2)
const BUMPS = new Set(['major', 'minor', 'patch', 'premajor', 'preminor', 'prepatch', 'prerelease'])

const flag = (name) => argv.includes(name)
const option = (name) => {
  const index = argv.indexOf(name)
  return index === -1 ? undefined : argv[index + 1]
}

const dryRun = flag('--dry-run')
const assumeYes = flag('--yes') || flag('-y')
const skipPublish = flag('--skip-publish')
const skipRelease = flag('--skip-release')
const explicitDistTag = option('--tag')
const requestedPreid = option('--preid')

if (flag('--help') || flag('-h')) {
  console.log(USAGE)
  process.exit(0)
}

// --sync copies this file into other projects and exits; it touches no git state.
if (flag('--sync')) {
  const self = new URL(import.meta.url).pathname
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

const target = argv.find((a) => !a.startsWith('-') && a !== explicitDistTag && a !== requestedPreid)

// ─────────────────────────────────────────────────────────────────────────────
// SETUP
// ─────────────────────────────────────────────────────────────────────────────

const root = tryRead('git', ['rev-parse', '--show-toplevel'])
if (!root) abort('not inside a git repository')
process.chdir(root)

if (!existsSync('package.json')) abort(`no package.json at ${root}`)
const pkg = readJson('package.json')
if (!pkg.version) abort('package.json has no "version" field')
if (!parseVersion(pkg.version)) abort(`package.json version "${pkg.version}" is not semver`)

const config = {
  ...DEFAULTS,
  ...(existsSync('release.config.json') ? readJson('release.config.json') : {}),
}
const unknownKeys = Object.keys(config).filter((key) => !(key in DEFAULTS))
if (unknownKeys.length) abort(`release.config.json has unknown keys: ${unknownKeys.join(', ')}`)

// ─────────────────────────────────────────────────────────────────────────────
// RESOLVE THE TARGET VERSION
// ─────────────────────────────────────────────────────────────────────────────

console.log(
  bold(`${pkg.name} release`) + (dryRun ? `  ${yellow('(dry run — nothing will execute)')}` : ''),
)

let version
if (!target) {
  ;({ version } = pkg)
} else if (BUMPS.has(target)) {
  const preid = requestedPreid ?? preidOf(pkg.version)
  if (target.startsWith('pre') && !preid) {
    abort(
      `a ${target} bump from a stable version needs --preid <${[...KNOWN_CHANNELS].sort().join('|')}>`,
    )
  }
  version = incrementVersion(pkg.version, target, preid)
} else if (parseVersion(target)) {
  version = target
} else {
  abort(`"${target}" is neither a semver version nor a bump (${[...BUMPS].join(', ')})`)
}

const tag = `${config.tagPrefix}${version}`
const isPrerelease = parseVersion(version).pre.length > 0
const bumping = version !== pkg.version

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
    .replaceAll('%n', transform(pkg.name))
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

const publishCommand = config.publish && !skipPublish ? expandShell(config.publish) : null

/**
 * npm and pnpm answer `whoami` and `view` identically and share `~/.npmrc`, so whichever
 * one publishes can also run the registry preflight. Checking with the wrong one mislabels
 * the result. A publish command driving anything else (vsce, a shell pipeline) is left
 * alone — it cannot be introspected, and guessing would invent failures.
 */
const REGISTRY_CLIS = new Set(['npm', 'pnpm'])
const publishCli = publishCommand?.trim().split(/\s+/)[0]
const registryCli = REGISTRY_CLIS.has(publishCli) ? publishCli : null

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

console.log(`  ${dim(`${pkg.version} → ${version}   tag ${tag}   dist-tag ${distTag}`)}`)

// ─────────────────────────────────────────────────────────────────────────────
// PREFLIGHT — every check runs, then we abort once with all of the failures
// ─────────────────────────────────────────────────────────────────────────────

step('Preflight')

const problems = []
const fail = (message) => {
  console.log(`  ${red('fail')} ${message}`)
  problems.push(message)
}

if (bumping && compareVersions(version, pkg.version) <= 0) {
  fail(`${version} is not greater than the current version ${pkg.version}`)
} else if (bumping) {
  ok(`version ${pkg.version} → ${version}`)
} else {
  ok(`releasing the version already in package.json (${version})`)
}

const dirty = tryRead('git', ['status', '--porcelain'])
if (dirty === null) fail('could not read git status')
else if (dirty) fail(`working tree is not clean:\n${indent(formatStatus(dirty))}`)
else ok('working tree clean')

const branch = tryRead('git', ['rev-parse', '--abbrev-ref', 'HEAD'])
if (!branch) fail('could not read the current branch')
else if (config.branch && branch !== config.branch) {
  fail(`on '${branch}', expected '${config.branch}'`)
} else ok(`on ${branch}`)

if (!succeeds('git', ['remote', 'get-url', config.remote])) {
  fail(`no '${config.remote}' remote configured`)
} else {
  ok(`remote ${config.remote}`)
  // Fetch so the tag and behind-remote checks below see the real remote state.
  if (!succeeds('git', ['fetch', '--quiet', '--tags', config.remote])) {
    fail(`could not fetch from ${config.remote}`)
  } else if (branch) {
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

const head = tryRead('git', ['rev-parse', 'HEAD'])
const taggedCommit = tryRead('git', ['rev-list', '-n', '1', tag])
if (taggedCommit && bumping) {
  fail(`tag ${tag} already exists — release a different version`)
} else if (taggedCommit && taggedCommit !== head) {
  fail(`tag ${tag} already exists at ${taggedCommit.slice(0, 8)}, not at HEAD`)
} else if (taggedCommit) {
  ok(`tag ${tag} already exists at HEAD — will reuse it`)
} else {
  ok(`tag ${tag} is free`)
}

let releaseExists = false
if (skipRelease) {
  note('GitHub release skipped (--skip-release)')
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
  note(skipPublish ? 'publish skipped (--skip-publish)' : 'publish disabled in config')
} else if (pkg.private) {
  fail('package.json is private but a publish command is configured')
} else if (!registryCli) {
  ok(`publish: ${publishCommand}`)
} else {
  if (isTrustedPublishing) {
    ok('trusted publishing (OIDC) — no token needed')
  } else {
    const user = tryRead(registryCli, ['whoami'])
    if (user === null) {
      // npm replaced long-lived tokens with two-hour sessions in December 2025, so the
      // usual cause is an expired login rather than never having logged in at all.
      fail(
        `${registryCli} is not authenticated — run \`${registryCli} login\`. ` +
          'npm logins are two-hour sessions now, so one from an earlier sitting has expired.',
      )
    } else ok(`${registryCli} authenticated (${user || 'unknown user'})`)
  }
  alreadyPublished = succeeds(registryCli, ['view', `${pkg.name}@${version}`, 'version'])
  if (alreadyPublished) {
    note(`${pkg.name}@${version} is already on the registry — will skip publishing`)
  }
}

// Notes: the changelog section for this version, else GitHub generates them from commits.
let notes = null
let rolledChangelog = null
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
      warn(
        `${config.changelog} has no ${version} or [Unreleased] section — GitHub will generate the notes`,
      )
    }
  }
} else if (config.changelog) {
  note(`no ${config.changelog} — GitHub will generate the notes`)
}

for (const asset of config.assets) {
  if (existsSync(asset)) ok(`asset ${asset}`)
  else fail(`asset ${asset} does not exist`)
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
    answer = await rl.question(`\nRelease ${bold(tag)} of ${pkg.name}? [y/N] `)
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

if (bumping) {
  step(`Write version ${version}`)
  for (const file of ['package.json', ...config.versionFiles]) {
    if (!existsSync(file)) abort(`versionFiles entry ${file} does not exist`)
    if (writeVersionInto(file, version)) {
      staged.push(file)
      console.log(`  ${dryRun ? yellow('would write') : dim('wrote')} ${file}`)
    }
  }
  // A package-lock.json embeds the root version twice, so it goes stale on a bump.
  if (existsSync('package-lock.json')) {
    mutate('npm', ['install', '--package-lock-only', '--ignore-scripts', '--silent'])
    staged.push('package-lock.json')
  }
}

if (rolledChangelog) {
  step(`Roll ${config.changelog} to ${version}`)
  if (dryRun) console.log(`  ${yellow('would write')} ${config.changelog}`)
  else writeFileSync(config.changelog, rolledChangelog)
  staged.push(config.changelog)
}

if (staged.length) {
  step('Commit')
  mutate('git', ['add', '--', ...staged])
  mutate('git', ['commit', '-m', expand(config.commitMessage)])
}

if (!taggedCommit) {
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
    `${notes ?? `${pkg.name} ${tag}`}\n`,
  ])
}

step(`Push branch and tag to ${config.remote}`)
// --follow-tags sends the commit and the tag in one call; pushing them separately is how
// a tag ends up on the remote without its commit, or a release without its tag.
mutate('git', ['push', '--follow-tags', config.remote, branch ?? 'HEAD'])

if (publishCommand && !alreadyPublished) {
  step(`Publish to the registry (dist-tag ${distTag})`)
  mutateShell(publishCommand)
}

if (!skipRelease && !releaseExists) {
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

console.log(
  `\n${green(bold(dryRun ? 'Dry run complete — nothing was changed.' : `Released ${tag}`))}`,
)
if (dryRun) note('Run the same command without --dry-run to execute.')
