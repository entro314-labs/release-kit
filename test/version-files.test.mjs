/** Reading and rewriting the version wherever a project keeps it. */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { kit } from './helpers/load.mjs'

const scratch = () => mkdtempSync(join(tmpdir(), 'release-kit-test-'))

describe('formats inferred from the file name', () => {
  it('reads and writes a JSON version without reformatting the file', () => {
    const dir = scratch()
    const path = join(dir, 'package.json')
    writeFileSync(path, '{\n  "name": "x",\n  "version": "1.0.0",\n  "private": true\n}\n')
    assert.equal(kit.readVersionFrom({ path }), '1.0.0')
    kit.writeVersionInto({ path }, '1.1.0')
    assert.equal(
      readFileSync(path, 'utf8'),
      '{\n  "name": "x",\n  "version": "1.1.0",\n  "private": true\n}\n',
    )
  })

  it('reads a TOML version without touching a dependency inline table', () => {
    const dir = scratch()
    const path = join(dir, 'Cargo.toml')
    writeFileSync(
      path,
      '[package]\nname = "x"\nversion = "0.4.1"\n\n[dependencies]\nserde = { version = "1.0" }\n',
    )
    assert.equal(kit.readVersionFrom({ path }), '0.4.1')
    kit.writeVersionInto({ path }, '0.5.0')
    const after = readFileSync(path, 'utf8')
    assert.match(after, /^version = "0\.5\.0"$/m)
    assert.match(after, /serde = \{ version = "1\.0" \}/, 'the dependency is untouched')
  })

  it('treats any other file as containing just the version', () => {
    const dir = scratch()
    const path = join(dir, 'VERSION')
    writeFileSync(path, '1.4.2\n')
    assert.equal(kit.readVersionFrom({ path }), '1.4.2')
    kit.writeVersionInto({ path }, '1.5.0')
    assert.equal(readFileSync(path, 'utf8'), '1.5.0\n')
  })

  it('honours an explicit pattern for a format it does not know', () => {
    const dir = scratch()
    const path = join(dir, 'version.go')
    writeFileSync(path, 'package main\n\nconst Version = "1.2.0"\n')
    const entry = { path, pattern: '^const Version = "(.+)"' }
    assert.equal(kit.readVersionFrom(entry), '1.2.0')
    kit.writeVersionInto(entry, '1.3.0')
    assert.match(readFileSync(path, 'utf8'), /const Version = "1\.3\.0"/)
  })
})

describe('Cargo.lock', () => {
  const lockfile = (dir) => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'Cargo.toml'), '[package]\nname = "myapp"\nversion = "0.1.0"\n')
    writeFileSync(
      join(dir, 'Cargo.lock'),
      'version = 3\n\n[[package]]\nname = "adler2"\nversion = "2.0.1"\n\n' +
        '[[package]]\nname = "myapp"\nversion = "0.1.0"\n\n' +
        '[[package]]\nname = "zerocopy"\nversion = "0.7.0"\n',
    )
    return join(dir, 'Cargo.lock')
  }

  it('rewrites only this project, not the first dependency in the file', () => {
    // A lockfile records a version for every dependency — hundreds of them. The generic
    // TOML pattern matches whichever crate sorts first, which is never yours.
    const path = lockfile(join(scratch(), 'src-tauri'))
    assert.equal(kit.readVersionFrom({ path }), '0.1.0')
    kit.writeVersionInto({ path }, '0.2.0')
    const after = readFileSync(path, 'utf8')
    assert.match(after, /name = "myapp"\nversion = "0\.2\.0"/)
    assert.match(after, /name = "adler2"\nversion = "2\.0\.1"/, 'adler2 untouched')
    assert.match(after, /name = "zerocopy"\nversion = "0\.7\.0"/, 'zerocopy untouched')
  })

  it('refuses rather than guesses when it cannot tell which package is yours', () => {
    const dir = scratch()
    writeFileSync(join(dir, 'Cargo.lock'), '[[package]]\nname = "adler2"\nversion = "2.0.1"\n')
    assert.throws(
      () => kit.readVersionFrom({ path: join(dir, 'Cargo.lock') }),
      /which package is yours/,
    )
  })
})

describe('a Cargo workspace', () => {
  const workspace = () => {
    const root = mkdtempSync(join(tmpdir(), 'release-kit-ws-'))
    writeFileSync(
      join(root, 'Cargo.toml'),
      '[workspace]\nmembers = ["crates/*"]\n\n[workspace.package]\nversion = "1.0.0"\n',
    )
    for (const [name, version] of [
      ['core', '{ workspace = true }'],
      ['cli', '{ workspace = true }'],
      // Pinned to its own number: versioned separately, so this bump does not own it.
      ['detached', '"0.4.2"'],
    ]) {
      mkdirSync(join(root, 'crates', name), { recursive: true })
      writeFileSync(
        join(root, 'crates', name, 'Cargo.toml'),
        `[package]\nname = "acme-${name}"\nversion = ${version}\n`,
      )
    }
    writeFileSync(
      join(root, 'Cargo.lock'),
      'version = 3\n\n' +
        '[[package]]\nname = "acme-core"\nversion = "1.0.0"\n\n' +
        '[[package]]\nname = "acme-cli"\nversion = "1.0.0"\n\n' +
        '[[package]]\nname = "acme-detached"\nversion = "0.4.2"\n\n' +
        '[[package]]\nname = "serde"\nversion = "1.0.219"\n',
    )
    return root
  }

  it('finds the members that inherit the workspace version', () => {
    assert.deepEqual(kit.workspaceCrates(join(workspace(), 'Cargo.toml')), [
      'acme-cli',
      'acme-core',
    ])
  })

  it('rewrites every inheriting member in Cargo.lock, and nothing else', () => {
    const root = workspace()
    kit.writeVersionInto({ path: join(root, 'Cargo.lock') }, '1.1.0')
    const lock = readFileSync(join(root, 'Cargo.lock'), 'utf8')
    assert.match(lock, /name = "acme-core"\nversion = "1\.1\.0"/)
    assert.match(lock, /name = "acme-cli"\nversion = "1\.1\.0"/)
    assert.match(lock, /name = "acme-detached"\nversion = "0\.4\.2"/, 'pinned member untouched')
    assert.match(lock, /name = "serde"\nversion = "1\.0\.219"/, 'dependency untouched')
  })
})

describe('expandPaths', () => {
  it('expands a * within one path segment', () => {
    const root = mkdtempSync(join(tmpdir(), 'release-kit-glob-'))
    for (const name of ['alpha', 'beta']) {
      mkdirSync(join(root, 'apps', name), { recursive: true })
      writeFileSync(join(root, 'apps', name, 'app.json'), '{}')
    }
    assert.deepEqual(kit.expandPaths(join(root, 'apps/*/app.json')), [
      join(root, 'apps/alpha/app.json'),
      join(root, 'apps/beta/app.json'),
    ])
  })

  it('yields a literal path when it exists, and nothing when it does not', () => {
    const root = mkdtempSync(join(tmpdir(), 'release-kit-glob-'))
    writeFileSync(join(root, 'VERSION'), '1.0.0')
    assert.deepEqual(kit.expandPaths(join(root, 'VERSION')), [join(root, 'VERSION')])
    assert.deepEqual(kit.expandPaths(join(root, 'nope')), [])
  })
})

describe('version markers', () => {
  const write = (contents) => {
    const path = join(scratch(), 'README.md')
    writeFileSync(path, contents)
    return path
  }

  it('rewrites the version on a marked line and nothing else', () => {
    const path = write(
      '# acme\n\nInstall 1.2.3 or later.\n\n```sh\nnpm i acme@1.2.3 <!-- x-release-kit-version -->\n```\n',
    )
    kit.writeVersionInto({ path }, '2.0.0')
    const out = readFileSync(path, 'utf8')
    assert.match(out, /npm i acme@2\.0\.0/)
    assert.match(out, /Install 1\.2\.3 or later\./, 'the unmarked line is untouched')
  })

  it('rewrites a run of lines between a start and an end marker', () => {
    const path = write(
      '<!-- x-release-kit-start-version -->\nacme@1.2.3\nacme-cli@1.2.3\n<!-- x-release-kit-end -->\nacme@1.2.3\n',
    )
    kit.writeVersionInto({ path }, '2.0.0')
    const out = readFileSync(path, 'utf8')
    assert.match(out, /acme@2\.0\.0\nacme-cli@2\.0\.0/)
    assert.match(out, /x-release-kit-end -->\nacme@1\.2\.3/, 'the block ended')
  })

  it('writes only the named part for a major, minor or date marker', () => {
    const path = write(
      'FROM acme:1 # x-release-kit-major\nFROM acme:2 # x-release-kit-minor\nReleased 2000-01-01 <!-- x-release-kit-date -->\n',
    )
    kit.writeVersionInto({ path }, '4.7.0', { date: '2026-08-20' })
    const out = readFileSync(path, 'utf8')
    assert.match(out, /FROM acme:4 #/)
    assert.match(out, /FROM acme:7 #/)
    assert.match(out, /Released 2026-08-20/)
  })

  it('reads the version back out, so a marked file can be the source of truth', () => {
    const path = write('npm i acme@1.2.3 <!-- x-release-kit-version -->\n')
    assert.equal(kit.readVersionFrom({ path }), '1.2.3')
  })

  it('loses to an explicit pattern, so config always wins over convention', () => {
    const path = write('pinned = "9.9.9"\nnpm i acme@1.2.3 <!-- x-release-kit-version -->\n')
    assert.equal(kit.readVersionFrom({ path, pattern: '^pinned = "(.+)"' }), '9.9.9')
  })
})

describe('a file that is neither marked, patterned, nor just a version', () => {
  it('refuses rather than replacing everything in it with the version', () => {
    // Listing a README in versionFiles used to overwrite it with "1.1.0\n".
    const path = join(scratch(), 'README.md')
    writeFileSync(path, '# acme\n\nA library.\n')
    assert.throws(() => kit.writeVersionInto({ path }, '1.1.0'), /would replace everything/)
  })

  it('still writes a plain VERSION file, which is what that mode is for', () => {
    const path = join(scratch(), 'VERSION')
    writeFileSync(path, '1.0.0\n')
    kit.writeVersionInto({ path }, '1.1.0')
    assert.equal(readFileSync(path, 'utf8'), '1.1.0\n')
  })
})

describe('the version-date marker', () => {
  it('writes both on one line, which is the shape of an AppStream release tag', () => {
    const path = join(scratch(), 'app.metainfo.xml')
    writeFileSync(
      path,
      '<releases>\n  <release version="1.0.0" date="2026-01-01"/> <!-- x-release-kit-version-date -->\n</releases>\n',
    )
    kit.writeVersionInto({ path }, '1.4.0', { date: '2026-08-21' })
    assert.match(readFileSync(path, 'utf8'), /<release version="1\.4\.0" date="2026-08-21"\/>/)
  })
})
