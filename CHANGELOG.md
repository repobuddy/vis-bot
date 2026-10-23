# vis-bot

## 0.1.0

### Minor Changes

- d5f3990: Make the action usable for per-OS snapshot PRs from CI.

  - Run `update-command` with Git for Windows' bash on Windows runners (the `bash` on PATH there can be WSL), and add a `shell` input (`bash`, `sh`, `pwsh`, `powershell`).
  - Make `update-command` optional. When empty, the action commits, pushes and opens the PR from the changes already in the working tree, so callers keep their own retry and timeout. Changes are carried onto the target branch, so a target branch that differs from the checked-out commit no longer loses them.
  - Skip fork pull requests, where `github.token` cannot push, instead of failing. The new `skipped` output is `true` in that case.
  - Fetch only the needed branches and deepen a shallow checkout before merging into an existing target branch.
  - Report `updated=false` when the target branch already has the same files.

## 0.0.1

### Patch Changes

- b34b75e: Initial alpha release.
