/**
 * Print mode (single-shot): Send prompts, output result, exit.
 *
 * Used for:
 * - `pi -p "prompt"` - text output
 * - `pi --mode json "prompt"` - JSON event stream
 */

import type { ImageContent } from "@earendil-works/pi-ai";
import type { AgentSessionRuntime } from "../core/agent-session-runtime.js";
import { type AgentAutonomousStatus, type AutonomousLimitReason, autonomousLimitReason } from "../core/autonomous.js";
import { flushRawStdout, writeRawStdout } from "../core/output-guard.js";
import { killTrackedDetachedChildren } from "../utils/shell.js";
import { InProcessAgentConnection } from "./agent-connection/in-process-agent-connection.js";
import type { AgentConnection } from "./agent-connection/types.js";
import { latestAutonomousGateAttempt, selectHeadlessTerminalResult } from "./headless-completion.js";

/**
 * Options for print mode.
 */
export interface PrintModeOptions {
	/** Output mode: "text" for final response only, "json" for all events */
	mode: "text" | "json";
	/** Array of additional prompts to send after initialMessage */
	messages?: string[];
	/** First message to send (may contain @file content) */
	initialMessage?: string;
	/** Images to attach to the initial message */
	initialImages?: ImageContent[];
}

/**
 * Emit tool-call boundaries to STDERR during a print-mode run.
 *
 * WHY THIS EXISTS. Print mode wrote nothing until the run finished, so a run
 * doing real work and a run wedged forever produced byte-identical output:
 * nothing. MEASURED — a log stayed at 0 bytes for 25 minutes while the agent
 * worked, and the only way to tell it was still alive was to stat the session
 * JSONL by hand. That is also why a watchdog cannot be written against the
 * CLI's own output.
 *
 * WHY STDERR. stdout is the result channel for `-p` and feeds pipelines; any
 * progress written there would corrupt them. Progress belongs on stderr, which
 * is exactly the convention, and is not TTY-gated because the case that matters
 * is unattended runs where stderr is a file.
 *
 * WHY ONLY BOUNDARIES. Per-token streaming would make the log unreadable and
 * bury the signal. A start line with no matching end line is precisely the
 * shape of a hang, and it is legible at a glance.
 */
function writeToolProgress(event: { type: string; [key: string]: unknown }, startedAt: Map<string, number>): void {
	const stamp = new Date().toISOString().slice(11, 19);
	if (event.type === "tool_execution_start") {
		const id = typeof event.toolCallId === "string" ? event.toolCallId : "";
		const name = typeof event.toolName === "string" ? event.toolName : "tool";
		if (id) startedAt.set(id, Date.now());
		process.stderr.write(`[${stamp}] → ${name}\n`);
		return;
	}
	if (event.type === "tool_execution_end") {
		const id = typeof event.toolCallId === "string" ? event.toolCallId : "";
		const name = typeof event.toolName === "string" ? event.toolName : "tool";
		const began = id ? startedAt.get(id) : undefined;
		if (id) startedAt.delete(id);
		const elapsed = began === undefined ? "" : ` (${((Date.now() - began) / 1000).toFixed(1)}s)`;
		const failed = event.isError === true ? " ERROR" : "";
		process.stderr.write(`[${stamp}] ← ${name}${elapsed}${failed}\n`);
	}
}

function describeAutonomousLimit(status: AgentAutonomousStatus, reason: AutonomousLimitReason): string {
	if (reason === "maxContinuations") {
		return `maxContinuations reached (${status.continuationsUsed}/${status.limits.maxContinuations})`;
	}
	if (reason === "maxTurns") {
		return `maxTurns reached (${status.turnsUsed}/${status.limits.maxTurns})`;
	}
	if (reason === "maxTokens") {
		return `maxTokens reached (${status.tokensUsed}/${status.limits.maxTokens})`;
	}
	const elapsed = status.startedAt === undefined ? 0 : Math.max(0, Date.now() - status.startedAt);
	return `timeoutMs reached (${elapsed}/${status.limits.timeoutMs})`;
}

/**
 * Run in print (single-shot) mode.
 * Sends prompts to the agent and outputs the result.
 */
export async function runPrintMode(runtimeHost: AgentSessionRuntime, options: PrintModeOptions): Promise<number> {
	const connection = new InProcessAgentConnection(runtimeHost);
	return runPrintModeWithConnectionInternal(connection, options, () => connection.bindHeadlessExtensions());
}

export async function runPrintModeWithConnection(
	connection: AgentConnection,
	options: PrintModeOptions,
): Promise<number> {
	return runPrintModeWithConnectionInternal(connection, options);
}

async function runPrintModeWithConnectionInternal(
	connection: AgentConnection,
	options: PrintModeOptions,
	bindHeadlessExtensions?: () => Promise<void>,
): Promise<number> {
	const { mode, messages = [], initialMessage, initialImages } = options;
	let exitCode = 0;
	let disposed = false;
	let unsubscribe: (() => void) | undefined;
	const signalCleanupHandlers: Array<() => void> = [];

	const disposeConnection = async (): Promise<void> => {
		if (disposed) return;
		disposed = true;
		unsubscribe?.();
		await connection.dispose();
	};

	for (const signal of [
		"SIGINT",
		"SIGTERM",
		...(process.platform === "win32" ? [] : ["SIGHUP"]),
	] as NodeJS.Signals[]) {
		const handler = () => {
			killTrackedDetachedChildren();
			void disposeConnection().finally(() => {
				const exitCode = signal === "SIGINT" ? 130 : signal === "SIGHUP" ? 129 : 143;
				process.exit(exitCode);
			});
		};
		process.on(signal, handler);
		signalCleanupHandlers.push(() => process.off(signal, handler));
	}

	try {
		if (mode === "json") {
			const header = await connection.getSessionHeader();
			if (header) {
				writeRawStdout(`${JSON.stringify(header)}\n`);
			}
		}

		const toolStartedAt = new Map<string, number>();
		unsubscribe = connection.subscribe((event) => {
			if (mode === "json" && event.type === "session_event") {
				writeRawStdout(`${JSON.stringify(event.event)}\n`);
			}
			if (mode === "text" && event.type === "session_event") {
				writeToolProgress(event.event, toolStartedAt);
			}
			if (event.type === "extension_error") {
				console.error(`Extension error (${event.extensionPath}): ${event.error}`);
			}
		});
		await bindHeadlessExtensions?.();

		if (initialMessage) {
			await connection.promptAndWait(initialMessage, { images: initialImages });
		}
		for (const message of messages) {
			await connection.promptAndWait(message);
		}

		const autonomousStatus = await connection.waitForHeadlessCompletion();
		if (mode === "text") {
			const { primary, compactionOutcomes } = selectHeadlessTerminalResult(await connection.getMessages());
			if (primary?.role === "assistant") {
				if (primary.stopReason === "error" || primary.stopReason === "aborted") {
					console.error(primary.errorMessage || `Request ${primary.stopReason}`);
					exitCode = 1;
				} else {
					for (const content of primary.content) {
						if (content.type === "text") {
							writeRawStdout(`${content.text}\n`);
						}
					}
				}
			} else if (primary) {
				writeRawStdout(`${primary.content}\n`);
				if (!primary.details.success || primary.details.severity === "error") exitCode = 1;
			}
			for (const outcome of compactionOutcomes) {
				console.error(outcome.content);
				if (outcome.details.outcome === "failed") exitCode = 1;
			}
		}

		const autonomousLimit = autonomousLimitReason(autonomousStatus);
		if (autonomousStatus.enabled && autonomousStatus.gates.commands.length > 0 && autonomousStatus.lastGateFailure) {
			const limitText = autonomousLimit
				? `; autonomous limit reached: ${describeAutonomousLimit(autonomousStatus, autonomousLimit)}`
				: "";
			console.error(
				`Autonomous quality gate still failing after attempt ${latestAutonomousGateAttempt(autonomousStatus)}/${autonomousStatus.gates.maxRetries}: ${autonomousStatus.lastGateFailure.exitText}${limitText}`,
			);
			exitCode = 1;
		} else if (autonomousStatus.enabled && autonomousStatus.gates.commands.length === 0 && autonomousLimit) {
			console.error(
				`Autonomous run stopped before terminal evidence; ${describeAutonomousLimit(autonomousStatus, autonomousLimit)}`,
			);
			exitCode = 1;
		}

		return exitCode;
	} catch (error: unknown) {
		console.error(error instanceof Error ? error.message : String(error));
		return 1;
	} finally {
		for (const cleanup of signalCleanupHandlers) {
			cleanup();
		}
		await disposeConnection();
		await flushRawStdout();
	}
}
