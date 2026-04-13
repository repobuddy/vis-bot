import * as core from '@actions/core'
import * as github from '@actions/github'
import { type SnapshotPrInputs, runSnapshotPrBot } from './git-pr.js'

function readInputs(): SnapshotPrInputs {
	const token = core.getInput('token', { trimWhitespace: false }) || process.env.GITHUB_TOKEN || ''
	const updateCommand = core.getInput('update-command', { required: true })
	return {
		updateCommand,
		targetBranch: core.getInput('target-branch'),
		baseBranch: core.getInput('base-branch'),
		token,
		commitMessage: core.getInput('commit-message'),
		prTitle: core.getInput('pr-title'),
		prBody: core.getInput('pr-body'),
		gitUserName: core.getInput('git-user-name'),
		gitUserEmail: core.getInput('git-user-email'),
		pathsToAddRaw: core.getInput('paths-to-add'),
	}
}

/**
 * The main function for the action.
 *
 * @returns Resolves when the action is complete.
 */
export async function run(): Promise<void> {
	try {
		const inputs = readInputs()
		if (!inputs.token) {
			core.setFailed('No GitHub token: provide input `token` or set GITHUB_TOKEN.')
			return
		}

		const result = await runSnapshotPrBot(github.context, inputs)

		core.setOutput('updated', result.updated ? 'true' : 'false')
		core.setOutput('pr-number', result.prNumber !== undefined ? String(result.prNumber) : '')
		core.setOutput('commit-sha', result.commitSha ?? '')

		if (result.updated) {
			core.info(`Committed baselines at ${result.commitSha ?? 'unknown'}`)
			if (result.prNumber !== undefined) {
				core.info(`Opened pull request #${result.prNumber}`)
			} else {
				core.info('Pull request already open for this branch; push updated the existing PR.')
			}
		} else {
			core.info('No baseline file changes; working tree clean after update command.')
		}
	} catch (error) {
		if (error instanceof Error) core.setFailed(error.message)
	}
}
