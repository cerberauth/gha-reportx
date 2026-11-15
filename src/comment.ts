import { debug, info, warning } from '@actions/core'
import { context, getOctokit } from '@actions/github'

// GitHub caps issue/PR comment bodies at 65536 characters.
const MAX_COMMENT_LENGTH = 65536

// reportx's own severity order, worst first.
// See https://github.com/cerberauth/reportx/blob/main/finding.go
const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'info']

// GitHub comments can't color text, so severities get a colored marker.
const SEVERITY_MARKERS: Record<string, string> = {
  critical: '🔴',
  high: '🟠',
  medium: '🟡',
  low: '🔵',
  info: '⚪'
}

interface ReportxFinding {
  title: string
  severity: string
  // active, false_positive, accepted_risk or mitigated. Missing means active.
  status?: string
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
  // Documentation and advisory links; the first one is the finding's docs.
  references?: string[]
  parameter?: string
  tags?: string[]
}

interface ReportxReport {
  metadata: {
    total: number
    by_severity?: Record<string, number>
    // Scanner version, e.g. "0.11.0".
    version?: string
    target?: string
  }
  coverage?: {
    run?: number
    skipped?: number
    errored?: number
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

// Only active findings need attention. Reports may also carry findings that
// are mitigated (e.g. a check that ran without finding a vulnerability),
// accepted risks or false positives.
function isActive(finding: ReportxFinding): boolean {
  return (finding.status ?? 'active') === 'active'
}

// Counted from the findings rather than metadata.by_severity, which also
// counts findings that are not active.
function severityCounts(findings: ReportxFinding[]): [string, number][] {
  const counts = findings.reduce<Record<string, number>>((acc, f) => {
    acc[f.severity] = (acc[f.severity] ?? 0) + 1
    return acc
  }, {})

  return SEVERITY_ORDER.filter((severity) => counts[severity]).map(
    (severity): [string, number] => [severity, counts[severity]]
  )
}

// Unknown severities sort after the known ones instead of before them.
function severityRank(severity: string): number {
  const rank = SEVERITY_ORDER.indexOf(severity)
  return rank === -1 ? SEVERITY_ORDER.length : rank
}

// Colored severity label, e.g. "🔴 Critical".
function severityLabel(severity: string): string {
  const marker = SEVERITY_MARKERS[severity]
  return marker ? `${marker} ${capitalize(severity)}` : capitalize(severity)
}

// The finding's own docs page when reportx has one (references[0], the SARIF
// rule helpUri), otherwise the tool's docs.
function docsUrl(
  finding: ReportxFinding,
  options: BuildCommentBodyOptions
): string {
  return finding.references?.[0] ?? options.docsUrl
}

// Findings grouped by endpoint (findings without one last), each group sorted
// by severity, worst first.
function groupByEndpoint(
  findings: ReportxFinding[]
): [string | undefined, ReportxFinding[]][] {
  const groups = new Map<string | undefined, ReportxFinding[]>()
  for (const f of findings) {
    const group = groups.get(f.url) ?? []
    group.push(f)
    groups.set(f.url, group)
  }
  return [...groups.entries()]
    .sort(([a], [b]) => {
      if (a === b) return 0
      if (a === undefined) return 1
      if (b === undefined) return -1
      return a.localeCompare(b)
    })
    .map(([endpoint, group]): [string | undefined, ReportxFinding[]] => [
      endpoint,
      [...group].sort(
        (a, b) =>
          severityRank(a.severity) - severityRank(b.severity) ||
          a.title.localeCompare(b.title)
      )
    ])
}

// Makes a value safe to put in a Markdown table cell: a `|` would start a new
// column and a line break would end the row.
function tableCell(value: string): string {
  return value.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|')
}

function congratsMessage(toolName: string): string {
  return `✅ No ${toolName} findings. Nice work! 🎉`
}

// Top-level summary table: one row per finding with just enough to triage
// (where, how bad, what) plus its docs link, grouped by endpoint and sorted by
// severity. The endpoint is only shown on the first row of its group. Full
// detail lives in the `<details>` block below it.
function renderSummaryTable(
  findings: ReportxFinding[],
  options: BuildCommentBodyOptions
): string {
  const rows = groupByEndpoint(findings).flatMap(([endpoint, group]) =>
    group.map((f, i) => {
      const endpointCell = i > 0 ? '' : endpoint ? tableCell(endpoint) : '—'
      return `| ${endpointCell} | ${severityLabel(f.severity)} | ${tableCell(f.title)} | [Docs](${docsUrl(f, options)}) |`
    })
  )
  return `| Endpoint | Severity | Vulnerability | Docs |\n| -------- | -------- | ------------- | ---- |\n${rows.join('\n')}`
}

// Renders every field reportx reports for a single finding, for the hidden
// details block. See finding.go for the schema this mirrors.
function renderFindingDetails(
  finding: ReportxFinding,
  options: BuildCommentBodyOptions
): string {
  const meta: string[] = [`- **Docs:** ${docsUrl(finding, options)}`]
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
  const otherReferences = finding.references?.slice(1) ?? []
  if (otherReferences.length > 0) {
    meta.push(`- **References:** ${otherReferences.join(', ')}`)
  }

  const sections = [
    `#### ${severityLabel(finding.severity)} — ${finding.title}`,
    meta.join('\n')
  ]
  if (finding.description) {
    sections.push(`**Description**\n\n${finding.description}`)
  }
  if (finding.remediation) {
    sections.push(`**Remediation**\n\n${finding.remediation}`)
  }
  return sections.join('\n\n')
}

// Hidden `<details>` block carrying the full write-up for every finding,
// grouped by endpoint like the summary table, so the visible comment stays
// scannable while the full report is one click away, right there on the PR.
function renderFindingsDetails(
  findings: ReportxFinding[],
  options: BuildCommentBodyOptions
): string {
  const sections = groupByEndpoint(findings)
    .map(([endpoint, group]) => {
      const heading = `### ${endpoint ?? 'No endpoint'}`
      const body = group
        .map((f) => renderFindingDetails(f, options))
        .join('\n\n---\n\n')
      return `${heading}\n\n${body}`
    })
    .join('\n\n')
  return `<details>\n\n<summary>Findings details</summary>\n\n${sections}\n\n</details>`
}

function renderSeverityTable(findings: ReportxFinding[]): string {
  const counts = severityCounts(findings)
  if (counts.length === 0) {
    return 'No findings.'
  }

  const rows = counts
    .map(([severity, count]) => `| ${severityLabel(severity)} | ${count} |`)
    .join('\n')
  return `| Severity | Count |\n|----------|-------|\n${rows}`
}

// Like super-linter's summary comment: which scanner and version produced the
// report, plus the scan target and how many checks ran.
function footer(
  options: BuildCommentBodyOptions,
  report: ReportxReport
): string {
  const lines = [`Powered by [${options.toolName}](${options.docsUrl})`]
  const { version, target } = report.metadata
  if (version) {
    lines.push(`${options.toolName} version: \`${version}\``)
  }
  if (target) {
    lines.push(`Target: \`${target}\``)
  }
  const coverage = report.coverage
  if (coverage) {
    lines.push(
      `Checks: ${coverage.run ?? 0} run, ${coverage.skipped ?? 0} skipped, ${coverage.errored ?? 0} errored`
    )
  }
  // A trailing backslash is a Markdown line break, as in super-linter's footer.
  return `\n\n---\n\n${lines.join('\\\n')}`
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
  const allFindings = report.findings ?? []
  const findings = allFindings.filter(isActive)
  const inactiveCount = allFindings.length - findings.length
  const inactiveNote =
    inactiveCount === 0
      ? ''
      : `\n\n${inactiveCount} other result${inactiveCount === 1 ? ' is' : 's are'} not listed (mitigated, accepted risk or false positive).`
  const heading = options.scanId
    ? `# ${options.toolName} scan results (${options.scanId})`
    : `# ${options.toolName} scan results`

  const summary =
    findings.length === 0
      ? congratsMessage(options.toolName)
      : `${renderSummaryTable(findings, options)}\n\n${options.toolName} detected ${findings.length} finding${findings.length === 1 ? '' : 's'}.`
  const summaryWithNote = `${summary}${inactiveNote}`
  const details =
    findings.length === 0
      ? ''
      : `\n\n${renderFindingsDetails(findings, options)}`

  const full = `${marker}\n${heading}\n\n${summaryWithNote}${footer(options, report)}${details}`
  if (full.length <= MAX_COMMENT_LENGTH) {
    return full
  }

  // Too large with the details block: keep the summary table and link to the
  // workflow run for the full write-up.
  const summaryOnly = `${marker}\n${heading}\n\n${summaryWithNote}\n\nThe findings details are too large for a PR comment — see the [workflow run](${workflowRunUrl()}) for the full report.${footer(options, report)}`
  if (summaryOnly.length <= MAX_COMMENT_LENGTH) {
    return summaryOnly
  }

  const table = `${heading}\n\n${renderSeverityTable(findings)}\n\nThe full findings summary is too large for a PR comment — see the [workflow run](${workflowRunUrl()}) for details.`
  return `${marker}\n${table}${footer(options, report)}`
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

    // Paginate: the first page only holds 30 comments, so on busy pull
    // requests the existing comment would be missed and a duplicate posted.
    const comments = await octokit.paginate(octokit.rest.issues.listComments, {
      owner,
      repo,
      issue_number,
      per_page: 100
    })
    const existing = comments.find((c) => c.body?.startsWith(marker))

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
