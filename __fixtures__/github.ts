import type * as github from '@actions/github'
import { jest } from '@jest/globals'

export const context = {
  eventName: 'push',
  repo: { owner: 'cerberauth', repo: 'example-action' },
  payload: {} as { pull_request?: { number: number } },
  serverUrl: 'https://github.com',
  runId: 123456
}

export const getOctokit = jest.fn<typeof github.getOctokit>()
