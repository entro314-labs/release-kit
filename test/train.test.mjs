import assert from 'node:assert/strict'
import { test } from 'node:test'

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
  rewriteRange,
  tagPatternFor,
  topoSort,
} from '../train.mjs'

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
