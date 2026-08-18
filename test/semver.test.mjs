/**
 * The version arithmetic, checked against the real `semver` package rather than against
 * what it looked like it should do. That is what catches the cases nobody remembers —
 * a breaking change below 1.0.0 bumps the minor, it does not jump to 1.0.0.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import semver from 'semver'

import { kit } from './helpers/load.mjs'

const VERSIONS = ['1.0.0', '1.2.3', '2.0.0-beta.1', '2.0.0-rc.9', '1.2.0-alpha.0', '3.0.0-0']
const BUMPS = ['major', 'minor', 'patch', 'premajor', 'preminor', 'prepatch', 'prerelease']

describe('incrementVersion', () => {
  it('matches semver.inc for every version and bump', () => {
    for (const version of VERSIONS) {
      for (const bump of BUMPS) {
        const existing = semver.prerelease(version)?.[0]
        const preid = bump.startsWith('pre')
          ? typeof existing === 'string'
            ? existing
            : 'beta'
          : undefined
        assert.equal(
          kit.incrementVersion(version, bump, preid),
          semver.inc(version, bump, preid),
          `${version} + ${bump}`,
        )
      }
    }
  })

  it('promotes a release candidate with a plain patch', () => {
    assert.equal(kit.incrementVersion('2.0.0-rc.9', 'patch'), '2.0.0')
  })
})

describe('compareVersions', () => {
  it('matches semver.compare for every ordered pair', () => {
    const all = [
      '1.0.0',
      '1.0.1',
      '1.1.0',
      '2.0.0',
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-alpha.beta',
      '1.0.0-beta',
      '1.0.0-beta.2',
      '1.0.0-beta.11',
      '1.0.0-rc.1',
      '1.0.0-0',
      '1.0.0-1',
    ]
    for (const a of all) {
      for (const b of all) {
        assert.equal(Math.sign(kit.compareVersions(a, b)), semver.compare(a, b), `${a} vs ${b}`)
      }
    }
  })
})

describe('parseVersion', () => {
  it('rejects things that are not semver', () => {
    for (const bad of ['1.2', 'v1.2.3', '1.2.3.4', '', 'abc', '1.2.3-']) {
      assert.equal(kit.parseVersion(bad), null, JSON.stringify(bad))
    }
  })

  it('accepts build metadata', () => {
    assert.notEqual(kit.parseVersion('1.2.3+build.5'), null)
  })
})

describe('distTagFor', () => {
  it('derives the channel from the version', () => {
    assert.equal(kit.distTagFor('1.2.3'), 'latest')
    assert.equal(kit.distTagFor('1.2.3-beta.4'), 'beta')
    assert.equal(kit.distTagFor('2.0.0-RC.1'), 'rc')
    assert.equal(
      kit.distTagFor('3.0.0-1751023456789'),
      'canary',
      'all-numeric is a canary timestamp',
    )
  })

  it('lets an explicit tag win', () => {
    assert.equal(kit.distTagFor('1.2.3-beta.4', 'experimental'), 'experimental')
  })

  it('refuses an identifier with no safe channel rather than defaulting to latest', () => {
    assert.throws(() => kit.distTagFor('1.2.3-lol.0'), /no known dist-tag/)
  })
})
