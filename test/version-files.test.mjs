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
