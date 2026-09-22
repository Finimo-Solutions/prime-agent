/**
 * Execution of machine-readable Definition-of-Done conditions attached to a
 * thread goal.
 *
 * A goal's `objective` is prose: the host cannot check it, so completion has
 * always been the model's own assertion. Conditions are the checkable half —
 * each is a shell command, exit 0 means satisfied, and `goal.complete()` is
 * refused while any of them is red.
 *
 * Two rules come from the fleet work-order convention this mirrors:
 *   - a condition must be able to FAIL, so the baseline exit code is recorded
 *     at goal creation and a condition that was already green is reported as
 *     non-discriminating;
 *   - a condition that hangs is a failed condition, hence the timeouts.
 */

import { execCommand } from "./exec.js";
import {
	GOAL_CONDITION_TIMEOUT_MS,
	GOAL_CONDITIONS_TOTAL_TIMEOUT_MS,
	type GoalCondition,
	type GoalConditionInput,
	type GoalConditionResult,
} from "./goals.js";

const MAX_CAPTURED_OUTPUT_CHARS = 2000;

export interface EvaluateGoalConditionsOptions {
	cwd: string;
	signal?: AbortSignal;
	/** Per-condition ceiling. */
	timeoutMs?: number;
	/** Ceiling for the whole set. */
	totalTimeoutMs?: number;
}

/**
 * Run every condition and report each outcome. Never throws for a failing
 * condition — a red condition is a result, not an error; only the caller
 * decides what a red result means.
 */
export async function evaluateGoalConditions(
	conditions: GoalCondition[],
	options: EvaluateGoalConditionsOptions,
): Promise<GoalConditionResult[]> {
	const outcomes = await runAll(conditions, options);
	return conditions.map((condition, index) => {
		const outcome = outcomes[index];
		return {
			id: condition.id,
			command: condition.command,
			passed: outcome.code === 0,
			exitCode: outcome.code,
			nonDiscriminating: outcome.code === 0 && condition.baselineExit === 0,
			output: outcome.output,
		};
	});
}

/**
 * Record how each condition behaves BEFORE any work happens, returning fully
 * baselined conditions. A condition that already exits 0 here can never
 * discriminate, and the caller refuses a set where that is true of all of them.
 *
 * Returning `GoalCondition[]` (whose `baselineExit` is required) is what stops
 * a half-baselined condition ever reaching stored goal state.
 */
export async function captureGoalConditionBaseline(
	conditions: GoalConditionInput[],
	options: EvaluateGoalConditionsOptions,
): Promise<GoalCondition[]> {
	const outcomes = await runAll(conditions, options);
	return conditions.map((condition, index) => ({ ...condition, baselineExit: outcomes[index].code }));
}

/**
 * Sequential on purpose: conditions routinely touch the same working tree
 * (build, then test the build), so racing them would make a red verdict depend
 * on scheduling — and a verdict that is not reproducible cannot serve as
 * evidence. The total budget bounds the worst case; conditions past it are
 * reported red rather than skipped, because an unrun check is not a pass.
 */
async function runAll(
	conditions: readonly GoalConditionInput[],
	options: EvaluateGoalConditionsOptions,
): Promise<{ code: number; output?: string }[]> {
	const perCondition = options.timeoutMs ?? GOAL_CONDITION_TIMEOUT_MS;
	const total = options.totalTimeoutMs ?? GOAL_CONDITIONS_TOTAL_TIMEOUT_MS;
	const deadline = Date.now() + total;
	const outcomes: { code: number; output?: string }[] = [];
	for (const condition of conditions) {
		const remaining = deadline - Date.now();
		if (remaining <= 0) {
			outcomes.push({
				code: 124,
				output: `not run: the ${Math.round(total / 1000)}s budget for the whole Definition of Done was exhausted`,
			});
			continue;
		}
		outcomes.push(
			await runCondition(condition.command, options.cwd, Math.min(perCondition, remaining), options.signal),
		);
	}
	return outcomes;
}

/**
 * `execCommand` never rejects, and a killed process always reports a non-zero
 * code (143 on SIGTERM, 137 on SIGKILL). So every failure shape — missing
 * binary, unusable cwd, timeout — already arrives here as non-zero, and a
 * condition that could not run can never read as satisfied.
 */
async function runCondition(
	command: string,
	cwd: string,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<{ code: number; output?: string }> {
	const result = await execCommand("sh", ["-c", command], cwd, { timeout: timeoutMs, signal });
	const merged = `${result.stdout}${result.stderr}`.trim();
	return {
		code: result.code,
		output: merged ? merged.slice(-MAX_CAPTURED_OUTPUT_CHARS) : undefined,
	};
}
