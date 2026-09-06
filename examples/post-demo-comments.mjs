// Demo consumer of the built package: posts two independent PR comments
// (built with `buildCommentBody`/`postScanComment` from `../dist/index.js`,
// same as a real reportx-based action would) so both the "findings" and
// "no findings" renderings can be reviewed straight from a pull request.
// Run via the `Example PR comments` workflow (`.github/workflows/example-pr-comment.yml`).
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  buildCommentBody,
  isPullRequestEvent,
  postScanComment
} from '../dist/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const TOOL_OPTIONS = {
  toolName: 'gha-reportx-demo',
  docsUrl: 'https://www.cerberauth.com/docs/gha-reportx/'
}

function fixture(name) {
  return readFileSync(join(__dirname, 'fixtures', name), 'utf8')
}

async function main() {
  if (!isPullRequestEvent()) {
    console.log('Not running for a pull request, skipping demo comments')
    return
  }

  const token = process.env.GITHUB_TOKEN
  if (!token) {
    throw new Error('GITHUB_TOKEN is required')
  }

  // Distinct `scanId`s so the two demo scans get and keep their own
  // comment instead of clobbering each other's.
  await postScanComment(
    token,
    buildCommentBody(fixture('report-with-findings.json'), {
      ...TOOL_OPTIONS,
      scanId: 'with-findings'
    })
  )

  await postScanComment(
    token,
    buildCommentBody(fixture('report-no-findings.json'), {
      ...TOOL_OPTIONS,
      scanId: 'no-findings'
    })
  )
}

await main()
