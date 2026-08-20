/**
 * Import the pure half of release.mjs.
 *
 * release.mjs is a single executable script: importing it directly would parse argv, read
 * the repository and start releasing. Everything above the ARGUMENTS banner is pure — no
 * argv, no side effects — so the tests evaluate exactly that prefix and export from it.
 *
 * The alternative is wrapping ~900 lines of top-level statements in a main guard, which
 * costs more in the file people actually read than it saves here.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SEAM = '// ARGUMENTS'
const source = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../release.mjs'),
  'utf8',
)
const seamAt = source.indexOf(SEAM)
if (seamAt === -1) {
  throw new Error(
    `test/helpers/load.mjs slices release.mjs at "${SEAM}" and that banner is gone.\n` +
      'Restore it, or point this helper at the new boundary between the pure functions and\n' +
      'the code that reads argv.',
  )
}

/** Every function declared above the seam, importable by name. */
export const kit = await import(
  `data:text/javascript,${encodeURIComponent(
    `${source.slice(0, seamAt)}
export {
  parseVersion, compareVersions, incrementVersion, preidOf, distTagFor,
  changelogSection, rollUnreleased, insertChangelogSection, changelogOutOfOrder,
  parseCommit, inferBump, changelogFromCommits, withoutRevertedCommits,
  cleanDraft, cleanNotes, linkCitedCommits, CONVENTIONAL_RE, CHANGELOG_SECTIONS, HOSTS,
  lintSubjects, CHANGELOG_TYPES, KNOWN_TYPES,
  readVersionFrom, writeVersionInto, versionSource, patternFor,
  inventedVersions, normalizeRepoUrl, fallbackCommitMessage,
}`,
  )}`
)
