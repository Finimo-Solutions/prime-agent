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
 *   - a condition that hangs is a failed condition, hence the hard timeout.
 */

import { execCommand } from "./exec.js";
import { GOAL_CONDITION_TIMEOUT_MS, type GoalCondition, type GoalConditionResult } from "./goals.js";

const MAX_CAPTURED_OUTPUT_CHARS = 2000;

export interface EvaluateGoalConditionsOptions {
	cwd: string;
	signal?: AbortSignal;
	timeoutMs?: number;
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
	const timeout = options.timeoutMs ?? GOAL_CONDITION_TIMEOUT_MS;
	const results: GoalConditionResult[] = [];
	for (const condition of conditions) {
		// Sequential on purpose: conditions routinely touch the same working
		// tree (build, then test the build), so racing them would make the
		// verdict depend on scheduling.
		const exitCode = await runCondition(condition.command, options.cwd, timeout, options.signal);
		results.push({
			id: condition.id,
			command: condition.command,
			passed: exitCode.code === 0,
			exitCode: exitCode.code,
			nonDiscriminating: exitCode.code === 0 && condition.baselineExit === 0,
			output: exitCode.output,
		});
	}
	return results;
}

/**
 * Record how each condition behaves BEFORE any work happens. A condition that
 * already exits 0 here can never discriminate, and saying so at creation time
 * is what stops a vacuous Definition of Done being written in the first place.
 */
export async function captureGoalConditionBaseline(
	conditions: GoalCondition[],
	options: EvaluateGoalConditionsOptions,
): Promise<GoalCondition[]> {
	const timeout = options.timeoutMs ?? GOAL_CONDITION_TIMEOUT_MS;
	const baselined: GoalCondition[] = [];
	for (const condition of conditions) {
		const outcome = await runCondition(condition.command, options.cwd, timeout, options.signal);
		baselined.push({ ...condition, baselineExit: outcome.code });
	}
	return baselined;
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
