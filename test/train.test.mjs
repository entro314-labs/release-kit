import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import semver from 'semver'

import {
  buildGraph,
  buildSummary,
  bumpFromCommits,
  bumpSemver,
  compareSemver,
  findCycles,
  normalizeAssistant,
  parseSemver,
  planReleases,
  rangeSatisfies,
  registryStatus,
  releaseArgs,
  rewriteManifest,
  rewriteRange,
  tagPatternFor,
  topoSort,
} from '../train.mjs'
import { makeRepo, tagsOnRemote } from './helpers/repo.mjs'

// ── semver ───────────────────────────────────────────────────────────────────

test('parseSemver accepts x.y.z and prereleases, rejects garbage', () => {
  assert.deepEqual(parseSemver('2.4.2'), { major: 2, minor: 4, patch: 2, prerelease: null })
  assert.equal(parseSemver('2.0.0-beta.1').prerelease, 'beta.1')
  assert.equal(parseSemver('v2.4.2'), null)
  assert.equal(parseSemver(null), null)
})

test('compareSemver orders versions and ranks prereleases below releases', () => {
  assert.ok(compareSemver('2.4.2', '2.4.1') > 0)
  assert.ok(compareSemver('2.0.0-rc.1', '2.0.0') < 0)
  assert.equal(compareSemver('1.2.3', '1.2.3'), 0)
})

test('bumpSemver, including as-is', () => {
  assert.equal(bumpSemver('2.4.2', 'patch'), '2.4.3')
  assert.equal(bumpSemver('2.4.2', 'minor'), '2.5.0')
  assert.equal(bumpSemver('2.4.2', 'major'), '3.0.0')
  assert.equal(bumpSemver('2.4.2', 'as-is'), '2.4.2')
})

// The train plans what release-kit will run, so its arithmetic has to be release-kit's —
// which is `semver.inc`'s. A prerelease manifest is where a naive increment diverges: the
// plan said 2.0.1 for a package release-kit was going to release as 2.0.0.
test('bumpSemver matches semver.inc off a prerelease, as release-kit does', () => {
  for (const version of ['1.2.3', '2.0.0-beta.1', '2.0.0-rc.9', '1.2.0-alpha.0', '3.0.0-0']) {
    for (const bump of ['major', 'minor', 'patch']) {
      assert.equal(bumpSemver(version, bump), semver.inc(version, bump), `${version} + ${bump}`)
    }
  }
})

test('compareSemver matches semver.compare, prerelease identifiers included', () => {
  // Ranking every prerelease equal left the last release tag to `git tag` order, which is
  // alphabetical: rc.9 outranked rc.10.
  const all = [
    '1.0.0',
    '1.0.1',
    '2.0.0',
    '1.0.0-alpha',
    '1.0.0-alpha.1',
    '1.0.0-alpha.beta',
    '1.0.0-beta',
    '1.0.0-beta.2',
    '1.0.0-beta.11',
    '1.0.0-rc.1',
    '2.0.0-rc.9',
    '2.0.0-rc.10',
  ]
  for (const a of all) {
    for (const b of all) {
      assert.equal(Math.sign(compareSemver(a, b)), semver.compare(a, b), `${a} vs ${b}`)
    }
  }
})

test('bumpFromCommits: feat → minor, breaking → major, softened below 1.0.0', () => {
  assert.equal(bumpFromCommits(['fix: a', 'chore: b'], '2.0.0'), 'patch')
  assert.equal(bumpFromCommits(['feat(api): add x'], '2.0.0'), 'minor')
  assert.equal(bumpFromCommits(['feat!: drop node 16'], '2.0.0'), 'major')
  assert.equal(bumpFromCommits(['feat!: drop node 16'], '0.3.0'), 'minor')
})

test('bumpFromCommits reads BREAKING CHANGE footers in the body, not just subjects', () => {
  const message =
    'fix: adjust parser\n\nRewrites entry API.\n\nBREAKING CHANGE: parse() now returns a tree'
  assert.equal(bumpFromCommits([message], '2.0.0'), 'major')
  assert.equal(bumpFromCommits(['feat: adds thing\n\nlong body text'], '2.0.0'), 'minor')
})

// ── registry status ──────────────────────────────────────────────────────────

test('registryStatus: current, pending (unpublished bump), first publish, behind, unknown', () => {
  assert.equal(registryStatus('2.2.3', ['2.2.2', '2.2.3']).state, 'current')
  assert.equal(registryStatus('2.2.4', ['2.2.2', '2.2.3']).state, 'pending')
  assert.equal(registryStatus('1.0.0', []).state, 'pending') // never published — first release
  assert.deepEqual(registryStatus('2.2.1', ['2.2.1', '2.3.0']), {
    state: 'behind',
    latest: '2.3.0',
  })
  assert.equal(registryStatus('2.2.0', ['2.2.1', '2.3.0']).state, 'behind')
  assert.equal(registryStatus('2.2.3', null).state, 'unknown')
  assert.equal(registryStatus(null, ['1.0.0']).state, 'unknown')
})

test('registryStatus ignores prereleases when deciding latest', () => {
  assert.equal(registryStatus('2.2.3', ['2.2.3', '3.0.0-beta.1']).state, 'current')
})

// ── graph ────────────────────────────────────────────────────────────────────

const member = (id, name, deps = {}, devDeps = {}) => ({ id, name, deps, devDeps })

test('buildGraph: runtime deps order publishes, devDeps do not', () => {
  const members = [
    member('shared', '@x/shared'),
    member('sdk', '@x/sdk', { '@x/shared': '^1.0.0' }, { '@x/tool': '^1.0.0' }),
    member('tool', '@x/tool'),
  ]
  const { orderEdges, devEdges } = buildGraph(members)
  assert.deepEqual(orderEdges.get('sdk'), [{ dep: 'shared', range: '^1.0.0' }])
  assert.deepEqual(devEdges.get('sdk'), [{ dep: 'tool', range: '^1.0.0' }])
  assert.deepEqual(orderEdges.get('shared'), [])
})

test('findCycles reports a runtime cycle, topoSort puts dependencies first', () => {
  const acyclic = buildGraph([
    member('a', 'a', { b: '^1.0.0' }),
    member('b', 'b', { c: '^1.0.0' }),
    member('c', 'c'),
  ])
  assert.deepEqual(findCycles(acyclic.orderEdges), [])
  const order = topoSort(acyclic.orderEdges)
  assert.ok(order.indexOf('c') < order.indexOf('b') && order.indexOf('b') < order.indexOf('a'))

  const cyclic = buildGraph([member('a', 'a', { b: '^1.0.0' }), member('b', 'b', { a: '^1.0.0' })])
  assert.equal(findCycles(cyclic.orderEdges).length, 1)
})

// ── tags and ranges ──────────────────────────────────────────────────────────

test('tagPatternFor: plain v-prefix for single-package repos, name@ for shared repos', () => {
  const m = { name: '@x/shared' }
  assert.deepEqual(tagPatternFor(m, 1), { prefix: 'v', glob: 'v*' })
  assert.deepEqual(tagPatternFor(m, 7), { prefix: '@x/shared@', glob: '@x/shared@*' })
})

test('tagPatternFor honours the tagPrefix a single-package repo releases with', () => {
  // release-kit tags with the package's configured prefix; reading history under `v`
  // would find no tags and plan a cold start for a package with a hundred releases.
  const m = { name: '@x/shared', tagPrefix: 'release-' }
  assert.deepEqual(tagPatternFor(m, 1), { prefix: 'release-', glob: 'release-*' })
  assert.deepEqual(tagPatternFor(m, 2), { prefix: '@x/shared@', glob: '@x/shared@*' })
})

test('rewriteRange honours policy and leaves workspace ranges alone', () => {
  assert.equal(rewriteRange('caret', '2.4.1', '2.4.3'), '^2.4.3')
  assert.equal(rewriteRange('tilde', '^2.4.1', '2.4.3'), '~2.4.3')
  assert.equal(rewriteRange('exact', '^2.4.1', '2.4.3'), '2.4.3')
  assert.equal(rewriteRange('preserve', '^2.4.1', '2.4.3'), '^2.4.3')
  assert.equal(rewriteRange('preserve', '2.4.1', '2.4.3'), '2.4.3')
  assert.equal(rewriteRange('caret', 'workspace:^', '2.4.3'), null)
})

test('rangeSatisfies: caret, tilde, exact, workspace', () => {
  assert.ok(rangeSatisfies('^2.4.1', '2.4.3'))
  assert.ok(!rangeSatisfies('^2.4.1', '3.0.0'))
  assert.ok(rangeSatisfies('~2.4.1', '2.4.9'))
  assert.ok(!rangeSatisfies('~2.4.1', '2.5.0'))
  assert.ok(rangeSatisfies('2.4.1', '2.4.1'))
  assert.ok(!rangeSatisfies('2.4.1', '2.4.2'))
  assert.ok(rangeSatisfies('workspace:^', '9.9.9'))
})

// ── planning ─────────────────────────────────────────────────────────────────

const noRegistry = (members) =>
  new Map(members.map((m) => [m.id, { state: 'unknown', latest: null, versions: null }]))

test('planReleases: change cascades to dependents as patch, in topo order', () => {
  const members = [
    { ...member('shared', '@x/shared'), version: '2.4.2', publish: true },
    { ...member('sdk', '@x/sdk', { '@x/shared': '^2.4.1' }), version: '1.1.0', publish: true },
    { ...member('cli', '@x/cli', { '@x/sdk': '^1.1.0' }), version: '3.0.0', publish: true },
    { ...member('lonely', '@x/lonely'), version: '0.1.0', publish: true },
  ]
  const { orderEdges, devEdges } = buildGraph(members)
  const changes = new Map([
    ['shared', { tag: '@x/shared@2.4.2', commits: ['feat: new api'] }],
    ['sdk', { tag: 'v1.1.0', commits: [] }],
    ['cli', { tag: 'v3.0.0', commits: [] }],
    ['lonely', { tag: 'v0.1.0', commits: [] }],
  ])
  const plan = planReleases({
    members,
    orderEdges,
    devEdges,
    changes,
    registry: noRegistry(members),
    requested: [],
    all: false,
    rangePolicy: 'caret',
  })
  assert.deepEqual(
    plan.map((p) => p.id),
    ['shared', 'sdk', 'cli'],
  )
  assert.equal(plan[0].bump, 'minor')
  assert.equal(plan[0].next, '2.5.0')
  assert.equal(plan[1].bump, 'patch')
  assert.equal(plan[1].reason, 'depends on shared')
  assert.deepEqual(plan[1].rewrites, [{ dep: 'shared', from: '^2.4.1', to: '^2.5.0' }])
  assert.equal(plan[2].reason, 'depends on sdk')
})

test('planReleases: a pending unpublished version is released as-is, even with no commits', () => {
  const members = [
    { ...member('remark', '@x/remark'), version: '2.2.4', publish: true, ecosystem: 'npm' },
    {
      ...member('kit', '@x/kit', { '@x/remark': '^2.2.3' }),
      version: '2.3.2',
      publish: true,
      ecosystem: 'npm',
    },
  ]
  const { orderEdges, devEdges } = buildGraph(members)
  const registry = new Map([
    ['remark', { state: 'pending', latest: '2.2.3', versions: ['2.2.3'] }],
    ['kit', { state: 'current', latest: '2.3.2', versions: ['2.3.2'] }],
  ])
  const changes = new Map([
    ['remark', { tag: 'v2.2.3', commits: [] }], // bump was committed before the tag — nothing new
    ['kit', { tag: 'v2.3.2', commits: [] }],
  ])
  const plan = planReleases({
    members,
    orderEdges,
    devEdges,
    changes,
    registry,
    requested: [],
    all: false,
    rangePolicy: 'caret',
  })
  assert.deepEqual(
    plan.map((p) => p.id),
    ['remark', 'kit'],
  )
  assert.equal(plan[0].bump, 'as-is')
  assert.equal(plan[0].next, '2.2.4')
  assert.match(plan[0].reason, /not on the registry/)
  // the dependent's rewrite targets the pending version, not a bump past it
  assert.deepEqual(plan[1].rewrites, [{ dep: 'remark', from: '^2.2.3', to: '^2.2.4' }])
})

test('planReleases: pending wins over commit-derived bumps — nothing is skipped over', () => {
  const members = [
    { ...member('remark', '@x/remark'), version: '2.2.4', publish: true, ecosystem: 'npm' },
  ]
  const { orderEdges, devEdges } = buildGraph(members)
  const registry = new Map([['remark', { state: 'pending', latest: '2.2.3', versions: ['2.2.3'] }]])
  const changes = new Map([['remark', { tag: null, commits: ['feat: something new'] }]])
  const plan = planReleases({
    members,
    orderEdges,
    devEdges,
    changes,
    registry,
    requested: [],
    all: false,
    rangePolicy: 'caret',
  })
  assert.equal(plan[0].bump, 'as-is')
  assert.equal(plan[0].next, '2.2.4')
})

test('planReleases: rangePolicy flows through to rewrites', () => {
  const members = [
    { ...member('shared', '@x/shared'), version: '1.0.0', publish: true },
    { ...member('sdk', '@x/sdk', { '@x/shared': '1.0.0' }), version: '1.0.0', publish: true },
  ]
  const { orderEdges, devEdges } = buildGraph(members)
  const changes = new Map([
    ['shared', { tag: 'v1.0.0', commits: ['fix: x'] }],
    ['sdk', { tag: 'v1.0.0', commits: [] }],
  ])
  const base = {
    members,
    orderEdges,
    devEdges,
    changes,
    registry: noRegistry(members),
    requested: [],
    all: false,
  }
  assert.equal(planReleases({ ...base, rangePolicy: 'tilde' })[1].rewrites[0].to, '~1.0.1')
  assert.equal(planReleases({ ...base, rangePolicy: 'exact' })[1].rewrites[0].to, '1.0.1')
  assert.equal(planReleases({ ...base, rangePolicy: 'preserve' })[1].rewrites[0].to, '1.0.1')
})

test('planReleases: requested package pulls in dependents, not dependencies', () => {
  const members = [
    { ...member('shared', '@x/shared'), version: '2.4.2', publish: true },
    { ...member('sdk', '@x/sdk', { '@x/shared': '^2.4.1' }), version: '1.1.0', publish: true },
    { ...member('cli', '@x/cli', { '@x/sdk': '^1.1.0' }), version: '3.0.0', publish: true },
  ]
  const { orderEdges, devEdges } = buildGraph(members)
  const changes = new Map(members.map((m) => [m.id, { tag: 'x', commits: [] }]))
  const plan = planReleases({
    members,
    orderEdges,
    devEdges,
    changes,
    registry: noRegistry(members),
    requested: ['sdk'],
    all: false,
    rangePolicy: 'caret',
  })
  assert.deepEqual(
    plan.map((p) => p.id),
    ['sdk', 'cli'],
  )
})

// ── summary and assistant ────────────────────────────────────────────────────

test('buildSummary: table rows, as-is rendering, ripple tree, rewrite count', () => {
  const plan = [
    {
      id: 'shared',
      bump: 'minor',
      current: '2.4.2',
      next: '2.5.0',
      reason: '2 commits',
      rewrites: [],
      member: {},
    },
    {
      id: 'remark',
      bump: 'as-is',
      current: '2.2.4',
      next: '2.2.4',
      reason: '2.2.4 in manifest, not on the registry',
      rewrites: [],
      member: {},
    },
    {
      id: 'sdk',
      bump: 'patch',
      current: '1.1.0',
      next: '1.1.1',
      reason: 'depends on shared',
      rewrites: [{ dep: 'shared', from: '^2.4.1', to: '^2.5.0' }],
      member: {},
    },
    {
      id: 'cli',
      bump: 'patch',
      current: '3.0.0',
      next: '3.0.1',
      reason: 'depends on sdk',
      rewrites: [{ dep: 'sdk', from: '^1.1.0', to: '^1.1.1' }],
      member: {},
    },
  ]
  const summary = buildSummary(plan, { workspace: 'acme', date: '2026-08-18' })
  assert.match(summary, /# Release train — acme/)
  assert.match(summary, /\| 1 \| shared \| 2\.4\.2 → 2\.5\.0 \| minor \| 2 commits \|/)
  assert.match(summary, /\| 2 \| remark \| 2\.2\.4 \(as-is\) \| as-is \|/)
  assert.match(summary, /## Dependency ripple/)
  assert.match(summary, /- \*\*shared\*\* \(2 commits\) pulled in:\n  - sdk\n    - cli/)
  assert.ok(!summary.includes('**remark**')) // no dependents, no ripple entry
  assert.match(summary, /2 internal dependency ranges updated/)
})

test('buildSummary: empty plan says so', () => {
  const summary = buildSummary([], { workspace: 'acme', date: '2026-08-18' })
  assert.match(summary, /Nothing to release/)
})

test('normalizeAssistant: none/null clear, names and objects normalize, junk errors', () => {
  assert.equal(normalizeAssistant(null), null)
  assert.equal(normalizeAssistant('none'), null)
  assert.deepEqual(normalizeAssistant('claude'), { tool: 'claude', model: null, effort: null })
  assert.deepEqual(normalizeAssistant({ tool: 'codex', model: 'gpt-5', effort: 'low' }), {
    tool: 'codex',
    model: 'gpt-5',
    effort: 'low',
  })
  assert.ok(normalizeAssistant('gemini').error)
  assert.ok(normalizeAssistant({ tool: 'none' }).error)
})

test('planReleases: devDependency edge cascades but never orders', () => {
  const members = [
    { ...member('tool', '@x/tool'), version: '1.0.0', publish: true },
    { ...member('lib', '@x/lib', {}, { '@x/tool': '^1.0.0' }), version: '2.0.0', publish: true },
  ]
  const { orderEdges, devEdges } = buildGraph(members)
  const changes = new Map([
    ['tool', { tag: 'v1.0.0', commits: ['fix: patch'] }],
    ['lib', { tag: 'v2.0.0', commits: [] }],
  ])
  const plan = planReleases({
    members,
    orderEdges,
    devEdges,
    changes,
    registry: noRegistry(members),
    requested: [],
    all: false,
    rangePolicy: 'caret',
  })
  assert.deepEqual(plan.map((p) => p.id).sort(), ['lib', 'tool'])
  const lib = plan.find((p) => p.id === 'lib')
  assert.equal(lib.reason, 'depends on tool')
  assert.deepEqual(lib.rewrites, []) // devDeps are not rewritten — they are not published
})

test('bumpFromCommits reads the same grammar release.mjs parses', () => {
  // Each of these was mis-read before: the type pattern was [a-z]+ and case-sensitive, and
  // BREAKING CHANGE was matched anywhere in the message rather than as a footer.
  assert.equal(bumpFromCommits(['i18n!: drop the legacy locale files'], '2.0.0'), 'major')
  assert.equal(bumpFromCommits(['a11y(nav)!: remove the skip link'], '2.0.0'), 'major')
  assert.equal(bumpFromCommits(['Feat: add x'], '2.0.0'), 'minor')
  assert.equal(bumpFromCommits(['feature: add x'], '2.0.0'), 'minor')
  assert.equal(
    bumpFromCommits(['fix: tidy\n\nThis is not a BREAKING CHANGE, just a rename.'], '2.0.0'),
    'patch',
    'prose mentioning the phrase is not a footer',
  )
  assert.equal(
    bumpFromCommits(['fix: tidy\n\nBREAKING-CHANGE: parse() returns a tree'], '2.0.0'),
    'major',
    'the hyphenated footer counts, as it does in release.mjs',
  )
  assert.equal(bumpFromCommits(['just some prose'], '2.0.0'), 'patch', 'unparseable is not a feat')
})

// ── execution ───────────────────────────────────────────────────────────────

test('rewriteManifest moves every map that names the dependency and keeps the indent', () => {
  const text =
    '{\n    "name": "b",\n    "dependencies": { "a": "^1.0.0", "z": "^9.0.0" },\n    "peerDependencies": { "a": "~1.0.0" }\n}\n'
  const out = rewriteManifest(text, new Map([['a', '1.1.0']]), 'preserve')
  const manifest = JSON.parse(out.text)
  assert.equal(manifest.dependencies.a, '^1.1.0')
  assert.equal(manifest.peerDependencies.a, '~1.1.0')
  assert.equal(manifest.dependencies.z, '^9.0.0')
  assert.match(out.text, /^\{\n {4}"name"/)
  assert.ok(out.text.endsWith('}\n'))
  assert.deepEqual(out.changed, ['a ^1.1.0', 'a ~1.1.0'])
})

test('rewriteManifest: nothing to move (a resumed train, a workspace range) is null', () => {
  const text = '{\n  "dependencies": { "a": "^1.1.0", "w": "workspace:*" }\n}\n'
  assert.equal(
    rewriteManifest(
      text,
      new Map([
        ['a', '1.1.0'],
        ['w', '2.0.0'],
      ]),
      'caret',
    ),
    null,
  )
})

test('releaseArgs: explicit version, --skip publish for publish: false, the assistant kill switch', () => {
  const member = { publish: true }
  assert.deepEqual(releaseArgs({ next: '1.1.0', member }), ['1.1.0', '--yes'])
  assert.deepEqual(releaseArgs({ next: null, member }), ['auto', '--yes'])
  assert.deepEqual(
    releaseArgs({ next: '2.0.0', member: { publish: false } }, { noAssistant: true }),
    ['2.0.0', '--yes', '--skip', 'publish', '--assistant', 'none'],
  )
})

const TRAIN_MJS = join(dirname(fileURLToPath(import.meta.url)), '../train.mjs')
const CHANGELOG = '# Changelog\n\n## [Unreleased]\n'
const gitIn = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim()

/**
 * A meta-workspace: sibling repositories, each with a bare remote and a v1.0.0 baseline tag
 * whose version is on the shared stub registry. `b` depends on `a` at ^1.0.0.
 */
function makeTrain({ trainConfig = {}, bPublish = true } = {}) {
  const ws = mkdtempSync(join(tmpdir(), 'release-train-'))
  const registry = join(ws, 'registry.txt')
  const make = (name) => makeRepo({ name, parent: ws, changelog: CHANGELOG })
  const a = make('@t/a')
  const b = make('@t/b')
  const manifest = JSON.parse(readFileSync(join(b.root, 'package.json'), 'utf8'))
  manifest.dependencies = { '@t/a': '^1.0.0' }
  writeFileSync(join(b.root, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  gitIn(b.root, 'commit', '-qam', 'chore: depend on a')
  for (const repo of [a, b]) {
    gitIn(repo.root, 'tag', '-a', 'v1.0.0', '-m', 'v1.0.0')
    gitIn(repo.root, 'push', '-q', 'origin', 'main', 'v1.0.0')
  }
  writeFileSync(registry, '@t/a@1.0.0\n@t/b@1.0.0\n')
  writeFileSync(
    join(ws, 'train.config.json'),
    JSON.stringify({
      packages: [
        { path: relative(ws, a.root), id: 'a' },
        { path: relative(ws, b.root), id: 'b', ...(bPublish ? {} : { publish: false }) },
      ],
      registryWait: { timeout: 2, interval: 0.1 },
      ...trainConfig,
    }),
  )
  // A change to a: a minor for it, a cascade patch for b.
  writeFileSync(join(a.root, 'feature.txt'), 'x\n')
  gitIn(a.root, 'add', 'feature.txt')
  gitIn(a.root, 'commit', '-qm', 'feat: a feature')
  gitIn(a.root, 'push', '-q', 'origin', 'main')
  return { ws, registry, a, b }
}

function runTrain({ ws, registry, a }, args, env = {}) {
  const result = spawnSync('node', [TRAIN_MJS, ...args], {
    cwd: ws,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${a.bin}:${process.env.PATH}`, NPM_REGISTRY: registry, ...env },
  })
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

const published = (registry) => readFileSync(registry, 'utf8').trim().split('\n')
const remoteManifest = (repo) =>
  JSON.parse(
    execFileSync('git', ['--git-dir', repo.remote, 'show', 'main:package.json'], {
      encoding: 'utf8',
    }),
  )

test('train releases dependencies first and moves the dependent onto the new version', () => {
  const t = makeTrain()
  const { status, output } = runTrain(t, ['--yes'])
  assert.equal(status, 0, output)
  assert.ok(tagsOnRemote(t.a).includes('v1.1.0'), output)
  assert.ok(tagsOnRemote(t.b).includes('v1.0.1'), output)
  assert.deepEqual(published(t.registry).slice(2), ['@t/a@1.1.0', '@t/b@1.0.1'])
  assert.equal(remoteManifest(t.b).dependencies['@t/a'], '^1.1.0')
  assert.equal(remoteManifest(t.b).version, '1.0.1')
  assert.match(
    gitIn(t.b.root, 'log', '--format=%s', 'v1.0.0..v1.0.1'),
    /chore\(deps\): move @t\/a \^1\.1\.0/,
  )
  assert.match(output, /Train released — 2 packages: a, b/)
})

test('train stops at a failed publish, leaves the dependent untouched, and a re-run finishes', () => {
  const t = makeTrain()
  const bHead = gitIn(t.b.root, 'rev-parse', 'HEAD')
  const failed = runTrain(t, ['--yes'], { NPM_PUBLISH_FAILS_FOR: '@t/a' })
  assert.equal(failed.status, 1, failed.output)
  assert.match(failed.output, /TRAIN STOPPED at a/)
  assert.match(failed.output, /not started: b/)
  assert.equal(gitIn(t.b.root, 'rev-parse', 'HEAD'), bHead)
  assert.deepEqual(tagsOnRemote(t.b), ['v1.0.0'])

  const resumed = runTrain(t, ['--yes'])
  assert.equal(resumed.status, 0, resumed.output)
  assert.match(resumed.output, /a\s+as-is\s+1\.1\.0 \(as-is\)/)
  assert.deepEqual(published(t.registry).slice(2), ['@t/a@1.1.0', '@t/b@1.0.1'])
  assert.deepEqual(tagsOnRemote(t.a), ['v1.0.0', 'v1.1.0'])
})

test('train stops before a dependent when the dependency never shows on the registry', () => {
  const t = makeTrain({ trainConfig: { registryWait: { timeout: 0.3, interval: 0.1 } } })
  const bHead = gitIn(t.b.root, 'rev-parse', 'HEAD')
  const { status, output } = runTrain(t, ['--yes'], { NPM_PUBLISH_INVISIBLE: '1' })
  assert.equal(status, 1, output)
  assert.match(output, /@t\/a@1\.1\.0 was released but is not on the registry after 0\.3s/)
  assert.equal(gitIn(t.b.root, 'rev-parse', 'HEAD'), bHead)
})

test('train releases a publish: false member without publishing it', () => {
  const t = makeTrain({ bPublish: false })
  const { status, output } = runTrain(t, ['--yes'])
  assert.equal(status, 0, output)
  assert.ok(tagsOnRemote(t.b).includes('v1.0.1'), output)
  assert.ok(!published(t.registry).includes('@t/b@1.0.1'))
})

test('train refuses to release without --yes when there is no terminal to confirm on', () => {
  const t = makeTrain()
  const { status, output } = runTrain(t, [])
  assert.equal(status, 1, output)
  assert.match(output, /pass --yes/)
  assert.deepEqual(tagsOnRemote(t.a), ['v1.0.0'])
})

test('train refuses --offline outside a dry run, and a registryWait that is not a positive number', () => {
  const t = makeTrain()
  assert.match(runTrain(t, ['--offline', '--yes']).output, /--offline cannot release/)
  writeFileSync(
    join(t.ws, 'train.config.json'),
    JSON.stringify({ packages: ['*'], registryWait: { timeout: '5m' } }),
  )
  const bad = runTrain(t, ['--dry-run'])
  assert.equal(bad.status, 1)
  assert.match(bad.output, /registryWait\.timeout must be a positive number/)
})

test('train refuses members that share a git repository, before anything mutates', () => {
  const ws = mkdtempSync(join(tmpdir(), 'release-train-'))
  const repo = makeRepo({
    name: '@t/root',
    parent: ws,
    files: {
      'packages/x/package.json': '{\n  "name": "@t/x",\n  "version": "1.0.0"\n}\n',
      'packages/y/package.json': '{\n  "name": "@t/y",\n  "version": "1.0.0"\n}\n',
    },
  })
  mkdirSync(join(repo.root, 'packages/x/src'), { recursive: true })
  writeFileSync(join(repo.root, 'packages/x/src/index.js'), 'export {}\n')
  gitIn(repo.root, 'add', '-A')
  gitIn(repo.root, 'commit', '-qm', 'feat: x')
  gitIn(repo.root, 'push', '-q', 'origin', 'main')
  const base = relative(ws, repo.root)
  writeFileSync(
    join(ws, 'train.config.json'),
    JSON.stringify({ packages: [`${base}/packages/x`, `${base}/packages/y`] }),
  )
  const result = runTrain({ ws, registry: join(ws, 'registry.txt'), a: repo }, ['--yes', '--all'])
  assert.equal(result.status, 1, result.output)
  assert.match(result.output, /holds 2 train members/)
  assert.deepEqual(tagsOnRemote(repo), [])
})
