/**
 * End-to-end releases against real repositories with a real bare remote.
 *
 * These are the tests that would have caught the defects found in use: a tag left behind
 * HEAD, a changelog rolled twice, a Python project reaching for npm.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import {
  makeRepo,
  readFile,
  release,
  RELEASE_MJS,
  stubAssistant,
  stubCalls,
  tagsOnRemote,
} from './helpers/repo.mjs'

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

  it('rejects an unknown flag instead of dropping it and releasing a different version', () => {
    const repo = makeRepo()
    const { status, stdout } = release(repo, ['--auto', '--assistant', 'auto', '--yes'])
    assert.equal(status, 1)
    assert.match(stdout, /unknown flag: --auto/)
    assert.match(stdout, /target is positional: .* auto, not --auto/)

    const bogus = release(repo, ['minor', '--bogus', '--yes'])
    assert.equal(bogus.status, 1)
    assert.match(bogus.stdout, /unknown flag: --bogus/)
    assert.doesNotMatch(bogus.stdout, /positional/)
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

  it('still refuses a dirty tree when the commit step is skipped, with no config hint', () => {
    const repo = makeRepo()
    writeFileSync(join(repo.root, 'junk.txt'), 'x')
    const { status, stdout } = release(repo, ['minor', '--yes', '--skip', 'commit'])
    assert.equal(status, 1)
    assert.match(stdout, /working tree is not clean/)
    assert.doesNotMatch(stdout, /steps list in release\.config\.json/)
  })

  it('hints at --commit when a config steps list is what excludes the commit step', () => {
    const repo = makeRepo()
    writeFileSync(
      join(repo.root, 'release.config.json'),
      JSON.stringify({ steps: ['version', 'changelog', 'tag', 'push'] }),
    )
    execFileSync('git', ['add', '--all'], { cwd: repo.root })
    execFileSync('git', ['commit', '-qm', 'chore: add config'], { cwd: repo.root })
    writeFileSync(join(repo.root, 'junk.txt'), 'x')
    const { status, stdout } = release(repo, ['minor', '--yes'])
    assert.equal(status, 1)
    assert.match(stdout, /working tree is not clean/)
    assert.match(stdout, /steps list in release\.config\.json omits `commit`/)
    assert.match(stdout, /--commit/)
  })

  it('--commit overrides a config steps list that omits the commit step', () => {
    const repo = makeRepo()
    writeFileSync(
      join(repo.root, 'release.config.json'),
      JSON.stringify({ steps: ['version', 'changelog', 'tag', 'push', 'publish', 'release'] }),
    )
    execFileSync('git', ['add', '--all'], { cwd: repo.root })
    execFileSync('git', ['commit', '-qm', 'chore: add config'], { cwd: repo.root })
    writeFileSync(join(repo.root, 'junk.txt'), 'x')
    const { status, stdout } = release(repo, ['minor', '--yes', '--commit'])
    assert.equal(status, 0, stdout)
    assert.match(stdout, /will be committed first/)
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

  it('passes a gate that prints more than a megabyte', () => {
    // A test suite or a build can print a lot. Past Node's default 1 MiB output buffer the
    // capture threw, and a passing gate was reported as "verify failed".
    const repo = makeRepo({
      config: {
        publish: null,
        steps: ['version', 'tag', 'push'],
        verify: 'node -e "process.stdout.write(\'x\'.repeat(2 * 1024 * 1024))"',
      },
    })
    const { status, stdout } = release(repo, ['minor', '--yes'])
    assert.equal(status, 0, stdout.slice(-2000))
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

  it('does not count a changelog roll the changelog step will not make', () => {
    // The roll is computed whenever [Unreleased] is populated, since the notes come from
    // it either way; it only becomes a commit when the step runs. Counting it regardless
    // refused a resume that was asked for with exactly the steps that remained.
    const repo = makeRepo({ changelog: CHANGELOG })
    execFileSync('git', ['tag', '-a', 'v1.0.0', '-m', 'existing'], { cwd: repo.root })
    const { status, stdout } = release(repo, ['--only', 'tag,push,release', '--yes'])
    assert.equal(status, 0, stdout)
    assert.match(stdout, /already exists at HEAD — will reuse it/)
    assert.deepEqual(tagsOnRemote(repo), ['v1.0.0'])
  })

  it('refuses a bump target when the version step would not write it', () => {
    // The tag would say 1.1.0 while package.json — what `npm publish` sends — says 1.0.0.
    // There is no release in which those two are allowed to differ.
    const repo = makeRepo({ changelog: CHANGELOG })
    const { status, stdout } = release(repo, ['minor', '--yes', '--skip', 'version'])
    assert.equal(status, 1)
    assert.match(stdout, /version step is not selected, but 1\.1\.0 is not the version/)
    assert.equal(JSON.parse(readFile(repo, 'package.json')).version, '1.0.0')
    assert.deepEqual(tagsOnRemote(repo), [])
    assert.ok(!stubCalls(repo).some((c) => c.startsWith('npm publish')), 'nothing published')
  })

  it('still releases the version already in the manifest with the version step off', () => {
    const repo = makeRepo({ changelog: CHANGELOG })
    const { status, stdout } = release(repo, ['--only', 'tag,push', '--yes'])
    assert.equal(status, 0, stdout)
    assert.match(stdout, /releasing the version already in package\.json \(1\.0\.0\)/)
    assert.deepEqual(tagsOnRemote(repo), ['v1.0.0'])
  })

  it('refuses a bump that would count from a version a dead run wrote but never committed', () => {
    // A run that wrote the version and died before its release commit — here an
    // afterVersion hook — leaves the bump on disk. The current version then reads from that
    // file, and `minor` re-run "the same way" released 1.2.0, with 1.1.0 tagged nowhere and
    // its changelog section documenting a version that never existed.
    const repo = makeRepo({
      changelog: CHANGELOG,
      config: { publish: null, steps: ['version', 'changelog', 'tag', 'push'] },
    })
    writeFileSync(
      join(repo.root, 'release.config.json'),
      JSON.stringify({
        ...JSON.parse(readFile(repo, 'release.config.json')),
        hooks: { afterVersion: 'exit 7' },
      }),
    )
    execFileSync('git', ['add', '--all'], { cwd: repo.root })
    execFileSync('git', ['commit', '-qm', 'chore: add a failing hook'], { cwd: repo.root })
    const dead = release(repo, ['minor', '--yes'])
    assert.equal(dead.status, 1, 'the hook was supposed to kill the run')
    assert.equal(
      JSON.parse(readFile(repo, 'package.json')).version,
      '1.1.0',
      'written, not committed',
    )

    // The user fixes the cause (drops the hook) and re-runs the same command.
    writeFileSync(
      join(repo.root, 'release.config.json'),
      JSON.stringify({ publish: null, steps: ['version', 'changelog', 'tag', 'push'] }),
    )
    const { status, stdout } = release(repo, ['minor', '--yes'])
    assert.equal(status, 1)
    assert.match(stdout, /package\.json says 1\.1\.0 on disk but 1\.0\.0 at HEAD/)
    assert.match(stdout, /1\.1\.0`/, 'names the command that finishes it')
    assert.deepEqual(tagsOnRemote(repo), [], 'nothing released')

    // Finishing it with the version on disk is what the message asks for.
    const finished = release(repo, ['1.1.0', '--yes', '--commit'])
    assert.equal(finished.status, 0, finished.stdout)
    assert.deepEqual(tagsOnRemote(repo), ['v1.1.0'])
  })

  it('lets a bump proceed over an unrelated uncommitted manifest edit', () => {
    // Only the version field matters: a script added to package.json is ordinary dirty
    // work for the commit step, not a half-finished release.
    const repo = makeRepo({ changelog: CHANGELOG })
    const manifest = JSON.parse(readFile(repo, 'package.json'))
    manifest.scripts = { test: 'node --test' }
    writeFileSync(join(repo.root, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    const { status, stdout } = release(repo, ['minor', '--yes'])
    assert.equal(status, 0, stdout)
    assert.deepEqual(tagsOnRemote(repo), ['v1.1.0'])
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

/** A GitHub Actions job with `id-token: write`: npm publishes over OIDC with no token. */
const OIDC = {
  GITHUB_ACTIONS: 'true',
  ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token.test',
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'request',
}

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

  it('still requires a cargo token under trusted publishing, which only npm carries', () => {
    // A CI job with id-token: write mints an OIDC token that npm exchanges itself. cargo
    // does not: crates.io's trusted publishing goes through an action that turns it into
    // CARGO_REGISTRY_TOKEN, so without one `cargo publish` fails after the tag and push.
    const repo = makeRepo(plugin())
    const { status, stdout } = release(repo, ['minor', '--yes'], {
      GITHUB_ACTIONS: 'true',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token.test',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'request',
      CARGO_REGISTRY_TOKEN: '',
      CARGO_REGISTRIES_CRATES_IO_TOKEN: '',
      HOME: repo.root,
    })
    assert.equal(status, 1)
    assert.match(stdout, /npm: trusted publishing \(OIDC\)/)
    assert.match(stdout, /cargo has no publish credentials/)
    assert.deepEqual(tagsOnRemote(repo), [], 'nothing mutated')
  })

  it('packages the crate before tagging, as publishing would', () => {
    const repo = makeRepo(plugin())
    const { status, stdout } = release(repo, ['minor', '--yes'], {
      CARGO_REGISTRY_TOKEN: 'test-token',
    })
    assert.equal(status, 0, stdout)
    assert.match(stdout, /ok {3}cargo package: demo-1\.0\.0\.crate \(0\.0 MiB\)/)
    const calls = stubCalls(repo)
    assert.ok(calls.includes('cargo package --locked'), calls.join(' | '))
    assert.ok(
      calls.indexOf('cargo package --locked') < calls.indexOf('cargo publish'),
      'packaged in preflight, long before the publish',
    )
  })

  it('refuses a crate over the crates.io upload limit before anything is tagged', () => {
    // crates.io rejects it at upload — which used to be after the tag and the push.
    const repo = makeRepo(plugin())
    const { status, stdout } = release(repo, ['minor', '--yes'], {
      CARGO_REGISTRY_TOKEN: 'test-token',
      CARGO_CRATE_BYTES: String(10 * 1024 * 1024 + 1),
    })
    assert.equal(status, 1, stdout)
    assert.match(stdout, /demo-1\.0\.0\.crate is 10\.0 MiB, over crates\.io's 10 MiB upload limit/)
    assert.deepEqual(tagsOnRemote(repo), [])
    assert.ok(!stubCalls(repo).some((c) => / publish/.test(c)), 'nothing was published')
  })

  it("refuses a crate that does not package, with cargo's own error", () => {
    const repo = makeRepo(plugin())
    const { status, stdout } = release(repo, ['minor', '--yes'], {
      CARGO_REGISTRY_TOKEN: 'test-token',
      CARGO_PACKAGE_FAILS: '1',
    })
    assert.equal(status, 1, stdout)
    assert.match(stdout, /`cargo package --locked` failed — `cargo publish` would too/)
    assert.match(stdout, /failed to verify package tarball/)
    assert.deepEqual(tagsOnRemote(repo), [])
  })

  it('is not undone by a verify build that prints a lot', () => {
    // Every "Compiling …" line of a real crate's build goes to stderr. Past Node's default
    // 1 MiB output buffer that threw, and read as "cargo package failed".
    const repo = makeRepo(plugin())
    const { status, stdout } = release(repo, ['minor', '--yes'], {
      CARGO_REGISTRY_TOKEN: 'test-token',
      CARGO_PACKAGE_NOISE: String(2 * 1024 * 1024),
    })
    assert.equal(status, 0, stdout.slice(-2000))
  })

  it('does not package a crate that is already published', () => {
    const repo = makeRepo(plugin())
    release(repo, ['minor', '--yes'], { CARGO_REGISTRY_TOKEN: 'test-token', CARGO_PUBLISHED: '0' })
    assert.ok(!stubCalls(repo).some((c) => c.startsWith('cargo package')))
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

  it('keeps Cargo.lock in step when Cargo.toml is the version source', () => {
    // A plain crate: no package.json, so Cargo.toml is the primary version file rather than
    // a companion. The lockfile was only ever added for the companion case, so it stayed at
    // the old version and `cargo publish` refused the now-dirty tree — after the push.
    const lock = (v) =>
      '[[package]]\nname = "adler2"\nversion = "2.0.1"\n\n' +
      `[[package]]\nname = "demo-crate"\nversion = "${v}"\n`
    const repo = makeRepo({
      manifest: false,
      files: {
        'Cargo.toml': '[package]\nname = "demo-crate"\nversion = "1.0.0"\n',
        'Cargo.lock': lock('1.0.0'),
      },
    })
    const { status, stdout } = release(repo, ['minor', '--yes', '--skip', 'release'], {
      CARGO_REGISTRY_TOKEN: 'test-token',
    })
    assert.equal(status, 0, stdout)
    assert.match(stdout, /also versioned in Cargo\.lock \(detected\)/)
    assert.equal(readFile(repo, 'Cargo.lock'), lock('1.1.0'))
    const dirty = execFileSync('git', ['status', '--porcelain'], {
      cwd: repo.root,
      encoding: 'utf8',
    })
    assert.equal(dirty, '', 'the lockfile rode in the release commit')
  })

  it('refuses a cargo publish whose Cargo.lock the configured files leave stale', () => {
    // Configured files are the whole answer and are not extended — so a crate published
    // with its lockfile left out would fail at `cargo publish` on a dirty tree, after the
    // push. That is caught before anything mutates instead.
    const repo = makeRepo({
      manifest: false,
      config: { versionFile: 'Cargo.toml', steps: ['version', 'tag', 'push', 'publish'] },
      files: {
        'Cargo.toml': '[package]\nname = "demo-crate"\nversion = "1.0.0"\n',
        'Cargo.lock': '[[package]]\nname = "demo-crate"\nversion = "1.0.0"\n',
      },
    })
    const { status, stdout } = release(repo, ['minor', '--yes'], {
      CARGO_REGISTRY_TOKEN: 'test-token',
    })
    assert.equal(status, 1, stdout)
    assert.match(stdout, /Cargo\.lock records demo-crate 1\.0\.0/)
    assert.match(stdout, /Add "Cargo\.lock" to versionFiles/)
    assert.deepEqual(tagsOnRemote(repo), [])
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

describe('trusted publishing', () => {
  it('refuses trusted publishing with an npm too old to do it', () => {
    // npm below 11.5.1 finds no token under OIDC and fails the publish — after the push.
    const repo = makeRepo({ config: { steps: ['version', 'tag', 'push', 'publish'] } })
    const { status, stdout } = release(repo, ['minor', '--yes'], {
      ...OIDC,
      NPM_VERSION: '10.9.2',
    })
    assert.equal(status, 1, stdout)
    assert.match(
      stdout,
      /npm 10\.9\.2 cannot publish with trusted publishing, which needs npm 11\.5\.1/,
    )
    assert.match(stdout, /npm install -g npm@latest/)
    assert.deepEqual(tagsOnRemote(repo), [])
  })

  it('accepts the minimum npm for trusted publishing, and warns on an unreadable one', () => {
    const repo = makeRepo({ config: { steps: ['version', 'tag', 'push', 'publish'] } })
    const exact = release(repo, ['minor', '--yes', '--dry-run'], { ...OIDC, NPM_VERSION: '11.5.1' })
    assert.ok(!/cannot publish with trusted publishing/.test(exact.stdout), exact.stdout)
    const unknown = release(repo, ['minor', '--yes', '--dry-run'], { ...OIDC, NPM_VERSION: '' })
    assert.match(unknown.stdout, /npm: could not read its version/)
    assert.ok(!/fail /.test(unknown.stdout), unknown.stdout)
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
      config: { publish: null, steps: ['version', 'tag'], notesFile: 'n.md' },
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

describe('requireGreen', () => {
  const green = () =>
    makeRepo({ config: { publish: null, steps: ['version', 'tag', 'push'], requireGreen: true } })
  const run = (name, status, conclusion = '', url = '') =>
    `${name}\t${status}\t${conclusion}\t${url}\n`

  it('releases a pushed HEAD whose checks all passed', () => {
    const repo = green()
    const { status, stdout } = release(repo, ['minor', '--yes'], {
      GH_CHECK_RUNS: run('test', 'completed', 'success') + run('lint', 'completed', 'skipped'),
      GH_STATUSES: 'buildkite\tsuccess\n',
    })
    assert.equal(status, 0, stdout)
    assert.match(stdout, /HEAD \([0-9a-f]{8}\) is green \(2 checks passed\)/)
    assert.ok(tagsOnRemote(repo).includes('v1.1.0'))
    assert.ok(
      stubCalls(repo).some((c) =>
        /gh api --paginate repos\/\{owner\}\/\{repo\}\/commits\/[0-9a-f]{40}\/check-runs/.test(c),
      ),
      'paginates the check runs of the exact commit',
    )
  })

  it('refuses a failed check run and names it, before anything mutates', () => {
    const repo = green()
    const { status, stdout } = release(repo, ['minor', '--yes'], {
      GH_CHECK_RUNS: run('test', 'completed', 'success') + run('e2e', 'completed', 'failure'),
    })
    assert.equal(status, 1, stdout)
    assert.match(stdout, /is not green — e2e \(failure\)/)
    assert.deepEqual(tagsOnRemote(repo), [])
    assert.equal(JSON.parse(readFile(repo, 'package.json')).version, '1.0.0')
  })

  it('refuses a failed commit status from outside Actions', () => {
    const repo = green()
    const { status, stdout } = release(repo, ['minor', '--yes'], {
      GH_CHECK_RUNS: run('test', 'completed', 'success'),
      GH_STATUSES: 'jenkins\terror\n',
    })
    assert.equal(status, 1, stdout)
    assert.match(stdout, /jenkins \(error\)/)
  })

  it('says to wait while checks are still running', () => {
    const repo = green()
    const { status, stdout } = release(repo, ['minor', '--yes'], {
      GH_CHECK_RUNS: run('test', 'in_progress') + run('lint', 'completed', 'success'),
    })
    assert.equal(status, 1, stdout)
    assert.match(stdout, /have not finished — test \(in_progress\)/)
    assert.match(stdout, /Wait for them to complete/)
  })

  it('refuses a commit nothing has checked', () => {
    // Zero checks is not green: it is a commit no CI has looked at.
    const repo = green()
    const { status, stdout } = release(repo, ['minor', '--yes'], {
      GH_CHECK_RUNS: run('lint', 'completed', 'skipped'),
    })
    assert.equal(status, 1, stdout)
    assert.match(stdout, /no check has passed/)
  })

  it('refuses a HEAD that is not on the remote yet', () => {
    const repo = green()
    writeFileSync(join(repo.root, 'x.txt'), 'x')
    execFileSync('git', ['add', '-A'], { cwd: repo.root })
    execFileSync('git', ['commit', '-qm', 'fix: local only'], { cwd: repo.root })
    const { status, stdout } = release(repo, ['minor', '--yes'], {
      GH_CHECK_RUNS: run('test', 'completed', 'success'),
    })
    assert.equal(status, 1, stdout)
    assert.match(stdout, /HEAD is 1 commit\(s\) ahead of origin\/main, so CI has not seen it/)
  })

  it('refuses a working tree the commit step would release unchecked', () => {
    const repo = green()
    writeFileSync(join(repo.root, 'x.txt'), 'x')
    const { status, stdout } = release(repo, ['minor', '--commit', '--yes'], {
      GH_CHECK_RUNS: run('test', 'completed', 'success'),
    })
    assert.equal(status, 1, stdout)
    assert.match(stdout, /working tree would be committed and released without CI/)
  })

  it('does not wait for the workflow run it is running in', () => {
    // Released from a workflow on the commit it checks, its own job is an unfinished check
    // run on that commit. Waiting for it would wait forever.
    const repo = green()
    const { status, stdout } = release(repo, ['minor', '--yes'], {
      GITHUB_ACTIONS: 'true',
      GITHUB_RUN_ID: '4242',
      GH_CHECK_RUNS:
        run('release', 'in_progress', '', 'https://github.com/o/r/actions/runs/4242/job/1') +
        run('test', 'completed', 'success', 'https://github.com/o/r/actions/runs/4100/job/7'),
    })
    assert.equal(status, 0, stdout)
    assert.match(stdout, /is green \(1 check passed\)/)
  })

  it('refuses when GitHub cannot be asked', () => {
    const repo = green()
    const { status, stdout } = release(repo, ['minor', '--yes'], { GH_API_FAILS: '1' })
    assert.equal(status, 1, stdout)
    assert.match(stdout, /could not read the checks/)
  })

  it('is off by default', () => {
    const repo = makeRepo({ config: { publish: null, steps: ['version', 'tag', 'push'] } })
    const { status, stdout } = release(repo, ['minor', '--yes'])
    assert.equal(status, 0, stdout)
    assert.ok(!stubCalls(repo).some((c) => c.includes('check-runs')))
  })
})

describe('drafted release notes', () => {
  const drafting = () => {
    const repo = makeRepo({ config: { publish: null, steps: ['version', 'tag'] } })
    execFileSync('git', ['tag', '-a', 'v1.0.0', '-m', 'base'], { cwd: repo.root })
    const commit = (subject, body) => {
      writeFileSync(join(repo.root, `${subject.replace(/\W/g, '')}.txt`), subject)
      execFileSync('git', ['add', '-A'], { cwd: repo.root })
      execFileSync('git', ['commit', '-qm', subject, ...(body ? ['-m', body] : [])], {
        cwd: repo.root,
      })
    }
    return { repo, commit, prompt: stubAssistant(repo) }
  }

  it("hands the model the author's Notes: wording and leaves no-notes commits out", () => {
    const { repo, commit, prompt } = drafting()
    commit('fix(ui): raise the badge z-index', 'Notes: The pull request badge stays on top')
    commit('refactor: move the parser', 'Notes: no-notes')

    const { status, stdout } = release(repo, ['1.1.0', '--assistant', 'claude', '--yes'], {
      CLAUDE_DRAFT: '### Fixed\n\n- The pull request badge stays on top',
    })
    assert.equal(status, 0, stdout)
    const sent = readFileSync(prompt, 'utf8')
    assert.match(sent, /raise the badge z-index\n {2}Notes: The pull request badge stays on top/)
    assert.ok(!sent.includes('move the parser'), 'the no-notes commit never reaches the model')
  })

  it('keeps shipped components and asks for fixes as what works now', () => {
    // Dropping every dependency bump hid the updates users actually run: a bundled
    // runtime or an embedded engine is the product, whatever the commit type says.
    const { repo, commit, prompt } = drafting()
    commit('fix: keep the cursor in place after a paste')

    const { status, stdout } = release(repo, ['1.1.0', '--assistant', 'claude', '--yes'], {
      CLAUDE_DRAFT: '### Fixed\n\n- The cursor stays in place after a paste',
    })
    assert.equal(status, 0, stdout)
    const sent = readFileSync(prompt, 'utf8')
    assert.match(sent, /except a component that ships inside the product/)
    assert.match(sent, /describe what works now, not what was broken/)
  })
})

describe('drafted entries the assistant marked [???]', () => {
  const FLAGGED = '### Fixed\n\n- [???] Tweaks the retry loop\n- The cursor stays put'
  const setup = () => {
    const config = { publish: null, steps: ['version', 'changelog', 'tag', 'push'] }
    const repo = makeRepo({ config, changelog: '# Changelog\n\n## [Unreleased]\n' })
    execFileSync('git', ['tag', '-a', 'v1.0.0', '-m', 'base'], { cwd: repo.root })
    writeFileSync(join(repo.root, 'retry.txt'), 'x')
    execFileSync('git', ['add', '-A'], { cwd: repo.root })
    execFileSync('git', ['commit', '-qm', 'fix: retry loop'], { cwd: repo.root })
    execFileSync('git', ['push', '-q', 'origin', 'main', '--tags'], { cwd: repo.root })
    return { repo, prompt: stubAssistant(repo) }
  }

  it('asks the model to flag what it is unsure of', () => {
    const { repo, prompt } = setup()
    release(repo, ['1.0.1', '--assistant', 'claude', '--yes'], {
      CLAUDE_DRAFT: '### Fixed\n\n- The retry loop gives up after five tries',
    })
    assert.match(readFileSync(prompt, 'utf8'), /start that bullet with \[\?\?\?\]/)
  })

  it('refuses under --yes before anything mutates, and names the entry', () => {
    // Nobody is at a prompt to review it, and a guess published as fact is what the marker
    // exists to prevent — the same "validated, not trusted" rule as an invented hash.
    const { repo } = setup()
    const { status, stdout } = release(repo, ['1.0.1', '--assistant', 'claude', '--yes'], {
      CLAUDE_DRAFT: FLAGGED,
    })
    assert.equal(status, 1, stdout)
    assert.match(stdout, /marked 1 drafted entry \[\?\?\?\]/)
    assert.match(stdout, /- \[\?\?\?\] Tweaks the retry loop/)
    assert.match(stdout, /Re-run without --yes in a terminal/)
    assert.ok(!/ok +release notes drafted/.test(stdout), 'no "ok" for notes it just refused')
    assert.deepEqual(tagsOnRemote(repo), ['v1.0.0'], 'nothing was tagged')
    assert.equal(JSON.parse(readFile(repo, 'package.json')).version, '1.0.0')
  })

  it('lets a draft with nothing flagged through', () => {
    const { repo } = setup()
    const { status, stdout } = release(repo, ['1.0.1', '--assistant', 'claude', '--yes'], {
      CLAUDE_DRAFT: '### Fixed\n\n- The retry loop gives up after five tries',
    })
    assert.equal(status, 0, stdout)
    assert.match(readFile(repo, 'CHANGELOG.md'), /gives up after five tries/)
    assert.match(
      readFile(repo, 'CHANGELOG.md'),
      /## \[Unreleased\]\n\n## \[1\.0\.1\]/,
      'the draft is filed below the empty [Unreleased]',
    )
  })

  it('stops after the working-tree commit when the notes were drafted after the prompt', () => {
    // With a dirty tree the notes wait for the commit, which comes after the prompt. The
    // commit stays; nothing past it happens, and the re-run drafts during preflight.
    const { repo } = setup()
    writeFileSync(join(repo.root, 'more.txt'), 'y')
    const args = ['1.0.1', '--commit', '--assistant', 'claude', '--yes']
    const { status, stdout } = release(repo, args, {
      CLAUDE_DRAFT: FLAGGED,
    })
    assert.equal(status, 1, stdout)
    assert.match(stdout, /The working tree is committed; nothing else has changed/)
    const log = execFileSync('git', ['log', '--format=%s', '-2'], {
      cwd: repo.root,
      encoding: 'utf8',
    })
    assert.match(log, /^chore: update more\.txt\n/, 'the working tree was committed')
    assert.deepEqual(tagsOnRemote(repo), ['v1.0.0'], 'nothing was tagged')
    assert.equal(JSON.parse(readFile(repo, 'package.json')).version, '1.0.0')
  })

  it('is left to hand-written notes', () => {
    // The marker is the assistant's. A changelog someone wrote is theirs to word.
    const { repo } = setup()
    writeFileSync(
      join(repo.root, 'CHANGELOG.md'),
      '# Changelog\n\n## [Unreleased]\n\n- [???] Ask Sam\n',
    )
    execFileSync('git', ['commit', '-qam', 'docs: notes'], { cwd: repo.root })
    const { status, stdout } = release(repo, ['1.0.1', '--assistant', 'claude', '--yes'], {
      CLAUDE_DRAFT: FLAGGED,
    })
    assert.equal(status, 0, stdout)
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

  it('generates the stable notes from commits, not from edited candidate sections', () => {
    // Pinned behaviour: a stable release has no section of its own, so its notes come from
    // every commit since the last stable tag. Wording edited into a candidate's section is
    // not carried over — the sections stay in the file, and the release says so.
    const repo = makeRepo({
      config: { publish: null, steps: ['version', 'changelog', 'tag', 'push'] },
      changelog: '# Changelog\n\n## [Unreleased]\n',
    })
    tag(repo, 'v1.0.0')
    commit(repo, 'feat: big new dashboard')
    release(repo, ['2.0.0-rc.1', '--yes'])
    const edited = readFile(repo, 'CHANGELOG.md').replace(
      /(## \[2\.0\.0-rc\.1\][^\n]*\n)/,
      '$1\nHand-edited: the dashboard replaces the old overview page.\n',
    )
    writeFileSync(join(repo.root, 'CHANGELOG.md'), edited)
    execFileSync('git', ['commit', '-qam', 'docs: reword the rc notes'], { cwd: repo.root })

    const { status, stdout } = release(repo, ['2.0.0', '--yes'])
    assert.equal(status, 0, stdout)
    assert.match(stdout, /CHANGELOG\.md has sections for 2\.0\.0-rc\.1, but 2\.0\.0 has none/)
    const annotation = execFileSync('git', ['tag', '-l', 'v2.0.0', '--format=%(contents)'], {
      cwd: repo.root,
      encoding: 'utf8',
    })
    assert.match(annotation, /big new dashboard/, 'generated from the commits')
    assert.ok(!annotation.includes('Hand-edited'), 'the candidate wording is not carried over')
    const changelog = readFile(repo, 'CHANGELOG.md')
    assert.match(changelog, /## \[2\.0\.0\][\s\S]*## \[2\.0\.0-rc\.1\][\s\S]*Hand-edited/)
  })

  it('uses [Unreleased] for the stable notes when it was written, and stays quiet', () => {
    const repo = makeRepo({
      config: { publish: null, steps: ['version', 'changelog', 'tag', 'push'] },
      changelog: '# Changelog\n\n## [Unreleased]\n',
    })
    tag(repo, 'v1.0.0')
    commit(repo, 'feat: big new dashboard')
    release(repo, ['2.0.0-rc.1', '--yes'])
    const withNotes = readFile(repo, 'CHANGELOG.md').replace(
      '## [Unreleased]\n',
      '## [Unreleased]\n\n- The dashboard replaces the overview page.\n',
    )
    writeFileSync(join(repo.root, 'CHANGELOG.md'), withNotes)
    execFileSync('git', ['commit', '-qam', 'docs: write the 2.0.0 notes'], { cwd: repo.root })

    const { status, stdout } = release(repo, ['2.0.0', '--yes'])
    assert.equal(status, 0, stdout)
    assert.ok(!stdout.includes('has sections for'), stdout)
    const annotation = execFileSync('git', ['tag', '-l', 'v2.0.0', '--format=%(contents)'], {
      cwd: repo.root,
      encoding: 'utf8',
    })
    assert.match(annotation, /replaces the overview page/)
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

describe('a release that was tagged but never published', () => {
  // The whole scenario, as it happened: `npm publish` failed on a prepublish gate after the
  // tag had already been made and pushed. The tag says 2.0.1 shipped. No registry has it,
  // and the ten commits it was made of were then invisible to every release that followed.
  const commit = (repo, subject) => {
    writeFileSync(join(repo.root, `${subject.replace(/\W/g, '')}.txt`), subject)
    execFileSync('git', ['add', '-A'], { cwd: repo.root })
    execFileSync('git', ['commit', '-qm', subject], { cwd: repo.root })
  }
  const tag = (repo, name) =>
    execFileSync('git', ['tag', '-a', name, '-m', name], { cwd: repo.root })

  /** A repository whose 1.1.0 release died at the publish step. */
  const halfReleased = () => {
    const repo = makeRepo({ changelog: CHANGELOG })
    tag(repo, 'v1.0.0')
    commit(repo, 'feat: the big feature')
    const failed = release(repo, ['minor', '--yes'], { NPM_PUBLISH_FAILS: '1' })
    assert.notEqual(failed.status, 0, 'the publish was supposed to fail')
    assert.ok(tagsOnRemote(repo).includes('v1.1.0'), 'the tag was pushed before the publish')
    return repo
  }

  // The registry's contents afterwards: 1.0.0 is on it, 1.1.0 never made it.
  const REGISTRY = { NPM_PUBLISHED_VERSIONS: '1.0.0', NPM_REACHABLE: '0' }

  it('finishes it on the next auto run instead of reporting nothing to release', () => {
    // `auto` resolves the version from the commits since the last tag, found none, and
    // aborted with "no releasable commits" — while the publish it never got to was the
    // only thing left to do. Re-running the same command is how this is documented to
    // recover, and `auto` was the one target that could not.
    const repo = halfReleased()
    const { status, stdout } = release(repo, ['auto', '--yes'], REGISTRY)
    assert.equal(status, 0, stdout)
    assert.match(stdout, /finishing v1\.1\.0/)
    assert.deepEqual(tagsOnRemote(repo).sort(), ['v1.0.0', 'v1.1.0'])
    assert.ok(
      stubCalls(repo).some((c) => c.startsWith('npm publish')),
      'published on the second run',
    )
  })

  it('carries its commits into the version that does ship them', () => {
    // The defect this file exists for: 1.2.0's notes described one commit, and the feature
    // that was 1.1.0 is named in no release anyone can install. It also decides the bump —
    // a feature shipping for the first time is not a patch.
    const repo = halfReleased()
    commit(repo, 'fix: a small thing')

    const { status, stdout } = release(repo, ['auto', '--yes'], REGISTRY)
    assert.equal(status, 0, stdout)
    assert.match(stdout, /auto: minor/, 'the absorbed feature decides the bump')
    assert.match(stdout, /v1\.1\.0 was tagged but never published/)
    const annotation = execFileSync('git', ['tag', '-l', 'v1.2.0', '--format=%(contents)'], {
      cwd: repo.root,
      encoding: 'utf8',
    })
    assert.match(annotation, /the big feature/, "the unpublished release's work is in the notes")
    assert.match(annotation, /a small thing/)
  })

  it('says which changelog section now documents a version no registry carries', () => {
    const repo = halfReleased()
    commit(repo, 'fix: a small thing')
    const { stdout } = release(repo, ['auto', '--yes'], REGISTRY)
    assert.match(stdout, /CHANGELOG\.md still documents 1\.1\.0/)
  })

  it('reads history exactly as before when the registry cannot answer', () => {
    // `npm view` exits non-zero both for a version that is not there and for a registry
    // that will not talk — offline, behind a proxy, session expired. Treating silence as
    // "never published" would drag the baseline back through the whole history, so a
    // registry that does not answer changes nothing at all.
    const repo = halfReleased()
    commit(repo, 'fix: a small thing')

    const { status, stdout } = release(repo, ['auto', '--yes'], { NPM_REACHABLE: '1' })
    assert.equal(status, 0, stdout)
    assert.match(stdout, /auto: patch/)
    assert.ok(!stdout.includes('never published'), 'nothing was concluded from the silence')
    assert.ok(tagsOnRemote(repo).includes('v1.1.1'), 'released 1.1.1')
  })

  it('walks back over a run of them, not just the last one', () => {
    // What actually happened: four consecutive versions were tagged and none of them
    // published, so npm went 2.0.0 → 2.0.5 and the releases page had one entry describing
    // one commit. The baseline has to walk back to the last version that shipped, however
    // many failed above it.
    const repo = halfReleased()
    commit(repo, 'fix: the second thing')
    const second = release(repo, ['auto', '--yes'], { ...REGISTRY, NPM_PUBLISH_FAILS: '1' })
    assert.notEqual(second.status, 0, 'the second publish was supposed to fail too')
    assert.ok(tagsOnRemote(repo).includes('v1.2.0'), 'and it tagged before failing')
    commit(repo, 'fix: the third thing')

    const { status, stdout } = release(repo, ['auto', '--yes'], REGISTRY)
    assert.equal(status, 0, stdout)
    assert.match(stdout, /v1\.2\.0, v1\.1\.0 were tagged but never published/)
    const annotation = execFileSync('git', ['tag', '-l', 'v1.3.0', '--format=%(contents)'], {
      cwd: repo.root,
      encoding: 'utf8',
    })
    for (const subject of ['the big feature', 'the second thing', 'the third thing']) {
      assert.match(annotation, new RegExp(subject), `${subject} is in the notes`)
    }
  })

  it('refuses a named bump that would skip past it', () => {
    // `auto` finishes the release it finds at HEAD; `minor` counted from its version and
    // released 1.2.0 from the same commit — two tags, one of them permanently unpublished,
    // and the registry receiving a version the v1.1.0 tag had already claimed.
    const repo = halfReleased()
    const { status, stdout } = release(repo, ['minor', '--yes'], REGISTRY)
    assert.equal(status, 1)
    assert.match(stdout, /v1\.1\.0 is tagged at HEAD but never reached the registry/)
    assert.match(stdout, /re-run with no target, or with auto/)
    assert.ok(!stdout.includes('ships its commits'), 'no contradictory absorb warning')
    assert.deepEqual(tagsOnRemote(repo).sort(), ['v1.0.0', 'v1.1.0'], 'no v1.2.0')
    assert.equal(
      stubCalls(repo).filter((c) => c.startsWith('npm publish')).length,
      1,
      'only the dead run published',
    )
  })

  it('lets a named bump absorb it once there is new work to commit', () => {
    // With something new on disk the tag can no longer be finished — publishing would ship
    // a tree it does not describe — so the bump is the documented absorb path.
    const repo = halfReleased()
    writeFileSync(join(repo.root, 'stray.txt'), 'more work')
    const { status, stdout } = release(repo, ['minor', '--yes'], REGISTRY)
    assert.equal(status, 0, stdout)
    assert.match(stdout, /v1\.1\.0 was tagged but never published/)
    assert.ok(tagsOnRemote(repo).includes('v1.2.0'))
  })

  it('refuses to finish it with a working tree that would move HEAD past the tag', () => {
    // Publishing sends what is on disk, not what the tag describes. Committing the tree
    // first and publishing anyway would ship 1.1.0 as something the v1.1.0 tag does not
    // contain — silent, and permanent once it is on the registry.
    const repo = halfReleased()
    writeFileSync(join(repo.root, 'stray.txt'), 'work in progress')

    const { status, stdout } = release(repo, ['--yes'], REGISTRY)
    assert.notEqual(status, 0)
    assert.match(stdout, /would still commit the working tree/)
  })
})

describe('the Latest badge on GitHub', () => {
  const gh = (repo) => stubCalls(repo).find((c) => c.startsWith('gh release create'))

  it('goes to an ordinary stable release', () => {
    const repo = makeRepo({ config: { publish: null } })
    const { status, stdout } = release(repo, ['minor', '--yes'])
    assert.equal(status, 0, stdout)
    assert.match(gh(repo), /--latest=true/)
  })

  it('is not taken by a patch on an older line', () => {
    // v2.0.0 was cut on another branch and never merged here; releasing 1.9.9 from this
    // one must not point releases/latest at the older line.
    const repo = makeRepo({ config: { publish: null, branch: null } })
    execFileSync('git', ['checkout', '-q', '-b', 'next'], { cwd: repo.root })
    writeFileSync(join(repo.root, 'two.txt'), 'x')
    execFileSync('git', ['add', '-A'], { cwd: repo.root })
    execFileSync('git', ['commit', '-qm', 'feat!: two'], { cwd: repo.root })
    execFileSync('git', ['tag', '-a', 'v2.0.0', '-m', 'two'], { cwd: repo.root })
    execFileSync('git', ['checkout', '-q', 'main'], { cwd: repo.root })

    const { status, stdout } = release(repo, ['1.9.9', '--yes'])
    assert.equal(status, 0, stdout)
    assert.match(stdout, /will not be marked Latest/)
    assert.match(gh(repo), /--latest=false/)
  })

  it('never applies to a prerelease', () => {
    const repo = makeRepo({ config: { publish: null } })
    const { status, stdout } = release(repo, ['2.0.0-rc.1', '--yes'])
    assert.equal(status, 0, stdout)
    assert.match(gh(repo), /--prerelease/)
    assert.doesNotMatch(gh(repo), /--latest/)
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

  it('does not retry a rejected atomic push one ref at a time', () => {
    // git's own rejection says "(atomic push failed)". Reading that as "the server cannot
    // do atomic pushes" sent the tag alone after the branch was refused.
    const repo = makeRepo({ config: { publish: null, steps: ['version', 'tag', 'push'] } })
    const other = `${repo.root}-other`
    execFileSync('git', ['clone', '-q', repo.remote, other])
    const git = (...args) => execFileSync('git', args, { cwd: other })
    git('config', 'user.email', 'other@example.com')
    git('config', 'user.name', 'Other')
    git('config', 'commit.gpgsign', 'false')
    writeFileSync(join(other, 'b.txt'), 'b\n')
    git('add', 'b.txt')
    git('commit', '-qm', 'fix: land first')
    // Pushed from the hook, so preflight's fetch saw a remote the release was not behind.
    writeFileSync(
      join(repo.root, 'release.config.json'),
      JSON.stringify({
        publish: null,
        steps: ['version', 'tag', 'push'],
        hooks: { beforeVersion: `git -C '${other}' push -q origin main` },
      }),
    )
    execFileSync('git', ['commit', '-qam', 'chore: config'], { cwd: repo.root })
    execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: repo.root })
    execFileSync('git', ['pull', '-q', '--rebase', 'origin', 'main'], { cwd: other })

    const { status, stdout } = release(repo, ['minor', '--yes'])
    assert.notEqual(status, 0, stdout)
    assert.deepEqual(tagsOnRemote(repo), [])
    assert.doesNotMatch(stdout, /does not support atomic pushes/)
  })

  it('falls back to a plain push on a server without the atomic capability', () => {
    const repo = makeRepo({ config: { publish: null, steps: ['version', 'tag', 'push'] } })
    execFileSync('git', ['--git-dir', repo.remote, 'config', 'receive.advertiseAtomic', 'false'])
    const { status, stdout } = release(repo, ['minor', '--yes'])
    assert.equal(status, 0, stdout)
    assert.match(stdout, /does not support atomic pushes/)
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

  it('refuses to shred a file listed by mistake, in preflight, before anything is written', () => {
    // The refusal used to come from the write itself — after package.json, first in the
    // list, had already been rewritten and left dirty on disk, under a raw stack trace.
    const repo = makeRepo({
      files: { 'README.md': '# demo\n\nA library.\n' },
      config: { versionFiles: ['README.md'], publish: null, steps: ['version'] },
    })
    const { status, stdout } = release(repo, ['minor', '--yes'])
    assert.equal(status, 1)
    assert.match(stdout, /would replace everything/)
    assert.equal(readFile(repo, 'README.md'), '# demo\n\nA library.\n')
    assert.equal(JSON.parse(readFile(repo, 'package.json')).version, '1.0.0', 'nothing written')
    assert.ok(!stdout.includes('at writeVersionInto'), 'a clean abort, not a stack trace')
  })

  it('refuses a Cargo.lock it cannot scope, in preflight', () => {
    const repo = makeRepo({
      files: { 'src-tauri/Cargo.lock': '[[package]]\nname = "adler2"\nversion = "2.0.1"\n' },
      config: { versionFiles: ['src-tauri/Cargo.lock'], publish: null, steps: ['version'] },
    })
    const { status, stdout } = release(repo, ['minor', '--yes'])
    assert.equal(status, 1)
    assert.match(stdout, /fail\s+src-tauri\/Cargo\.lock lists every dependency's version/)
    assert.ok(!stdout.includes('at cargoLockPattern'), 'a clean abort, not a stack trace')
    assert.equal(JSON.parse(readFile(repo, 'package.json')).version, '1.0.0', 'nothing written')
  })
})

describe('--sync', () => {
  it('copies itself from a path containing a space', () => {
    // A URL pathname is percent-encoded, so a copy installed under such a directory was
    // reported as "piped from stdin" and refused to copy itself.
    const base = mkdtempSync(join(tmpdir(), 'release kit '))
    mkdirSync(join(base, 'tool'))
    mkdirSync(join(base, 'target'))
    writeFileSync(join(base, 'tool', 'release.mjs'), readFileSync(RELEASE_MJS, 'utf8'))
    const stdout = execFileSync('node', [join(base, 'tool', 'release.mjs'), '--sync', 'target'], {
      cwd: base,
      encoding: 'utf8',
    })
    assert.match(stdout, /target: installed/)
    assert.equal(
      readFileSync(join(base, 'target', 'scripts', 'release.mjs'), 'utf8'),
      readFileSync(RELEASE_MJS, 'utf8'),
    )
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
