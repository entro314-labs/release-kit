/**
 * End-to-end releases against real repositories with a real bare remote.
 *
 * These are the tests that would have caught the defects found in use: a tag left behind
 * HEAD, a changelog rolled twice, a Python project reaching for npm.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { makeRepo, readFile, release, stubCalls, tagsOnRemote } from './helpers/repo.mjs'

const CHANGELOG = '# Changelog\n\n## [Unreleased]\n\n### Added\n\n- A thing.\n'

describe('a default release', () => {
  it('runs every step and lands the tag on the remote', () => {
    const repo = makeRepo({ changelog: CHANGELOG })
    const { status, stdout } = release(repo, ['minor', '--yes'])
    assert.equal(status, 0, stdout)
    assert.deepEqual(tagsOnRemote(repo), ['v1.1.0'])
    assert.equal(JSON.parse(readFile(repo, 'package.json')).version, '1.1.0')
    assert.match(readFile(repo, 'CHANGELOG.md'), /## \[1\.1\.0\] - \d{4}-\d{2}-\d{2}\n\n### Added/)
    const calls = stubCalls(repo)
    assert.ok(
      calls.some((c) => c.startsWith('npm publish')),
      'published',
    )
    assert.ok(
      calls.some((c) => c.startsWith('gh release create')),
      'released',
    )
  })

  it('carries the notes into the tag annotation, markdown intact', () => {
    const repo = makeRepo({ changelog: CHANGELOG })
    release(repo, ['minor', '--yes'])
    const annotation = execFileSync('git', ['tag', '-l', 'v1.1.0', '--format=%(contents)'], {
      cwd: repo.root,
      encoding: 'utf8',
    })
    // git strips '#'-leading lines from tag messages unless --cleanup=verbatim.
    assert.match(annotation, /### Added/)
  })
})

describe('re-running a release', () => {
  it('detects what is already done instead of repeating it', () => {
    const repo = makeRepo({ changelog: CHANGELOG })
    release(repo, ['minor', '--yes'])
    const { status, stdout } = release(repo, ['--yes'], {
      GH_RELEASE_EXISTS: '0',
      NPM_PUBLISHED: '0',
    })
    assert.equal(status, 0, stdout)
    assert.match(stdout, /already exists at HEAD/)
    assert.match(stdout, /already published/)
  })
})

describe('preflight', () => {
  it('reports every failure at once rather than stopping at the first', () => {
    const repo = makeRepo()
    writeFileSync(join(repo.root, 'junk.txt'), 'x')
    execFileSync('git', ['checkout', '-q', '-b', 'feature'], { cwd: repo.root })
    const { status, stdout } = release(repo, ['0.5.0', '--yes'], { GH_AUTHED: '1' })
    assert.equal(status, 1)
    for (const expected of [
      /not greater than/,
      /working tree is not clean/,
      /expected 'main'/,
      /not authenticated/,
    ]) {
      assert.match(stdout, expected)
    }
  })

  it('refuses a detached HEAD, which is how CI checks out a tag', () => {
    const repo = makeRepo()
    execFileSync('git', ['checkout', '-q', '--detach', 'HEAD'], { cwd: repo.root })
    const { status, stdout } = release(repo, ['minor', '--yes'])
    assert.equal(status, 1)
    assert.match(stdout, /HEAD is detached/)
  })

  it('refuses to reuse a tag while still producing a commit', () => {
    // Reusing the tag is the resume path, and a resume writes nothing. Committing anyway
    // moves HEAD past the tag and the release ends up tagged at the wrong revision.
    const repo = makeRepo({ changelog: CHANGELOG })
    execFileSync('git', ['tag', '-a', 'v1.0.0', '-m', 'existing'], { cwd: repo.root })
    const { status, stdout } = release(repo, ['--yes'])
    assert.equal(status, 1)
    assert.match(stdout, /would still commit/)
  })
})

describe('steps', () => {
  it('runs only what was selected', () => {
    const repo = makeRepo({ changelog: CHANGELOG })
    const { status, stdout } = release(repo, ['minor', '--skip', 'publish,release', '--yes'])
    assert.equal(status, 0, stdout)
    assert.deepEqual(tagsOnRemote(repo), ['v1.1.0'])
    const calls = stubCalls(repo)
    assert.ok(!calls.some((c) => c.startsWith('npm publish')), 'did not publish')
    assert.ok(!calls.some((c) => c.startsWith('gh release create')), 'did not release')
  })

  it('rejects a misspelled step instead of silently ignoring it', () => {
    const repo = makeRepo()
    const { status, stdout } = release(repo, ['minor', '--skip', 'pubish', '--yes'])
    assert.equal(status, 1)
    assert.match(stdout, /unknown step\(s\): pubish/)
  })

  it('does not mistake a flag value for the release target', () => {
    const repo = makeRepo({ changelog: CHANGELOG })
    const { status, stdout } = release(repo, ['--only', 'tag,push', '--yes'])
    assert.equal(status, 0, stdout)
    assert.deepEqual(tagsOnRemote(repo), ['v1.0.0'])
  })
})

describe('non-Node projects', () => {
  it('detects the version source and does not reach for npm', () => {
    const repo = makeRepo({
      config: { versionFile: 'pyproject.toml', steps: ['version', 'tag', 'push'] },
      files: { 'pyproject.toml': '[project]\nname = "widgetlib"\nversion = "2.1.0"\n' },
    })
    const { status, stdout } = release(repo, ['patch', '--yes'])
    assert.equal(status, 0, stdout)
    assert.match(readFile(repo, 'pyproject.toml'), /version = "2\.1\.1"/)
    assert.ok(!stubCalls(repo).some((c) => c.startsWith('npm publish')), 'never published to npm')
  })

  it('keeps many version files in step across formats', () => {
    const repo = makeRepo({
      config: {
        versionFiles: ['src-tauri/tauri.conf.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock'],
        publish: null,
        steps: ['version', 'tag', 'push'],
      },
      files: {
        'src-tauri/tauri.conf.json': '{\n  "version": "1.0.0"\n}\n',
        'src-tauri/Cargo.toml': '[package]\nname = "myapp"\nversion = "1.0.0"\n',
        'src-tauri/Cargo.lock':
          '[[package]]\nname = "adler2"\nversion = "2.0.1"\n\n[[package]]\nname = "myapp"\nversion = "1.0.0"\n',
      },
    })
    const { status, stdout } = release(repo, ['minor', '--yes'])
    assert.equal(status, 0, stdout)
    assert.match(readFile(repo, 'src-tauri/tauri.conf.json'), /"version": "1\.1\.0"/)
    assert.match(readFile(repo, 'src-tauri/Cargo.toml'), /^version = "1\.1\.0"$/m)
    assert.match(readFile(repo, 'src-tauri/Cargo.lock'), /name = "myapp"\nversion = "1\.1\.0"/)
    assert.match(readFile(repo, 'src-tauri/Cargo.lock'), /name = "adler2"\nversion = "2\.0\.1"/)
  })
})

describe('auto', () => {
  it('infers the bump from the commits since the last tag', () => {
    const repo = makeRepo({ config: { publish: null, steps: ['version', 'tag', 'push'] } })
    execFileSync('git', ['tag', '-a', 'v1.0.0', '-m', 'base'], { cwd: repo.root })
    writeFileSync(join(repo.root, 'a.txt'), 'a')
    execFileSync('git', ['add', '-A'], { cwd: repo.root })
    execFileSync('git', ['commit', '-qm', 'feat: add a thing'], { cwd: repo.root })
    const { status, stdout } = release(repo, ['auto', '--yes'])
    assert.equal(status, 0, stdout)
    assert.match(stdout, /auto: minor/)
    // --follow-tags pushes the pre-existing local v1.0.0 alongside the new one.
    assert.ok(tagsOnRemote(repo).includes('v1.1.0'), 'the new tag reached the remote')
  })
})

describe('repositories that version by tag alone', () => {
  const goRepo = () =>
    makeRepo({
      config: { versionFile: null, publish: null, steps: ['tag', 'push'] },
      files: { 'go.mod': 'module github.com/acme/tool\n\ngo 1.24\n' },
    })

  it('reads the current version from the latest tag', () => {
    // A Go module has no version file — the tag is the version. Without this, auto and
    // every bump have nothing to work from.
    const repo = goRepo()
    execFileSync('git', ['tag', '-a', 'v1.2.0', '-m', 'base'], { cwd: repo.root })
    writeFileSync(join(repo.root, 'a.go'), 'package main')
    execFileSync('git', ['add', '-A'], { cwd: repo.root })
    execFileSync('git', ['commit', '-qm', 'feat: add a thing'], { cwd: repo.root })

    const { status, stdout } = release(repo, ['auto', '--yes'])
    assert.equal(status, 0, stdout)
    assert.match(stdout, /1\.2\.0 → 1\.3\.0/)
    assert.ok(tagsOnRemote(repo).includes('v1.3.0'))
  })

  it('asks for a version when there is neither a file nor a tag', () => {
    const { status, stdout } = release(goRepo(), ['auto', '--yes'])
    assert.equal(status, 1)
    assert.match(stdout, /nothing to bump from/)
  })
})
