# vis-bot — Visual baseline PR bot

[![Linter](https://github.com/repobuddy/vis-bot/actions/workflows/linter.yml/badge.svg)](https://github.com/repobuddy/vis-bot/actions/workflows/linter.yml)
[![CI](https://github.com/repobuddy/vis-bot/actions/workflows/ci.yml/badge.svg)](https://github.com/repobuddy/vis-bot/actions/workflows/ci.yml)
[![Check dist/](https://github.com/repobuddy/vis-bot/actions/workflows/check-dist.yml/badge.svg)](https://github.com/repobuddy/vis-bot/actions/workflows/check-dist.yml)
[![CodeQL](https://github.com/repobuddy/vis-bot/actions/workflows/codeql-analysis.yml/badge.svg)](https://github.com/repobuddy/vis-bot/actions/workflows/codeql-analysis.yml)
![Coverage](./badges/coverage.svg)

GitHub Action that runs a **baseline update** command for [Repobuddy visual-testing](https://github.com/repobuddy/visual-testing):

- [vitest-plugin-vis](https://www.npmjs.com/package/vitest-plugin-vis)
- [storybook-addon-vis](https://www.npmjs.com/package/storybook-addon-vis)

**commits** the changed image baselines, **pushes** to a branch, and **opens a pull request** when none exists yet.
If a PR for that branch is already open, a new push **updates** it automatically.

## What you need in the workflow

- **`actions/checkout`** with enough history to branch from your base (use `fetch-depth: 0` unless you know a smaller depth is enough).
- **Install and build** steps your Vis tests need (Node, pnpm/npm, Storybook build, etc.) **before** this action.
- **Permissions**: `contents: write` and `pull-requests: write` for `github.token` (or equivalent scopes on a PAT).

Image baselines are sensitive to **OS, fonts, and renderer**. Use a **consistent runner image** (and document any extra system packages or font installs) so regenerated PNGs stay stable across runs.

## Usage

### vitest-plugin-vis

Typical flow: run Vitest with snapshot update flags after install.

```yaml
permissions:
  contents: write
  pull-requests: write

jobs:
  update-vis-baselines:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          token: ${{ secrets.GITHUB_TOKEN }}

      - uses: pnpm/action-setup@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: pnpm

      - run: pnpm install

      - uses: repobuddy/vis-bot@v1
        with:
          update-command: pnpm exec vitest run -u
          paths-to-add: __vis__
```

Point `paths-to-add` at the Vis output root from your config (often `__vis__`) so unrelated working tree changes are not committed.

### storybook-addon-vis

Use the same pattern: add whatever **Storybook / test runner** steps your project needs **before** this action, then set `update-command` to the command that refreshes baselines per [storybook-addon-vis](https://github.com/repobuddy/storybook-addon-vis) and your setup. Align `paths-to-add` with where baselines are written.

## Inputs and outputs

See [`action.yml`](action.yml) for the full list. Commonly used inputs:

- **`update-command`**: Command that refreshes the baselines, run with `shell`. Leave it empty to commit the changes already in the working tree (see [Running the update yourself](#running-the-update-yourself)).
- **`shell`**: `bash` (default), `sh`, `pwsh` or `powershell`. On Windows runners `bash` is Git for Windows' bash, the same one `shell: bash` uses in a workflow step, not the WSL launcher.
- **`target-branch`**: Branch to push. Defaults to the **pull_request head** when the event is `pull_request`, otherwise `bot/update-snapshots`.
- **`base-branch`**: Base for the PR and for syncing. Defaults to the **pull_request base** when applicable, otherwise the repository default branch.
- **`paths-to-add`**: Optional space-separated paths for `git add`. Empty means `git add -A`.

Outputs: **`updated`**, **`pr-number`** (set only when a PR is created in that run), **`commit-sha`**, **`skipped`** (`true` when the run did nothing on purpose, such as a fork PR).

## Running the update yourself

If the baselines come from a step you want to control (retries, a timeout, a matrix of OSes), run it in your own workflow step and leave `update-command` empty. The action then only commits, pushes and opens the PR from whatever changed in the working tree:

```yaml
- uses: nick-fields/retry@v4
  with:
    max_attempts: 3
    timeout_minutes: 10
    command: pnpm verify:ci

- uses: repobuddy/vis-bot@v1
  if: matrix.node == 'lts/*'
  with:
    target-branch: vis-bot/update-snapshot/${{ github.head_ref }}-${{ runner.os }}-lts-latest
    base-branch: ${{ github.head_ref }}
    paths-to-add: "*/*/__vis__/${{ runner.os == 'Windows' && 'win32' || 'linux' }}"
```

A retry input would duplicate what `nick-fields/retry` and `timeout-minutes` already do, and could not cover work the caller does around the command, so the action has none.

### A snapshot PR separate from the feature branch

Set `target-branch` to a new branch and `base-branch` to the pull request's head branch. The action pushes the baselines to `target-branch` (created from `base-branch`) and opens a PR from it into `base-branch`. This works on `pull_request` and on `workflow_dispatch`, where there is no pull request payload and you pass the head ref yourself.

## Branch and PR behavior

1. Runs `update-command` (if set) in the checked-out tree. If there are no file changes, the action succeeds with `updated=false`.
2. Commits the changes to a temporary local commit, so they survive switching branches.
3. Fetches `base-branch` (and `target-branch` when it exists on the remote), then checks out the target branch, creating it from `base-branch` if it does not exist on the remote, or merging `base-branch` into it if it does.
4. Copies the changed files onto the target branch and commits them. If the target branch already holds identical files, the action succeeds with `updated=false`.
5. Pushes, and calls the REST API to **create** a PR only when no open PR exists for `head = owner:target-branch` and `base = base-branch`.

Merging into an existing target branch needs shared history, so a shallow checkout (`actions/checkout` defaults to `fetch-depth: 1`) is deepened automatically. If the fetch or merge still fails, use `fetch-depth: 0`.

## Limitations

- **Fork PRs**: `github.token` is read-only for pull requests from forks, so the action cannot push. It skips them: it logs why, sets `skipped=true` and `updated=false`, and the job passes. Pushing to forks would need a different token or `pull_request_target`, which has strong security implications; review [GitHub’s docs](https://docs.github.com/en/actions/security-guides/automatic-token-authentication#permissions-for-the-github_token) first.
- **Pull requests that `github.token` cannot push for other reasons** (for example Dependabot, whose token is read-only): skip them in your workflow with an `if:`.
- **Concurrency**: For scheduled or parallel triggers, consider a [`concurrency` group](https://docs.github.com/en/actions/using-jobs/using-concurrency) so two jobs do not push to the same bot branch at once.

## Developing

```bash
pnpm install
pnpm all
```

This formats, tests, updates the coverage badge, and runs `tsdown` to produce `dist/index.mjs` (required for the action to run). To try the action locally, see [`@github/local-action`](https://github.com/github/local-action) and [`package.json`](package.json) script `local-action`.

## Publishing

See [Action versioning](https://github.com/actions/toolkit/blob/main/docs/action-versioning.md) and this repo’s [`script/release`](./script/release) helper if present.

## Dependency licenses

Dependency license metadata lives under [`.licenses/`](./.licenses/). The [`licensed.yml`](./.github/workflows/licensed.yml) workflow can validate compliance; after dependency changes, run `licensed cache` locally if you use [Licensed](https://github.com/licensee/licensed).

## License

The scripts and documentation in this project are released under the [MIT License](LICENSE).
