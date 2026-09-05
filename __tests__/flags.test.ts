/**
 * Unit tests for src/flags.ts
 */
import { jest } from '@jest/globals'
import * as core from '../__fixtures__/core.js'

jest.unstable_mockModule('@actions/core', () => core)

const { appendReportxFlags, hasFlag, parseFormatFlag, parseOutputFlags } =
  await import('../src/flags.js')

describe('flags.ts', () => {
  beforeEach(() => {
    jest.resetAllMocks()
    core.getInput.mockReturnValue('')
  })

  describe('hasFlag', () => {
    it('matches an exact flag', () => {
      expect(hasFlag(['--output', 'a.json'], '--output')).toBe(true)
    })

    it('matches a flag=value form', () => {
      expect(hasFlag(['--output=a.json'], '--output')).toBe(true)
    })

    it('is false when absent', () => {
      expect(hasFlag(['--format', 'json'], '--output')).toBe(false)
    })
  })

  describe('parseFormatFlag / parseOutputFlags', () => {
    it('reads --format', () => {
      expect(parseFormatFlag(['--format', 'markdown'])).toBe('markdown')
    })

    it('reads --output and --output-format', () => {
      expect(
        parseOutputFlags(['--output', 'a.json', '--output-format', 'json'])
      ).toEqual({ path: 'a.json', format: 'json' })
    })

    it('returns undefined when absent', () => {
      expect(parseOutputFlags([])).toEqual({
        path: undefined,
        format: undefined
      })
    })
  })

  describe('appendReportxFlags', () => {
    it('adds --output/--output-format from the output-format input', () => {
      core.getInput.mockImplementation((name: string) =>
        name === 'output-format' ? 'sarif' : ''
      )

      const args: string[] = []
      appendReportxFlags(args)

      expect(args[0]).toBe('--output')
      expect(args[1]).toMatch(/reportx-report-.*\.sarif\.json$/)
      expect(args.slice(2)).toEqual(['--output-format', 'sarif'])
    })

    it('uses the output-path input when given', () => {
      core.getInput.mockImplementation((name: string) => {
        if (name === 'output-format') return 'json'
        if (name === 'output-path') return './out/report.json'
        return ''
      })

      const args: string[] = []
      appendReportxFlags(args)

      expect(args).toEqual([
        '--output',
        './out/report.json',
        '--output-format',
        'json'
      ])
    })

    it('does not override an existing --output', () => {
      core.getInput.mockImplementation((name: string) =>
        name === 'output-format' ? 'sarif' : ''
      )

      const args = ['--output', 'mine.json']
      appendReportxFlags(args)

      expect(args).toEqual(['--output', 'mine.json'])
    })

    it('adds --report-url, --report-format and --report-header', () => {
      core.getInput.mockImplementation((name: string) => {
        if (name === 'report-url') return 'https://example.com/ingest'
        if (name === 'report-format') return 'json'
        if (name === 'report-headers')
          return 'Authorization: Bearer token\nX-Foo=bar\n\n'
        return ''
      })

      const args: string[] = []
      appendReportxFlags(args)

      expect(args).toEqual([
        '--report-url',
        'https://example.com/ingest',
        '--report-format',
        'json',
        '--report-header',
        'Authorization=Bearer token',
        '--report-header',
        'X-Foo=bar'
      ])
    })

    it('does not override an existing --report-url', () => {
      core.getInput.mockImplementation((name: string) =>
        name === 'report-url' ? 'https://example.com/ingest' : ''
      )

      const args = ['--report-url', 'https://mine.example.com']
      appendReportxFlags(args)

      expect(args).toEqual(['--report-url', 'https://mine.example.com'])
    })

    it('adds show-all-findings, no-color and quiet flags when enabled', () => {
      core.getInput.mockImplementation((name: string) => {
        if (name === 'show-all-findings') return 'true'
        if (name === 'no-color') return 'true'
        if (name === 'quiet') return 'true'
        return ''
      })

      const args: string[] = []
      appendReportxFlags(args)

      expect(args).toEqual(['--show-all-findings', '--no-color', '--quiet'])
    })

    it('does not duplicate flags already present in args', () => {
      core.getInput.mockImplementation((name: string) =>
        name === 'no-color' ? 'true' : ''
      )

      const args = ['--no-color']
      appendReportxFlags(args)

      expect(args).toEqual(['--no-color'])
    })
  })
})
