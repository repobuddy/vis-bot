import * as exec from '@actions/exec'
import * as github from '@actions/github'

export type SnapshotPrResult = {
	updated: boolean
	prNumber: number | undefined
	commitSha: string | undefined
}

export type SnapshotPrInputs = {
	updateCommand: string
	targetBranch: string
	baseBranch: string
	token: string
	commitMessage: string
	prTitle: string
	prBody: string
	gitUserName: string
	gitUserEmail: string
	pathsToAddRaw: string
}

/** @internal exported for tests */
export function parsePathsToAdd(raw: string): string[] | null {
	const parts = raw
		.split(/\s+/u)
		.map((p) => p.trim())
		.filter(Boolean)
	return parts.length === 0 ? null : parts
}

/** @internal exported for tests */
export function resolveBranches(
	context: typeof github.context,
	inputTarget: string,
	inputBase: string,
): { targetBranch: string; baseBranch: string } {
	const pr = context.payload.pull_request
	const defaultBranch = context.payload.repository?.default_branch ?? 'main'

	let targetBranch = inputTarget.trim()
	if (targetBranch === '' && context.eventName === 'pull_request' && pr?.head?.ref) {
		targetBranch = pr.head.ref
	}
	if (targetBranch === '') targetBranch = 'bot/update-snapshots'

	let baseBranch = inputBase.trim()
	if (baseBranch === '' && context.eventName === 'pull_request' && pr?.base?.ref) {
		baseBranch = pr.base.ref
	}
	if (baseBranch === '') baseBranch = defaultBranch

	return { targetBranch, baseBranch }
}

function workspaceDir(): string {
	return process.env.GITHUB_WORKSPACE ?? process.cwd()
}

function authenticatedRemoteUrl(serverUrl: string, owner: string, repo: string, token: string): string {
	const base = serverUrl.replace(/\/$/u, '') || 'https://github.com'
	const host = new URL(base).host
	return `https://x-access-token:${token}@${host}/${owner}/${repo}.git`
}

async function runShellCommand(command: string, cwd: string): Promise<void> {
	const result = await exec.getExecOutput('bash', ['-c', command], {
		cwd,
		ignoreReturnCode: true,
	})
	if (result.exitCode !== 0) {
		throw new Error(`update-command failed with exit ${result.exitCode}: ${result.stderr || result.stdout}`)
	}
}

async function git(
	args: string[],
	cwd: string,
	allowFailure = false,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const result = await exec.getExecOutput('git', args, {
		cwd,
		ignoreReturnCode: true,
	})
	if (!allowFailure && result.exitCode !== 0) {
		throw new Error(`git ${args.join(' ')} failed (${result.exitCode}): ${result.stderr}`)
	}
	return {
		exitCode: result.exitCode,
		stdout: result.stdout,
		stderr: result.stderr,
	}
}

async function hasRemoteBranch(cwd: string, branch: string): Promise<boolean> {
	const r = await git(['ls-remote', '--heads', 'origin', branch], cwd, true)
	if (r.exitCode !== 0) return false
	return r.stdout.trim().length > 0
}

async function isWorkingTreeClean(cwd: string): Promise<boolean> {
	const r = await git(['status', '--porcelain'], cwd)
	return r.stdout.trim() === ''
}

async function ensureTargetBranch(cwd: string, targetBranch: string, baseBranch: string): Promise<void> {
	await git(['fetch', 'origin'], cwd)

	const remoteExists = await hasRemoteBranch(cwd, targetBranch)
	if (remoteExists) {
		await git(['checkout', '-B', targetBranch, `origin/${targetBranch}`], cwd)
		const merge = await git(['merge', `origin/${baseBranch}`, '--no-edit'], cwd, true)
		if (merge.exitCode !== 0) {
			throw new Error(
				`Could not merge origin/${baseBranch} into ${targetBranch}. Resolve conflicts locally: ${merge.stderr}`,
			)
		}
	} else {
		await git(['checkout', '-B', targetBranch, `origin/${baseBranch}`], cwd)
	}
}

async function configureGit(cwd: string, name: string, email: string): Promise<void> {
	await git(['config', 'user.name', name], cwd)
	await git(['config', 'user.email', email], cwd)
}

async function setOriginUrl(cwd: string, url: string): Promise<void> {
	await git(['remote', 'set-url', 'origin', url], cwd)
}

async function stageChanges(cwd: string, paths: string[] | null): Promise<void> {
	if (paths === null) {
		await git(['add', '-A'], cwd)
	} else {
		await git(['add', '--', ...paths], cwd)
	}
}

async function createPrIfNeeded(
	octokit: ReturnType<typeof github.getOctokit>,
	owner: string,
	repo: string,
	head: string,
	base: string,
	title: string,
	body: string,
): Promise<number | undefined> {
	const { data: open } = await octokit.rest.pulls.list({
		owner,
		repo,
		state: 'open',
		head: `${owner}:${head}`,
		base,
		per_page: 1,
	})
	if (open.length > 0) return undefined

	const { data: created } = await octokit.rest.pulls.create({
		owner,
		repo,
		title,
		head,
		base,
		body,
	})
	return created.number
}

export async function runSnapshotPrBot(
	context: typeof github.context,
	inputs: SnapshotPrInputs,
): Promise<SnapshotPrResult> {
	const cwd = workspaceDir()
	const { owner, repo } = context.repo
	const octokit = github.getOctokit(inputs.token)

	const { targetBranch, baseBranch } = resolveBranches(context, inputs.targetBranch, inputs.baseBranch)
	const paths = parsePathsToAdd(inputs.pathsToAddRaw)
	const serverUrl = process.env.GITHUB_SERVER_URL ?? 'https://github.com'
	const remoteWithAuth = authenticatedRemoteUrl(serverUrl, owner, repo, inputs.token)

	await configureGit(cwd, inputs.gitUserName, inputs.gitUserEmail)
	await setOriginUrl(cwd, remoteWithAuth)

	await ensureTargetBranch(cwd, targetBranch, baseBranch)

	await runShellCommand(inputs.updateCommand, cwd)

	if (await isWorkingTreeClean(cwd)) {
		return { updated: false, prNumber: undefined, commitSha: undefined }
	}

	await stageChanges(cwd, paths)
	const staged = await git(['diff', '--cached', '--quiet'], cwd, true)
	if (staged.exitCode === 0) {
		throw new Error(
			'Working tree had changes but nothing was staged. Check paths-to-add matches your Vis output paths.',
		)
	}
	await git(['commit', '-m', inputs.commitMessage], cwd)

	const shaResult = await git(['rev-parse', 'HEAD'], cwd)
	const commitSha = shaResult.stdout.trim()

	const push = await git(['push', 'origin', `HEAD:${targetBranch}`], cwd, true)
	if (push.exitCode !== 0) {
		throw new Error(`git push failed: ${push.stderr}`)
	}

	const prNumber = await createPrIfNeeded(octokit, owner, repo, targetBranch, baseBranch, inputs.prTitle, inputs.prBody)

	return { updated: true, prNumber, commitSha }
}
