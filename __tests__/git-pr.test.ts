import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as exec from '@actions/exec'
import type * as github from '@actions/github'

const { mockGetOctokit } = vi.hoisted(() => ({
	mockGetOctokit: vi.fn(),
}))

vi.mock('@actions/github', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@actions/github')>()
	return {
		...actual,
		getOctokit: mockGetOctokit,
	}
})

import { parsePathsToAdd, resolveBranches, runSnapshotPrBot, type SnapshotPrInputs } from '../src/git-pr.js'

vi.mock('@actions/exec', () => ({
	getExecOutput: vi.fn(),
}))

const getExecOutput = vi.mocked(exec.getExecOutput)

function fakeContext(overrides: Partial<typeof github.context> = {}): typeof github.context {
	return {
		eventName: 'workflow_dispatch',
		repo: { owner: 'acme', repo: 'demo' },
		payload: {
			repository: { default_branch: 'main' },
		},
		...overrides,
	} as typeof github.context
}

const baseInputs: SnapshotPrInputs = {
	updateCommand: 'pnpm exec vitest run -u',
	targetBranch: '',
	baseBranch: '',
	token: 'tok',
	commitMessage: 'chore(vis): update',
	prTitle: 'Vis baselines',
	prBody: 'Automated',
	gitUserName: 'bot',
	gitUserEmail: 'bot@example.com',
	pathsToAddRaw: '',
}

describe('parsePathsToAdd', () => {
	it('returns null for empty / whitespace', () => {
		expect(parsePathsToAdd('')).toBeNull()
		expect(parsePathsToAdd('  \n  ')).toBeNull()
	})

	it('splits on whitespace', () => {
		expect(parsePathsToAdd('__vis__ dist/snap')).toEqual(['__vis__', 'dist/snap'])
	})
})

describe('resolveBranches', () => {
	it('uses defaults on workflow_dispatch', () => {
		const { targetBranch, baseBranch } = resolveBranches(fakeContext(), '', '')
		expect(targetBranch).toBe('bot/update-snapshots')
		expect(baseBranch).toBe('main')
	})

	it('uses pull_request head and base when inputs empty', () => {
		const ctx = fakeContext({
			eventName: 'pull_request',
			payload: {
				repository: {
					default_branch: 'main',
					name: 'demo',
					owner: { login: 'acme' },
				},
				pull_request: {
					number: 1,
					head: { ref: 'feature/foo' },
					base: { ref: 'develop' },
				},
			},
		})
		const { targetBranch, baseBranch } = resolveBranches(ctx, '', '')
		expect(targetBranch).toBe('feature/foo')
		expect(baseBranch).toBe('develop')
	})

	it('respects explicit inputs', () => {
		const ctx = fakeContext({
			eventName: 'pull_request',
			payload: {
				repository: {
					default_branch: 'main',
					name: 'demo',
					owner: { login: 'acme' },
				},
				pull_request: {
					number: 1,
					head: { ref: 'feature/foo' },
					base: { ref: 'develop' },
				},
			},
		})
		const { targetBranch, baseBranch } = resolveBranches(ctx, 'bot/vis', 'staging')
		expect(targetBranch).toBe('bot/vis')
		expect(baseBranch).toBe('staging')
	})
})

describe('runSnapshotPrBot', () => {
	const list = vi.fn()
	const create = vi.fn()

	beforeEach(() => {
		vi.stubEnv('GITHUB_WORKSPACE', '/tmp/vis-bot-ws')
		vi.stubEnv('GITHUB_SERVER_URL', 'https://github.com')
		getExecOutput.mockReset()
		list.mockReset()
		create.mockReset()
		mockGetOctokit.mockReturnValue({
			rest: {
				pulls: {
					list,
					create,
				},
			},
		} as unknown as ReturnType<typeof import('@actions/github').getOctokit>)
	})

	afterEach(() => {
		vi.unstubAllEnvs()
		mockGetOctokit.mockReset()
	})

	it('returns updated false when working tree is clean after command', async () => {
		const ok = { exitCode: 0, stdout: '', stderr: '' }
		getExecOutput.mockImplementation(() => Promise.resolve(ok))

		list.mockResolvedValue({ data: [] })

		const result = await runSnapshotPrBot(fakeContext(), baseInputs)

		expect(result).toEqual({ updated: false, prNumber: undefined, commitSha: undefined })
		expect(list).not.toHaveBeenCalled()
		expect(create).not.toHaveBeenCalled()
	})

	it('commits, pushes, and creates a PR when there are changes (new bot branch)', async () => {
		const ok = { exitCode: 0, stdout: '', stderr: '' }
		let statusCalls = 0
		getExecOutput.mockImplementation((cmd: string, args?: string[]) => {
			const a = args ?? []
			if (cmd === 'git' && a[0] === 'ls-remote') {
				return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' })
			}
			if (cmd === 'git' && a[0] === 'status' && a[1] === '--porcelain') {
				statusCalls += 1
				if (statusCalls === 1) {
					return Promise.resolve({ exitCode: 0, stdout: ' M __vis__/a.png\n', stderr: '' })
				}
				return Promise.resolve(ok)
			}
			if (cmd === 'git' && a[0] === 'diff' && a[1] === '--cached') {
				return Promise.resolve({ exitCode: 1, stdout: '', stderr: '' })
			}
			if (cmd === 'git' && a[0] === 'rev-parse') {
				return Promise.resolve({ exitCode: 0, stdout: 'deadbeef\n', stderr: '' })
			}
			return Promise.resolve(ok)
		})

		list.mockResolvedValue({ data: [] })
		create.mockResolvedValue({ data: { number: 7 } })

		const result = await runSnapshotPrBot(fakeContext(), baseInputs)

		expect(result.updated).toBe(true)
		expect(result.commitSha).toBe('deadbeef')
		expect(result.prNumber).toBe(7)
		expect(create).toHaveBeenCalledOnce()
	})
})
