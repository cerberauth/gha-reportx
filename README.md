# @cerberauth/gha-reportx

Shared [reportx](https://github.com/cerberauth/reportx) CLI flag and PR-comment
helpers for CerberAuth's reportx-based GitHub Action wrappers
([jwtop-action](https://github.com/cerberauth/jwtop-action) today, others
later), so the PR-comment summary and `--output`/`--report-url` flag wiring
aren't reimplemented per repository.

## Installation

```sh
npm install @cerberauth/gha-reportx
```

This package has `@actions/core` and `@actions/github` as peer dependencies —
install whichever versions your action already depends on.

## API

### Flags (`src/flags.ts`)

Helpers for reportx's own CLI flags (`--output`, `--output-format`,
`--report-url`, `--report-format`, `--report-header`, `--show-all-findings`,
`--no-color`, `--quiet`), so actions can expose first-class inputs for them
without hand-crafting a raw `args` input.

- `hasFlag(args: string[], flag: string): boolean` — whether `flag` (as `--flag`
  or `--flag=value`) is already present in `args`.
- `parseFormatFlag(args: string[]): string | undefined` — reads a `--format`
  flag's value out of `args`.
- `parseOutputFlags(args: string[]): { path?: string; format?: string }` — reads
  `--output` and `--output-format` out of `args`.
- `tempReportPath(format: string): string` — a temp file path (under
  `RUNNER_TEMP`, falling back to the OS temp dir) with the extension reportx
  uses for the given `--output-format` value.
- `appendReportxFlags(commandArgs: string[]): void` — reads the standard
  reportx-related action inputs (`output-format`, `output-path`, `report-url`,
  `report-format`, `report-headers`, `show-all-findings`, `no-color`, `quiet`)
  via `@actions/core`'s `getInput` and appends the matching CLI flags to
  `commandArgs`, unless already present.

### Comments (`src/comment.ts`)

Helpers for turning a reportx JSON report (see
[format/json.go](https://github.com/cerberauth/reportx/blob/main/format/json.go)
and [finding.go](https://github.com/cerberauth/reportx/blob/main/finding.go) for
the schema) into a PR comment.

- `isPullRequestEvent(): boolean` — whether the current workflow run was
  triggered by a `pull_request` or `pull_request_target` event with a pull
  request in the payload.
- `workflowRunUrl(): string` — a link to the current workflow run, used as a
  fallback when the full findings summary doesn't fit in a PR comment.
- `buildCommentBody(reportJson: string, options: { toolName: string; docsUrl: string }): string`
  — builds a comment body listing every finding with its severity and URL. Falls
  back to a per-severity count table plus a link to the workflow run when the
  full summary would exceed GitHub's comment size limit. `toolName` and
  `docsUrl` are used in the heading, footer, and to scope the marker used to
  find/update this comment on future runs (so different tools commenting on the
  same PR don't clobber each other's comments).
- `postScanComment(token: string, body: string): Promise<void>` — creates or
  updates the PR comment carrying `body` (identified by the marker on its first
  line, as produced by `buildCommentBody`). No-ops outside of pull requests.
  Logs a warning instead of throwing on failure (e.g. a token without
  `pull-requests: write` on pull requests from forks), since commenting is a
  best-effort convenience on top of the scan.

### Example

```ts
import { getInput } from '@actions/core'
import {
  appendReportxFlags,
  buildCommentBody,
  isPullRequestEvent,
  postScanComment
} from '@cerberauth/gha-reportx'
import { readFileSync } from 'fs'

const args = ['scan']
appendReportxFlags(args)

// ... run the tool with `args`, writing a reportx JSON report to some path ...

if (isPullRequestEvent()) {
  const reportJson = readFileSync('report.json', 'utf8')
  const body = buildCommentBody(reportJson, {
    toolName: 'my-tool',
    docsUrl: 'https://www.cerberauth.com/docs/my-tool/'
  })
  await postScanComment(getInput('github-token'), body)
}
```
