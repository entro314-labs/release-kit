/**
 * Throwaway git repositories for the integration tests.
 *
 * Each fixture is a real repository with a real bare remote, so pushes, tags and
 * fast-forward checks behave as they do in anger. `gh` and the package manager are stubbed
 * on PATH: the release path is under test, not GitHub's availability. Every stub call is
 * appended to a log so a test can assert on the exact argv that was run.
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const RELEASE_MJS = join(dirname(fileURLToPath(import.meta.url)), '../../release.mjs')

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' })

/**
 * @param {object} [options]
 * @param {string} [options.name]     package name
 * @param {string} [options.version]  starting version
 * @param {object} [options.config]   release.config.json contents
 * @param {string} [options.changelog] CHANGELOG.md contents, omitted when absent
 * @param {Record<string,string>} [options.files] extra files to create
 * @param {boolean} [options.manifest] write a package.json; false for a repository whose
 *                                     language has no manifest at all, like a Go module
 */
export function makeRepo({
  name = '@scope/demo',
  version = '1.0.0',
  config,
  changelog,
  files = {},
  manifest = true,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'release-kit-repo-'))
  const remote = `${root}-origin.git`
  const calls = join(root, '..', `${root.split('/').pop()}-calls.log`)

  if (manifest) {
    writeFileSync(
      join(root, 'package.json'),
      `{\n  "name": "${name}",\n  "version": "${version}"\n}\n`,
    )
  }
  if (config)
    writeFileSync(join(root, 'release.config.json'), `${JSON.stringify(config, null, 2)}\n`)
  if (changelog) writeFileSync(join(root, 'CHANGELOG.md'), changelog)
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), contents)
  }

  git(root, 'init', '-q', '-b', 'main')
  git(root, 'config', 'user.email', 'test@example.com')
  git(root, 'config', 'user.name', 'Test')
  // Signing depends on the developer's machine; the release path does not.
  git(root, 'config', 'commit.gpgsign', 'false')
  git(root, 'config', 'tag.gpgsign', 'false')
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', 'feat: initial')
  execFileSync('git', ['init', '-q', '--bare', remote], { stdio: 'pipe' })
  git(root, 'remote', 'add', 'origin', remote)
  git(root, 'push', '-q', '-u', 'origin', 'main')

  writeFileSync(calls, '')
  // Outside the repository: anything inside it would leave the working tree dirty and
  // every preflight would fail on it.
  return { root, remote, calls, bin: stubBin(`${root}-bin`, calls) }
}

/** A PATH entry holding stub `gh`, `npm` and `cargo` that record their argv. */
function stubBin(bin, calls) {
  mkdirSync(bin, { recursive: true })

  writeFileSync(
    join(bin, 'gh'),
    `#!/bin/sh
echo "gh $*" >> "${calls}"
case "$1 $2" in
  "release view") exit \${GH_RELEASE_EXISTS:-1} ;;
  "auth status") exit \${GH_AUTHED:-0} ;;
  "api user") echo "test-user"; exit 0 ;;
  "api user/ssh_signing_keys") exit 1 ;;
  "release create") cat > /dev/null 2>&1; echo "https://example.test/releases/tag"; exit 0 ;;
esac
exit 0
`,
  )
  writeFileSync(
    join(bin, 'npm'),
    `#!/bin/sh
echo "npm $*" >> "${calls}"
case "$1" in
  whoami) echo "test-npm-user"; exit \${NPM_AUTHED:-0} ;;
  view) exit \${NPM_PUBLISHED:-1} ;;
esac
exit 0
`,
  )
  writeFileSync(
    join(bin, 'cargo'),
    `#!/bin/sh
echo "cargo $*" >> "${calls}"
case "$1" in
  info) exit \${CARGO_PUBLISHED:-101} ;;
esac
exit 0
`,
  )
  for (const name of ['gh', 'npm', 'cargo']) chmodSync(join(bin, name), 0o755)
  return bin
}

/** Run release.mjs in a fixture. Never throws — tests assert on status and output. */
export function release(repo, args = [], env = {}) {
  try {
    const stdout = execFileSync('node', [RELEASE_MJS, ...args], {
      cwd: repo.root,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${repo.bin}:${process.env.PATH}`, CALLS: repo.calls, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { status: 0, stdout }
  } catch (err) {
    return { status: err.status ?? 1, stdout: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

export const stubCalls = (repo) =>
  readFileSync(repo.calls, 'utf8').trim().split('\n').filter(Boolean)
export const tagsOnRemote = (repo) =>
  execFileSync('git', ['--git-dir', repo.remote, 'tag'], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter(Boolean)
export const readFile = (repo, path) => readFileSync(join(repo.root, path), 'utf8')
