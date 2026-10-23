import { existsSync } from 'node:fs'
import * as exec from '@actions/exec'
import * as github from '@actions/github'

export type SnapshotPrResult = {
	updated: boolean
	prNumber: number | undefined
	commitSha: string | undefined
	/** Why the run did nothing on purpose (e.g. fork PR). `undefined` when it ran normally. */
	skippedReason?: string | undefined
}

export type SnapshotPrInputs = {
	/** Empty means commit-only: use the changes already in the working tree. */
	updateCommand: string
	/** `bash` (default), `sh`, `pwsh` or `powershell`. Empty means `bash`. */
	shell?: string
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

/** @internal exported for tests */
export function resolveShell(
	shell: string,
	command: string,
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
	exists: (path: string) => boolean = existsSync,
): { tool: string; args: string[] } {
	const name = shell.trim().toLowerCase() || 'bash'
	switch (name) {
		case 'bash':
		case 'sh': {
			// On Windows runners `bash` on PATH can be the WSL launcher. Use Git for Windows' bash, as `shell: bash` does.
			if (name === 'bash' && platform === 'win32') {
				for (const root of [env.ProgramW6432, env.ProgramFiles, 'C:\\Program Files']) {
					if (!root) continue
					const candidate = `${root}\\Git\\bin\\bash.exe`
					if (exists(candidate))
						// exec splits its first argument on spaces, so a path with spaces must be quoted.
						return { tool: `"${candidate}"`, args: ['-c', command] }
				}
			}
			return { tool: name, args: ['-c', command] }
		}
		case 'pwsh':
		case 'powershell':
			return {
				tool: name,
				args: [
					'-NoProfile',
					'-NonInteractive',
					'-Command',
					`$ErrorActionPreference = 'Stop'\n${command}\nif ($LASTEXITCODE -is [int] -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`,
				],
			}
		default:
			throw new Error(`Unsupported shell "${shell}". Use bash, sh, pwsh or powershell.`)
	}
}

async function runShellCommand(command: string, shell: string, cwd: string): Promise<void> {
	const { tool, args } = resolveShell(shell, command)
	const result = await exec.getExecOutput(tool, args, {
		cwd,
		ignoreReturnCode: true,
	})
	if (result.exitCode !== 0) {
		throw new Error(`update-command failed with exit ${result.exitCode}: ${result.stderr || result.stdout}`)
	}
}

/**
 * A pull_request from a fork gets a read-only `github.token`, so nothing can be pushed.
 *
 * @internal exported for tests
 */
export function isForkPullRequest(context: typeof github.context): boolean {
	const pr = context.payload.pull_request
	if (!pr) return false
	const headRepo = pr.head?.repo
	// A deleted fork has no head repo.
	if (!headRepo) return true
	const baseName = pr.base?.repo?.full_name
	return baseName ? headRepo.full_name !== baseName : headRepo.fork === true
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

const FETCH_DEPTH_HINT = 'Use `fetch-depth: 0` on actions/checkout if this keeps failing.'

async function ensureTargetBranch(cwd: string, targetBranch: string, baseBranch: string): Promise<void> {
	const remoteExists = await hasRemoteBranch(cwd, targetBranch)
	const branches = remoteExists && targetBranch !== baseBranch ? [baseBranch, targetBranch] : [baseBranch]
	const shallow = (await git(['rev-parse', '--is-shallow-repository'], cwd, true)).stdout.trim() === 'true'

	// Fetch only the branches we need. Merging into an existing target needs shared history, which a
	// shallow checkout (the actions/checkout default) does not have, so deepen it first.
	const fetchArgs = ['fetch', '--no-tags']
	if (remoteExists && shallow) fetchArgs.push('--unshallow')
	fetchArgs.push('origin', ...branches.map((b) => `+refs/heads/${b}:refs/remotes/origin/${b}`))
	const fetched = await git(fetchArgs, cwd, true)
	if (fetched.exitCode !== 0) {
		throw new Error(`Could not fetch ${branches.join(', ')} from origin: ${fetched.stderr} ${FETCH_DEPTH_HINT}`)
	}

	if (remoteExists) {
		await git(['checkout', '-f', '-B', targetBranch, `origin/${targetBranch}`], cwd)
		const merge = await git(['merge', `origin/${baseBranch}`, '--no-edit'], cwd, true)
		if (merge.exitCode !== 0) {
			throw new Error(
				`Could not merge origin/${baseBranch} into ${targetBranch}. Resolve conflicts locally: ${merge.stderr} ${FETCH_DEPTH_HINT}`,
			)
		}
	} else {
		await git(['checkout', '-f', '-B', targetBranch, `origin/${baseBranch}`], cwd)
	}
}

type StagedChange = { status: string; path: string }

/** Staged changes against HEAD. Renames are reported as a delete plus an add. */
async function listStagedChanges(cwd: string): Promise<StagedChange[]> {
	const r = await git(['diff', '--cached', '--no-renames', '--name-status', '-z'], cwd)
	const tokens = r.stdout.split('\0').filter((t) => t !== '')
	const changes: StagedChange[] = []
	for (let i = 0; i + 1 < tokens.length; i += 2) {
		changes.push({ status: tokens[i].charAt(0), path: tokens[i + 1] })
	}
	return changes
}

/** Apply `changes`, as committed in `source`, onto the checked-out branch and stage them. */
async function applyChanges(cwd: string, source: string, changes: StagedChange[]): Promise<void> {
	const pathspec = (list: StagedChange[]) => Buffer.from(list.map((c) => c.path).join('\0'))
	const deleted = changes.filter((c) => c.status === 'D')
	const written = changes.filter((c) => c.status !== 'D')
	const run = async (args: string[], list: StagedChange[]) => {
		if (list.length === 0) return
		const result = await exec.getExecOutput('git', ['--literal-pathspecs', ...args], {
			cwd,
			ignoreReturnCode: true,
			input: pathspec(list),
		})
		if (result.exitCode !== 0) {
			throw new Error(`git ${args.join(' ')} failed (${result.exitCode}): ${result.stderr}`)
		}
	}
	await run(['checkout', source, '--pathspec-from-file=-', '--pathspec-file-nul'], written)
	await run(['rm', '-q', '--ignore-unmatch', '--pathspec-from-file=-', '--pathspec-file-nul'], deleted)
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
	if (isForkPullRequest(context)) {
		return {
			updated: false,
			prNumber: undefined,
			commitSha: undefined,
			skippedReason: 'Pull request comes from a fork: github.token is read-only there, so baselines cannot be pushed.',
		}
	}

	const cwd = workspaceDir()
	const { owner, repo } = context.repo
	const octokit = github.getOctokit(inputs.token)

	const { targetBranch, baseBranch } = resolveBranches(context, inputs.targetBranch, inputs.baseBranch)
	const paths = parsePathsToAdd(inputs.pathsToAddRaw)
	const serverUrl = process.env.GITHUB_SERVER_URL ?? 'https://github.com'
	const remoteWithAuth = authenticatedRemoteUrl(serverUrl, owner, repo, inputs.token)

	await configureGit(cwd, inputs.gitUserName, inputs.gitUserEmail)
	await setOriginUrl(cwd, remoteWithAuth)

	// With no update-command, the baselines are already in the working tree (the caller ran them).
	if (inputs.updateCommand.trim() !== '') {
		await runShellCommand(inputs.updateCommand, inputs.shell ?? '', cwd)
	}

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

	// Park the changes in a throwaway commit, switch to the target branch, then copy them over.
	// Switching first would lose them (or refuse to switch) when the checked-out commit differs.
	const changes = await listStagedChanges(cwd)
	await git(['commit', '--no-verify', '-m', 'vis-bot: baselines in progress'], cwd)
	const parked = (await git(['rev-parse', 'HEAD'], cwd)).stdout.trim()

	await ensureTargetBranch(cwd, targetBranch, baseBranch)
	await applyChanges(cwd, parked, changes)

	const differs = await git(['diff', '--cached', '--quiet'], cwd, true)
	if (differs.exitCode === 0) {
		// The target branch already holds these baselines.
		return { updated: false, prNumber: undefined, commitSha: undefined }
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
