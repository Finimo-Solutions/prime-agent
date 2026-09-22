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
		// The refusal must leave the goal running, or the agent escapes anyway.
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
		expect(harness.session.goalState.lastReason).toContain("1 conditions passed");
	});

	it("reports a condition that was already green as proving nothing", async () => {
		const harness = await goalHarness();
		writeFileSync(join(harness.tempDir, "already-there.txt"), "");
		await harness.session.handleGoalHostRequest("goal.create", {
			objective: "a goal whose check cannot fail",
			conditions: ["test -f already-there.txt"],
		});

		await harness.session.handleGoalHostRequest("goal.complete");

		expect(harness.session.goalState.lastReason).toContain("D1");
		expect(harness.session.goalState.lastReason).toContain("prove nothing");
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

	it("reports a condition as red when the command cannot run in its directory", async () => {
		// An unknown binary still spawns `sh` (which exits 127); an unusable
		// working directory is the other failure shape. Both must stay red —
		// a check that cannot run is not a pass.
		const results = await evaluateGoalConditions([{ id: "D1", command: "true" }], {
			cwd: join(tmpdir(), "goal-conditions-directory-that-does-not-exist"),
		});

		expect(results[0]).toMatchObject({ passed: false });
	});

	it("fails a condition that hangs instead of waiting on it forever", async () => {
		const results = await evaluateGoalConditions([{ id: "D1", command: "sleep 30" }], {
			cwd: tmpdir(),
			timeoutMs: 150,
		});

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
