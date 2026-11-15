/**
 * Unit tests for src/comment.ts
 */
import { jest } from '@jest/globals'
import * as core from '../__fixtures__/core.js'
import * as githubModule from '../__fixtures__/github.js'

jest.unstable_mockModule('@actions/core', () => core)
jest.unstable_mockModule('@actions/github', () => githubModule)

const {
  buildCommentBody,
  isPullRequestEvent,
  postScanComment,
  workflowRunUrl
} = await import('../src/comment.js')

const TOOL_OPTIONS = {
  toolName: 'example-tool',
  docsUrl: 'https://www.cerberauth.com/docs/example-tool/'
}

const listComments = jest.fn()
const createComment = jest.fn()
const updateComment = jest.fn()

function reportJson(
  findings: {
    title: string
    severity: string
    url?: string
  }[]
): string {
  const bySeverity: Record<string, number> = {}
  for (const f of findings) {
    bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1
  }
  return JSON.stringify({
    metadata: { total: findings.length, by_severity: bySeverity },
    findings
  })
}

describe('comment.ts', () => {
  beforeEach(() => {
    jest.resetAllMocks()

    githubModule.context.eventName = 'push'
    githubModule.context.payload = {}
    githubModule.context.serverUrl = 'https://github.com'
    githubModule.context.runId = 123456

    listComments.mockResolvedValue({ data: [] })
    githubModule.getOctokit.mockReturnValue({
      // Mirrors octokit.paginate: calls the endpoint and returns its items.
      paginate: async (
        endpoint: (params: unknown) => Promise<{ data: unknown[] }>,
        params: unknown
      ) => (await endpoint(params)).data,
      rest: {
        issues: { listComments, createComment, updateComment }
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
  })

  describe('isPullRequestEvent', () => {
    it('is false for non pull request events', () => {
      githubModule.context.eventName = 'push'
      expect(isPullRequestEvent()).toBe(false)
    })

    it('is true for pull_request events with a pull_request payload', () => {
      githubModule.context.eventName = 'pull_request'
      githubModule.context.payload = { pull_request: { number: 42 } }
      expect(isPullRequestEvent()).toBe(true)
    })

    it('is true for pull_request_target events with a pull_request payload', () => {
      githubModule.context.eventName = 'pull_request_target'
      githubModule.context.payload = { pull_request: { number: 42 } }
      expect(isPullRequestEvent()).toBe(true)
    })

    it('is false for pull_request events without a pull_request payload', () => {
      githubModule.context.eventName = 'pull_request'
      githubModule.context.payload = {}
      expect(isPullRequestEvent()).toBe(false)
    })
  })

  describe('workflowRunUrl', () => {
    it('builds a link to the current workflow run', () => {
      expect(workflowRunUrl()).toBe(
        'https://github.com/cerberauth/example-action/actions/runs/123456'
      )
    })
  })

  describe('buildCommentBody', () => {
    it('lists each finding in a summary table with its endpoint, colored severity and docs link', () => {
      const body = buildCommentBody(
        reportJson([
          {
            title: 'Blank Secret',
            severity: 'critical',
            url: 'https://api.example.com/token'
          },
          { title: 'Algorithm None', severity: 'high' }
        ]),
        TOOL_OPTIONS
      )

      expect(body).toContain('<!-- cerberauth/example-tool -->')
      expect(body).toContain('# example-tool scan results')
      expect(body).toContain('| Endpoint | Severity | Vulnerability | Docs |')
      expect(body).toContain(
        '| https://api.example.com/token | 🔴 Critical | Blank Secret | [Docs](https://www.cerberauth.com/docs/example-tool/) |'
      )
      expect(body).toContain(
        '| — | 🟠 High | Algorithm None | [Docs](https://www.cerberauth.com/docs/example-tool/) |'
      )
      expect(body).toContain('example-tool detected 2 findings.')
    })

    it('groups findings by endpoint, then sorts them by severity', () => {
      const body = buildCommentBody(
        reportJson([
          { title: 'No Endpoint', severity: 'critical' },
          { title: 'B Low', severity: 'low', url: 'https://b.example.com' },
          { title: 'A Info', severity: 'info', url: 'https://a.example.com' },
          {
            title: 'B Critical',
            severity: 'critical',
            url: 'https://b.example.com'
          },
          { title: 'A High', severity: 'high', url: 'https://a.example.com' }
        ]),
        TOOL_OPTIONS
      )

      const rows = body
        .split('<details>')[0]
        .split('\n')
        .filter((l) => l.startsWith('| ') && !/^\| (Endpoint|-)/.test(l))
        .map((l) => l.split(' | ').slice(0, 3).join(' | '))
      expect(rows).toEqual([
        '| https://a.example.com | 🟠 High | A High',
        '|  | ⚪ Info | A Info',
        '| https://b.example.com | 🔴 Critical | B Critical',
        '|  | 🔵 Low | B Low',
        '| — | 🔴 Critical | No Endpoint'
      ])
    })

    it('links each finding to its own docs page when the report has one', () => {
      const body = buildCommentBody(
        JSON.stringify({
          metadata: { total: 1 },
          findings: [
            {
              title: 'Weak Secret',
              severity: 'critical',
              references: [
                'https://www.cerberauth.com/docs/jwtop/vulnerabilities/jwt-weak-secret',
                'https://cwe.mitre.org/data/definitions/345.html'
              ]
            }
          ]
        }),
        TOOL_OPTIONS
      )

      expect(body).toContain(
        '| 🔴 Critical | Weak Secret | [Docs](https://www.cerberauth.com/docs/jwtop/vulnerabilities/jwt-weak-secret) |'
      )
      expect(body).toContain(
        '- **Docs:** https://www.cerberauth.com/docs/jwtop/vulnerabilities/jwt-weak-secret'
      )
      expect(body).toContain(
        '- **References:** https://cwe.mitre.org/data/definitions/345.html'
      )
    })

    it('puts full finding details in a hidden details block', () => {
      const body = buildCommentBody(
        reportJson([
          {
            title: 'Blank Secret',
            severity: 'critical',
            url: 'https://api.example.com/token'
          }
        ]),
        TOOL_OPTIONS
      )

      expect(body).toContain('<details>')
      expect(body).toContain('<summary>Findings details</summary>')
      expect(body).toContain('### https://api.example.com/token')
      expect(body).toContain('#### 🔴 Critical — Blank Secret')
      expect(body).toContain(
        '- **Docs:** https://www.cerberauth.com/docs/example-tool/'
      )
      expect(body).toContain('</details>')
    })

    it('says so when there are no findings, without a details block', () => {
      const body = buildCommentBody(reportJson([]), TOOL_OPTIONS)
      expect(body).toContain('No example-tool findings. Nice work! 🎉')
      expect(body).not.toContain('<details>')
    })

    it('links to the docs URL with the tool name', () => {
      const body = buildCommentBody(reportJson([]), TOOL_OPTIONS)
      expect(body).toContain(
        'Powered by [example-tool](https://www.cerberauth.com/docs/example-tool/)'
      )
    })

    it('shows the scanner version, target and checks, like super-linter', () => {
      const body = buildCommentBody(
        JSON.stringify({
          metadata: {
            total: 0,
            tool: 'example-tool',
            version: '0.11.0',
            target: 'http://localhost:8080'
          },
          coverage: { run: 4, skipped: 12, errored: 1 },
          findings: []
        }),
        TOOL_OPTIONS
      )

      expect(body).toContain(
        [
          'Powered by [example-tool](https://www.cerberauth.com/docs/example-tool/)\\',
          'example-tool version: `0.11.0`\\',
          'Target: `http://localhost:8080`\\',
          'Checks: 4 run, 12 skipped, 1 errored'
        ].join('\n')
      )
    })

    it('scopes the marker and heading to scanId, for several scans on the same PR', () => {
      const bodyA = buildCommentBody(reportJson([]), {
        ...TOOL_OPTIONS,
        scanId: 'https://api-a.example.com'
      })
      const bodyB = buildCommentBody(reportJson([]), {
        ...TOOL_OPTIONS,
        scanId: 'https://api-b.example.com'
      })

      expect(bodyA).toContain(
        '<!-- cerberauth/example-tool/https://api-a.example.com -->'
      )
      expect(bodyA).toContain(
        '# example-tool scan results (https://api-a.example.com)'
      )
      expect(bodyB).toContain(
        '<!-- cerberauth/example-tool/https://api-b.example.com -->'
      )
      // Different scanId means a different marker, so the two never collide.
      expect(bodyA.split('\n')[0]).not.toBe(bodyB.split('\n')[0])
    })

    it('escapes pipes and line breaks so a finding cannot break the summary table', () => {
      const body = buildCommentBody(
        reportJson([
          {
            title: 'Header A | B\ninjected',
            severity: 'low',
            url: 'https://api.example.com/?a=1|2'
          }
        ]),
        TOOL_OPTIONS
      )

      expect(body).toContain(
        '| https://api.example.com/?a=1\\|2 | 🔵 Low | Header A \\| B injected |'
      )
    })

    it('lists only active findings and counts the others', () => {
      const body = buildCommentBody(
        JSON.stringify({
          metadata: { total: 4, by_severity: { critical: 4 } },
          findings: [
            { title: 'Weak Secret', severity: 'critical', status: 'active' },
            { title: 'Algorithm None', severity: 'critical' },
            {
              title: 'Blank Secret',
              severity: 'critical',
              status: 'mitigated'
            },
            {
              title: 'Null Signature',
              severity: 'critical',
              status: 'accepted_risk'
            }
          ]
        }),
        TOOL_OPTIONS
      )

      expect(body).toContain('| Weak Secret |')
      expect(body).toContain('| Algorithm None |')
      expect(body).not.toContain('Blank Secret')
      expect(body).not.toContain('Null Signature')
      expect(body).toContain('example-tool detected 2 findings.')
      expect(body).toContain(
        '2 other results are not listed (mitigated, accepted risk or false positive).'
      )
    })

    it('congratulates when no finding is active', () => {
      const body = buildCommentBody(
        JSON.stringify({
          metadata: { total: 1, by_severity: { critical: 1 } },
          findings: [
            { title: 'Blank Secret', severity: 'critical', status: 'mitigated' }
          ]
        }),
        TOOL_OPTIONS
      )

      expect(body).toContain('No example-tool findings. Nice work! 🎉')
      expect(body).toContain('1 other result is not listed')
      expect(body).not.toContain('<details>')
    })

    it('sorts findings with an unknown severity after the known ones', () => {
      const body = buildCommentBody(
        reportJson([
          { title: 'Odd One', severity: 'unknown' },
          { title: 'Info One', severity: 'info' }
        ]),
        TOOL_OPTIONS
      )

      expect(body.indexOf('| Info One |')).toBeLessThan(
        body.indexOf('| Odd One |')
      )
    })

    it('drops the details block but keeps the summary table when only the details are too large', () => {
      const findings = Array.from({ length: 3 }, (_, i) => ({
        title: `Finding ${i}`,
        severity: 'high',
        description: 'x'.repeat(30000)
      }))

      const body = buildCommentBody(
        JSON.stringify({ metadata: { total: 3 }, findings }),
        TOOL_OPTIONS
      )

      expect(body.length).toBeLessThanOrEqual(65536)
      expect(body).toContain('| — | 🟠 High | Finding 0 |')
      expect(body).not.toContain('<details>')
      expect(body).toContain(
        'https://github.com/cerberauth/example-action/actions/runs/123456'
      )
    })

    it('falls back to a severity count table and the workflow run link when too large', () => {
      const findings = Array.from({ length: 2000 }, (_, i) => ({
        title: `Finding ${i}`,
        severity: 'medium',
        url: `https://www.cerberauth.com/docs/example-tool/finding-${i}/`
      }))

      const body = buildCommentBody(reportJson(findings), TOOL_OPTIONS)

      expect(body.length).toBeLessThanOrEqual(65536)
      expect(body).toContain('| Severity | Count |')
      expect(body).toContain('| 🟡 Medium | 2000 |')
      expect(body).not.toContain('Finding 0')
      expect(body).toContain(
        'https://github.com/cerberauth/example-action/actions/runs/123456'
      )
    })
  })

  describe('postScanComment', () => {
    it('does nothing when there is no pull request in the payload', async () => {
      githubModule.context.payload = {}

      await postScanComment('token', 'body')

      expect(githubModule.getOctokit).not.toHaveBeenCalled()
    })

    it('creates a new comment when none exists yet', async () => {
      githubModule.context.payload = { pull_request: { number: 7 } }

      await postScanComment('token', 'body')

      expect(createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: 'cerberauth',
          repo: 'example-action',
          issue_number: 7,
          body: 'body'
        })
      )
      expect(updateComment).not.toHaveBeenCalled()
    })

    it('updates the existing comment carrying the same marker', async () => {
      githubModule.context.payload = { pull_request: { number: 7 } }
      listComments.mockResolvedValue({
        data: [
          { id: 1, body: 'unrelated comment' },
          { id: 2, body: '<!-- cerberauth/example-tool -->\nold results' }
        ]
      })

      await postScanComment('token', '<!-- cerberauth/example-tool -->\nnew')

      expect(updateComment).toHaveBeenCalledWith(
        expect.objectContaining({ comment_id: 2 })
      )
      expect(createComment).not.toHaveBeenCalled()
    })

    it('searches every page of comments, so busy pull requests do not get duplicates', async () => {
      githubModule.context.payload = { pull_request: { number: 7 } }

      await postScanComment('token', '<!-- cerberauth/example-tool -->\nnew')

      expect(listComments).toHaveBeenCalledWith(
        expect.objectContaining({ issue_number: 7, per_page: 100 })
      )
    })

    it('keeps a separate comment per scanId, for several scans of the same tool on one PR', async () => {
      githubModule.context.payload = { pull_request: { number: 7 } }
      const bodyA = buildCommentBody(reportJson([]), {
        ...TOOL_OPTIONS,
        scanId: 'https://api-a.example.com'
      })
      const bodyB = buildCommentBody(reportJson([]), {
        ...TOOL_OPTIONS,
        scanId: 'https://api-b.example.com'
      })
      listComments.mockResolvedValue({
        data: [{ id: 1, body: bodyA.replace('nice work', 'old results') }]
      })

      // Scan A already has a comment: it should be updated in place...
      await postScanComment('token', bodyA)
      expect(updateComment).toHaveBeenCalledWith(
        expect.objectContaining({ comment_id: 1, body: bodyA })
      )
      // ...while scan B, seeing no comment carrying its own marker, gets a
      // new one instead of overwriting scan A's.
      await postScanComment('token', bodyB)
      expect(createComment).toHaveBeenCalledWith(
        expect.objectContaining({ body: bodyB })
      )
    })

    it('does not match a comment carrying a different tool marker', async () => {
      githubModule.context.payload = { pull_request: { number: 7 } }
      listComments.mockResolvedValue({
        data: [{ id: 2, body: '<!-- cerberauth/other-tool -->\nold results' }]
      })

      await postScanComment('token', '<!-- cerberauth/example-tool -->\nnew')

      expect(createComment).toHaveBeenCalled()
      expect(updateComment).not.toHaveBeenCalled()
    })

    it('warns instead of throwing when the API call fails', async () => {
      githubModule.context.payload = { pull_request: { number: 7 } }
      listComments.mockRejectedValue(new Error('Resource not accessible'))

      await expect(postScanComment('token', 'body')).resolves.not.toThrow()

      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining('Resource not accessible')
      )
    })
  })
})
