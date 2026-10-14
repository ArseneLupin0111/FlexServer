# Project Agent Instructions

## Mandatory Superpowers Workflow

These are mandatory workflows, not suggestions. Before every task, check for relevant skills and read their full instructions through `skill://<name>` in Oh My Pi. Do not rely on skill descriptions alone.

For development work in this project, follow the stages below in this order. Do not skip or reorder stages without explicit approval from the user. TDD and review are repeated within implementation, not deferred until the end.

1. **`brainstorming` — before building anything.** Clarify what the user wants and why through questions, then reflect the understanding back for correction. Small changes require agreement in chat; larger work requires a written design document that a builder can plan from. Obtain design approval before proceeding.
2. **`using-git-worktrees` — after design approval.** Create an isolated workspace on a new branch, perform project setup, and verify a clean test baseline. Report existing baseline failures rather than treating them as regressions from the new work.
3. **`writing-plans` — with an approved design.** Break the work into bite-sized tasks, targeting 2–5 minutes each. Each task must include exact file paths, complete code, and verification steps.
4. **`subagent-driven-development` or `executing-plans` — with an approved plan.** Choose one execution mode: fresh subagents per task with review after each task, or inline implementation in the current session with a fresh review of the whole branch at the end. Follow the chosen skill's full instructions.
5. **`test-driven-development` — during implementation.** Follow RED–GREEN–REFACTOR: write a failing test, observe the expected failure, write minimal implementation, observe the test passing, refactor, and commit the verified increment. If implementation was written before its test, delete that premature implementation and restart test-first. Do not delete unrelated or pre-existing user code.
6. **`requesting-code-review` — between tasks.** Review against the approved plan and report issues by severity. Critical issues block progress and must be resolved before continuing. Also perform the fresh whole-branch review required by inline execution.
7. **`finishing-a-development-branch` — after all tasks are complete.** Verify tests, present integration options (merge, PR, keep, discard), and perform the selected integration and worktree cleanup. Do not merge, discard work, or remove a worktree without the user's choice.

Use other relevant skills in addition to this sequence; for bugs or unexpected behavior, load `systematic-debugging` before proposing a fix. Additional skills do not replace the required development stages.

This file records the user's project workflow. Follow higher-priority platform and safety instructions when they conflict with any step; disclose the conflict rather than silently claiming compliance.
