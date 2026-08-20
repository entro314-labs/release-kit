/** Reading, rolling and inserting changelog sections. */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { kit } from './helpers/load.mjs'

describe('changelogSection', () => {
  it('recognises every heading shape in the wild', () => {
    for (const heading of [
      '## [1.2.3] - 2026-08-17',
      '## v1.2.3',
      '## 1.2.3',
      '## 1.2.3 (2026-08-17)',
      '## v1.2.3 — 2026-08-17',
      '## [1.2.3]',
    ]) {
      const doc = `# Changelog\n\n${heading}\n\n### Added\n\n- Thing.\n\n## [1.2.2]\n\n- Old.\n`
      assert.equal(kit.changelogSection(doc, '1.2.3'), '### Added\n\n- Thing.', heading)
    }
  })

  it('does not match a longer version sharing a prefix', () => {
    const doc = '## [1.2.30]\n\n- Thirty.\n\n## [1.2.3]\n\n- Three.\n'
    assert.equal(kit.changelogSection(doc, '1.2.3'), '- Three.')
    assert.equal(kit.changelogSection(doc, '1.2.30'), '- Thirty.')
  })

  it('stops at a horizontal rule as well as the next heading', () => {
    assert.equal(
      kit.changelogSection('## v1.0.0\n\n- Body.\n\n---\n\nfooter\n', '1.0.0'),
      '- Body.',
    )
  })

  it('reports an absent or empty section as null', () => {
    assert.equal(kit.changelogSection('## [1.0.0]\n\n- x\n', '9.9.9'), null)
    assert.equal(kit.changelogSection('## [1.0.0]\n\n## [0.9.0]\n\n- x\n', '1.0.0'), null)
  })
})

describe('rollUnreleased', () => {
  const populated =
    '# Changelog\n\n## [Unreleased]\n\n### Added\n\n- A thing.\n\n## [1.0.0]\n\n- Old.\n'

  it('promotes the section and reopens an empty [Unreleased]', () => {
    const rolled = kit.rollUnreleased(populated, '1.1.0', '2026-08-17')
    assert.match(rolled, /## \[Unreleased\]\n\n## \[1\.1\.0\] - 2026-08-17\n\n### Added/)
    assert.equal(kit.changelogSection(rolled, '1.1.0'), '### Added\n\n- A thing.')
  })

  it('is a no-op the second time', () => {
    const rolled = kit.rollUnreleased(populated, '1.1.0', '2026-08-17')
    assert.equal(kit.rollUnreleased(rolled, '1.1.0', '2026-08-17'), null)
  })

  it('refuses when the version already has a heading, even an empty one', () => {
    // The regression that produced two `## [2.3.1]` headings in this project's own
    // changelog: an empty section reads as absent, so it rolled a second time.
    const broken =
      '# Changelog\n\n## [Unreleased]\n\n## [2.3.1] - 2026-08-17\n\n## [2.3.0]\n\n- Real.\n'
    assert.equal(kit.rollUnreleased(broken, '2.3.1', '2026-08-18'), null)
  })

  it('refuses to roll an empty [Unreleased]', () => {
    const empty = '# Changelog\n\n## [Unreleased]\n\n## [1.0.0]\n\n- Old.\n'
    assert.equal(kit.rollUnreleased(empty, '1.1.0', '2026-08-17'), null)
  })
})

describe('insertChangelogSection', () => {
  it('inserts above the newest existing section and keeps the preamble', () => {
    const doc = '# Changelog\n\nIntro.\n\n## [1.0.0] - 2026-01-01\n\n- Old.\n'
    const out = kit.insertChangelogSection(doc, '1.1.0', '2026-08-17', '### Added\n\n- New.')
    assert.ok(out.startsWith('# Changelog\n\nIntro.\n\n'))
    assert.match(out, /## \[1\.1\.0\] - 2026-08-17\n\n### Added\n\n- New\.\n\n## \[1\.0\.0\]/)
  })

  it('handles a changelog with no sections yet', () => {
    assert.equal(
      kit.insertChangelogSection('# Changelog\n', '1.0.0', '2026-08-17', '- First.'),
      '# Changelog\n\n## [1.0.0] - 2026-08-17\n\n- First.\n',
    )
  })
})

describe('section placement', () => {
  it('places a release above the first older version, not blindly at the top', () => {
    // Inserting at the top is correct only while the file is already newest-first. This is
    // the bug that put a released 2.5.0 between 2.3.3 and 2.4.0 in this project's own
    // changelog, and made every subsequent release worse.
    const out = kit.insertChangelogSection(
      '# Changelog\n\n## [2.4.0]\n\n- newer.\n\n## [2.3.3]\n\n- older.\n',
      '2.3.5',
      '2026-08-18',
      '- middle.',
    )
    assert.deepEqual(
      out.split('\n').filter((l) => l.startsWith('## ')),
      ['## [2.4.0]', '## [2.3.5] - 2026-08-18', '## [2.3.3]'],
    )
  })

  it('appends when the new version is the oldest', () => {
    const out = kit.insertChangelogSection(
      '# Changelog\n\n## [2.0.0]\n\n- x.\n',
      '1.0.0',
      '2026-01-01',
      '- first.',
    )
    assert.deepEqual(
      out.split('\n').filter((l) => l.startsWith('## ')),
      ['## [2.0.0]', '## [1.0.0] - 2026-01-01'],
    )
  })

  it('lifts a misplaced [Unreleased] to the top instead of rolling in place', () => {
    const broken =
      '# Changelog\n\n## [2.3.3]\n\n- old.\n\n## [Unreleased]\n\n- new work.\n\n## [2.4.0]\n\n- newer.\n'
    const out = kit.rollUnreleased(broken, '2.5.0', '2026-08-18')
    const headings = out.split('\n').filter((l) => l.startsWith('## '))
    assert.equal(headings[0], '## [Unreleased]')
    assert.equal(headings[1], '## [2.5.0] - 2026-08-18')
    assert.equal(kit.changelogSection(out, '2.5.0'), '- new work.')
  })
})

describe('changelogOutOfOrder', () => {
  it('says nothing about a newest-first file', () => {
    assert.deepEqual(kit.changelogOutOfOrder('## [2.5.0]\n## [2.4.0]\n## [2.3.3]\n'), [])
  })

  it('names the versions sitting above a newer one', () => {
    assert.deepEqual(kit.changelogOutOfOrder('## [2.3.3]\n## [2.4.0]\n## [2.3.2]\n'), ['2.4.0'])
  })
})

describe('link reference definitions', () => {
  // `## [1.2.3]` is a markdown link reference: without a definition at the foot of the
  // file it renders as literal bracketed text. Nothing was writing them.
  const links = {
    base: 'https://github.com/acme/tool',
    issue: 'https://github.com/acme/tool/issues',
    commit: 'https://github.com/acme/tool/commit',
    compare: (from, to) => `https://github.com/acme/tool/compare/${from}...${to}`,
    tag: (name) => `https://github.com/acme/tool/releases/tag/${name}`,
  }
  const doc = '# Changelog\n\n## [Unreleased]\n\n## [1.2.0]\n\n- b\n\n## [1.1.0]\n\n- a\n'

  it('compares each version with the one below it', () => {
    const out = kit.withChangelogLinks(doc, links, 'v')
    assert.match(
      out,
      /^\[1\.2\.0\]: https:\/\/github\.com\/acme\/tool\/compare\/v1\.1\.0\.\.\.v1\.2\.0$/m,
    )
  })

  it('links the oldest version to its own tag, having nothing to compare against', () => {
    const out = kit.withChangelogLinks(doc, links, 'v')
    assert.match(out, /^\[1\.1\.0\]: https:\/\/github\.com\/acme\/tool\/releases\/tag\/v1\.1\.0$/m)
  })

  it('compares [Unreleased] against HEAD', () => {
    const out = kit.withChangelogLinks(doc, links, 'v')
    assert.match(out, /^\[Unreleased\]: \S+\/compare\/v1\.2\.0\.\.\.HEAD$/m)
  })

  it('repairs a changelog that never had definitions, not only the new section', () => {
    const out = kit.withChangelogLinks(doc, links, 'v')
    assert.equal(out.match(/^\[[^\]]+\]: /gm).length, 3)
  })

  it('is idempotent', () => {
    const once = kit.withChangelogLinks(doc, links, 'v')
    assert.equal(kit.withChangelogLinks(once, links, 'v'), once)
  })

  it("leaves the author's own link definitions alone", () => {
    const withOwn = `${doc}\n[the docs]: https://example.test/docs\n`
    const out = kit.withChangelogLinks(withOwn, links, 'v')
    assert.match(out, /^\[the docs\]: https:\/\/example\.test\/docs$/m)
  })

  it('does nothing without a resolvable remote', () => {
    assert.equal(kit.withChangelogLinks(doc, null, 'v'), doc)
  })

  it('honours a non-default tag prefix', () => {
    const out = kit.withChangelogLinks(doc, links, 'release-')
    assert.match(out, /compare\/release-1\.1\.0\.\.\.release-1\.2\.0/)
  })
})
