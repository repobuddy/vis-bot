import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as github from '@actions/github'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockGetOctokit } = vi.hoisted(() => ({
	mockGetOctokit: vi.fn(),
}))

vi.mock('@actions/github', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@actions/github')>()
	return { ...actual, getOctokit: mockGetOctokit }
})

import { runSnapshotPrBot, type SnapshotPrInputs } from '../src/git-pr.js'

/** These tests drive real git against a local bare "origin". */
let root: string
let origin: string
let work: string
let seed: string
const list = vi.fn()
const create = vi.fn()

function git(cwd: string, ...args: string[]): string {
	return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function write(dir: string, file: string, content: string) {
	mkdirSync(join(dir, file, '..'), { recursive: true })
	writeFileSync(join(dir, file), content)
}

const inputs: SnapshotPrInputs = {
	updateCommand: '',
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

function dispatchContext(): typeof github.context {
	return {
		eventName: 'workflow_dispatch',
		repo: { owner: 'acme', repo: 'demo' },
		payload: { repository: { default_branch: 'main' } },
	} as typeof github.context
}

function pullRequestContext(headRef: string, baseRef = 'main'): typeof github.context {
	return {
		eventName: 'pull_request',
		repo: { owner: 'acme', repo: 'demo' },
		payload: {
			repository: { default_branch: 'main' },
			pull_request: {
				number: 5,
				head: { ref: headRef, repo: { full_name: 'acme/demo', fork: false } },
				base: { ref: baseRef, repo: { full_name: 'acme/demo' } },
			},
		},
	} as typeof github.context
}

/** Like actions/checkout with fetch-depth 1: a shallow clone of one branch, detached at its tip. */
function shallowCheckout(branch: string) {
	execFileSync('git', ['clone', '--depth', '1', '--branch', branch, `file://${origin}`, work], { encoding: 'utf8' })
	git(work, 'checkout', '--detach')
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'vis-bot-it-'))
	origin = join(root, 'origin.git')
	work = join(root, 'work')
	seed = join(root, 'seed')
	const gitConfig = join(root, 'gitconfig')
	// The action points `origin` at an https URL with the token; send that to the local bare repo.
	writeFileSync(
		gitConfig,
		`[url "file://${origin}"]\n\tinsteadOf = https://x-access-token:tok@github.com/acme/demo.git\n[protocol "file"]\n\tallow = always\n`,
	)
	vi.stubEnv('GIT_CONFIG_GLOBAL', gitConfig)
	vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
	vi.stubEnv('GITHUB_WORKSPACE', work)
	vi.stubEnv('GITHUB_SERVER_URL', 'https://github.com')

	execFileSync('git', ['init', '--bare', '-b', 'main', origin])
	mkdirSync(seed)
	git(seed, 'init', '-b', 'main')
	git(seed, 'config', 'user.name', 'seed')
	git(seed, 'config', 'user.email', 'seed@example.com')
	write(seed, 'src/a.txt', 'a\n')
	write(seed, 'pkg/__vis__/linux/__baselines__/old.png', 'old\n')
	git(seed, 'add', '-A')
	git(seed, 'commit', '-m', 'init')
	write(seed, 'src/a.txt', 'a2\n')
	git(seed, 'commit', '-am', 'second')
	git(seed, 'remote', 'add', 'origin', origin)
	git(seed, 'push', 'origin', 'main')
	// A feature branch (the PR head) that is ahead of main.
	git(seed, 'checkout', '-b', 'feature/x')
	write(seed, 'src/feature.txt', 'feature\n')
	git(seed, 'add', '-A')
	git(seed, 'commit', '-m', 'feature work')
	git(seed, 'push', 'origin', 'feature/x')

	list.mockReset()
	create.mockReset()
	list.mockResolvedValue({ data: [] })
	create.mockResolvedValue({ data: { number: 9 } })
	mockGetOctokit.mockReturnValue({ rest: { pulls: { list, create } } })
})

afterEach(() => {
	vi.unstubAllEnvs()
	mockGetOctokit.mockReset()
	rmSync(root, { recursive: true, force: true })
})

describe('runSnapshotPrBot (real git)', () => {
	it('commit-only: opens a PR from a separate target branch into the head branch (pull_request, shallow checkout)', async () => {
		shallowCheckout('feature/x')
		write(work, 'pkg/__vis__/linux/__baselines__/new.png', 'new\n')
		write(work, 'pkg/__vis__/linux/__baselines__/old.png', 'changed\n')

		const target = 'vis-bot/update-snapshot/feature/x-ubuntu-latest-lts-latest'
		const result = await runSnapshotPrBot(pullRequestContext('feature/x'), {
			...inputs,
			targetBranch: target,
			baseBranch: 'feature/x',
		})

		expect(result.updated).toBe(true)
		expect(result.prNumber).toBe(9)
		expect(create).toHaveBeenCalledWith(expect.objectContaining({ head: target, base: 'feature/x' }))
		expect(list).toHaveBeenCalledWith(expect.objectContaining({ head: `acme:${target}`, base: 'feature/x' }))

		// The pushed branch is feature/x plus exactly one baseline commit.
		expect(git(origin, 'rev-list', '--count', `feature/x..${target}`)).toBe('1')
		expect(git(origin, 'show', `${target}:pkg/__vis__/linux/__baselines__/new.png`)).toBe('new')
		expect(git(origin, 'show', `${target}:pkg/__vis__/linux/__baselines__/old.png`)).toBe('changed')
		expect(git(origin, 'show', `${target}:src/feature.txt`)).toBe('feature')
		expect(git(origin, 'rev-parse', 'feature/x')).not.toBe(git(origin, 'rev-parse', target))
	})

	it('commit-only: works on workflow_dispatch with no pull_request payload', async () => {
		shallowCheckout('feature/x')
		write(work, 'pkg/__vis__/linux/__baselines__/new.png', 'new\n')

		const target = 'vis-bot/update-snapshot/feature/x-windows-latest-lts-latest'
		const result = await runSnapshotPrBot(dispatchContext(), {
			...inputs,
			targetBranch: target,
			baseBranch: 'feature/x',
		})

		expect(result.updated).toBe(true)
		expect(create).toHaveBeenCalledWith(expect.objectContaining({ head: target, base: 'feature/x' }))
	})

	it('commit-only: carries a deletion over', async () => {
		shallowCheckout('feature/x')
		rmSync(join(work, 'pkg/__vis__/linux/__baselines__/old.png'))

		const target = 'vis-bot/update-snapshot/feature/x-ubuntu-latest-lts-latest'
		await runSnapshotPrBot(dispatchContext(), { ...inputs, targetBranch: target, baseBranch: 'feature/x' })

		expect(git(origin, 'ls-tree', '-r', '--name-only', target)).not.toContain('old.png')
	})

	it('merges the base into an existing target branch from a shallow checkout', async () => {
		const target = 'vis-bot/update-snapshot/feature/x-ubuntu-latest-lts-latest'
		// An existing snapshot branch that is behind feature/x.
		git(seed, 'checkout', '-b', target, 'main')
		write(seed, 'pkg/__vis__/linux/__baselines__/first.png', 'first\n')
		git(seed, 'add', '-A')
		git(seed, 'commit', '-m', 'earlier baselines')
		git(seed, 'push', 'origin', target)

		shallowCheckout('feature/x')
		expect(git(work, 'rev-parse', '--is-shallow-repository')).toBe('true')
		write(work, 'pkg/__vis__/linux/__baselines__/second.png', 'second\n')

		const result = await runSnapshotPrBot(pullRequestContext('feature/x'), {
			...inputs,
			targetBranch: target,
			baseBranch: 'feature/x',
		})

		expect(result.updated).toBe(true)
		expect(git(origin, 'show', `${target}:pkg/__vis__/linux/__baselines__/first.png`)).toBe('first')
		expect(git(origin, 'show', `${target}:pkg/__vis__/linux/__baselines__/second.png`)).toBe('second')
		expect(git(origin, 'show', `${target}:src/feature.txt`)).toBe('feature')
	})

	it('reports updated false when the target branch already has the same baselines', async () => {
		const target = 'vis-bot/update-snapshot/feature/x-ubuntu-latest-lts-latest'
		git(seed, 'checkout', '-b', target, 'feature/x')
		write(seed, 'pkg/__vis__/linux/__baselines__/new.png', 'new\n')
		git(seed, 'add', '-A')
		git(seed, 'commit', '-m', 'baselines')
		git(seed, 'push', 'origin', target)
		const before = git(origin, 'rev-parse', target)

		shallowCheckout('feature/x')
		write(work, 'pkg/__vis__/linux/__baselines__/new.png', 'new\n')

		const result = await runSnapshotPrBot(dispatchContext(), {
			...inputs,
			targetBranch: target,
			baseBranch: 'feature/x',
		})

		expect(result).toEqual({ updated: false, prNumber: undefined, commitSha: undefined })
		expect(git(origin, 'rev-parse', target)).toBe(before)
		expect(create).not.toHaveBeenCalled()
	})

	it('does nothing when the working tree is clean', async () => {
		shallowCheckout('feature/x')
		const result = await runSnapshotPrBot(dispatchContext(), {
			...inputs,
			targetBranch: 'bot/x',
			baseBranch: 'feature/x',
		})
		expect(result.updated).toBe(false)
		expect(git(origin, 'branch', '--list', 'bot/x')).toBe('')
	})

	it('runs update-command, then commits what it wrote', async () => {
		shallowCheckout('feature/x')
		const result = await runSnapshotPrBot(dispatchContext(), {
			...inputs,
			updateCommand: 'echo generated > pkg/__vis__/linux/__baselines__/gen.png',
			targetBranch: 'bot/x',
			baseBranch: 'feature/x',
		})
		expect(result.updated).toBe(true)
		expect(readFileSync(join(work, 'pkg/__vis__/linux/__baselines__/gen.png'), 'utf8').trim()).toBe('generated')
		expect(git(origin, 'show', 'bot/x:pkg/__vis__/linux/__baselines__/gen.png')).toBe('generated')
	})

	it('respects paths-to-add and leaves other changes out of the commit', async () => {
		shallowCheckout('feature/x')
		write(work, 'pkg/__vis__/linux/__baselines__/new.png', 'new\n')
		write(work, 'src/a.txt', 'dirty\n')

		await runSnapshotPrBot(dispatchContext(), {
			...inputs,
			pathsToAddRaw: 'pkg/__vis__',
			targetBranch: 'bot/x',
			baseBranch: 'feature/x',
		})

		expect(git(origin, 'show', 'bot/x:src/a.txt')).toBe('a2')
		expect(git(origin, 'show', 'bot/x:pkg/__vis__/linux/__baselines__/new.png')).toBe('new')
	})

	it('skips a fork pull request before touching git or the API', async () => {
		const ctx = pullRequestContext('feature/x')
		;(ctx.payload.pull_request as { head: { repo: { full_name: string; fork: boolean } } }).head.repo = {
			full_name: 'someone/demo',
			fork: true,
		}
		const result = await runSnapshotPrBot(ctx, { ...inputs, updateCommand: 'exit 1' })
		expect(result.updated).toBe(false)
		expect(result.skippedReason).toMatch(/fork/u)
		expect(mockGetOctokit).not.toHaveBeenCalled()
	})
})
