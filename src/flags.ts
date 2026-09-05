import { getInput } from '@actions/core'
import os from 'os'
import path from 'path'

// File extensions reportx's formatters use for each --format/--output-format
// value, mirroring format.Formatter.FileExtension() in the reportx package.
const FORMAT_EXTENSIONS: Record<string, string> = {
  json: '.json',
  yaml: '.yaml',
  yml: '.yaml',
  jsonl: '.jsonl',
  sarif: '.sarif.json',
  markdown: '.md',
  md: '.md',
  html: '.html',
  terminal: '.txt',
  text: '.txt',
  plain: '.txt'
}

export function hasFlag(args: string[], flag: string): boolean {
  return args.some((a) => a === flag || a.startsWith(`${flag}=`))
}

function getFlagValue(args: string[], flag: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag) return args[i + 1]
    if (args[i].startsWith(`${flag}=`)) return args[i].split('=')[1]
  }
  return undefined
}

export function parseFormatFlag(args: string[]): string | undefined {
  return getFlagValue(args, '--format')
}

export function parseOutputFlags(args: string[]): {
  path?: string
  format?: string
} {
  return {
    path: getFlagValue(args, '--output'),
    format: getFlagValue(args, '--output-format')
  }
}

export function tempReportPath(format: string): string {
  const dir = process.env['RUNNER_TEMP'] || os.tmpdir()
  const ext = FORMAT_EXTENSIONS[format] ?? '.txt'
  return path.join(dir, `reportx-report-${Date.now()}${ext}`)
}

// Turns action inputs for reportx's own CLI flags (see cobrax/reportx in
// github.com/cerberauth/x) into CLI args, so users get first-class access to
// reportx's output formats, HTTP transport, and display options without
// hand-crafting a raw args input. Existing flags already present in
// commandArgs are left untouched.
export function appendReportxFlags(commandArgs: string[]): void {
  const outputFormat = getInput('output-format')
  const outputPath = getInput('output-path')
  if (!hasFlag(commandArgs, '--output') && (outputFormat || outputPath)) {
    const format = outputFormat || 'json'
    commandArgs.push(
      '--output',
      outputPath || tempReportPath(format),
      '--output-format',
      format
    )
  }

  const reportUrl = getInput('report-url')
  if (!hasFlag(commandArgs, '--report-url') && reportUrl) {
    commandArgs.push('--report-url', reportUrl)

    const reportFormat = getInput('report-format')
    if (reportFormat && !hasFlag(commandArgs, '--report-format')) {
      commandArgs.push('--report-format', reportFormat)
    }

    const reportHeaders = getInput('report-headers')
    for (const line of reportHeaders.split('\n')) {
      const header = line.trim()
      if (!header) continue
      // Accepts "Key: Value" or "Key=Value", one per line.
      const sepIndex = header.search(/[:=]/)
      if (sepIndex === -1) continue
      const key = header.slice(0, sepIndex).trim()
      const value = header.slice(sepIndex + 1).trim()
      if (!key || !value) continue
      commandArgs.push('--report-header', `${key}=${value}`)
    }
  }

  if (
    getInput('show-all-findings') === 'true' &&
    !hasFlag(commandArgs, '--show-all-findings')
  ) {
    commandArgs.push('--show-all-findings')
  }
  if (getInput('no-color') === 'true' && !hasFlag(commandArgs, '--no-color')) {
    commandArgs.push('--no-color')
  }
  if (getInput('quiet') === 'true' && !hasFlag(commandArgs, '--quiet')) {
    commandArgs.push('--quiet')
  }
}
