---
name: goal
description: Manage the persistent thread goal from the Python REPL. Use to read goal status and budget usage, to start a goal when the user explicitly asks for one, or to mark the active goal complete once its objective is fully achieved.
---

# Goal

The thread goal is a persistent objective the harness keeps re-prompting you to
pursue across turns until it is complete. Goal state (status, token budget,
usage accounting) lives in the host; this skill is the kernel-side interface to
it. Call it directly from the Python REPL:

```python
await goal.get()
await goal.create("ship the release notes")
# Only pass token_budget when the user explicitly asks for one:
# await goal.create("ship the release notes", token_budget=200000)
# A Definition of Done — completion is refused while any of these fails:
await goal.create("make the suite green", conditions=["npm test", "npm run lint"])
await goal.complete()
```

## API

- `await goal.get()` — current goal as a dict: `goal` (or `None` when no goal
  is set), `remaining_tokens`, and `completion_budget_report`. The `goal` dict
  carries `objective`, `status`, `token_budget`, `tokens_used`,
  `time_used_seconds`, and timestamps.
- `await goal.create(objective, token_budget=None, conditions=None)` — start a
  new active goal. Fails while a goal is still pending (active, paused, or
  budget-limited); a completed or errored goal is replaced by the new one. Only
  create a goal when the user or system/developer instructions explicitly ask
  for a persistent long-running goal; do not infer goals from ordinary tasks.
  Set `token_budget` only when an explicit token budget is requested.
  `conditions` is a list of shell commands, numbered `D1..Dn`, each satisfied
  when it exits 0 — the goal's machine-readable Definition of Done.
- `await goal.complete(waive=None)` — mark the existing goal achieved. Use only
  when the objective has actually been achieved and no required work remains;
  do not call it merely because the budget is nearly exhausted or because you
  are stopping work. When the goal carries conditions, the host runs them and
  RAISES with the failing ones listed instead of completing. `waive` is
  `{condition_id: reason}` for a condition red for a reason the work cannot fix;
  the reason is mandatory and is recorded on the goal. When the result includes
  a `completion_budget_report`, report that final usage to the user.

## Rules

- Goal status transitions other than completion (pause, resume, clear,
  budget-limiting) are controlled by the user and the host; there is no API for
  them here.
- When an active goal is actually complete, call `await goal.complete()`; do
  not merely say it is done — the harness keeps continuing the goal until the
  completion call arrives.
- Prefer conditions the user can check over prose only you can. A condition
  must be able to FAIL: one that already passes before you start proves
  nothing, and is reported as non-discriminating when the goal completes.
- A refused completion is not an error to work around. Do the work the failing
  condition describes, then call `await goal.complete()` again.
- A Definition of Done in which EVERY condition already passes is refused at
  creation — it cannot fail, so completing it would prove nothing. One
  already-green condition is fine and often right: a regression guard ("the
  suite still passes") is non-discriminating by construction.
- Waive only what the work genuinely cannot fix, and say why. A waiver is
  recorded on the completed goal; `/goal clear` is not an exemption, it
  destroys the goal and the evidence that a gate existed.
