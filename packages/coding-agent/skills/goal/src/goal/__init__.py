"""Prime Agent goal skill: manage the persistent thread goal from the kernel.

All goal state lives in the TypeScript host; these functions are thin typed
wrappers over the generic host bridge (`rlm.host_request`). They only work
inside the Prime Agent Python kernel.
"""

from __future__ import annotations

from typing import Any

from rlm import host_request


async def get() -> dict[str, Any]:
    """Read the current thread goal.

    Returns a dict with `goal` (None when no goal is set), `remaining_tokens`,
    and `completion_budget_report`. The `goal` dict carries the objective,
    status, token budget, and token/elapsed-time usage.
    """
    return await host_request("goal.get")


async def create(
    objective: str,
    token_budget: int | None = None,
    conditions: list[str] | None = None,
) -> dict[str, Any]:
    """Start a new active thread goal.

    Fails while a goal is still pending (active, paused, or budget-limited);
    a completed or errored goal is replaced. Only create a goal when the user
    or system/developer instructions explicitly ask for a persistent
    long-running goal. Set `token_budget` only when an explicit token budget is
    requested.

    `conditions` is the goal's Definition of Done: shell commands, numbered
    D1..Dn, each satisfied when it exits 0. `complete()` is REFUSED while any
    of them fails, so the objective stops being a claim only you can check.
    Each condition is run once at creation to record whether it was already
    green — one that was cannot discriminate, and is reported as proving
    nothing when the goal completes.
    """
    if not isinstance(objective, str):
        raise TypeError(f"objective must be str, got {type(objective).__name__}")
    if token_budget is not None and not isinstance(token_budget, int):
        raise TypeError(f"token_budget must be int or None, got {type(token_budget).__name__}")
    if conditions is not None and not isinstance(conditions, list):
        raise TypeError(f"conditions must be list[str] or None, got {type(conditions).__name__}")
    payload: dict[str, Any] = {"objective": objective}
    if token_budget is not None:
        payload["token_budget"] = token_budget
    if conditions is not None:
        payload["conditions"] = conditions
    return await host_request("goal.create", payload)


async def complete(waive: dict[str, str] | None = None) -> dict[str, Any]:
    """Mark the existing thread goal achieved.

    Use only when the objective has actually been achieved and no required
    work remains — not because the budget is nearly exhausted or because you
    are stopping work. Pause, resume, and budget-limit transitions are
    controlled by the user and the host.

    When the goal carries conditions, the host runs them now and RAISES with
    the failing ones listed rather than completing; the goal stays active.

    `waive` is `{condition_id: reason}` for a condition that is red for a
    reason the work cannot fix (a dead dependency, a moved path). The reason is
    mandatory and is recorded on the completed goal, so an excused check stays
    visible as excused. Do not waive a condition you simply have not satisfied.
    """
    payload: dict[str, Any] = {}
    if waive is not None:
        if not isinstance(waive, dict):
            raise TypeError(f"waive must be dict[str, str] or None, got {type(waive).__name__}")
        payload["waive"] = waive
    return await host_request("goal.complete", payload)
