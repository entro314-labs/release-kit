/**
 * Sanitising what a drafting assistant returns. The hard requirement is that no attribution
 * for the tool ever reaches a commit, tag or changelog.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { kit } from './helpers/load.mjs'

describe('cleanDraft', () => {
  it('strips tool attribution in every form seen', () => {
    assert.equal(
      kit.cleanDraft('feat: x\n\nBody.\n\nCo-Authored-By: Claude <noreply@anthropic.com>'),
      'feat: x\n\nBody.',
    )
    assert.equal(kit.cleanDraft('fix: x\n\nco-authored-by: Claude Opus <a@b.c>'), 'fix: x')
    assert.equal(
      kit.cleanDraft('feat: y\n\n🤖 Generated with [Claude Code](https://claude.com)'),
      'feat: y',
    )
    assert.equal(kit.cleanDraft('feat: y\n\nGenerated with Claude'), 'feat: y')
    assert.equal(kit.cleanDraft('feat: z\n\nSigned-off-by: Claude'), 'feat: z')
  })

  it('keeps a human Signed-off-by', () => {
    assert.equal(
      kit.cleanDraft('feat: z\n\nSigned-off-by: Dominikos <d@e.f>'),
      'feat: z\n\nSigned-off-by: Dominikos <d@e.f>',
    )
  })

  it('strips the fences models wrap output in', () => {
    assert.equal(kit.cleanDraft('```\nfeat: a\n```'), 'feat: a')
    assert.equal(kit.cleanDraft('```markdown\n### Added\n\n- Thing.\n```'), '### Added\n\n- Thing.')
    assert.equal(kit.cleanDraft('### Added\n\n- Thing.'), '### Added\n\n- Thing.')
  })
})

describe('cleanNotes', () => {
  it('drops a stray fence and the trailing commentary a real model produced', () => {
    assert.equal(
      kit.cleanNotes(
        '### Added\n\n- `tokenize()` splits on whitespace.\n- `ParseError` reports the line.\n```\n\n' +
          'Both commits in this release are new features, so only the `### Added` heading applies.',
      ),
      '### Added\n\n- `tokenize()` splits on whitespace.\n- `ParseError` reports the line.',
    )
  })

  it('drops multi-paragraph commentary', () => {
    assert.equal(
      kit.cleanNotes('### Fixed\n\n- A thing.\n\nThat covers it.\n\nLet me know.'),
      '### Fixed\n\n- A thing.',
    )
  })

  it('keeps wrapped bullet continuations', () => {
    const wrapped = '### Added\n\n- A long bullet that wraps\n  onto a second indented line.'
    assert.equal(kit.cleanNotes(wrapped), wrapped)
  })

  it('leaves clean input alone and still strips attribution', () => {
    assert.equal(
      kit.cleanNotes('### Added\n\n- One.\n\n### Fixed\n\n- Two.'),
      '### Added\n\n- One.\n\n### Fixed\n\n- Two.',
    )
    assert.equal(
      kit.cleanNotes('### Added\n\n- One.\n\nCo-Authored-By: Claude <a@b>'),
      '### Added\n\n- One.',
    )
  })

  it('returns null when there is nothing but commentary', () => {
    assert.equal(kit.cleanNotes('I could not determine the changes.'), null)
  })
})

describe('CONVENTIONAL_RE', () => {
  it('accepts valid subjects', () => {
    for (const good of [
      'feat: x',
      'fix(core): y',
      'chore!: z',
      'refactor(a-b): c',
      'docs: multi word',
    ]) {
      assert.ok(kit.CONVENTIONAL_RE.test(good), good)
    }
  })

  it('rejects what should never be committed as a drafted message', () => {
    for (const bad of ['added a thing', 'Feat: x', 'feat x', 'feat:', 'wip: x', 'deps: x', '']) {
      assert.ok(!kit.CONVENTIONAL_RE.test(bad), JSON.stringify(bad))
    }
  })
})

describe('linkCitedCommits', () => {
  const commits = [
    { hash: 'abc1234def', subject: 'feat: a' },
    { hash: 'deadbee0000', subject: 'fix: b' },
  ]
  const links = { commit: 'https://github.com/o/r/commit', issue: 'https://github.com/o/r/issues' }

  it('turns a citation into a link', () => {
    assert.equal(
      kit.linkCitedCommits('### Added\n\n- Something (abc1234)', commits, links),
      '### Added\n\n- Something ([abc1234](https://github.com/o/r/commit/abc1234))',
    )
  })

  it('handles a bullet that merges several commits', () => {
    const out = kit.linkCitedCommits('- Merged work (abc1234, deadbee)', commits, links)
    assert.match(out, /\[abc1234\].*\[deadbee\]/)
  })

  it('removes a hash the model invented', () => {
    // Models produce plausible-looking hashes. Publishing a link to a commit that does not
    // exist is worse than publishing no link.
    assert.equal(kit.linkCitedCommits('- Something (0000000)', commits, links), '- Something')
  })

  it('keeps only the real hashes from a mixed citation', () => {
    const out = kit.linkCitedCommits('- Something (abc1234, 0000000)', commits, links)
    assert.match(out, /\[abc1234\]/)
    assert.ok(!out.includes('0000000'))
  })

  it('falls back to plain code spans with no remote to link to', () => {
    assert.equal(
      kit.linkCitedCommits('- Something (abc1234)', commits, null),
      '- Something (`abc1234`)',
    )
  })

  it('leaves bullets without a citation alone', () => {
    assert.equal(kit.linkCitedCommits('- Something', commits, links), '- Something')
  })
})
