/**
 * Background Processes Extension
 *
 * Lets Pi start, stop, list, and read logs for long-running local processes
 * like dev servers without tmux. Processes are detached and tracked with PID
 * files under ~/.pi/agent/background-processes/.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, open, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, formatSize, truncateTail } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

type BackgroundAction = "start" | "stop" | "status" | "list" | "logs" | "forget";
type ProcessScope = "project" | "owned" | "all";
type StopSignal = "SIGTERM" | "SIGINT" | "SIGKILL";

type BackgroundProcessInput = {
	action: BackgroundAction;
	name?: string;
	command?: string;
	cwd?: string;
	restart?: boolean;
	lines?: number;
	scope?: ProcessScope;
	signal?: StopSignal;
};

type ProcessRecord = {
	name: string;
	slug: string;
	command: string;
	cwd: string;
	pid: number;
	logFile: string;
	startedAt: string;
	stoppedAt?: string;
	ownerId?: string;
};

const configDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const stateDir = join(configDir, "background-processes");

const processSchema = Type.Object({
	action: StringEnum(["start", "stop", "status", "list", "logs", "forget"] as const, {
		description: "Operation to perform.",
	}),
	name: Type.Optional(
		Type.String({ description: "Process name. Use a stable name like devserver, api, worker, or docs." }),
	),
	command: Type.Optional(Type.String({ description: "Shell command to start. Required for action=start." })),
	cwd: Type.Optional(Type.String({ description: "Working directory. Defaults to the current Pi cwd." })),
	restart: Type.Optional(Type.Boolean({ description: "For action=start, stop an existing running process first." })),
	lines: Type.Optional(Type.Number({ description: "For action=logs, max log lines to return. Defaults to 120." })),
	scope: Type.Optional(
		StringEnum(["project", "owned", "all"] as const, {
			description:
				"For action=list, which records to show. project shows this cwd/project, owned shows this Pi session, all shows every tracked process. Defaults to project.",
		}),
	),
	signal: Type.Optional(
		StringEnum(["SIGTERM", "SIGINT", "SIGKILL"] as const, { description: "Signal for action=stop." }),
	),
});

function slugify(name: string): string {
	return (
		name
			.toLowerCase()
			.replace(/[^a-z0-9._-]+/g, "-")
			.replace(/^-+|-+$/g, "") || "process"
	);
}

function recordPath(nameOrSlug: string): string {
	return join(stateDir, `${slugify(nameOrSlug)}.json`);
}

function logPath(slug: string): string {
	return join(stateDir, `${slug}.log`);
}

async function ensureStateDir() {
	await mkdir(stateDir, { recursive: true });
}

async function readRecord(name: string): Promise<ProcessRecord | undefined> {
	try {
		return JSON.parse(await readFile(recordPath(name), "utf8")) as ProcessRecord;
	} catch {
		return undefined;
	}
}

async function writeRecord(record: ProcessRecord) {
	await ensureStateDir();
	await writeFile(recordPath(record.slug), `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

async function listRecords(): Promise<ProcessRecord[]> {
	await ensureStateDir();
	const files = await readdir(stateDir);
	const records = await Promise.all(
		files
			.filter((file) => file.endsWith(".json"))
			.map(async (file) => {
				try {
					return JSON.parse(await readFile(join(stateDir, file), "utf8")) as ProcessRecord;
				} catch {
					return undefined;
				}
			}),
	);
	return records.filter((record): record is ProcessRecord => Boolean(record));
}

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function statusOf(record: ProcessRecord): "running" | "stopped" {
	return !record.stoppedAt && isPidAlive(record.pid) ? "running" : "stopped";
}

async function sleep(ms: number) {
	await new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function stopProcess(record: ProcessRecord, signal: StopSignal = "SIGTERM") {
	if (statusOf(record) === "stopped") {
		record.stoppedAt = record.stoppedAt ?? new Date().toISOString();
		await writeRecord(record);
		return false;
	}

	try {
		// Detached children get their own process group on POSIX. Kill the group first
		// so child processes created by dev servers are stopped too.
		process.kill(-record.pid, signal);
	} catch {
		try {
			process.kill(record.pid, signal);
		} catch {
			// Already gone.
		}
	}

	for (let i = 0; i < 20; i++) {
		if (!isPidAlive(record.pid)) break;
		await sleep(100);
	}

	if (isPidAlive(record.pid) && signal !== "SIGKILL") {
		try {
			process.kill(-record.pid, "SIGKILL");
		} catch {
			try {
				process.kill(record.pid, "SIGKILL");
			} catch {
				// Already gone.
			}
		}
	}

	record.stoppedAt = new Date().toISOString();
	await writeRecord(record);
	return true;
}

function formatRecord(record: ProcessRecord): string {
	return `${record.name} [${statusOf(record)}] pid=${record.pid}\n  command: ${record.command}\n  cwd: ${record.cwd}\n  log: ${record.logFile}`;
}

function isSameOrNestedPath(first: string, second: string): boolean {
	const a = resolve(first);
	const b = resolve(second);
	return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function filterRecords(records: ProcessRecord[], scope: ProcessScope, cwd: string, ownerId: string): ProcessRecord[] {
	switch (scope) {
		case "owned":
			return records.filter((record) => record.ownerId === ownerId);
		case "all":
			return records;
		case "project":
		default:
			return records.filter((record) => isSameOrNestedPath(record.cwd, cwd));
	}
}

async function tailLog(file: string, maxLines: number) {
	if (!existsSync(file)) return "No log file found.";
	const full = await readFile(file, "utf8");
	const truncation = truncateTail(full, {
		maxLines,
		maxBytes: DEFAULT_MAX_BYTES,
	});

	let output = truncation.content || "(log is empty)";
	if (truncation.truncated) {
		output = `[Log truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(
			truncation.outputBytes,
		)} of ${formatSize(truncation.totalBytes)}). Full log: ${file}]\n\n${output}`;
	}
	return output;
}

type StatusContext = {
	hasUI: boolean;
	cwd: string;
	ui: { setStatus: (key: string, value?: string) => void };
};

async function updateBackgroundStatus(ctx: StatusContext) {
	if (!ctx.hasUI) return;

	const records = filterRecords(await listRecords(), "project", ctx.cwd, "");
	const running = records.filter((record) => statusOf(record) === "running");
	ctx.ui.setStatus(
		"background-processes",
		running.length > 0 ? `bg: ${running.length}/${records.length} running` : undefined,
	);
}

export default function (pi: ExtensionAPI) {
	const runtimeOwnerId = `runtime:${process.pid}:${Date.now()}`;
	let currentOwnerId = runtimeOwnerId;

	function ownerIdFromSession(ctx: { sessionManager?: { getSessionFile?: () => string | undefined } }) {
		return ctx.sessionManager?.getSessionFile?.() ?? runtimeOwnerId;
	}

	async function stopOwnedProcesses(ctx: { sessionManager?: { getSessionFile?: () => string | undefined } }) {
		const ownerId = ownerIdFromSession(ctx);
		const owned = (await listRecords()).filter(
			(record) => record.ownerId === ownerId && statusOf(record) === "running",
		);

		await Promise.all(owned.map((record) => stopProcess(record)));
		return owned.length;
	}

	pi.registerTool({
		name: "background_process",
		label: "Background Process",
		description:
			"Start, stop, list, inspect status, read logs, or forget detached background processes such as dev servers.",
		promptSnippet: "Manage detached background processes such as dev servers, API servers, workers, and docs servers.",
		promptGuidelines: [
			"Use background_process with action=start for long-running commands like dev servers instead of bash, unless the user specifically asks for tmux.",
			"Use background_process with action=list and scope=project to see background processes already managed for the current project, including processes started by other Pi agents on this machine.",
			"Use background_process with action=logs or action=status to inspect a started server before assuming it is healthy.",
			"Use stable background_process names like devserver, api, worker, or docs so later turns can stop or inspect them.",
		],
		parameters: processSchema,
		async execute(_toolCallId, params: BackgroundProcessInput, _signal, _onUpdate, ctx) {
			await ensureStateDir();
			currentOwnerId = ownerIdFromSession(ctx);

			try {
				if (params.action === "list") {
					const scope = params.scope ?? "project";
					const records = filterRecords(await listRecords(), scope, ctx.cwd, currentOwnerId);
					const text = records.length
						? records.map(formatRecord).join("\n\n")
						: `No background processes are tracked for scope=${scope}.`;
					return { content: [{ type: "text", text }], details: { records, scope } };
				}

			const name = params.name?.trim() || "devserver";
			const existing = await readRecord(name);

			if (params.action === "start") {
				if (!params.command?.trim()) throw new Error("action=start requires a command.");

				if (existing && statusOf(existing) === "running") {
					if (!params.restart) {
						return {
							content: [
								{
									type: "text",
									text: `${existing.name} is already running. Use restart=true to restart it.\n\n${formatRecord(existing)}`,
								},
							],
							details: { record: existing, status: "running" },
						};
					}
					await stopProcess(existing);
				}

				const slug = slugify(name);
				const cwd = resolve(ctx.cwd, params.cwd ?? ".");
				const logFile = logPath(slug);
				const logHandle = await open(logFile, "a");
				const shell = process.env.SHELL || "/bin/sh";

				let child;
				try {
					child = spawn(shell, ["-lc", params.command], {
						cwd,
						detached: true,
						stdio: ["ignore", logHandle.fd, logHandle.fd],
						env: process.env,
					});
					child.unref();
				} finally {
					await logHandle.close();
				}

				const record: ProcessRecord = {
					name,
					slug,
					command: params.command,
					cwd,
					pid: child.pid ?? 0,
					logFile,
					startedAt: new Date().toISOString(),
					ownerId: currentOwnerId,
				};
				await writeRecord(record);

				return {
					content: [{ type: "text", text: `Started ${name}.\n\n${formatRecord(record)}` }],
					details: { record, status: statusOf(record) },
				};
			}

			if (!existing) {
				return { content: [{ type: "text", text: `No tracked process named ${name}.` }], details: {} };
			}

			if (params.action === "stop") {
				const stopped = await stopProcess(existing, params.signal ?? "SIGTERM");
				return {
					content: [{ type: "text", text: stopped ? `Stopped ${name}.` : `${name} was already stopped.` }],
					details: { record: existing, stopped },
				};
			}

			if (params.action === "status") {
				return {
					content: [{ type: "text", text: formatRecord(existing) }],
					details: { record: existing, status: statusOf(existing) },
				};
			}

			if (params.action === "logs") {
				const lines = Math.max(1, Math.min(Math.floor(params.lines ?? 120), 2000));
				return {
					content: [{ type: "text", text: await tailLog(existing.logFile, lines) }],
					details: { record: existing, lines },
				};
			}

			if (params.action === "forget") {
				if (statusOf(existing) === "running") {
					return {
						content: [{ type: "text", text: `${name} is still running. Stop it before forgetting it.` }],
						details: { record: existing, status: "running" },
					};
				}
				await rm(recordPath(existing.slug), { force: true });
				return {
					content: [{ type: "text", text: `Forgot ${name}. Log kept at ${existing.logFile}.` }],
					details: { record: existing },
				};
			}

				throw new Error(`Unknown action: ${params.action}`);
			} finally {
				await updateBackgroundStatus(ctx);
			}
		},
	});

	pi.registerCommand("processes", {
		description: "Show tracked background processes for this project. Use /processes all or /processes owned to change scope.",
		handler: async (args, ctx) => {
			const requestedScope = args.trim() as ProcessScope;
			const scope: ProcessScope = ["project", "owned", "all"].includes(requestedScope) ? requestedScope : "project";
			const ownerId = ownerIdFromSession(ctx);
			const records = filterRecords(await listRecords(), scope, ctx.cwd, ownerId);
			const text = records.length
				? records.map(formatRecord).join("\n\n")
				: `No background processes are tracked for scope=${scope}.`;
			if (ctx.hasUI) {
				ctx.ui.setWidget("background-processes", text.split("\n"));
				ctx.ui.notify(`Background processes (${scope}): ${records.length}`, "info");
			}
		},
	});

	pi.registerCommand("processes-clear", {
		description: "Hide the background processes widget",
		handler: async (_args, ctx) => {
			if (ctx.hasUI) ctx.ui.setWidget("background-processes", undefined);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		currentOwnerId = ownerIdFromSession(ctx);
		await updateBackgroundStatus(ctx);
	});

	pi.on("turn_start", async (_event, ctx) => {
		await updateBackgroundStatus(ctx);
	});

	pi.on("turn_end", async (_event, ctx) => {
		await updateBackgroundStatus(ctx);
	});

	pi.on("session_shutdown", async (event, ctx) => {
		// Keep background processes alive across /reload so extension edits do not kill dev servers.
		// Stop them when the owning Pi session exits or is replaced.
		if (event.reason === "reload") return;

		const stopped = await stopOwnedProcesses(ctx);
		if (stopped > 0 && ctx.hasUI) {
			ctx.ui.notify(`Stopped ${stopped} background process${stopped === 1 ? "" : "es"}.`, "info");
		}
	});
}
