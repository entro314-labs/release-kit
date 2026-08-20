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
  it('reports every type by default, since a changelog is a record', () => {
    const out = kit.changelogFromCommits([
      c('a', 'feat(api): add streaming'),
      c('b', 'fix: header whitespace'),
      c('c', 'chore: bump deps'),
      c('d', 'ci: cache'),
      c('e', 'perf: faster parse'),
    ])
    assert.deepEqual(
      out.split('\n').filter((l) => l.startsWith('###')),
      [
        '### Features',
        '### Bug Fixes',
        '### Performance Improvements',
        '### Continuous Integration',
        '### Miscellaneous Chores',
      ],
    )
  })

  it('leaves out only the types a project asks to hide', () => {
    const out = kit.changelogFromCommits(
      [c('a', 'feat: x'), c('b', 'chore: tidy'), c('c', 'ci: cache')],
      null,
      ['chore', 'ci'],
    )
    assert.deepEqual(
      out.split('\n').filter((l) => l.startsWith('###')),
      ['### Features'],
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

  it('returns null only when nothing parses at all', () => {
    assert.equal(kit.changelogFromCommits([c('a', 'random work')]), null)
    assert.equal(
      kit.changelogFromCommits([c('a', 'chore: x')], null, ['chore']),
      null,
      'or when everything present is hidden',
    )
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

describe('types outside the table', () => {
  it('parses a type containing digits', () => {
    // `[a-z]+` silently failed to parse these at all, so the commit vanished.
    assert.equal(kit.parseCommit('i18n: add Greek').type, 'i18n')
    assert.equal(kit.parseCommit('a11y(nav): focus ring').type, 'a11y')
  })

  it('still refuses prose', () => {
    assert.equal(kit.parseCommit('just did some stuff'), null)
  })

  it('collects unanticipated types under Other Changes instead of dropping them', () => {
    const out = kit.changelogFromCommits([
      c('a', 'feat: known'),
      c('b', 'security: patch a CVE'),
      c('c', 'i18n: add Greek'),
    ])
    assert.match(out, /### Other Changes\n\n- patch a CVE\n- add Greek/)
  })

  it('hides an unanticipated type too when it is listed', () => {
    assert.equal(kit.changelogFromCommits([c('a', 'security: x')], null, ['security']), null)
  })

  it('groups dependency bumps', () => {
    assert.match(
      kit.changelogFromCommits([c('a', 'deps: bump serde')]),
      /### Dependencies\n\n- bump serde/,
    )
  })
})

describe('lintSubjects', () => {
  const lint = (...subjects) =>
    kit.lintSubjects(subjects.map((s) => ({ hash: 'abc1234', subject: s })))

  it('passes the subjects the changelog can file', () => {
    assert.deepEqual(
      lint('feat: a', 'fix(core): b', 'chore!: c', 'deps: bump serde', 'feature: legacy alias'),
      [],
    )
  })

  it('fails prose, because the bump and the changelog both skip it', () => {
    const [finding] = lint('added a thing')
    assert.equal(finding.level, 'error')
    assert.equal(finding.subject, 'added a thing')
    assert.equal(finding.hash, 'abc1234')
    assert.match(finding.reason, /not Conventional Commits/)
  })

  it('fails a header that only looks conventional', () => {
    for (const bad of ['feat x', 'feat:', 'feat:no space', '']) {
      assert.equal(lint(bad)[0]?.level, 'error', JSON.stringify(bad))
    }
  })

  it('tolerates an uppercase type, because parseCommit folds it', () => {
    // Worth pinning: the linter is only allowed to fail what the release actually mishandles,
    // and `Feat:` bumps and files exactly as `feat:` does.
    assert.equal(
      kit.inferBump([{ hash: 'a', subject: 'Feat: x', body: '' }], '1.0.0').bump,
      'minor',
    )
    assert.deepEqual(lint('Feat: x'), [])
  })

  it('only warns for a type with no section, which is still printed', () => {
    const findings = lint('security: patch a CVE', 'i18n: add Greek')
    assert.deepEqual(
      findings.map((f) => f.level),
      ['warn', 'warn'],
    )
    assert.match(findings[0].reason, /Other Changes/)
  })

  it('accepts a subject with no hash, as a pull request title has none', () => {
    assert.deepEqual(kit.lintSubjects([{ subject: 'feat: a' }]), [])
    assert.equal(kit.lintSubjects([{ subject: 'a' }])[0].hash, '')
  })
})

describe('the type table is the only list of types', () => {
  it('accepts every changelog type, so nothing is filed but unwritable', () => {
    for (const type of kit.CHANGELOG_TYPES) {
      assert.match(`${type}: x`, kit.CONVENTIONAL_RE, type)
      assert.deepEqual(kit.lintSubjects([{ subject: `${type}: x` }]), [])
    }
  })

  it('knows the feature alias changelogFromCommits folds into Features', () => {
    assert.ok(kit.KNOWN_TYPES.has('feature'))
    assert.match(kit.changelogFromCommits([c('a', 'feature: x')]), /### Features\n\n- x/)
  })
})
