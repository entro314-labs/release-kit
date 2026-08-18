/** Parsing Conventional Commits, inferring the bump, and rendering release notes. */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { kit } from './helpers/load.mjs'

const c = (hash, subject, body = '') => ({ hash, subject, body })
const LINKS = {
  base: 'https://github.com/o/r',
  issue: 'https://github.com/o/r/issues',
  commit: 'https://github.com/o/r/commit',
}

describe('parseCommit', () => {
  it('reads type, scope and subject', () => {
    const { type, scope, subject } = kit.parseCommit('fix(core): trim whitespace')
    assert.deepEqual(
      { type, scope, subject },
      { type: 'fix', scope: 'core', subject: 'trim whitespace' },
    )
  })

  it('detects a breaking change from either marker', () => {
    assert.equal(kit.parseCommit('feat!: x').breaking, true)
    assert.equal(kit.parseCommit('feat(api)!: x').breaking, true)
    assert.equal(kit.parseCommit('feat: x', 'BREAKING CHANGE: gone').breaking, true)
    assert.equal(kit.parseCommit('feat: x', 'BREAKING-CHANGE: gone').breaking, true)
    assert.equal(kit.parseCommit('feat: x').breaking, false)
  })

  it('prefers the BREAKING CHANGE footer over the subject', () => {
    assert.equal(
      kit.parseCommit('feat: rework', 'BREAKING CHANGE: removeFoo() is gone').breakingNote,
      'removeFoo() is gone',
    )
    assert.equal(kit.parseCommit('feat!: rework').breakingNote, null)
  })

  it('collects closed issues, and only closed ones', () => {
    assert.deepEqual(kit.parseCommit('fix: x', 'closes #12').closes, ['12'])
    assert.deepEqual(kit.parseCommit('fix: x', 'fixes #34').closes, ['34'])
    assert.deepEqual(kit.parseCommit('fix: x', 'resolves #56').closes, ['56'])
    assert.deepEqual(kit.parseCommit('fix: x, closes #7').closes, ['7'], 'in the subject too')
    assert.deepEqual(kit.parseCommit('fix: x', 'closes #1\nfixes #1').closes, ['1'], 'deduped')
    assert.deepEqual(
      kit.parseCommit('fix: see #12').closes,
      [],
      'a bare mention is not a reference',
    )
  })

  it('reads a Release-As footer, with or without the v', () => {
    assert.equal(kit.parseCommit('chore: x', 'Release-As: 2.0.0').releaseAs, '2.0.0')
    assert.equal(kit.parseCommit('chore: x', 'Release-As: v2.0.0').releaseAs, '2.0.0')
  })

  it('returns null for anything not Conventional Commits', () => {
    assert.equal(kit.parseCommit('just did some stuff'), null)
  })
})

describe('inferBump', () => {
  const bump = (commits, version, strategy = 'conventional') =>
    kit.inferBump(commits, version, strategy).bump

  it('follows the default strategy at 1.x', () => {
    assert.equal(bump([c('a', 'feat!: x')], '1.2.3'), 'major')
    assert.equal(bump([c('a', 'feat: x')], '1.2.3'), 'minor')
    assert.equal(bump([c('a', 'fix: x')], '1.2.3'), 'patch')
    assert.equal(bump([c('a', 'docs: x')], '1.2.3'), 'patch')
    assert.equal(bump([c('a', 'fix: a'), c('b', 'feat!: b')], '1.2.3'), 'major', 'breaking wins')
  })

  it('softens below 1.0.0, where breaking bumps the minor', () => {
    assert.equal(bump([c('a', 'feat!: x')], '0.4.1'), 'minor')
    assert.equal(bump([c('a', 'feat: x')], '0.4.1'), 'minor')
  })

  it('honours the always-* strategies', () => {
    assert.equal(bump([c('a', 'fix: x')], '1.2.3', 'always-major'), 'major')
    assert.equal(bump([c('a', 'feat!: x')], '1.2.3', 'always-patch'), 'patch')
  })

  it('lets Release-As override everything', () => {
    assert.equal(
      kit.inferBump([c('a', 'fix: x', 'Release-As: 9.9.9')], '1.2.3', 'conventional').releaseAs,
      '9.9.9',
    )
  })
})

describe('changelogFromCommits', () => {
  it('groups by type and hides the noise', () => {
    const out = kit.changelogFromCommits([
      c('a', 'feat(api): add streaming'),
      c('b', 'fix: header whitespace'),
      c('c', 'chore: bump deps'),
      c('d', 'ci: cache'),
      c('e', 'perf: faster parse'),
    ])
    assert.equal(
      out,
      '### Features\n\n- **api:** add streaming\n\n' +
        '### Bug Fixes\n\n- header whitespace\n\n' +
        '### Performance Improvements\n\n- faster parse',
    )
  })

  it('puts breaking changes first, using the footer text', () => {
    const out = kit.changelogFromCommits([
      c('deadbee', 'feat!: rework', 'BREAKING CHANGE: removeFoo() is gone'),
    ])
    assert.ok(out.startsWith('### ⚠ BREAKING CHANGES'))
    assert.match(out, /- removeFoo\(\) is gone/)
  })

  it('links the commit and any issues it closes', () => {
    assert.equal(
      kit.changelogFromCommits([c('abc1234def', 'feat(api): add streaming', 'closes #12')], LINKS),
      '### Features\n\n- **api:** add streaming ' +
        '([abc1234](https://github.com/o/r/commit/abc1234)), ' +
        'closes [#12](https://github.com/o/r/issues/12)',
    )
  })

  it('returns null when nothing visible changed', () => {
    assert.equal(kit.changelogFromCommits([c('a', 'chore: x'), c('b', 'ci: y')]), null)
    assert.equal(kit.changelogFromCommits([c('a', 'random work')]), null)
  })
})

describe('withoutRevertedCommits', () => {
  it('drops a reverted commit and the revert together', () => {
    const kept = kit.withoutRevertedCommits([
      c('aaaaaaa', 'feat: add thing'),
      c('bbbbbbb', 'revert: add thing', 'This reverts commit aaaaaaa.'),
      c('ccccccc', 'fix: keep this'),
    ])
    assert.deepEqual(
      kept.map((x) => x.subject),
      ['fix: keep this'],
    )
  })

  it('leaves a history with no reverts alone', () => {
    assert.equal(kit.withoutRevertedCommits([c('a', 'feat: x')]).length, 1)
  })
})

describe('HOSTS', () => {
  it('encodes the path differences between forges', () => {
    assert.deepEqual(kit.HOSTS['bitbucket.org'], { issue: 'issue', commit: 'commits' })
    assert.deepEqual(kit.HOSTS['github.com'], { issue: 'issues', commit: 'commit' })
  })
})
