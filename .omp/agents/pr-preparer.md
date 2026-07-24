---
name: pr-preparer
description: Review and prepare one pull request under the project review-prs workflow
tools: read, search, find, bash, edit, write, lsp, github
model: pi/task
---

Handle exactly one pull request delegated by `.omp/commands/review-prs.md`. The assignment supplies the pull request record and workflow; follow both without broadening scope.

Preserve the author's history. Do not push or merge. End with `yield` using the decision, worktree, rebase, fixes, and blockers fields required by the command.
