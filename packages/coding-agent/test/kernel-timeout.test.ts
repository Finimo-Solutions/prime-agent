import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KernelManager } from "../src/core/kernel/index.js";

/**
 * MEASURED WEDGE (the reason this file exists): a cell that spawns a child
 * blocked on stdin never replies. The kernel waits on the child, the agent
 * waits on the kernel, and nothing surfaces — no error, no log line. Killing
 * the blocked child by hand did NOT resume the run, so it is a terminal state
 * reached silently, which is disqualifying for unattended work.
 *
 * These tests use a REAL kernel and a REAL blocked child. A mocked kernel that
 * resolves when asked would prove nothing about the case that actually hangs.
 */
function resolveKernelPython(): string | null {
	const candidates = [
		process.env.PRIME_AGENT_KERNEL_PYTHON,
		join(homedir(), ".prime", "agent", "kernel-venv", "bin", "python"),
	].filter((p): p is string => Boolean(p));
	for (const python of candidates) {
		if (!existsSync(python)) continue;
		const check = spawnSync(python, ["-c", "import ipykernel, dill"], { encoding: "utf8" });
		if (check.status === 0) return python;
	}
	return null;
}

const python = resolveKernelPython();
const describeIfKernel = python ? describe : describe.skip;

/**
 * A child that blocks forever on stdin, reproducing the measured state exactly:
 * fd 0 = PIPE, empty, and never closed.
 *
 * The write end is deliberately held open in the parent. `subprocess.run(...,
 * stdin=PIPE)` does NOT reproduce the wedge — it closes the write end straight
 * away, the child reads EOF and exits in milliseconds. That version of this
 * test passed against an unbounded kernel and proved nothing.
 */
const BLOCK_ON_STDIN_CELL = [
	"import os, subprocess",
	"read_fd, write_fd = os.pipe()  # write_fd stays open -> the child never sees EOF",
	"proc = subprocess.Popen(['bash', '-c', 'read line'], stdin=read_fd)",
	"proc.wait()",
].join("\n");

describeIfKernel("kernel execute timeout (real kernel, real blocked child)", { tags: ["kernel-heavy"] }, () => {
	let manager: KernelManager;

	beforeAll(async () => {
		manager = new KernelManager({ cwd: process.cwd(), python: python ?? undefined });
		await manager.start();
	}, 180_000);

	afterAll(async () => {
		await manager?.dispose?.().catch(() => undefined);
	}, 60_000);

	it("returns a timeout result instead of hanging forever on a child blocked on stdin", async () => {
		const streamed: string[] = [];
		const started = Date.now();

		const result = await manager.execute(BLOCK_ON_STDIN_CELL, {
			timeoutMs: 3000,
			onStream: (chunk, name) => {
				if (name === "stderr") streamed.push(chunk);
			},
		});

		// (a) it SETTLES. Without the bound this promise never resolves and the
		// test dies on vitest's own timeout instead — which is the bug.
		expect(result.status).toBe("timeout");
		// (b) it settles promptly: the bound plus the post-interrupt kill grace,
		// not the 15-minute default and not forever.
		expect(Date.now() - started).toBeLessThan(60_000);
		// (c) it is VISIBLE. A silent timeout is the same observability failure
		// as the silent hang it replaces.
		expect(streamed.join("")).toContain("exceeded");
	}, 120_000);

	it("stays usable after a timeout, so one bad cell does not end the session", async () => {
		// The measured failure was unrecoverable: the run never resumed. The
		// whole point of returning a result is that the next cell still works.
		const after = await manager.execute("print(6 * 7)", { timeoutMs: 60_000 });
		expect(after.status).toBe("ok");
		expect(after.stdout).toContain("42");
	}, 120_000);

	it("does not disturb a cell that finishes inside its bound", async () => {
		const result = await manager.execute("print('quick')", { timeoutMs: 30_000 });
		expect(result.status).toBe("ok");
		expect(result.stdout).toContain("quick");
	}, 120_000);
});
