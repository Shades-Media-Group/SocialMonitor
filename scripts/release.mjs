// yarn release <patch|minor|major>
//
// Bumps the version of the root and every workspace, turns the changelog's Unreleased section
// into this version's, commits and tags. Then: git push --follow-tags. Pushing the tag makes
// the release workflow publish a GitHub release with this version's changelog section.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const kind = process.argv[2]
if (!['patch', 'minor', 'major'].includes(kind)) {
  console.error('Usage: yarn release <patch|minor|major>')
  process.exit(1)
}
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()
if (git('status', '--porcelain')) {
  console.error('Commit or stash your changes first.')
  process.exit(1)
}

const root = JSON.parse(readFileSync('package.json', 'utf8'))
const [major, minor, patch] = root.version.split('.').map(Number)
const version =
  kind === 'major'
    ? `${major + 1}.0.0`
    : kind === 'minor'
      ? `${major}.${minor + 1}.0`
      : `${major}.${minor}.${patch + 1}`

const files = ['package.json', 'apps/app/package.json', 'apps/site/package.json']
for (const file of files) {
  const text = readFileSync(file, 'utf8')
  writeFileSync(file, text.replace(/"version": "[^"]+"/, `"version": "${version}"`))
}

const log = readFileSync('CHANGELOG.md', 'utf8')
const unreleased = log.match(/## \[Unreleased\]\n([\s\S]*?)(?=\n## \[|$)/)
if (!unreleased || !unreleased[1].trim()) {
  console.error('The changelog has nothing under [Unreleased].')
  process.exit(1)
}
const date = new Date().toISOString().slice(0, 10)
writeFileSync(
  'CHANGELOG.md',
  log.replace('## [Unreleased]\n', `## [Unreleased]\n\n## [${version}] - ${date}\n`),
)

git('add', 'CHANGELOG.md', ...files)
git('-c', 'user.email=cristian.brinza@shades.md', 'commit', '-m', `chore(release): ${version}`)
git('tag', '-a', `v${version}`, '-m', `SocialMonitor ${version}`)
console.log(`Tagged v${version}. Now: git push --follow-tags`)
