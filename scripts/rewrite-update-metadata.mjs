import { readFileSync, writeFileSync } from 'node:fs'

const ymlPath = process.argv[2]
const repository = process.env.GITHUB_REPOSITORY
const tag = process.env.GITHUB_REF_NAME

if (ymlPath === undefined) {
  console.error('Usage: node scripts/rewrite-update-metadata.mjs <latest*.yml path>')
  process.exit(1)
}
if (repository === undefined || tag === undefined) {
  console.error('GITHUB_REPOSITORY and GITHUB_REF_NAME must be set')
  process.exit(1)
}

const baseUrl = `https://github.com/${repository}/releases/download/${tag}`
const content = readFileSync(ymlPath, 'utf8')
const rewritten = content.replace(
  /^(\s*(?:- )?(?:url|path):\s*)(\S+)$/gm,
  (match, prefix, value) => (/^https?:\/\//.test(value) ? match : `${prefix}${baseUrl}/${value}`)
)

if (rewritten !== content) {
  writeFileSync(ymlPath, rewritten)
  console.log(`Rewrote ${ymlPath} with base ${baseUrl}`)
} else {
  console.warn(`No url/path entries found in ${ymlPath}`)
}