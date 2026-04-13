/**
 * Unit tests for the action entrypoint, src/main.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as core from '../__fixtures__/core.js'
import * as github from '@actions/github'

const { mockRunSnapshotPrBot } = vi.hoisted(() => ({
	mockRunSnapshotPrBot: vi.fn(),
}))

vi.mock('../src/git-pr.js', () => ({
	runSnapshotPrBot: mockRunSnapshotPrBot,
}))

vi.mock('@actions/core', () => core)
vi.mock('@actions/github', () => ({
	context: {
		eventName: 'workflow_dispatch',
		repo: { owner: 'o', repo: 'r' },
		payload: { repository: { default_branch: 'main' } },
	},
}))

const { run } = await import('../src/main.js')

describe('main.ts', () => {
	beforeEach(() => {
		core.getInput.mockImplementation((name: string) => {
			const map: Record<string, string> = {
				token: 't',
				'update-command': 'pnpm vitest run -u',
				'target-branch': '',
				'base-branch': '',
				'commit-message': 'msg',
				'pr-title': 'title',
				'pr-body': 'body',
				'git-user-name': 'n',
				'git-user-email': 'e@e',
				'paths-to-add': '',
			}
			return map[name] ?? ''
		})
		core.setOutput.mockClear()
		core.setFailed.mockClear()
		mockRunSnapshotPrBot.mockReset()
	})

	afterEach(() => {
		vi.resetAllMocks()
	})

	it('fails when token is missing', async () => {
		core.getInput.mockImplementation((name: string) => {
			if (name === 'token') return ''
			if (name === 'update-command') return 'cmd'
			return ''
		})
		vi.stubEnv('GITHUB_TOKEN', '')
		await run()
		expect(core.setFailed).toHaveBeenCalledWith('No GitHub token: provide input `token` or set GITHUB_TOKEN.')
		vi.unstubAllEnvs()
	})

	it('sets outputs when baselines update and a PR is created', async () => {
		mockRunSnapshotPrBot.mockResolvedValue({
			updated: true,
			prNumber: 3,
			commitSha: 'abc',
		})
		await run()
		expect(mockRunSnapshotPrBot).toHaveBeenCalledWith(github.context, expect.any(Object))
		expect(core.setOutput).toHaveBeenCalledWith('updated', 'true')
		expect(core.setOutput).toHaveBeenCalledWith('pr-number', '3')
		expect(core.setOutput).toHaveBeenCalledWith('commit-sha', 'abc')
	})

	it('sets outputs when there are no changes', async () => {
		mockRunSnapshotPrBot.mockResolvedValue({
			updated: false,
			prNumber: undefined,
			commitSha: undefined,
		})
		await run()
		expect(core.setOutput).toHaveBeenCalledWith('updated', 'false')
		expect(core.setOutput).toHaveBeenCalledWith('pr-number', '')
		expect(core.setOutput).toHaveBeenCalledWith('commit-sha', '')
	})
})
