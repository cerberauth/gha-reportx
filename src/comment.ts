import { debug, info, warning } from '@actions/core'
import { context, getOctokit } from '@actions/github'

// GitHub caps issue/PR comment bodies at 65536 characters.
const MAX_COMMENT_LENGTH = 65536

// reportx's own severity order, worst first.
// See https://github.com/cerberauth/reportx/blob/main/finding.go
const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'info']

interface ReportxFinding {
  title: string
  severity: string
  url?: string
  description?: string
  remediation?: string
  cwe_id?: string
  cwe_name?: string
  owasp_top10?: string
  cvss31_score?: number
  cvss31_vector?: string
  cvss40_score?: number
  cvss40_vector?: string
  parameter?: string
  tags?: string[]
}

interface ReportxReport {
  metadata: {
    total: number
    by_severity?: Record<string, number>
  }
  findings: ReportxFinding[]
}

export interface BuildCommentBodyOptions {
  // Name of the tool that produced the report, e.g. "jwtop". Used in the
  // comment heading and to scope the marker used to find/update this
  // comment across runs.
  toolName: string
  // Docs URL linked from the comment footer.
  docsUrl: string
  // Distinguishes multiple scans by the same tool on the same PR (e.g. one
  // per matrix target/job), so each gets and keeps its own comment instead
  // of clobbering the others. Included in the comment marker and heading.
  // Only needs to be unique per tool, e.g. the scanned target's URL or the
  // job/matrix label.
  scanId?: string
}

export function isPullRequestEvent(): boolean {
  return (
    (context.eventName === 'pull_request' ||
      context.eventName === 'pull_request_target') &&
    context.payload.pull_request != null
  )
}

// The workflow run this action is executing in, used as a fallback link
// when the full findings summary doesn't fit in a PR comment.
export function workflowRunUrl(): string {
  const { owner, repo } = context.repo
  return `${context.serverUrl}/${owner}/${repo}/actions/runs/${context.runId}`
}

function commentMarker(toolName: string, scanId?: string): string {
  return scanId
    ? `<!-- cerberauth/${toolName}/${scanId} -->`
    : `<!-- cerberauth/${toolName} -->`
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function severityCounts(report: ReportxReport): [string, number][] {
  const counts =
    report.metadata.by_severity ??
    report.findings.reduce<Record<string, number>>((acc, f) => {
      acc[f.severity] = (acc[f.severity] ?? 0) + 1
      return acc
    }, {})

  return SEVERITY_ORDER.filter((severity) => counts[severity]).map(
    (severity): [string, number] => [severity, counts[severity]]
  )
}

function sortBySeverity(findings: ReportxFinding[]): ReportxFinding[] {
  return [...findings].sort(
    (a, b) =>
      SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)
  )
}

function congratsMessage(toolName: string): string {
  return `No ${toolName} findings. Nice work! 🎉`
}

// Top-level summary table: one row per finding with just enough to triage
// (what, where, how bad) plus a docs link, GitHub's collapsed-by-default
// comment preview. Full detail lives in the `<details>` block below it.
function renderSummaryTable(
  findings: ReportxFinding[],
  options: BuildCommentBodyOptions
): string {
  const rows = sortBySeverity(findings)
    .map((f) => {
      const severity = `\`${capitalize(f.severity)}\``
      const endpoint = f.url ?? '—'
      return `| ${f.title} | ${endpoint} | ${severity} | [Docs](${options.docsUrl}) |`
    })
    .join('\n')
  return `| Vulnerability | Endpoint | Severity | Docs |\n| ------------- | -------- | -------- | ---- |\n${rows}`
}

// Renders every field reportx reports for a single finding, for the hidden
// details block. See finding.go for the schema this mirrors.
function renderFindingDetails(finding: ReportxFinding): string {
  const meta: string[] = []
  if (finding.url) meta.push(`- **Endpoint:** ${finding.url}`)
  if (finding.parameter) meta.push(`- **Parameter:** \`${finding.parameter}\``)
  if (finding.cwe_id) {
    meta.push(
      `- **CWE:** ${finding.cwe_id}${finding.cwe_name ? ` — ${finding.cwe_name}` : ''}`
    )
  }
  if (finding.owasp_top10) {
    meta.push(`- **OWASP Top 10:** ${finding.owasp_top10}`)
  }
  if (finding.cvss31_score != null) {
    meta.push(
      `- **CVSS 3.1:** ${finding.cvss31_score}${finding.cvss31_vector ? ` (${finding.cvss31_vector})` : ''}`
    )
  }
  if (finding.cvss40_score != null) {
    meta.push(
      `- **CVSS 4.0:** ${finding.cvss40_score}${finding.cvss40_vector ? ` (${finding.cvss40_vector})` : ''}`
    )
  }
  if (finding.tags?.length) {
    meta.push(`- **Tags:** ${finding.tags.join(', ')}`)
  }

  const sections = [
    `### ${finding.title} (\`${capitalize(finding.severity)}\`)`
  ]
  if (meta.length > 0) {
    sections.push(meta.join('\n'))
  }
  if (finding.description) {
    sections.push(`**Description**\n\n${finding.description}`)
  }
  if (finding.remediation) {
    sections.push(`**Remediation**\n\n${finding.remediation}`)
  }
  return sections.join('\n\n')
}

// Hidden `<details>` block carrying the full write-up for every finding, so
// the visible comment stays scannable while the full report is one click
// away, right there on the PR.
function renderFindingsDetails(findings: ReportxFinding[]): string {
  const sections = sortBySeverity(findings)
    .map(renderFindingDetails)
    .join('\n\n---\n\n')
  return `<details>\n\n<summary>Findings details</summary>\n\n${sections}\n\n</details>`
}

function renderSeverityTable(report: ReportxReport): string {
  const counts = severityCounts(report)
  if (counts.length === 0) {
    return 'No findings.'
  }

  const rows = counts
    .map(([severity, count]) => `| ${capitalize(severity)} | ${count} |`)
    .join('\n')
  return `| Severity | Count |\n|----------|-------|\n${rows}`
}

function footer(options: BuildCommentBodyOptions): string {
  return `\n\n---\nGenerated by [${options.toolName}](${options.docsUrl}).`
}

// Builds a PR comment body out of a reportx JSON report, in two parts, mirroring
// how super-linter formats its own summary comment: a visible summary table
// (one row per finding: vulnerability, endpoint, severity, docs), or a congrats
// message when there are none, followed by a hidden `<details>` block carrying
// every field reportx reports for each finding. When even the summary table
// would be too large for a GitHub comment, falls back to a per-severity finding
// count plus a link to the workflow run, where the full report is still
// available (as an artifact, in the logs, ...).
// When `options.scanId` is set, it's folded into the comment marker (and
// shown in the heading), so several scans by the same tool on the same PR
// (e.g. one per matrix target) each get their own comment that
// `postScanComment` finds and updates independently, instead of the scans
// clobbering a single shared comment.
export function buildCommentBody(
  reportJson: string,
  options: BuildCommentBodyOptions
): string {
  const report = JSON.parse(reportJson) as ReportxReport
  const marker = commentMarker(options.toolName, options.scanId)
  const findings = report.findings ?? []
  const heading = options.scanId
    ? `# ${options.toolName} scan results (${options.scanId})`
    : `# ${options.toolName} scan results`

  const summary =
    findings.length === 0
      ? congratsMessage(options.toolName)
      : `${renderSummaryTable(findings, options)}\n\n${options.toolName} detected ${findings.length} finding${findings.length === 1 ? '' : 's'}.`
  const details =
    findings.length === 0 ? '' : `\n\n${renderFindingsDetails(findings)}`

  const full = `${marker}\n${heading}\n\n${summary}${footer(options)}${details}`
  if (full.length <= MAX_COMMENT_LENGTH) {
    return full
  }

  const table = `${heading}\n\n${renderSeverityTable(report)}\n\nThe full findings summary is too large for a PR comment — see the [workflow run](${workflowRunUrl()}) for details.`
  return `${marker}\n${table}${footer(options)}`
}

// Creates or updates the PR comment carrying the scan results. Any failure
// (most commonly a token without pull-requests/issues write access, e.g. on
// forked-repo pull requests) is logged as a warning rather than failing the
// action, since commenting is a best-effort convenience on top of the scan.
// The comment to update, if any, is identified by the marker on the first
// line of `body` (as produced by buildCommentBody), so different tools
// commenting on the same PR don't clobber each other's comments.
export async function postScanComment(
  token: string,
  body: string
): Promise<void> {
  const pullRequest = context.payload.pull_request
  if (!pullRequest) {
    debug('Not running for a pull request, skipping comment')
    return
  }

  const { owner, repo } = context.repo
  const issue_number = pullRequest.number
  const marker = body.split('\n')[0]

  try {
    const octokit = getOctokit(token)

    const comments = await octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number
    })
    const existing = comments.data.find((c) => c.body?.startsWith(marker))

    if (existing) {
      await octokit.rest.issues.updateComment({
        owner,
        repo,
        comment_id: existing.id,
        body
      })
      info(`Updated scan results comment on PR #${issue_number}`)
    } else {
      await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number,
        body
      })
      info(`Created scan results comment on PR #${issue_number}`)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    warning(
      `Skipping PR comment (does the token have pull-requests: write permission?): ${message}`
    )
  }
}
