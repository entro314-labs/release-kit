#!/usr/bin/env node
/**
 * release-train — orchestrated releases for interdependent packages, prototype.
 *
 * Implements the read-only phases of TRAIN.md — discover → graph → detect changes →
 * cascade → plan → preflight — plus `seed-tags`, which establishes baseline release tags.
 * Execution (releasing via release-kit) is not implemented yet; `train` without
 * --dry-run says so and exits.
 *
 *   train graph              print the derived dependency graph and topo order
 *   train --dry-run          full plan + whole-train preflight, execute nothing
 *   train --dry-run --all    plan every member, not just changed ones
 *   train --dry-run <id>...  plan these packages and their dependents
 *   train seed-tags          create baseline tags at each repo's HEAD (--dry-run to preview)
 *   train --offline          skip network work (registry lookups, tag pushes)
 *   train --config <path>    config elsewhere than ./train.config.json
 *
 * Reads train.config.json in the working directory. Config declares membership and
 * policy only; versions, dependencies and order are derived from the package manifests —
 * see TRAIN.md for why.
 *
 * A package's next version is derived, never guessed, from three sources in this order:
 *   1. The registry. A manifest version that is not published — a pending bump that was
 *      committed but never released, or a package that has never been published — is
 *      released **as-is**: the pending version is the release, nothing is skipped over.
 *      A manifest *behind* the registry is a preflight failure, not a guess.
 *   2. The commits since the package's last release tag, by Conventional Commit rules
 *      (feat → minor, breaking → major, softened below 1.0.0).
 *   3. The cascade: a dependent of a releasing package joins with at least a patch.
 */

import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// ─────────────────────────────────────────────────────────────────────────────
// Small utilities
// ─────────────────────────────────────────────────────────────────────────────

function fail(message) {
  console.error(`train: ${message}`)
  process.exit(1)
}

function git(repoDir, args, { allowFailure = false } = {}) {
  try {
    return execFileSync('git', args, {
      cwd: repoDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  } catch (err) {
    if (allowFailure) return null
    throw err
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

// ─────────────────────────────────────────────────────────────────────────────
// Semver — the subset the train needs (release-kit owns full semver per package)
// ─────────────────────────────────────────────────────────────────────────────

export function parseSemver(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version ?? '')
  if (!match) return null
  return { major: +match[1], minor: +match[2], patch: +match[3], prerelease: match[4] ?? null }
}

export function compareSemver(a, b) {
  const pa = parseSemver(a)
  const pb = parseSemver(b)
  if (!pa || !pb) return 0
  for (const key of ['major', 'minor', 'patch']) {
    if (pa[key] !== pb[key]) return pa[key] - pb[key]
  }
  if (pa.prerelease && !pb.prerelease) return -1
  if (!pa.prerelease && pb.prerelease) return 1
  return 0
}

export function bumpSemver(version, bump) {
  const v = parseSemver(version)
  if (!v) return null
  if (bump === 'as-is') return version
  if (bump === 'major') return `${v.major + 1}.0.0`
  if (bump === 'minor') return `${v.major}.${v.minor + 1}.0`
  return `${v.major}.${v.minor}.${v.patch + 1}`
}

/**
 * Conventional Commit derivation over full messages: feat → minor, a breaking change
 * (`!` in the type or a BREAKING CHANGE footer anywhere in the body) → major, softened
 * to minor below 1.0.0, else patch.
 */
export function bumpFromCommits(messages, currentVersion) {
  let bump = 'patch'
  const below1 = parseSemver(currentVersion)?.major === 0
  for (const message of messages) {
    const subject = message.split('\n', 1)[0]
    if (/^[a-z]+(\([^)]*\))?!:/.test(subject) || /BREAKING CHANGE/.test(message)) {
      return below1 ? 'minor' : 'major'
    }
    if (/^feat(\([^)]*\))?:/.test(subject)) bump = 'minor'
  }
  return bump
}

// ─────────────────────────────────────────────────────────────────────────────
// Configuration and argument parsing
// ─────────────────────────────────────────────────────────────────────────────

const CONFIG_KEYS = new Set([
  '$schema',
  'packages',
  'rangePolicy',
  'registryWait',
  'summaryFile',
  'assistant',
])
const RANGE_POLICIES = new Set(['caret', 'tilde', 'exact', 'preserve'])
const ASSISTANT_NAMES = new Set(['none', 'auto', 'claude', 'codex'])

/** Normalize an assistant spec (a name, "auto", "none", or { tool, model, effort }). */
export function normalizeAssistant(spec) {
  if (spec === null || spec === undefined || spec === 'none') return null
  const object = typeof spec === 'string' ? { tool: spec } : spec
  if (
    typeof object.tool !== 'string' ||
    !ASSISTANT_NAMES.has(object.tool) ||
    object.tool === 'none'
  ) {
    return {
      error: `assistant must be one of: ${[...ASSISTANT_NAMES].join(', ')}, or { tool, model, effort }`,
    }
  }
  return { tool: object.tool, model: object.model ?? null, effort: object.effort ?? null }
}

export function loadConfig(configPath) {
  if (!existsSync(configPath)) fail(`no ${basename(configPath)} found at ${configPath}`)
  const config = readJson(configPath)
  const unknown = Object.keys(config).filter((key) => !CONFIG_KEYS.has(key))
  if (unknown.length)
    fail(`unknown config key${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`)
  if (!Array.isArray(config.packages) || config.packages.length === 0) {
    fail('config must declare a non-empty "packages" array')
  }
  const rangePolicy = config.rangePolicy ?? 'caret'
  if (!RANGE_POLICIES.has(rangePolicy))
    fail(`rangePolicy must be one of: ${[...RANGE_POLICIES].join(', ')}`)
  const registryWait = { timeout: 300, interval: 5, ...config.registryWait }
  const assistant = normalizeAssistant(config.assistant ?? null)
  if (assistant?.error) fail(assistant.error)
  const summaryFile = config.summaryFile ?? null
  if (summaryFile !== null && typeof summaryFile !== 'string')
    fail('summaryFile must be a path or null')
  return { packages: config.packages, rangePolicy, registryWait, summaryFile, assistant }
}

const KNOWN_FLAGS = new Set([
  '--dry-run',
  '--all',
  '--offline',
  '--config',
  '--summary',
  '--assistant',
  '--help',
  '-h',
])
const COMMANDS = new Set(['graph', 'seed-tags'])

function parseArgs(argv) {
  const args = {
    command: null,
    ids: [],
    dryRun: false,
    all: false,
    offline: false,
    configPath: null,
    summaryPath: null,
    assistant: undefined, // undefined = no override; null = --assistant none (kill switch)
    help: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--config') {
      args.configPath = argv[++i] ?? fail('--config needs a path')
    } else if (arg === '--summary') {
      args.summaryPath = argv[++i] ?? fail('--summary needs a path')
    } else if (arg === '--assistant') {
      const name = argv[++i] ?? fail('--assistant needs a name (none, auto, claude, codex)')
      if (!ASSISTANT_NAMES.has(name))
        fail(`--assistant must be one of: ${[...ASSISTANT_NAMES].join(', ')}`)
      const normalized = normalizeAssistant(name)
      args.assistant = normalized?.error ? fail(normalized.error) : normalized
    } else if (arg === '--dry-run') args.dryRun = true
    else if (arg === '--all') args.all = true
    else if (arg === '--offline') args.offline = true
    else if (arg === '--help' || arg === '-h') args.help = true
    else if (arg.startsWith('-'))
      fail(`unknown flag ${arg} (known: ${[...KNOWN_FLAGS].join(', ')})`)
    else if (args.command === null && args.ids.length === 0 && COMMANDS.has(arg)) args.command = arg
    else args.ids.push(arg)
  }
  if (args.all && args.ids.length)
    fail('--all and explicit package ids conflict — pass one or the other')
  if (args.command === 'graph' && (args.all || args.ids.length))
    fail('graph takes no package ids or --all')
  return args
}

/** Expand a membership entry to directories. Supports a single trailing `/*`. */
function expandEntry(rootDir, entry) {
  const spec = typeof entry === 'string' ? { path: entry } : entry
  if (!spec.path.includes('*')) return [spec]
  const starIndex = spec.path.indexOf('*')
  const parent = join(rootDir, spec.path.slice(0, starIndex))
  if (!existsSync(parent)) return []
  return readdirSync(parent)
    .filter((name) => !name.startsWith('.') && statSync(join(parent, name)).isDirectory())
    .map((name) =>
      Object.assign({}, spec, { path: join(relative(rootDir, parent), name), id: undefined }),
    )
}

// ─────────────────────────────────────────────────────────────────────────────
// Discovery — manifests and owning repos
// ─────────────────────────────────────────────────────────────────────────────

/** Read whichever manifest the directory carries: name, version, dependency maps. */
function readManifest(dir) {
  const pkgJson = join(dir, 'package.json')
  if (existsSync(pkgJson)) {
    const m = readJson(pkgJson)
    return {
      ecosystem: 'npm',
      manifestFile: 'package.json',
      name: m.name ?? null,
      version: m.version ?? null,
      deps: { ...m.dependencies, ...m.peerDependencies, ...m.optionalDependencies },
      devDeps: { ...m.devDependencies },
    }
  }
  const composer = join(dir, 'composer.json')
  if (existsSync(composer)) {
    const m = readJson(composer)
    return {
      ecosystem: 'php',
      manifestFile: 'composer.json',
      name: m.name ?? null,
      version: m.version ?? null,
      deps: { ...m.require },
      devDeps: { ...m['require-dev'] },
    }
  }
  const pyproject = join(dir, 'pyproject.toml')
  if (existsSync(pyproject)) {
    const text = readFileSync(pyproject, 'utf8')
    const name = /^name\s*=\s*"([^"]+)"/m.exec(text)?.[1] ?? null
    const version = /^version\s*=\s*"([^"]+)"/m.exec(text)?.[1] ?? null
    return {
      ecosystem: 'python',
      manifestFile: 'pyproject.toml',
      name,
      version,
      deps: {},
      devDeps: {},
    }
  }
  const goMod = join(dir, 'go.mod')
  if (existsSync(goMod)) {
    const name = /^module\s+(\S+)/m.exec(readFileSync(goMod, 'utf8'))?.[1] ?? null
    return { ecosystem: 'go', manifestFile: 'go.mod', name, version: null, deps: {}, devDeps: {} }
  }
  return null
}

/** Walk up from dir to the nearest .git, stopping at rootDir's parent. */
function findOwningRepo(rootDir, dir) {
  let current = resolve(dir)
  const stop = dirname(resolve(rootDir))
  while (current !== stop && current !== dirname(current)) {
    if (existsSync(join(current, '.git'))) return current
    current = dirname(current)
  }
  return null
}

export function discover(rootDir, config) {
  const members = []
  const problems = []
  for (const entry of config.packages.flatMap((e) => expandEntry(rootDir, e))) {
    const dir = join(rootDir, entry.path)
    if (!existsSync(dir)) {
      problems.push(`membership path does not exist: ${entry.path}`)
      continue
    }
    const manifest = readManifest(dir)
    if (!manifest) {
      problems.push(
        `no manifest (package.json / composer.json / pyproject.toml / go.mod) in ${entry.path}`,
      )
      continue
    }
    const repoDir = findOwningRepo(rootDir, dir)
    if (!repoDir) problems.push(`no owning git repository found for ${entry.path}`)
    const releaseConfigPath = join(dir, 'release.config.json')
    const releaseConfig = existsSync(releaseConfigPath) ? readJson(releaseConfigPath) : {}
    members.push({
      id: entry.id ?? manifest.name ?? basename(dir),
      path: entry.path,
      dir,
      repoDir,
      repoRelPath: repoDir ? relative(repoDir, dir) || '.' : null,
      publish: entry.publish !== false,
      branch: releaseConfig.branch === undefined ? 'main' : releaseConfig.branch,
      ...manifest,
    })
  }
  const seen = new Map()
  for (const member of members) {
    if (seen.has(member.id))
      problems.push(
        `duplicate package id "${member.id}" (${seen.get(member.id)} and ${member.path})`,
      )
    seen.set(member.id, member.path)
  }
  return { members, problems }
}

// ─────────────────────────────────────────────────────────────────────────────
// Graph — internal edges, cycles, topological order
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Publish-order edges come from dependencies/peerDependencies/optionalDependencies whose
 * name matches another member. devDependencies never order publishes (they are not in the
 * published artifact) but still cascade — a devDep edge is tracked separately.
 */
export function buildGraph(members) {
  const byName = new Map(members.filter((m) => m.name).map((m) => [m.name, m]))
  const orderEdges = new Map(members.map((m) => [m.id, []]))
  const devEdges = new Map(members.map((m) => [m.id, []]))
  for (const member of members) {
    for (const [depName, range] of Object.entries(member.deps ?? {})) {
      const dep = byName.get(depName)
      if (dep && dep.id !== member.id) orderEdges.get(member.id).push({ dep: dep.id, range })
    }
    for (const [depName, range] of Object.entries(member.devDeps ?? {})) {
      const dep = byName.get(depName)
      if (dep && dep.id !== member.id) devEdges.get(member.id).push({ dep: dep.id, range })
    }
  }
  return { orderEdges, devEdges }
}

export function findCycles(orderEdges) {
  const cycles = []
  const done = new Set()
  const walk = (id, stack) => {
    if (done.has(id)) return
    const at = stack.indexOf(id)
    if (at !== -1) {
      cycles.push([...stack.slice(at), id])
      return
    }
    for (const edge of orderEdges.get(id) ?? []) walk(edge.dep, [...stack, id])
    done.add(id)
  }
  for (const id of orderEdges.keys()) walk(id, [])
  return cycles
}

/** Dependencies-first order. Deterministic: alphabetical among peers. */
export function topoSort(orderEdges) {
  const order = []
  const done = new Set()
  const visit = (id) => {
    if (done.has(id)) return
    done.add(id)
    for (const edge of [...(orderEdges.get(id) ?? [])].sort((a, b) => a.dep.localeCompare(b.dep)))
      visit(edge.dep)
    order.push(id)
  }
  for (const id of [...orderEdges.keys()].sort()) visit(id)
  return order
}

// ─────────────────────────────────────────────────────────────────────────────
// Tags and change detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tag scheme: `v<version>` when the repo owns exactly one member, `<name>@<version>` when
 * it owns several — which keeps single-package repos identical to standalone release-kit.
 */
export function tagPatternFor(member, repoMemberCount) {
  return repoMemberCount > 1
    ? { prefix: `${member.name}@`, glob: `${member.name}@*` }
    : { prefix: 'v', glob: 'v*' }
}

function lastReleaseTag(member, repoMemberCount) {
  if (!member.repoDir) return null
  const { prefix, glob } = tagPatternFor(member, repoMemberCount)
  const tags = git(member.repoDir, ['tag', '--list', glob], { allowFailure: true })
  if (!tags) return null
  const versions = tags
    .split('\n')
    .map((tag) => ({ tag, version: tag.slice(prefix.length) }))
    .filter(({ version }) => parseSemver(version))
    .sort((a, b) => compareSemver(a.version, b.version))
  return versions.at(-1) ?? null
}

/** Full commit messages (subject + body) since the tag, newest first, for this path. */
function commitsSince(member, tag) {
  const range = tag ? `${tag}..HEAD` : 'HEAD'
  const pathArgs = member.repoRelPath === '.' ? [] : ['--', member.repoRelPath]
  const out = git(member.repoDir, ['log', '--format=%B%x1e', range, ...pathArgs], {
    allowFailure: true,
  })
  if (!out) return []
  return out
    .split('\u001E')
    .map((message) => message.trim())
    .filter(Boolean)
}

// ─────────────────────────────────────────────────────────────────────────────
// Registry — published versions, cached one lookup per package
// ─────────────────────────────────────────────────────────────────────────────

const registryCache = new Map()

/**
 * All published versions of an npm package. `[]` means "confirmed never published"
 * (E404); `null` means the lookup failed (network, auth) and nothing can be concluded.
 */
function publishedVersions(name) {
  if (registryCache.has(name)) return registryCache.get(name)
  let result
  try {
    const out = execFileSync('npm', ['view', name, 'versions', '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 20_000,
    }).trim()
    const parsed = JSON.parse(out)
    result = Array.isArray(parsed) ? parsed : [parsed]
  } catch (err) {
    result = /E404|404 Not Found/.test(`${err.stderr ?? ''}${err.stdout ?? ''}`) ? [] : null
  }
  registryCache.set(name, result)
  return result
}

/**
 * How a manifest version relates to the registry. The pure half of pending-version
 * detection, so it is testable without a network.
 *
 *   current    — normal: the manifest version is the registry's latest
 *   pending    — the manifest version is not published (a committed-but-unreleased bump,
 *                or a first release); it should be released as-is, not skipped over
 *   behind     — the registry has a newer version than the manifest; releasing anything
 *                from this tree would regress, so it is a preflight failure
 *   unknown    — the lookup failed or was skipped (--offline)
 */
export function registryStatus(manifestVersion, versions) {
  if (versions === null || !manifestVersion) return { state: 'unknown', latest: null }
  const latest =
    versions
      .filter((v) => parseSemver(v) && !parseSemver(v).prerelease)
      .sort(compareSemver)
      .at(-1) ?? null
  if (!versions.includes(manifestVersion)) {
    if (latest && compareSemver(latest, manifestVersion) > 0) return { state: 'behind', latest }
    return { state: 'pending', latest }
  }
  if (latest && compareSemver(latest, manifestVersion) > 0) return { state: 'behind', latest }
  return { state: 'current', latest }
}

/** Gather registry status for every npm publishable member. Offline: everything unknown. */
function gatherRegistry(members, offline) {
  const registry = new Map()
  for (const member of members) {
    if (member.ecosystem !== 'npm' || !member.publish || !member.name) {
      registry.set(member.id, { state: 'unknown', latest: null, versions: null })
      continue
    }
    const versions = offline ? null : publishedVersions(member.name)
    registry.set(member.id, { ...registryStatus(member.version, versions), versions })
  }
  return registry
}

// ─────────────────────────────────────────────────────────────────────────────
// Plan — release set, bumps, range rewrites
// ─────────────────────────────────────────────────────────────────────────────

export function rewriteRange(policy, currentRange, newVersion) {
  if (currentRange.startsWith('workspace:')) return null // the package manager rewrites these at publish
  if (policy === 'preserve') {
    const operator = /^[\^~]/.exec(currentRange)?.[0] ?? ''
    return `${operator}${newVersion}`
  }
  if (policy === 'caret') return `^${newVersion}`
  if (policy === 'tilde') return `~${newVersion}`
  return newVersion
}

export function rangeSatisfies(range, version) {
  if (range.startsWith('workspace:')) return true
  const operator = /^[\^~]/.exec(range)?.[0] ?? ''
  const base = parseSemver(range.replace(/^[\^~]/, ''))
  const v = parseSemver(version)
  if (!base || !v) return false
  if (operator === '^') return v.major === base.major && compareSemver(version, range.slice(1)) >= 0
  if (operator === '~')
    return v.major === base.major && v.minor === base.minor && v.patch >= base.patch
  return compareSemver(version, range) === 0
}

/**
 * Decide the release set and each member's bump.
 *
 * Seeding, in priority order per member:
 *   1. Registry `pending` — an unpublished manifest version is released **as-is**;
 *      the member joins the set even with zero new commits.
 *   2. Explicit request / --all / commits since the last release tag — bump derived
 *      from the commit messages.
 * Cascade then raises "not releasing" to patch, transitively, through both order and
 * dev edges. A pending member reached by cascade stays as-is: its unpublished version
 * is already the release.
 */
export function planReleases({
  members,
  orderEdges,
  devEdges,
  changes,
  registry,
  requested,
  all,
  rangePolicy,
}) {
  const byId = new Map(members.map((m) => [m.id, m]))
  const bumps = new Map()
  const reasons = new Map()

  for (const member of members) {
    if (registry?.get(member.id)?.state === 'pending') {
      bumps.set(member.id, 'as-is')
      reasons.set(member.id, `${member.version} in manifest, not on the registry`)
    }
  }

  const seedIds = requested.length
    ? requested
    : members.filter((m) => (all ? true : changes.get(m.id)?.commits.length)).map((m) => m.id)
  for (const id of seedIds) {
    if (bumps.has(id)) continue // pending wins: the unpublished version is the release
    const change = changes.get(id)
    const messages = change?.commits ?? []
    bumps.set(id, messages.length ? bumpFromCommits(messages, byId.get(id).version) : 'patch')
    reasons.set(
      id,
      requested.length
        ? 'requested'
        : all
          ? '--all'
          : `${messages.length} commit${messages.length === 1 ? '' : 's'}`,
    )
  }

  const dependents = new Map(members.map((m) => [m.id, new Set()]))
  for (const [id, edges] of orderEdges) for (const e of edges) dependents.get(e.dep)?.add(id)
  for (const [id, edges] of devEdges) for (const e of edges) dependents.get(e.dep)?.add(id)

  const queue = [...bumps.keys()]
  while (queue.length) {
    const id = queue.shift()
    for (const dependent of dependents.get(id) ?? []) {
      if (!bumps.has(dependent)) {
        bumps.set(dependent, 'patch')
        reasons.set(dependent, `depends on ${id}`)
        queue.push(dependent)
      }
    }
  }

  const order = topoSort(orderEdges).filter((id) => bumps.has(id))
  return order.map((id) => {
    const member = byId.get(id)
    const bump = bumps.get(id)
    const next = member.version ? bumpSemver(member.version, bump) : null
    const rewrites = (orderEdges.get(id) ?? [])
      .filter((edge) => bumps.has(edge.dep))
      .map((edge) => {
        const dep = byId.get(edge.dep)
        const depNext = dep.version ? bumpSemver(dep.version, bumps.get(edge.dep)) : null
        return {
          dep: edge.dep,
          from: edge.range,
          to: depNext ? rewriteRange(rangePolicy, edge.range, depNext) : null,
        }
      })
      .filter((r) => r.to !== null || r.from.startsWith('workspace:'))
    return { id, member, bump, current: member.version, next, reason: reasons.get(id), rewrites }
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Preflight — accumulate every failure, report once
// ─────────────────────────────────────────────────────────────────────────────

function preflight({
  members,
  plan,
  cycles,
  discoveryProblems,
  repoMemberCounts,
  changes,
  registry,
  offline,
  rootDir,
}) {
  const failures = [...discoveryProblems]
  const warnings = []
  if (offline)
    warnings.push(
      '--offline: registry checks skipped — pending versions, collisions and behind-registry states are not detected',
    )

  for (const cycle of cycles)
    failures.push(`dependency cycle: ${cycle.join(' → ')} — no release order exists`)

  const repos = new Map()
  for (const member of members) {
    if (member.repoDir && !repos.has(member.repoDir)) repos.set(member.repoDir, member)
  }
  const plannedRepoDirs = new Set(plan.map((item) => item.member.repoDir).filter(Boolean))

  for (const [repoDir, sample] of repos) {
    if (!plannedRepoDirs.has(repoDir)) continue
    const label = relative(rootDir, repoDir) || '.'
    const dirty = git(repoDir, ['status', '--porcelain'], { allowFailure: true })
    if (dirty) {
      const count = dirty.split('\n').length
      failures.push(
        `${label}: working tree not clean (${count} ${count === 1 ? 'entry' : 'entries'})`,
      )
    }
    const branch = git(repoDir, ['branch', '--show-current'], { allowFailure: true })
    if (sample.branch !== null) {
      if (!branch) failures.push(`${label}: detached HEAD`)
      else if (branch !== sample.branch)
        failures.push(`${label}: on branch "${branch}", releases run from "${sample.branch}"`)
    }
    const upstream = git(repoDir, ['rev-parse', '--abbrev-ref', '@{upstream}'], {
      allowFailure: true,
    })
    if (!upstream) {
      warnings.push(
        `${label}: no upstream tracking branch — cannot tell whether it is behind its remote`,
      )
    } else {
      const behind = git(repoDir, ['rev-list', '--count', `HEAD..${upstream}`], {
        allowFailure: true,
      })
      if (behind && +behind > 0)
        failures.push(`${label}: ${behind} commit(s) behind ${upstream} (as of the last fetch)`)
    }
  }

  for (const member of members) {
    const status = registry.get(member.id)
    if (status?.state === 'behind') {
      failures.push(
        `${member.id}: manifest says ${member.version} but the registry's latest is ${status.latest} — the tree is behind what was published; sync it before releasing`,
      )
    }
    if (
      !offline &&
      member.ecosystem === 'npm' &&
      member.publish &&
      status?.state === 'unknown' &&
      member.name
    ) {
      warnings.push(
        `${member.id}: registry lookup failed — pending/collision checks not performed for it`,
      )
    }
  }

  for (const item of plan) {
    const { member, next } = item
    if (!member.version) {
      warnings.push(
        `${item.id}: no manifest version (${member.ecosystem}); current version must come from its last release tag`,
      )
      continue
    }
    const change = changes.get(item.id)
    if (!change?.tag)
      warnings.push(
        `${item.id}: no release tag yet (cold start) — bump derived from the full history; consider seed-tags first`,
      )
    if (next) {
      const { prefix } = tagPatternFor(member, repoMemberCounts.get(member.repoDir) ?? 1)
      const nextTag = `${prefix}${next}`
      const existing = member.repoDir
        ? git(member.repoDir, ['tag', '--list', nextTag], { allowFailure: true })
        : ''
      if (existing && item.bump === 'as-is') {
        warnings.push(
          `${item.id}: tag ${nextTag} already exists — a failed publish; release-kit reuses it when it is at HEAD`,
        )
      } else if (existing) {
        failures.push(`${item.id}: tag ${nextTag} already exists`)
      }
      const status = registry.get(item.id)
      if (status?.versions?.includes(next) && item.bump !== 'as-is') {
        failures.push(`${item.id}: ${member.name}@${next} is already on the registry`)
      }
    }
    for (const rewrite of item.rewrites) {
      if (
        rewrite.to &&
        !rangeSatisfies(rewrite.to, plan.find((p) => p.id === rewrite.dep)?.next ?? '')
      ) {
        failures.push(
          `${item.id}: rewritten range ${rewrite.to} for ${rewrite.dep} does not match its planned version`,
        )
      }
    }
  }

  for (const member of members) {
    for (const [depName, range] of Object.entries(member.deps ?? {})) {
      if (range.startsWith('workspace:') && !members.some((m) => m.name === depName)) {
        failures.push(
          `${member.id}: workspace range for ${depName}, which is not a member of the train`,
        )
      }
    }
  }

  return { failures, warnings }
}

// ─────────────────────────────────────────────────────────────────────────────
// seed-tags — establish baseline release tags so change detection has a floor
// ─────────────────────────────────────────────────────────────────────────────

/**
 * For each member: tag the manifest version at the owning repo's HEAD, then push the tag.
 * Refuses per member, without touching it, when
 *   - the manifest version is not on the registry — the baseline would claim a release
 *     that never happened (pending versions are released by the train, not seeded), or
 *   - the manifest file itself has uncommitted changes — the version on disk may not be
 *     the version at HEAD, so the tag would point at the wrong commit, or
 *   - there is no manifest version at all (go, tag-only projects) — seed by hand.
 * Under --offline the registry cannot vouch for npm members, so npm members are skipped;
 * tags that are created are not pushed. --dry-run prints every action and does nothing.
 */
function seedTags({ members, repoMemberCounts, registry, dryRun, offline }) {
  const results = []
  for (const member of members) {
    const { id, repoDir, version } = member
    if (!repoDir) {
      results.push({ id, action: 'skip', detail: 'no owning git repository' })
      continue
    }
    if (!version) {
      results.push({
        id,
        action: 'skip',
        detail: `no manifest version (${member.ecosystem}) — seed by hand if the registry has releases`,
      })
      continue
    }
    const { prefix } = tagPatternFor(member, repoMemberCounts.get(repoDir) ?? 1)
    const tag = `${prefix}${version}`
    if (git(repoDir, ['tag', '--list', tag], { allowFailure: true })) {
      results.push({ id, action: 'ok', detail: `${tag} already exists` })
      continue
    }
    if (member.ecosystem === 'npm' && member.publish) {
      const status = registry.get(id)
      if (status?.state === 'pending') {
        results.push({
          id,
          action: 'refuse',
          detail: `${version} is not on the registry — a pending version is released by the train, not seeded`,
        })
        continue
      }
      if (status?.state === 'behind') {
        results.push({
          id,
          action: 'refuse',
          detail: `manifest ${version} is behind the registry (${status.latest}) — sync the tree first`,
        })
        continue
      }
      if (status?.state === 'unknown') {
        results.push({
          id,
          action: 'skip',
          detail: offline
            ? 'registry unverifiable under --offline'
            : 'registry lookup failed — cannot verify the version was released',
        })
        continue
      }
    }
    const manifestDirty = git(
      repoDir,
      [
        'status',
        '--porcelain',
        '--',
        join(member.repoRelPath === '.' ? '' : member.repoRelPath, member.manifestFile),
      ],
      {
        allowFailure: true,
      },
    )
    if (manifestDirty) {
      results.push({
        id,
        action: 'refuse',
        detail: `${member.manifestFile} has uncommitted changes — the version on disk may not match HEAD`,
      })
      continue
    }
    if (dryRun) {
      results.push({
        id,
        action: 'would-tag',
        detail: `${tag} at HEAD${offline ? '' : ', then push'}`,
      })
      continue
    }
    const tagged = git(
      repoDir,
      [
        'tag',
        '-a',
        tag,
        '-m',
        `Baseline for ${member.name ?? id} ${version} (seeded by release-train)`,
      ],
      { allowFailure: true },
    )
    if (tagged === null) {
      results.push({ id, action: 'error', detail: `git tag ${tag} failed` })
      continue
    }
    if (offline) {
      results.push({ id, action: 'tagged', detail: `${tag} created, not pushed (--offline)` })
      continue
    }
    const pushed = git(repoDir, ['push', 'origin', tag], { allowFailure: true })
    results.push(
      pushed === null
        ? { id, action: 'tagged', detail: `${tag} created; push failed — push it manually` }
        : { id, action: 'tagged', detail: `${tag} created and pushed` },
    )
  }
  return results
}

// ─────────────────────────────────────────────────────────────────────────────
// Train summary — deterministic report, optionally with a drafted announcement
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Markdown report of the whole train: every package with its version movement and why,
 * plus the dependency ripple — which changes pulled which dependents in. Deterministic
 * and buildable from the plan alone; per-package release notes stay per-package
 * (release-kit owns those). `mode` is 'planned' until execution exists.
 */
export function buildSummary(plan, { workspace, date, mode = 'planned' }) {
  const lines = [
    `# Release train — ${workspace}`,
    '',
    `_${date} · ${plan.length} package${plan.length === 1 ? '' : 's'} ${mode}, in dependency order_`,
    '',
  ]
  if (plan.length === 0) {
    lines.push(
      'Nothing to release: no member had commits since its last release tag or a pending unpublished version.',
    )
    return `${lines.join('\n')}\n`
  }
  lines.push('| # | Package | Version | Bump | Why |', '|---|---------|---------|------|-----|')
  for (const [index, item] of plan.entries()) {
    const version =
      item.bump === 'as-is'
        ? `${item.current} (as-is)`
        : item.current
          ? `${item.current} → ${item.next}`
          : '(from tag)'
    lines.push(`| ${index + 1} | ${item.id} | ${version} | ${item.bump} | ${item.reason} |`)
  }

  // Ripple: cascade reasons carry a parent pointer ("depends on <id>") — render each
  // seed with the transitive dependents it pulled in.
  const children = new Map()
  for (const item of plan) {
    const parent = /^depends on (.+)$/.exec(item.reason)?.[1]
    if (parent) {
      if (!children.has(parent)) children.set(parent, [])
      children.get(parent).push(item.id)
    }
  }
  const seeds = plan.filter((item) => !item.reason.startsWith('depends on '))
  const rippleLines = []
  const renderRipple = (id, depth) => {
    for (const child of children.get(id) ?? []) {
      rippleLines.push(`${'  '.repeat(depth)}- ${child}`)
      renderRipple(child, depth + 1)
    }
  }
  for (const seed of seeds) {
    if (!children.has(seed.id)) continue
    rippleLines.push(`- **${seed.id}** (${seed.reason}) pulled in:`)
    renderRipple(seed.id, 1)
  }
  if (rippleLines.length) lines.push('', '## Dependency ripple', '', ...rippleLines)

  const rewriteCount = plan.reduce((sum, item) => sum + item.rewrites.filter((r) => r.to).length, 0)
  if (rewriteCount)
    lines.push(
      '',
      `${rewriteCount} internal dependency range${rewriteCount === 1 ? '' : 's'} updated across the train.`,
    )
  return `${lines.join('\n')}\n`
}

// Assistant invocations mirror release-kit's ASSISTANTS table, so a tool configured for
// one behaves identically for the other.
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
    effort: (e) => [`-c`, `model_reasoning_effort="${e}"`],
    outputFile: (path) => ['--output-last-message', path],
  },
}

const DRAFT_TIMEOUT_MS = 180_000

/** Strip tool attribution and markdown fences a model may wrap its answer in. */
function cleanDraft(text) {
  return text
    .replace(/^\s*```[a-z]*\s*\n?/i, '')
    .replace(/\n?```\s*$/, '')
    .split('\n')
    .filter(
      (line) => !/^\s*co-authored-by:/i.test(line) && !/^\s*(🤖\s*)?generated with/i.test(line),
    )
    .join('\n')
    .trim()
}

function assistantAvailable(tool) {
  try {
    execFileSync(ASSISTANTS[tool].command, ASSISTANTS[tool].probe, {
      stdio: 'ignore',
      timeout: 10_000,
    })
    return true
  } catch {
    return false
  }
}

/** "auto" → the first tool on PATH; a named tool that is missing is a hard error. */
function resolveAssistant(spec) {
  if (!spec) return null
  if (spec.tool === 'auto') {
    const found = Object.keys(ASSISTANTS).find((tool) => assistantAvailable(tool))
    return found ? { ...spec, tool: found } : null // auto degrades quietly by design
  }
  if (!assistantAvailable(spec.tool))
    fail(`assistant "${spec.tool}" is not installed or not working`)
  return spec
}

/**
 * Draft a short ecosystem announcement from the deterministic summary. Every failure —
 * timeout, unusable answer, tool error — returns null and the train carries on with the
 * deterministic summary alone. A train is never blocked by a text generator.
 */
function draftAnnouncement(assistant, summaryMarkdown) {
  const definition = ASSISTANTS[assistant.tool]
  const prompt = [
    'Draft a short release announcement (3-6 sentences, plain prose, no headings) for this',
    'coordinated multi-package release. Lead with what changed and why consumers care;',
    'mention the packages by name only where it helps. Output only the announcement text.',
    '',
    summaryMarkdown,
  ].join('\n')
  const args = [
    ...definition.args,
    ...(assistant.model ? definition.model(assistant.model) : []),
    ...(assistant.effort ? definition.effort(assistant.effort) : []),
  ]
  let outputPath = null
  if (definition.outputFile) {
    outputPath = join(mkdtempSync(join(tmpdir(), 'train-')), 'answer.md')
    args.push(...definition.outputFile(outputPath))
  }
  try {
    const stdout = execFileSync(definition.command, args, {
      input: prompt,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: DRAFT_TIMEOUT_MS,
    })
    const answer = cleanDraft(outputPath ? readFileSync(outputPath, 'utf8') : stdout)
    return answer.length >= 20 ? answer : null
  } catch {
    return null
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Output
// ─────────────────────────────────────────────────────────────────────────────

function printGraph(members, orderEdges, order) {
  console.log(`train graph — ${members.length} members\n`)
  for (const id of order) {
    const edges = orderEdges.get(id) ?? []
    const deps = edges.map((e) => `${e.dep} (${e.range})`).join(', ')
    console.log(`  ${id}  ←  ${deps || '(no internal deps)'}`)
  }
  console.log('\nTopological order (dependencies first):')
  console.log(`  ${order.join(' → ')}`)
}

function printPlan(plan, { failures, warnings }) {
  if (plan.length === 0) {
    console.log(
      'Nothing to release: no member has commits since its last release tag or a pending unpublished version.',
    )
  } else {
    console.log(`Release plan — ${plan.length} package${plan.length === 1 ? '' : 's'}, in order:\n`)
    for (const [index, item] of plan.entries()) {
      const versionText =
        item.bump === 'as-is'
          ? `${item.current} (as-is)`
          : item.current
            ? `${item.current} → ${item.next}`
            : `(${item.member.ecosystem}: version from tag)`
      console.log(
        `  ${String(index + 1).padStart(2)}. ${item.id.padEnd(24)} ${item.bump.padEnd(6)} ${versionText.padEnd(20)} ${item.reason}`,
      )
      for (const rewrite of item.rewrites) {
        const target = rewrite.from.startsWith('workspace:')
          ? `${rewrite.from} (rewritten at publish)`
          : `${rewrite.from} → ${rewrite.to}`
        console.log(`        deps: ${rewrite.dep} ${target}`)
      }
    }
  }
  if (warnings.length) {
    console.log(`\nWarnings (${warnings.length}):`)
    for (const warning of warnings) console.log(`  warn  ${warning}`)
  }
  if (failures.length) {
    console.log(
      `\nPreflight failures (${failures.length}) — nothing would mutate until every one is fixed:`,
    )
    for (const failure of failures) console.log(`  FAIL  ${failure}`)
  } else {
    console.log('\nPreflight: ok')
  }
}

function printSeedResults(results, dryRun) {
  console.log(`seed-tags${dryRun ? ' (dry run)' : ''} — ${results.length} members\n`)
  for (const r of results) console.log(`  ${r.action.padEnd(10)} ${r.id.padEnd(24)} ${r.detail}`)
  const refusedOrErrored = results.filter(
    (r) => r.action === 'refuse' || r.action === 'error',
  ).length
  if (refusedOrErrored)
    console.log(`\n${refusedOrErrored} member(s) refused or failed — see above.`)
}

const HELP = `release-train (prototype — read-only phases, seed-tags, and the train summary)

  train graph               print the derived dependency graph and topo order
  train --dry-run           plan + whole-train preflight, execute nothing
  train --dry-run --all     plan every member
  train --dry-run <id>...   plan these packages and their dependents
  train seed-tags           create baseline tags (add --dry-run to preview)
  train --summary <path>    write the train summary (markdown) here; overrides summaryFile
  train --assistant <name>  none (whole-train kill switch), auto, claude, codex
  train --offline           skip network work (registry lookups, tag pushes)
  train --config <path>     config file (default ./train.config.json)
`

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(HELP)
    return
  }
  const configPath = args.configPath ?? join(process.cwd(), 'train.config.json')
  const config = loadConfig(configPath)
  const rootDir = dirname(resolve(configPath))
  const { members, problems } = discover(rootDir, config)
  const { orderEdges, devEdges } = buildGraph(members)
  const cycles = findCycles(orderEdges)
  const order = topoSort(orderEdges)

  if (args.command === 'graph') {
    printGraph(members, orderEdges, order)
    if (cycles.length) for (const cycle of cycles) console.log(`\nCYCLE: ${cycle.join(' → ')}`)
    if (problems.length) for (const problem of problems) console.log(`warn  ${problem}`)
    process.exitCode = cycles.length || problems.length ? 1 : 0
    return
  }

  const repoMemberCounts = new Map()
  for (const member of members) {
    if (member.repoDir)
      repoMemberCounts.set(member.repoDir, (repoMemberCounts.get(member.repoDir) ?? 0) + 1)
  }
  const registry = gatherRegistry(members, args.offline)

  if (args.command === 'seed-tags') {
    const results = seedTags({
      members,
      repoMemberCounts,
      registry,
      dryRun: args.dryRun,
      offline: args.offline,
    })
    printSeedResults(results, args.dryRun)
    process.exitCode = results.some((r) => r.action === 'error') ? 1 : 0
    return
  }

  if (!args.dryRun) fail('execution is not implemented yet — run with --dry-run')

  const changes = new Map()
  for (const member of members) {
    if (!member.repoDir) continue
    const last = lastReleaseTag(member, repoMemberCounts.get(member.repoDir))
    changes.set(member.id, { tag: last?.tag ?? null, commits: commitsSince(member, last?.tag) })
  }

  for (const id of args.ids)
    if (!members.some((m) => m.id === id)) fail(`unknown package id "${id}" — see train graph`)

  const plan = planReleases({
    members,
    orderEdges,
    devEdges,
    changes,
    registry,
    requested: args.ids,
    all: args.all,
    rangePolicy: config.rangePolicy,
  })
  const result = preflight({
    members,
    plan,
    cycles,
    discoveryProblems: problems,
    repoMemberCounts,
    changes,
    registry,
    offline: args.offline,
    rootDir,
  })
  printPlan(plan, result)

  // Train summary: deterministic always; announcement drafted only when an assistant is
  // configured (or forced via --assistant) and never blocking. --assistant none is the
  // whole-train kill switch — when execution lands it is also forwarded to every
  // release-kit run, and it is the ONLY assistant value that is forwarded: forcing a
  // drafting tool onto packages that did not opt in stays impossible by design.
  const summaryPath = args.summaryPath ?? config.summaryFile
  if (summaryPath) {
    const date = new Date().toISOString().slice(0, 10)
    let summary = buildSummary(plan, {
      workspace: basename(rootDir),
      date,
      mode: 'planned (dry run)',
    })
    const assistant = resolveAssistant(
      args.assistant === undefined ? config.assistant : args.assistant,
    )
    if (assistant && plan.length) {
      const announcement = draftAnnouncement(assistant, summary)
      if (announcement) summary = summary.replace('\n', `\n\n## Announcement\n\n${announcement}\n`)
      else
        console.log(
          `\nwarn  ${assistant.tool} produced no usable announcement — deterministic summary only`,
        )
    }
    writeFileSync(resolve(rootDir, summaryPath), summary)
    console.log(`\nTrain summary written to ${summaryPath}`)
  }

  process.exitCode = result.failures.length ? 1 : 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
