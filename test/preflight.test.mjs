/** Preflight helpers: drafted-version validation and repository URL normalization. */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { kit } from './helpers/load.mjs'

describe('inventedVersions', () => {
  it('flags a version the staged changes never touch', () => {
    const message = 'feat: add job type and release v1.4.5'
    const changed = '+  "instance.arc_cache",\n-  "old_type",'
    assert.deepEqual(kit.inventedVersions(message, changed), ['1.4.5'])
  })

  it('accepts a version quoted from a changed line', () => {
    const message = 'chore(deps): bump tsdown to 0.23.0-rc.0'
    const changed = '+    "tsdown": "0.23.0-rc.0",\n-    "tsdown": "0.22.1",'
    assert.deepEqual(kit.inventedVersions(message, changed), [])
  })

  it('reports each invented version once and passes messages with none', () => {
    assert.deepEqual(kit.inventedVersions('fix: 2.0.0 then 2.0.0 again', ''), ['2.0.0'])
    assert.deepEqual(kit.inventedVersions('fix: trim whitespace', '+x'), [])
  })
})

describe('fallbackCommitMessage', () => {
  it('names one or two files in the subject', () => {
    assert.equal(kit.fallbackCommitMessage(['junk.txt']), 'chore: update junk.txt')
    assert.equal(
      kit.fallbackCommitMessage(['package.json', 'pnpm-lock.yaml']),
      'chore: update package.json and pnpm-lock.yaml',
    )
  })

  it('counts many files and lists their paths in the body', () => {
    const message = kit.fallbackCommitMessage(['a.js', 'src/b.js', 'test/c.js'])
    const [subject, blank, ...body] = message.split('\n')
    assert.equal(subject, 'chore: update 3 files')
    assert.equal(blank, '')
    assert.deepEqual(body, ['- a.js', '- src/b.js', '- test/c.js'])
  })

  it('always yields a valid Conventional Commits subject, even for long names', () => {
    const long = [`${'x'.repeat(80)}.js`, 'y.js']
    for (const files of [['a.js'], long, ['a', 'b', 'c', 'd']]) {
      const [subject] = kit.fallbackCommitMessage(files).split('\n')
      assert.match(subject, kit.CONVENTIONAL_RE, subject)
      assert.ok(subject.length <= 72, subject)
    }
  })
})

describe('normalizeRepoUrl', () => {
  it('treats git+, ssh, scp shorthand, .git and case as the same repository', () => {
    const canonical = 'https://github.com/capy-base/sdk-ts'
    for (const url of [
      'git+https://github.com/capy-base/sdk-ts.git',
      'git@github.com:capy-base/sdk-ts.git',
      'ssh://git@github.com/capy-base/sdk-ts',
      'git://github.com/capy-base/sdk-ts.git',
      'https://github.com/Capy-Base/SDK-TS/',
    ]) {
      assert.equal(kit.normalizeRepoUrl(url), canonical, url)
    }
  })

  it('distinguishes actually different repositories, and handles null', () => {
    assert.notEqual(
      kit.normalizeRepoUrl('https://github.com/capy-base/capydb-sdk-ts.git'),
      kit.normalizeRepoUrl('https://github.com/capy-base/sdk-ts.git'),
    )
    assert.equal(kit.normalizeRepoUrl(null), null)
  })
})
