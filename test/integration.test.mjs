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
    const { status, stdout } = release(repo, ['0.5.0', '--yes', '--skip', 'commit'], {
      GH_AUTHED: '1',
    })
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

  it('rejects extra positional arguments and points at the flag spelling', () => {
    const repo = makeRepo()
    const { status, stdout } = release(repo, ['auto', 'assistant', 'auto', '--yes'])
    assert.equal(status, 1)
    assert.match(stdout, /unexpected argument/)
    assert.match(stdout, /--assistant auto/)
  })

  it('commits a dirty tree without an assistant, using a generated message', () => {
    const repo = makeRepo()
    writeFileSync(join(repo.root, 'junk.txt'), 'x')
    const { status, stdout } = release(repo, ['minor', '--yes'])
    assert.equal(status, 0, stdout)
    assert.match(stdout, /will be committed first/)
    assert.match(stdout, /no assistant configured/)
    const subjects = execFileSync('git', ['log', '--format=%s'], {
      cwd: repo.root,
      encoding: 'utf8',
    })
    assert.match(subjects, /^chore: update junk\.txt$/m)
  })

  it('still refuses a dirty tree when the commit step is skipped', () => {
    const repo = makeRepo()
    writeFileSync(join(repo.root, 'junk.txt'), 'x')
    const { status, stdout } = release(repo, ['minor', '--yes', '--skip', 'commit'])
    assert.equal(status, 1)
    assert.match(stdout, /working tree is not clean/)
  })

  it('runs the configured verify command and fails preflight when it fails', () => {
    const repo = makeRepo()
    writeFileSync(
      join(repo.root, 'release.config.json'),
      JSON.stringify({ verify: 'node -e "console.error(0); process.exit(1)"' }),
    )
    execFileSync('git', ['add', '--all'], { cwd: repo.root })
    execFileSync('git', ['commit', '-qm', 'chore: add config'], { cwd: repo.root })
    const { status, stdout } = release(repo, ['minor', '--yes'])
    assert.equal(status, 1)
    assert.match(stdout, /verify failed/)
    assert.deepEqual(tagsOnRemote(repo), []) // nothing mutated
  })

  it('passes preflight when the verify command succeeds', () => {
    const repo = makeRepo()
    writeFileSync(join(repo.root, 'release.config.json'), JSON.stringify({ verify: 'node -e ""' }))
    execFileSync('git', ['add', '--all'], { cwd: repo.root })
    execFileSync('git', ['commit', '-qm', 'chore: add config'], { cwd: repo.root })
    const { status, stdout } = release(repo, ['minor', '--yes'])
    assert.equal(status, 0, stdout)
    assert.match(stdout, /verify passed/)
  })

  it('warns when package.json names a different repository than the remote', () => {
    const repo = makeRepo()
    const manifest = JSON.parse(readFile(repo, 'package.json'))
    manifest.repository = { type: 'git', url: 'https://github.com/somewhere/else.git' }
    writeFileSync(join(repo.root, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    execFileSync('git', ['add', '--all'], { cwd: repo.root })
    execFileSync('git', ['commit', '-qm', 'chore: point repository elsewhere'], { cwd: repo.root })
    const { status, stdout } = release(repo, ['minor', '--yes'])
    assert.equal(status, 0, stdout)
    assert.match(
      stdout,
      /package\.json repository is .* the registry will link the wrong repository/,
    )
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

describe('one repository, two ecosystems', () => {
  // A Tauri plugin is a crate and an npm package built from one source tree: both
  // manifests sit at the root, carry the same version, and publish on the same release.
  const plugin = (crateVersion = '1.0.0') => ({
    name: '@tauri-apps/plugin-demo',
    files: {
      'Cargo.toml': `[package]\nname = "tauri-plugin-demo"\nversion = "${crateVersion}"\n`,
      'Cargo.lock':
        '[[package]]\nname = "adler2"\nversion = "2.0.1"\n\n' +
        `[[package]]\nname = "tauri-plugin-demo"\nversion = "${crateVersion}"\n`,
    },
  })

  it('bumps both manifests and the lockfile with no config at all', () => {
    const repo = makeRepo(plugin())
    const { status, stdout } = release(repo, ['minor', '--yes'], {
      CARGO_REGISTRY_TOKEN: 'test-token',
    })
    assert.equal(status, 0, stdout)
    assert.match(stdout, /also versioned in Cargo\.toml, Cargo\.lock \(detected\)/)
    assert.equal(JSON.parse(readFile(repo, 'package.json')).version, '1.1.0')
    assert.match(readFile(repo, 'Cargo.toml'), /^version = "1\.1\.0"$/m)
    assert.match(readFile(repo, 'Cargo.lock'), /name = "tauri-plugin-demo"\nversion = "1\.1\.0"/)
    assert.match(readFile(repo, 'Cargo.lock'), /name = "adler2"\nversion = "2\.0\.1"/)
  })

  it('publishes to npm first and crates.io second', () => {
    const repo = makeRepo(plugin())
    const { status, stdout } = release(repo, ['minor', '--yes'], {
      CARGO_REGISTRY_TOKEN: 'test-token',
    })
    assert.equal(status, 0, stdout)
    const published = stubCalls(repo).filter((c) => /^(npm|cargo) publish/.test(c))
    // npm is the recoverable one — an unpublish window exists there and not on crates.io —
    // so a failure part-way through must not have already made the permanent half.
    assert.deepEqual(published, ['npm publish --tag latest', 'cargo publish'])
  })

  it('looks the crate up under its crate name, not the npm one', () => {
    const repo = makeRepo(plugin())
    release(repo, ['minor', '--yes'], { CARGO_REGISTRY_TOKEN: 'test-token' })
    const calls = stubCalls(repo)
    assert.ok(
      calls.includes('cargo info tauri-plugin-demo@1.1.0'),
      `looked up the crate by its own name, got: ${calls.join(' | ')}`,
    )
  })

  it('skips the half that is already published and runs the other', () => {
    const repo = makeRepo(plugin())
    const { status, stdout } = release(repo, ['minor', '--yes'], {
      CARGO_REGISTRY_TOKEN: 'test-token',
      CARGO_PUBLISHED: '0',
    })
    assert.equal(status, 0, stdout)
    assert.match(stdout, /tauri-plugin-demo@1\.1\.0 is already published/)
    const published = stubCalls(repo).filter((c) => /^(npm|cargo) publish/.test(c))
    assert.deepEqual(published, ['npm publish --tag latest'])
  })

  it('fails preflight when crates.io has no credentials', () => {
    const repo = makeRepo(plugin())
    const { status, stdout } = release(repo, ['minor', '--yes'], {
      CARGO_REGISTRY_TOKEN: '',
      CARGO_REGISTRIES_CRATES_IO_TOKEN: '',
      HOME: repo.root,
    })
    assert.equal(status, 1)
    assert.match(stdout, /cargo has no publish credentials/)
  })

  it('leaves a manifest on its own version line alone, and says why', () => {
    // Different versions mean two independent release lines. Syncing them would silently
    // jump the crate five minor versions; refusing is the only safe reading.
    const repo = makeRepo(plugin('0.3.0'))
    const { status, stdout } = release(repo, ['minor', '--yes'])
    assert.equal(status, 0, stdout)
    assert.match(stdout, /Cargo\.toml is at 0\.3\.0 while package\.json is at 1\.0\.0/)
    assert.match(readFile(repo, 'Cargo.toml'), /^version = "0\.3\.0"$/m)
    assert.ok(
      !stubCalls(repo).some((c) => c.startsWith('cargo publish')),
      'never published a crate it was not versioning',
    )
  })

  it('does not detect a publish command for a crate that forbids publishing', () => {
    const repo = makeRepo({
      name: '@scope/demo',
      files: {
        'Cargo.toml': '[package]\nname = "internal"\nversion = "1.0.0"\npublish = false\n',
      },
    })
    const { status, stdout } = release(repo, ['minor', '--yes'])
    assert.equal(status, 0, stdout)
    assert.match(readFile(repo, 'Cargo.toml'), /^version = "1\.1\.0"$/m)
    assert.ok(
      !stubCalls(repo).some((c) => c.startsWith('cargo publish')),
      'honoured publish = false',
    )
  })

  it('versions a native extension crate without publishing it to crates.io', () => {
    // maturin and napi-rs compile a cdylib into a wheel or a .node. Its version tracks the
    // package it ships inside — which is why the two match — but it is not a crate anyone
    // depends on, and detecting `cargo publish` for it would publish the wrong thing.
    const repo = makeRepo({
      files: {
        'Cargo.toml':
          '[package]\nname = "demo-native"\nversion = "1.0.0"\n\n' +
          '[lib]\ncrate-type = ["cdylib"]\n',
      },
    })
    const { status, stdout } = release(repo, ['minor', '--yes'])
    assert.equal(status, 0, stdout)
    assert.match(readFile(repo, 'Cargo.toml'), /^version = "1\.1\.0"$/m)
    assert.ok(
      !stubCalls(repo).some((c) => c.startsWith('cargo publish')),
      'never published an extension module as a crate',
    )
    assert.ok(
      stubCalls(repo).some((c) => c.startsWith('npm publish')),
      'still published the package it ships inside',
    )
  })

  it('does not extend a versionFiles the project wrote itself', () => {
    const repo = makeRepo({
      config: { versionFiles: ['VERSION'], publish: null, steps: ['version', 'tag', 'push'] },
      files: {
        VERSION: '1.0.0\n',
        'Cargo.toml': '[package]\nname = "demo"\nversion = "1.0.0"\n',
      },
    })
    const { status, stdout } = release(repo, ['minor', '--yes'])
    assert.equal(status, 0, stdout)
    assert.equal(readFile(repo, 'VERSION'), '1.1.0\n')
    assert.match(readFile(repo, 'Cargo.toml'), /^version = "1\.0\.0"$/m)
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

  // A language with no version of its own still leaves the project wanting `--version` to
  // work, so the number is kept in source and the tag is supposed to match it.
  const goModule = (files) =>
    makeRepo({
      manifest: false,
      files: { 'go.mod': 'module github.com/acme/tool\n\ngo 1.24\n', ...files },
    })

  const tagged = (repo, version) => {
    execFileSync('git', ['tag', '-a', `v${version}`, '-m', 'base'], { cwd: repo.root })
    writeFileSync(join(repo.root, 'a.go'), 'package main')
    execFileSync('git', ['add', '-A'], { cwd: repo.root })
    execFileSync('git', ['commit', '-qm', 'feat: add a thing'], { cwd: repo.root })
    return repo
  }

  it('writes the version into the files a project listed, which it used to ignore', () => {
    // The version step ran, wrote nothing, and tagged a commit still carrying the old
    // number: `bumping` required a versionFile, and a tag-versioned repository has none.
    const repo = tagged(
      goModule({ 'version.go': 'package main\n\nconst Version = "1.2.0"\n' }),
      '1.2.0',
    )
    writeFileSync(
      join(repo.root, 'release.config.json'),
      JSON.stringify({
        versionFile: null,
        versionFiles: [{ path: 'version.go', pattern: '^const Version = "(.+)"' }],
        publish: null,
        steps: ['version', 'tag', 'push'],
      }),
    )
    execFileSync('git', ['add', '-A'], { cwd: repo.root })
    execFileSync('git', ['commit', '-qm', 'chore: config'], { cwd: repo.root })

    const { status, stdout } = release(repo, ['minor', '--yes'])
    assert.equal(status, 0, stdout)
    assert.match(readFile(repo, 'version.go'), /const Version = "1\.3\.0"/)
    assert.ok(tagsOnRemote(repo).includes('v1.3.0'))
  })

  it('detects a version constant in source with no config at all', () => {
    const repo = tagged(
      goModule({ 'version.go': 'package main\n\nconst Version = "1.2.0"\n' }),
      '1.2.0',
    )
    const { status, stdout } = release(repo, ['minor', '--yes', '--skip', 'publish,release'])
    assert.equal(status, 0, stdout)
    assert.match(stdout, /also versioned in version\.go \(detected\)/)
    assert.match(readFile(repo, 'version.go'), /const Version = "1\.3\.0"/)
  })

  it('finds the constant in the conventional nested packages too', () => {
    const repo = tagged(
      goModule({
        'internal/version/version.go': 'package version\n\nvar Version string = "1.2.0"\n',
      }),
      '1.2.0',
    )
    const { status, stdout } = release(repo, ['minor', '--yes', '--skip', 'publish,release'])
    assert.equal(status, 0, stdout)
    assert.match(readFile(repo, 'internal/version/version.go'), /Version string = "1\.3\.0"/)
  })

  it('leaves a placeholder a build injects with -ldflags alone, and silently', () => {
    // `var Version = "dev"` is replaced at link time. It is not a version to bump, and it
    // is common enough that warning about it every release would be noise.
    const repo = tagged(
      goModule({ 'version.go': 'package main\n\nvar Version = "dev"\n' }),
      '1.2.0',
    )
    const { status, stdout } = release(repo, ['minor', '--yes', '--skip', 'publish,release'])
    assert.equal(status, 0, stdout)
    assert.equal(readFile(repo, 'version.go'), 'package main\n\nvar Version = "dev"\n')
    assert.doesNotMatch(stdout, /version\.go/)
  })

  it('leaves a constant that has drifted from the tag alone', () => {
    const repo = tagged(
      goModule({ 'version.go': 'package main\n\nconst Version = "0.9.0"\n' }),
      '1.2.0',
    )
    const { status, stdout } = release(repo, ['minor', '--yes', '--skip', 'publish,release'])
    assert.equal(status, 0, stdout)
    assert.match(readFile(repo, 'version.go'), /const Version = "0\.9\.0"/)
  })

  it('does not reach for a registry just because it found a version file', () => {
    // The crash this pins: detected mirrors are { path, pattern }, and publish detection
    // read them as plain paths.
    const repo = tagged(
      goModule({ 'version.go': 'package main\n\nconst Version = "1.2.0"\n' }),
      '1.2.0',
    )
    const { status, stdout } = release(repo, ['minor', '--yes', '--skip', 'release'])
    assert.equal(status, 0, stdout)
    assert.ok(!stubCalls(repo).some((c) => c.startsWith('npm publish')), 'never published')
  })
})

describe('commits that will not appear in the notes', () => {
  it('says how many are not Conventional Commits', () => {
    // A squash-merge takes its subject from the PR title, which is where this usually goes
    // wrong — and silently, because the release still succeeds.
    const repo = makeRepo({ config: { publish: null, steps: ['version', 'tag', 'push'] } })
    execFileSync('git', ['tag', '-a', 'v1.0.0', '-m', 'base'], { cwd: repo.root })
    for (const message of ['feat: a proper one', 'updated some stuff', 'fixed the thing']) {
      writeFileSync(join(repo.root, 'f.txt'), message)
      execFileSync('git', ['add', '-A'], { cwd: repo.root })
      execFileSync('git', ['commit', '-qm', message], { cwd: repo.root })
    }
    const { stdout } = release(repo, ['auto', '--yes', '--dry-run'])
    assert.match(stdout, /2 of 3 commit\(s\) are not Conventional Commits/)
  })
})

describe('choosing where notes come from', () => {
  const withChangelog = () =>
    makeRepo({
      changelog: '# Changelog\n\n## [Unreleased]\n\n- Hand-written note.\n',
      config: { publish: null, steps: ['tag'], notesFile: 'n.md' },
    })

  const tagAnnotation = (repo, tag) =>
    execFileSync('git', ['tag', '-l', tag, '--format=%(contents)'], {
      cwd: repo.root,
      encoding: 'utf8',
    })

  it('prefers a hand-written changelog by default', () => {
    const repo = withChangelog()
    release(repo, ['1.1.0', '--yes'])
    assert.match(tagAnnotation(repo, 'v1.1.0'), /Hand-written note/)
  })

  it('keeps a hand-written section when a dirty tree is committed first', () => {
    // Drafting is deferred past the commit only when preflight found nothing to release
    // with. Deferring on a dirty tree alone re-drafted over a section that already existed,
    // which discarded the notes the confirmation prompt showed and appended a second
    // section for the same version.
    const repo = makeRepo({
      changelog: '# Changelog\n\n## [1.1.0] - 2026-01-01\n\n- Hand-written note.\n',
      config: { publish: null },
    })
    writeFileSync(join(repo.root, 'junk.txt'), 'x')

    const { status, stdout } = release(repo, ['1.1.0', '--yes'])
    assert.equal(status, 0, stdout)
    assert.match(tagAnnotation(repo, 'v1.1.0'), /Hand-written note/)
    const changelog = readFile(repo, 'CHANGELOG.md')
    assert.equal(changelog.match(/^## \[1\.1\.0\]/gm).length, 1, changelog)
  })

  it('forces the commit log when asked, over a populated [Unreleased]', () => {
    // --notes names the source; --assistant only names the tool. Asking for one thing and
    // being given another is worse than being told it is unavailable.
    const repo = withChangelog()
    execFileSync('git', ['tag', '-a', 'v1.0.0', '-m', 'base'], { cwd: repo.root })
    writeFileSync(join(repo.root, 'a.txt'), 'a')
    execFileSync('git', ['add', '-A'], { cwd: repo.root })
    execFileSync('git', ['commit', '-qm', 'feat(api): add a streaming writer'], { cwd: repo.root })

    const { status, stdout } = release(repo, ['1.1.0', '--notes', 'commits', '--yes'])
    assert.equal(status, 0, stdout)
    const annotation = tagAnnotation(repo, 'v1.1.0')
    assert.match(annotation, /### Features/)
    assert.ok(!annotation.includes('Hand-written note'), 'the changelog did not win')
  })

  it('refuses when the named source cannot produce anything', () => {
    const repo = withChangelog()
    const { status, stdout } = release(repo, ['1.1.0', '--notes', 'assistant', '--yes'])
    assert.equal(status, 1)
    assert.match(stdout, /none is available/)
  })

  it('rejects an unknown source', () => {
    const { status, stdout } = release(withChangelog(), ['1.1.0', '--notes', 'telepathy', '--yes'])
    assert.equal(status, 1)
    assert.match(stdout, /unknown notes source/)
  })
})

describe('which tag a release reads history from', () => {
  const tagOnly = () => makeRepo({ config: { publish: null, steps: ['version', 'tag', 'push'] } })
  const commit = (repo, subject, file = subject.replace(/\W/g, '')) => {
    writeFileSync(join(repo.root, `${file}.txt`), file)
    execFileSync('git', ['add', '-A'], { cwd: repo.root })
    execFileSync('git', ['commit', '-qm', subject], { cwd: repo.root })
  }
  const tag = (repo, name) =>
    execFileSync('git', ['tag', '-a', name, '-m', name], { cwd: repo.root })

  it('ignores a tag that carries no version', () => {
    // A rolling channel marker — tauri-release-kit maintains `latest-beta` and
    // `latest-alpha` — is the nearest tag but not a release. Reading history from it hid
    // every commit since the real last release and aborted the run.
    const repo = tagOnly()
    tag(repo, 'v1.0.0')
    commit(repo, 'feat: add a thing')
    tag(repo, 'latest-beta')

    const { status, stdout } = release(repo, ['auto', '--yes'])
    assert.equal(status, 0, stdout)
    assert.match(stdout, /auto: minor/)
    assert.ok(tagsOnRemote(repo).includes('v1.1.0'), 'released 1.1.0')
  })

  it('takes the highest version, not the nearest tag', () => {
    // `git describe --abbrev=0` answers "nearest ancestor", which is not "latest release":
    // a patch tagged on top of a later minor would drag the baseline backwards. A
    // repository versioned by tag alone reads its current version from exactly this.
    const repo = makeRepo({
      config: { versionFile: null, publish: null, steps: ['tag', 'push'] },
    })
    tag(repo, 'v2.0.0')
    commit(repo, 'fix: something small')
    tag(repo, 'v1.9.9')

    const { status, stdout } = release(repo, ['auto', '--yes'])
    assert.equal(status, 0, stdout)
    assert.match(stdout, /2\.0\.0 → 2\.0\.1/)
  })

  it('rolls the release candidates up into the stable release they led to', () => {
    // Promoting 2.0.0-rc.2 to 2.0.0 read history from rc.2, so the only commit in range
    // was the release chore — which is ignored. The features that *were* 2.0.0 went
    // missing from the tag annotation and the GitHub release.
    const repo = tagOnly()
    tag(repo, 'v1.0.0')
    commit(repo, 'feat: big new dashboard')
    commit(repo, 'feat: export to CSV')
    release(repo, ['2.0.0-rc.1', '--yes'])
    commit(repo, 'fix: rc feedback typo')
    release(repo, ['2.0.0-rc.2', '--yes'])

    const { status, stdout } = release(repo, ['2.0.0', '--yes'])
    assert.equal(status, 0, stdout)
    const annotation = execFileSync('git', ['tag', '-l', 'v2.0.0', '--format=%(contents)'], {
      cwd: repo.root,
      encoding: 'utf8',
    })
    assert.match(annotation, /big new dashboard/, 'the rc.1 feature is in the stable notes')
    assert.match(annotation, /export to CSV/, 'the second feature is in the stable notes')
    assert.match(annotation, /rc feedback typo/, 'the rc.2 fix is in the stable notes')
  })

  it('still scopes a release candidate to what changed since the previous one', () => {
    // Rolling up is only right for the stable release. Each candidate's own notes should
    // say what changed in that candidate, or they all repeat the whole cycle.
    const repo = tagOnly()
    tag(repo, 'v1.0.0')
    commit(repo, 'feat: big new dashboard')
    release(repo, ['2.0.0-rc.1', '--yes'])
    commit(repo, 'fix: rc feedback typo')

    const { status, stdout } = release(repo, ['2.0.0-rc.2', '--yes'])
    assert.equal(status, 0, stdout)
    const annotation = execFileSync('git', ['tag', '-l', 'v2.0.0-rc.2', '--format=%(contents)'], {
      cwd: repo.root,
      encoding: 'utf8',
    })
    assert.match(annotation, /rc feedback typo/)
    assert.ok(!annotation.includes('big new dashboard'), 'rc.1 content is not repeated')
  })
})

describe('pushing the commit and the tag', () => {
  it('sends them as one transaction', () => {
    // --follow-tags decides which refs go; --atomic decides whether they go together.
    // Without the second, a server may take the branch and reject the tag.
    const repo = makeRepo({ config: { publish: null, steps: ['version', 'tag', 'push'] } })
    const { status, stdout } = release(repo, ['minor', '--yes'])
    assert.equal(status, 0, stdout)
    assert.match(stdout, /git push --follow-tags --atomic origin main/)
    assert.deepEqual(tagsOnRemote(repo), ['v1.1.0'])
  })
})

describe('changelog link definitions', () => {
  // The URLs themselves are unit-tested against every forge shape in changelog.test.mjs;
  // a fixture cannot exercise them, because its remote is a local path and
  // `git remote get-url` rewrites any forge URL back to it through insteadOf. What is
  // worth pinning here is that the pass runs on a real release without corrupting a
  // document it cannot derive links for.
  it('leaves the document intact when the remote is not a forge URL', () => {
    const repo = makeRepo({
      changelog:
        '# Changelog\n\n## [Unreleased]\n\n### Added\n\n- A thing.\n\n## [1.0.0]\n\n- First.\n',
      config: { publish: null, steps: ['version', 'changelog', 'tag', 'push'] },
    })
    const { status, stdout } = release(repo, ['minor', '--yes'])
    assert.equal(status, 0, stdout)
    const changelog = readFile(repo, 'CHANGELOG.md')
    assert.match(changelog, /## \[1\.1\.0\] - \d{4}-\d{2}-\d{2}/)
    assert.match(changelog, /## \[1\.0\.0\]/)
    assert.ok(!/^\[[^\]]+\]: /m.test(changelog), 'no definitions invented from a local path')
  })
})

describe('lockfiles that record the project version', () => {
  const lock = (version) =>
    `{\n  "name": "@scope/demo",\n  "version": "${version}",\n  "lockfileVersion": 3,\n` +
    `  "packages": {\n    "": {\n      "name": "@scope/demo",\n      "version": "${version}"\n    }\n  }\n}\n`

  it('refreshes npm-shrinkwrap.json, not only package-lock.json', () => {
    // Both record the root version twice. npm writes whichever the project has.
    const repo = makeRepo({
      files: { 'npm-shrinkwrap.json': lock('1.0.0') },
      config: { publish: null, steps: ['version', 'tag', 'push'] },
    })
    const { status, stdout } = release(repo, ['minor', '--yes'])
    assert.equal(status, 0, stdout)
    assert.ok(
      stubCalls(repo).some((c) => c.startsWith('npm install --package-lock-only')),
      'npm was asked to rewrite the lockfile',
    )
  })

  it('leaves a uv.lock alone when the release is not versioning pyproject.toml', () => {
    // A polyglot repository can hold a lockfile for a component this release does not
    // version; regenerating it would put an unrelated change in the release commit.
    const repo = makeRepo({
      files: { 'uv.lock': 'version = 1\n\n[[package]]\nname = "other"\nversion = "0.1.0"\n' },
      config: { publish: null, steps: ['version', 'tag', 'push'] },
    })
    const { status, stdout } = release(repo, ['minor', '--yes'])
    assert.equal(status, 0, stdout)
    assert.equal(
      readFile(repo, 'uv.lock'),
      'version = 1\n\n[[package]]\nname = "other"\nversion = "0.1.0"\n',
    )
  })
})

describe('a versionFiles glob', () => {
  it('bumps every file it matches', () => {
    // A desktop app carries the same version in a per-platform config for every platform
    // it ships. Writing them out one by one is the config the glob replaces.
    const repo = makeRepo({
      files: {
        'src-tauri/tauri.macos.conf.json': '{\n  "version": "1.0.0"\n}\n',
        'src-tauri/tauri.linux.conf.json': '{\n  "version": "1.0.0"\n}\n',
      },
      config: {
        versionFiles: ['src-tauri/tauri.*.conf.json'],
        publish: null,
        steps: ['version', 'tag', 'push'],
      },
    })
    const { status, stdout } = release(repo, ['minor', '--yes'])
    assert.equal(status, 0, stdout)
    assert.equal(JSON.parse(readFile(repo, 'src-tauri/tauri.macos.conf.json')).version, '1.1.0')
    assert.equal(JSON.parse(readFile(repo, 'src-tauri/tauri.linux.conf.json')).version, '1.1.0')
  })

  it('refuses a pattern that matches nothing rather than skipping it silently', () => {
    const repo = makeRepo({
      config: { versionFiles: ['configs/*.json'], publish: null, steps: ['version'] },
    })
    const { status, stdout } = release(repo, ['minor', '--yes'])
    assert.equal(status, 1)
    assert.match(stdout, /matched no files/)
  })
})

describe('version markers in an arbitrary file', () => {
  it('bumps the marked lines of a README on a real release', () => {
    const repo = makeRepo({
      files: { 'README.md': '# demo\n\n`npm i demo@1.0.0` <!-- x-release-kit-version -->\n' },
      config: { versionFiles: ['README.md'], publish: null, steps: ['version', 'tag', 'push'] },
    })
    const { status, stdout } = release(repo, ['minor', '--yes'])
    assert.equal(status, 0, stdout)
    assert.match(readFile(repo, 'README.md'), /npm i demo@1\.1\.0/)
  })

  it('refuses to shred a file listed by mistake', () => {
    const repo = makeRepo({
      files: { 'README.md': '# demo\n\nA library.\n' },
      config: { versionFiles: ['README.md'], publish: null, steps: ['version'] },
    })
    const { status, stdout } = release(repo, ['minor', '--yes'])
    assert.equal(status, 1)
    assert.match(stdout, /would replace everything/)
    assert.equal(readFile(repo, 'README.md'), '# demo\n\nA library.\n')
  })
})

describe('next', () => {
  const commit = (repo, subject) => {
    writeFileSync(join(repo.root, `${subject.replace(/\W/g, '')}.txt`), 'x')
    execFileSync('git', ['add', '-A'], { cwd: repo.root })
    execFileSync('git', ['commit', '-qm', subject], { cwd: repo.root })
  }

  it('prints the version a target would release, and nothing else', () => {
    // It exists to be substituted into a shell command, so narration goes to stderr.
    const repo = makeRepo()
    const { status, stdout } = release(repo, ['next', 'minor'])
    assert.equal(status, 0, stdout)
    assert.equal(stdout, '1.1.0\n')
  })

  it('resolves auto exactly as the release would', () => {
    const repo = makeRepo()
    execFileSync('git', ['tag', '-a', 'v1.0.0', '-m', 'base'], { cwd: repo.root })
    commit(repo, 'feat: something')
    const { status, stdout } = release(repo, ['next', 'auto'])
    assert.equal(status, 0, stdout)
    assert.equal(stdout, '1.1.0\n')
  })

  it('prints the current version with no target', () => {
    assert.equal(release(makeRepo(), ['next']).stdout, '1.0.0\n')
  })

  it('touches nothing', () => {
    const repo = makeRepo()
    release(repo, ['next', 'major'])
    assert.equal(JSON.parse(readFile(repo, 'package.json')).version, '1.0.0')
    assert.deepEqual(tagsOnRemote(repo), [])
  })
})

describe('lifecycle hooks', () => {
  it('runs each hook at its point in the release', () => {
    const repo = makeRepo({
      config: {
        publish: 'npm publish --tag %d',
        steps: ['version', 'tag', 'push', 'publish'],
        hooks: {
          beforeVersion: 'echo before-version >> hooks.log',
          afterVersion: 'echo after-version >> hooks.log',
          beforePublish: 'echo before-publish >> hooks.log',
          afterPublish: 'echo after-publish %v >> hooks.log',
        },
      },
    })
    const { status, stdout } = release(repo, ['minor', '--yes'])
    assert.equal(status, 0, stdout)
    assert.deepEqual(readFile(repo, 'hooks.log').trim().split('\n'), [
      'before-version',
      'after-version',
      'before-publish',
      // The token is shell-quoted on substitution, so the shell hands the hook one
      // literal argument — a version carrying metacharacters cannot become syntax.
      'after-publish 1.1.0',
    ])
  })

  it('stages what afterVersion regenerated, so it rides in the release commit', () => {
    // The reason the hook is placed there: a file derived from the version is useless if
    // it is left behind in the working tree.
    const repo = makeRepo({
      files: { 'generated.txt': 'stale\n' },
      config: {
        publish: null,
        steps: ['version', 'tag', 'push'],
        hooks: { afterVersion: 'echo %v > generated.txt' },
      },
    })
    const { status, stdout } = release(repo, ['minor', '--yes'])
    assert.equal(status, 0, stdout)
    assert.match(readFile(repo, 'generated.txt'), /1\.1\.0/)
    const dirty = execFileSync('git', ['status', '--porcelain'], {
      cwd: repo.root,
      encoding: 'utf8',
    })
    assert.equal(dirty.trim(), '', 'the regenerated file was committed, not left behind')
  })

  it('aborts the release where a hook failed', () => {
    const repo = makeRepo({
      config: { publish: null, steps: ['version', 'tag'], hooks: { beforeVersion: 'exit 3' } },
    })
    const { status, stdout } = release(repo, ['minor', '--yes'])
    assert.equal(status, 1)
    assert.equal(JSON.parse(readFile(repo, 'package.json')).version, '1.0.0', 'nothing written')
    assert.match(stdout, /exit 3/)
  })

  it('refuses a hook name it does not know', () => {
    const repo = makeRepo({ config: { hooks: { afterEverything: 'true' } } })
    const { status, stdout } = release(repo, ['minor', '--yes'])
    assert.equal(status, 1)
    assert.match(stdout, /unknown hooks: afterEverything/)
  })
})

describe('new contributors', () => {
  it('names the people whose first commit is in this release', () => {
    // git-cliff derives this from the forge API. The repository already knows: an author
    // absent from every commit before the previous tag has not contributed before.
    const repo = makeRepo({ config: { publish: null, steps: ['version', 'tag', 'push'] } })
    execFileSync('git', ['tag', '-a', 'v1.0.0', '-m', 'base'], { cwd: repo.root })
    const by = (name, email, subject) => {
      writeFileSync(join(repo.root, `${email.split('@')[0]}.txt`), 'x')
      execFileSync('git', ['add', '-A'], { cwd: repo.root })
      execFileSync('git', ['commit', '-qm', subject], {
        cwd: repo.root,
        env: { ...process.env, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email },
      })
    }
    by('Ada', '1+ada@users.noreply.github.com', 'feat: something new')
    by('Test', 'test@example.com', 'fix: an existing author')

    const { status, stdout } = release(repo, ['minor', '--yes'])
    assert.equal(status, 0, stdout)
    const annotation = execFileSync('git', ['tag', '-l', 'v1.1.0', '--format=%(contents)'], {
      cwd: repo.root,
      encoding: 'utf8',
    })
    assert.match(annotation, /### New Contributors/)
    assert.match(annotation, /- @ada made their first contribution/, 'handle from the noreply')
    assert.ok(!annotation.includes('Test made their'), 'the existing author is not new')
  })

  it('says nothing on a first release, where everyone would be new', () => {
    const repo = makeRepo({ config: { publish: null, steps: ['version', 'tag', 'push'] } })
    writeFileSync(join(repo.root, 'a.txt'), 'a')
    execFileSync('git', ['add', '-A'], { cwd: repo.root })
    execFileSync('git', ['commit', '-qm', 'feat: first thing'], { cwd: repo.root })
    const { status } = release(repo, ['minor', '--yes'])
    assert.equal(status, 0)
    const annotation = execFileSync('git', ['tag', '-l', 'v1.1.0', '--format=%(contents)'], {
      cwd: repo.root,
      encoding: 'utf8',
    })
    assert.ok(!annotation.includes('New Contributors'))
  })
})

describe('a versionFiles entry with no version in it', () => {
  const overlays = {
    'src-tauri/tauri.conf.json': '{\n  "version": "1.0.0",\n  "productName": "App"\n}\n',
    // A Tauri per-OS overlay holds only the keys it overrides, so it has no version.
    'src-tauri/tauri.macos.conf.json': '{\n  "bundle": {\n    "targets": ["dmg"]\n  }\n}\n',
  }

  it('is skipped when a glob matched it', () => {
    const repo = makeRepo({
      files: overlays,
      config: {
        versionFiles: ['src-tauri/tauri.*conf.json'],
        publish: null,
        steps: ['version', 'tag', 'push'],
      },
    })
    const { status, stdout } = release(repo, ['minor', '--yes'])
    assert.equal(status, 0, stdout)
    assert.equal(JSON.parse(readFile(repo, 'src-tauri/tauri.conf.json')).version, '1.1.0')
    assert.equal(
      readFile(repo, 'src-tauri/tauri.macos.conf.json'),
      overlays['src-tauri/tauri.macos.conf.json'],
    )
  })

  it('fails preflight when it was named on purpose, before anything is written', () => {
    // It used to discover this while writing the others, aborting with a raw stack trace
    // after some files had already changed.
    const repo = makeRepo({
      files: overlays,
      config: {
        versionFiles: ['src-tauri/tauri.conf.json', 'src-tauri/tauri.macos.conf.json'],
        publish: null,
        steps: ['version'],
      },
    })
    const { status, stdout } = release(repo, ['minor', '--yes'])
    assert.equal(status, 1)
    assert.match(stdout, /tauri\.macos\.conf\.json has no version for release-kit to replace/)
    assert.ok(!stdout.includes('at writeVersionInto'), 'a clean abort, not a stack trace')
    assert.equal(
      JSON.parse(readFile(repo, 'src-tauri/tauri.conf.json')).version,
      '1.0.0',
      'nothing was written',
    )
  })
})
