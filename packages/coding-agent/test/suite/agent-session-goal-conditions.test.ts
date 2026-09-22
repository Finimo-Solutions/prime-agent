/**
 * A goal's `objective` is prose the host cannot check, so completion has
 * always been the model's own assertion. These tests pin the checkable half:
 * `goal.complete()` must be REFUSED while any Definition-of-Done condition is
 * red, and a condition that was already green before the work started must be
 * reported as proving nothing.
 */

import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateGoalConditions } from "../../src/core/goal-conditions.js";
import { createHarness, type Harness } from "./harness.js";

describe("goal definition-of-done conditions", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length) {
			harnesses.pop()?.cleanup();
		}
	});

	/** The session runs in the harness temp dir, so conditions resolve there. */
	async function goalHarness(): Promise<Harness> {
		const harness = await createHarness({ tools: [] });
		harnesses.push(harness);
		return harness;
	}

	it("refuses completion while a condition is red and keeps the goal active", async () => {
		const harness = await goalHarness();
		await harness.session.handleGoalHostRequest("goal.create", {
			objective: "produce the artefact",
			conditions: ["test -f artefact.txt"],
		});

		await expect(harness.session.handleGoalHostRequest("goal.complete")).rejects.toThrow(
			/cannot complete goal: 1 of 1 conditions are not satisfied/,
		);
		expect(harness.session.goalState).toMatchObject({ status: "active", active: true });
	});

	it("names the failing condition so the model knows what to do", async () => {
		const harness = await goalHarness();
		await harness.session.handleGoalHostRequest("goal.create", {
			objective: "produce two artefacts",
			conditions: ["test -f present.txt", "test -f missing.txt"],
		});
		writeFileSync(join(harness.tempDir, "present.txt"), "");

		await expect(harness.session.handleGoalHostRequest("goal.complete")).rejects.toThrow(/D2.*test -f missing\.txt/s);
	});

	it("carries the failing condition's own output into the refusal", async () => {
		const harness = await goalHarness();
		await harness.session.handleGoalHostRequest("goal.create", {
			objective: "a condition that explains itself",
			conditions: ["ls /zzz-no-such-path"],
		});

		await expect(harness.session.handleGoalHostRequest("goal.complete")).rejects.toThrow(/No such file or directory/);
	});

	it("bounds captured output so one noisy condition cannot flood the goal", async () => {
		const results = await evaluateGoalConditions(
			[{ id: "D1", command: "head -c 60000 /dev/zero | tr '\\0' 'x'; exit 1", baselineExit: 1 }],
			{ cwd: tmpdir() },
		);

		expect(results[0].passed).toBe(false);
		expect(results[0].output).toBeDefined();
		expect((results[0].output ?? "").length).toBeLessThanOrEqual(2000);
		expect(results[0].output).toBe("x".repeat(2000));
	});

	it("completes once the work actually satisfies the condition", async () => {
		const harness = await goalHarness();
		await harness.session.handleGoalHostRequest("goal.create", {
			objective: "produce the artefact",
			conditions: ["test -f artefact.txt"],
		});
		await expect(harness.session.handleGoalHostRequest("goal.complete")).rejects.toThrow();

		writeFileSync(join(harness.tempDir, "artefact.txt"), "done");
		const completed = await harness.session.handleGoalHostRequest("goal.complete");

		expect(completed.goal).toMatchObject({ status: "complete" });
		expect(harness.session.goalState.lastReason).toContain("1 conditions evaluated");
	});

	it("refuses a Definition of Done where every condition already passes", async () => {
		const harness = await goalHarness();
		writeFileSync(join(harness.tempDir, "already-there.txt"), "");

		await expect(
			harness.session.handleGoalHostRequest("goal.create", {
				objective: "a goal whose checks cannot fail",
				conditions: ["test -f already-there.txt", "true"],
			}),
		).rejects.toThrow(/all 2 conditions already pass before any work has started/);
		expect(harness.session.goalState.status).toBe("idle");
	});

	it("allows a regression guard alongside a discriminating condition, and names it", async () => {
		const harness = await goalHarness();
		writeFileSync(join(harness.tempDir, "already-there.txt"), "");
		await harness.session.handleGoalHostRequest("goal.create", {
			objective: "add the artefact without breaking what exists",
			conditions: ["test -f already-there.txt", "test -f new.txt"],
		});
		writeFileSync(join(harness.tempDir, "new.txt"), "");

		await harness.session.handleGoalHostRequest("goal.complete");

		expect(harness.session.goalState.lastReason).toContain("D1");
		expect(harness.session.goalState.lastReason).toContain("prove nothing");
	});

	it("waives a red condition only with a reason, and records it on the goal", async () => {
		const harness = await goalHarness();
		await harness.session.handleGoalHostRequest("goal.create", {
			objective: "blocked by something the work cannot fix",
			conditions: ["test -f unreachable.txt"],
		});

		await expect(harness.session.handleGoalHostRequest("goal.complete", { waive: { D1: "  " } })).rejects.toThrow(
			/requires a non-empty reason/,
		);
		await expect(harness.session.handleGoalHostRequest("goal.complete")).rejects.toThrow(/not satisfied/);

		await harness.session.handleGoalHostRequest("goal.complete", {
			waive: { D1: "staging DNS is down, verified by hand" },
		});

		expect(harness.session.goalState.status).toBe("complete");
		expect(harness.session.goalState.lastReason).toContain("WAIVED D1");
		expect(harness.session.goalState.lastReason).toContain("staging DNS is down");
	});

	it("refuses a waiver on a goal that has no conditions to waive", async () => {
		const h = await goalHarness();
		await h.session.handleGoalHostRequest("goal.create", { objective: "no conditions" });
		const done = h.session.handleGoalHostRequest("goal.complete", { waive: { D1: "nothing" } });
		await expect(done).rejects.toThrow(/goal has none/);
	});

	it("reports conditions left unrun by the total budget as red, never as passed", async () => {
		const results = await evaluateGoalConditions(
			[
				{ id: "D1", command: "sleep 30", baselineExit: 1 },
				{ id: "D2", command: "true", baselineExit: 1 },
			],
			{ cwd: tmpdir(), timeoutMs: 5_000, totalTimeoutMs: 120 },
		);

		expect(results[0]).toMatchObject({ passed: false });
		expect(results[1]).toMatchObject({ passed: false, exitCode: 124 });
		expect(results[1].output).toContain("budget");
	});

	it("treats a condition that cannot run as red rather than crashing", async () => {
		const harness = await goalHarness();
		await harness.session.handleGoalHostRequest("goal.create", {
			objective: "depends on a command that does not exist",
			conditions: ["definitely-not-a-real-binary-xyz"],
		});

		await expect(harness.session.handleGoalHostRequest("goal.complete")).rejects.toThrow(/not satisfied/);
		expect(harness.session.goalState.status).toBe("active");
	});

	it.each([
		{ name: "an unusable working directory", command: "true", cwd: join(tmpdir(), "no-such-dir"), timeoutMs: 5_000 },
		{ name: "a command that hangs", command: "sleep 30", cwd: tmpdir(), timeoutMs: 150 },
	])("reports a condition red when it cannot run: $name", async ({ command, cwd, timeoutMs }) => {
		const results = await evaluateGoalConditions([{ id: "D1", command, baselineExit: 1 }], { cwd, timeoutMs });

		expect(results[0]).toMatchObject({ passed: false });
	});

	it("leaves goals without conditions completing exactly as before", async () => {
		const harness = await goalHarness();
		await harness.session.handleGoalHostRequest("goal.create", { objective: "no conditions supplied" });
		const completed = await harness.session.handleGoalHostRequest("goal.complete");

		expect(completed.goal).toMatchObject({ status: "complete" });
		expect(harness.session.goalState.lastReason).toBe("Goal achieved");
	});

	it("rejects malformed conditions at creation rather than at completion", async () => {
		const harness = await goalHarness();

		await expect(
			harness.session.handleGoalHostRequest("goal.create", { objective: "bad conditions", conditions: [42] }),
		).rejects.toThrow(/must be a shell command string/);
	});
});
