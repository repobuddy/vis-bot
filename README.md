# vis-bot — Visual baseline PR bot

[![Linter](https://github.com/repobuddy/vis-bot/actions/workflows/linter.yml/badge.svg)](https://github.com/repobuddy/vis-bot/actions/workflows/linter.yml)
[![CI](https://github.com/repobuddy/vis-bot/actions/workflows/ci.yml/badge.svg)](https://github.com/repobuddy/vis-bot/actions/workflows/ci.yml)
[![Check dist/](https://github.com/repobuddy/vis-bot/actions/workflows/check-dist.yml/badge.svg)](https://github.com/repobuddy/vis-bot/actions/workflows/check-dist.yml)
[![CodeQL](https://github.com/repobuddy/vis-bot/actions/workflows/codeql-analysis.yml/badge.svg)](https://github.com/repobuddy/vis-bot/actions/workflows/codeql-analysis.yml)
![Coverage](./badges/coverage.svg)

GitHub Action that runs a **baseline update** command for [Repobuddy visual-testing](https://github.com/repobuddy/visual-testing) (e.g. [vitest-plugin-vis](https://www.npmjs.com/package/vitest-plugin-vis) or [storybook-addon-vis](https://www.npmjs.com/package/storybook-addon-vis)), **commits** the changed image baselines, **pushes** to a branch, and **opens a pull request** when none exists yet. If a PR for that branch is already open, a new push **updates** it automatically.

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

- **`update-command`** (required): Shell command run with `bash -c` (Linux/macOS runners).
- **`target-branch`**: Branch to push. Defaults to the **pull_request head** when the event is `pull_request`, otherwise `bot/update-snapshots`.
- **`base-branch`**: Base for the PR and for syncing. Defaults to the **pull_request base** when applicable, otherwise the repository default branch.
- **`paths-to-add`**: Optional space-separated paths for `git add`. Empty means `git add -A`.

Outputs: **`updated`**, **`pr-number`** (set only when a PR is created in that run), **`commit-sha`**.

## Branch and PR behavior

1. Fetches `origin` and checks out the target branch, creating it from `base-branch` if it does not exist on the remote, or merging `base-branch` into it if it does.
2. Runs `update-command`.
3. If there are no file changes, the action succeeds with `updated=false`.
4. Otherwise it commits, pushes, and calls the REST API to **create** a PR only when no open PR exists for `head = owner:target-branch` and `base = base-branch`.

## Limitations

- **Fork PRs**: Workflows triggered from forks often receive a read-only `GITHUB_TOKEN`, so pushes or PR creation may fail unless you use a different approach (for example a carefully scoped PAT or `pull_request_target`, which has strong security implications—review [GitHub’s docs](https://docs.github.com/en/actions/security-guides/automatic-token-authentication#permissions-for-the-github_token) before changing event or token strategy).
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
