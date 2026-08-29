/**
 * Claude CC Sessions - persistent non-interactive Claude Code sessions
 *
 * Lets the pi agent start and drive long-lived Claude Code sessions:
 *   - cc_spawn: start a session (runs one `claude -p` turn, captures session_id)
 *   - cc_send:  follow up in an existing session (`claude -p --resume <id>`)
 *   - cc_list:  list sessions tracked in this pi process
 *   - cc_attach: re-attach to a raw Claude Code session id (e.g. after pi restart)
 *   - cc_close: mark a session as closed
 *
 * Sessions persist on disk in Claude Code's session store (~/.claude/projects/...),
 * so they survive both tool calls and pi restarts. Each turn is a fresh
 * non-interactive `claude -p` invocation resumed by session id — no long-lived
 * process to babysit.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DEFAULT_PERMISSION_MODE = "acceptEdits";
const DEFAULT_TURN_TIMEOUT_MS = 30 * 60 * 1000; // 30 min per turn
const RESULT_PREVIEW_BYTES = 20 * 1024; // inline cap; full output is always saved to disk

type PermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";

interface CCSession {
	alias: string;
	/** Claude Code session id (uuid) — the actual persistent identifier. */
	sessionId: string;
	label: string;
	cwd: string;
	model?: string;
	permissionMode: PermissionMode;
	createdAt: number;
	lastUsedAt: number;
	turns: number;
	costUsd: number;
	lastResult?: string;
	lastError?: string;
	closed: boolean;
}

const sessions = new Map<string, CCSession>();
let counter = 0;

function nextAlias(): string {
	counter += 1;
	for (;;) {
		const alias = `cc-${counter}`;
		if (!sessions.has(alias)) return alias;
		counter += 1;
	}
}

function trackTimeout(proc: import("node:child_process").ChildProcessWithoutNullStreams, ms: number): void {
	if (!ms || ms <= 0) return;
	setTimeout(() => {
		if (!proc.killed) {
			proc.kill("SIGTERM");
			setTimeout(() => {
				if (!proc.killed) proc.kill("SIGKILL");
			}, 5000).unref?.();
		}
	}, ms).unref?.();
}

function runClaude(
	args: string[],
	cwd: string,
	signal: AbortSignal | undefined,
	timeoutMs: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (code: number, stdout: string, stderr: string) => {
			if (settled) return;
			settled = true;
			resolve({ code, stdout, stderr });
		};

		let proc: import("node:child_process").ChildProcessWithoutNullStreams;
		try {
			proc = spawn("claude", args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
		} catch (err) {
			finish(127, "", `Failed to spawn claude: ${(err as Error).message}`);
			return;
		}

		let stdout = "";
		let stderr = "";
		proc.stdout.on("data", (d) => (stdout += d.toString()));
		proc.stderr.on("data", (d) => (stderr += d.toString()));
		proc.on("error", (err) => finish(127, stdout, stderr + `\n${err.message}`));
		proc.on("close", (code) => finish(code ?? 0, stdout, stderr));

		trackTimeout(proc, timeoutMs);

		if (signal) {
			const kill = () => {
				proc.kill("SIGTERM");
				setTimeout(() => {
					if (!proc.killed) proc.kill("SIGKILL");
				}, 5000).unref?.();
			};
			if (signal.aborted) kill();
			else signal.addEventListener("abort", kill, { once: true });
		}
	});
}

function buildArgs(opts: {
	resumeSessionId?: string;
	model?: string;
	permissionMode: PermissionMode;
	prompt: string;
}): string[] {
	const args = ["-p", "--output-format", "json"];
	if (opts.resumeSessionId) args.push("--resume", opts.resumeSessionId);
	if (opts.model) args.push("--model", opts.model);
	switch (opts.permissionMode) {
		case "bypassPermissions":
			args.push("--permission-mode", "bypassPermissions");
			break;
		case "acceptEdits":
			args.push("--permission-mode", "acceptEdits");
			break;
		case "plan":
			args.push("--permission-mode", "plan");
			break;
		case "default":
			break;
	}
	args.push(opts.prompt);
	return args;
}

function preview(text: string, maxBytes = RESULT_PREVIEW_BYTES): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	let out = text.slice(0, maxBytes);
	while (Buffer.byteLength(out, "utf8") > maxBytes) out = out.slice(0, -1);
	return `${out}\n... [truncated, ${Buffer.byteLength(text) - Buffer.byteLength(out)} bytes omitted]`;
}

function sessionDir(s: CCSession): string {
	const base = path.join(os.tmpdir(), "pi-cc-sessions", s.alias);
	fs.mkdirSync(base, { recursive: true });
	return base;
}

function saveTurnOutput(s: CCSession, kind: string, text: string): string | undefined {
	if (!text) return undefined;
	try {
		const file = path.join(sessionDir(s), `turn-${s.turns}-${kind}.txt`);
		fs.writeFileSync(file, text, "utf8");
		return file;
	} catch {
		return undefined;
	}
}

function sessionLine(s: CCSession): string {
	const state = s.closed ? "closed" : s.lastError ? "last-turn-errored" : "active";
	const cost = s.costUsd > 0 ? `$${s.costUsd.toFixed(4)}` : "";
	const label = s.label ? ` "${s.label}"` : "";
	return `${s.alias}${label} [${state}] turns:${s.turns} ${cost} sid:${s.sessionId} cwd:${s.cwd}`;
}

function parseClaudeResult(stdout: string): Record<string, any> | null {
	const trimmed = stdout.trim();
	if (!trimmed) return null;
	try {
		return JSON.parse(trimmed);
	} catch {
		// stream-json or mixed output: try the last line
		const lines = trimmed.split("\n");
		for (let i = lines.length - 1; i >= 0; i--) {
			try {
				const obj = JSON.parse(lines[i]);
				if (obj && typeof obj === "object" && "type" in obj) return obj;
			} catch {
				/* keep looking */
			}
		}
		return null;
	}
}

const PermissionModeSchema = Type.Union(
	[Type.Literal("default"), Type.Literal("acceptEdits"), Type.Literal("plan"), Type.Literal("bypassPermissions")],
	{ description: `Claude Code permission mode. Default: "${DEFAULT_PERMISSION_MODE}".` },
);

const TimeoutSchema = Type.Optional(
	Type.Number({ description: "Per-turn timeout in milliseconds. Default 1800000 (30 min), 0 = no timeout." }),
);

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "cc_spawn",
		label: "CC Spawn",
		description:
			"Start a persistent non-interactive Claude Code session and run its first turn. " +
			"The session keeps living after this call returns; follow up with cc_send using the returned alias. " +
			"The call blocks until this turn finishes (claude -p with acceptEdits by default).",
		parameters: Type.Object({
			task: Type.String({ description: "First task for the new session." }),
			label: Type.Optional(Type.String({ description: "Short human label for this session (shown in cc_list)." })),
			cwd: Type.Optional(Type.String({ description: "Working directory for the session. Default: current pi cwd." })),
			model: Type.Optional(Type.String({ description: "Model override (e.g. \"sonnet\"). Default: claude's default." })),
			permissionMode: Type.Optional(PermissionModeSchema),
			timeoutMs: TimeoutSchema,
		}),

		async execute(_id, params: any, signal, _onUpdate, ctx) {
			const cwd = params.cwd ? path.resolve(params.cwd) : ctx.cwd;
			const permissionMode: PermissionMode = params.permissionMode ?? DEFAULT_PERMISSION_MODE;
			const timeoutMs = params.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;

			const args = buildArgs({ model: params.model, permissionMode, prompt: params.task });
			const { code, stdout, stderr } = await runClaude(args, cwd, signal, timeoutMs);

			const parsed = parseClaudeResult(stdout);
			const sessionId: string | undefined = parsed?.session_id;
			const result: string = typeof parsed?.result === "string" ? parsed.result : "";
			const isError = (parsed?.is_error ?? false) || code !== 0 || !sessionId;

			if (isError) {
				return {
					content: [
						{
							type: "text",
							text: `cc_spawn failed (exit ${code}).\nstdout: ${preview(stdout, 2000)}\nstderr: ${preview(stderr, 2000)}`,
						},
					],
					isError: true,
				};
			}

			const alias = nextAlias();
			const session: CCSession = {
				alias,
				sessionId,
				label: params.label ?? "",
				cwd,
				model: params.model,
				permissionMode,
				createdAt: Date.now(),
				lastUsedAt: Date.now(),
				turns: 1,
				costUsd: typeof parsed?.total_cost_usd === "number" ? parsed.total_cost_usd : 0,
				lastResult: result,
				closed: false,
			};
			sessions.set(alias, session);

			const fullFile = saveTurnOutput(session, "result", result);
			const savedNote = fullFile ? `\n\nFull output saved: ${fullFile}` : "";

			return {
				content: [
					{
						type: "text",
						text: `Session started: ${alias} (claude session ${sessionId}, cwd ${cwd}, permission ${permissionMode})\n\nFirst turn result:\n${preview(result)}${savedNote}`,
					},
				],
			};
		},
	});

	pi.registerTool({
		name: "cc_send",
		label: "CC Send",
		description:
			"Send a follow-up message to an existing persistent Claude Code session (cc_spawn alias or raw session id). " +
			"Blocks until the turn completes and returns the assistant's reply. The session's full history is preserved between calls.",
		parameters: Type.Object({
			session: Type.String({ description: "cc_spawn alias (e.g. cc-1) or a raw Claude Code session id." }),
			message: Type.String({ description: "Message / next instruction for the session." }),
			permissionMode: Type.Optional(PermissionModeSchema),
			timeoutMs: TimeoutSchema,
		}),

		async execute(_id, params: any, signal, _onUpdate, ctx) {
			const key = params.session;
			const session =
				sessions.get(key) ??
				[...sessions.values()].find((s) => s.sessionId === key);

			let sessionId: string;
			let cwd: string;
			let permissionMode: PermissionMode;
			let model: string | undefined;

			if (session) {
				if (session.closed) {
					return {
						content: [{ type: "text", text: `Session ${session.alias} is closed. Use cc_attach to reopen it by session id, or cc_spawn a new one.` }],
						isError: true,
					};
				}
				sessionId = session.sessionId;
				cwd = session.cwd;
				permissionMode = params.permissionMode ?? session.permissionMode;
				model = session.model;
			} else if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key)) {
				// raw session id, not tracked
				sessionId = key;
				cwd = ctx.cwd;
				permissionMode = params.permissionMode ?? DEFAULT_PERMISSION_MODE;
			} else {
				const known = [...sessions.keys()].join(", ") || "none";
				return {
					content: [{ type: "text", text: `Unknown session "${key}". Tracked aliases: ${known}. For untracked sessions pass the raw Claude Code session id (uuid).` }],
					isError: true,
				};
			}

			const args = buildArgs({ resumeSessionId: sessionId, model, permissionMode, prompt: params.message });
			const { code, stdout, stderr } = await runClaude(args, cwd, signal, params.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS);

			const parsed = parseClaudeResult(stdout);
			const result: string = typeof parsed?.result === "string" ? parsed.result : "";
			const isError = (parsed?.is_error ?? false) || code !== 0 || !result;

			if (session) {
				session.lastUsedAt = Date.now();
				session.turns += 1;
				if (typeof parsed?.total_cost_usd === "number") session.costUsd += parsed.total_cost_usd;
				session.lastResult = result;
				session.lastError = isError ? result || stderr || `exit ${code}` : undefined;
			}

			if (isError) {
				return {
					content: [
						{ type: "text", text: `cc_send to ${key} failed (exit ${code}).\nstdout: ${preview(stdout, 2000)}\nstderr: ${preview(stderr, 2000)}` },
					],
					isError: true,
				};
			}

			const fullFile = session ? saveTurnOutput(session, "result", result) : undefined;
			const savedNote = fullFile ? `\n\nFull output saved: ${fullFile}` : "";

			return {
				content: [
					{ type: "text", text: `[${session?.alias ?? key}] turn ${session?.turns ?? "?"}:\n${preview(result)}${savedNote}` },
				],
			};
		},
	});

	pi.registerTool({
		name: "cc_list",
		label: "CC List",
		description: "List Claude Code sessions tracked in this pi process (alias, state, turns, cost, cwd, session id).",
		parameters: Type.Object({}),

		async execute() {
			const all = [...sessions.values()];
			if (all.length === 0) {
				return { content: [{ type: "text", text: "No tracked Claude Code sessions. Start one with cc_spawn." }] };
			}
			return { content: [{ type: "text", text: all.map(sessionLine).join("\n") }] };
		},
	});

	pi.registerTool({
		name: "cc_attach",
		label: "CC Attach",
		description:
			"Attach to an existing (possibly untracked) Claude Code session by its raw session id (uuid), e.g. after a pi restart. " +
			"Returns a new alias you can use with cc_send.",
		parameters: Type.Object({
			sessionId: Type.String({ description: "Raw Claude Code session id (uuid)." }),
			label: Type.Optional(Type.String({ description: "Short human label." })),
			cwd: Type.Optional(Type.String({ description: "Working directory the session was started in. Default: current pi cwd." })),
		}),

		async execute(_id, params: any, _signal, _onUpdate, ctx) {
			const sessionId = params.sessionId.trim();
			if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) {
				return { content: [{ type: "text", text: `Not a valid session uuid: ${sessionId}` }], isError: true };
			}
			const existing = [...sessions.values()].find((s) => s.sessionId === sessionId);
			if (existing) {
				return { content: [{ type: "text", text: `Already tracked as ${existing.alias}: ${sessionLine(existing)}` }] };
			}
			const alias = nextAlias();
			const session: CCSession = {
				alias,
				sessionId,
				label: params.label ?? "",
				cwd: params.cwd ? path.resolve(params.cwd) : ctx.cwd,
				permissionMode: DEFAULT_PERMISSION_MODE,
				createdAt: Date.now(),
				lastUsedAt: Date.now(),
				turns: 0,
				costUsd: 0,
				closed: false,
			};
			sessions.set(alias, session);
			return {
				content: [
					{
						type: "text",
						text: `Attached: ${alias} (claude session ${sessionId}, cwd ${session.cwd}). Send follow-ups with cc_send. Note: turns/cost tracking starts from now.`,
					},
				],
			};
		},
	});

	pi.registerTool({
		name: "cc_close",
		label: "CC Close",
		description: "Mark a tracked Claude Code session as closed (no more cc_send to it). The on-disk session remains resumable via cc_attach.",
		parameters: Type.Object({
			session: Type.String({ description: "cc_spawn alias or raw session id." }),
		}),

		async execute(_id, params: any) {
			const key = params.session;
			const session = sessions.get(key) ?? [...sessions.values()].find((s) => s.sessionId === key);
			if (!session) {
				return { content: [{ type: "text", text: `Unknown session "${key}".` }], isError: true };
			}
			session.closed = true;
			return { content: [{ type: "text", text: `${session.alias} closed. ${sessionLine(session)}` }] };
		},
	});
}
