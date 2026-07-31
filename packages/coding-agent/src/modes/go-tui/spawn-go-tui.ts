/**
 * Spawn omp-tui with inherited real TTY stdio, wait, proxy signals, return exit.
 *
 * Topology: Bun launcher → Go frontend (inherits stdin/stdout/stderr TTY) →
 * Go spawns Bun core `--mode rpc-ui` on private pipes. This launcher does NOT
 * bridge JSONL; it only hands Go the core argv JSON, optional bootstrap JSON,
 * and the recursion guard.
 *
 * No shell. No env dump. Sets OMP_TUI_ACTIVE=1 so a nested Bun core that somehow
 * took the interactive path cannot re-exec Go.
 */
import type { Subprocess } from "bun";
import {
	OMP_CORE_COMMAND_JSON_ENV,
	OMP_CORE_CWD_ENV,
	OMP_TUI_ACTIVE_ENV,
	OMP_TUI_BOOTSTRAP_JSON_ENV,
} from "./constants";
import type { CoreArgvResult, GoTuiBootstrap } from "./core-argv";

export interface SpawnGoTuiOptions {
	/** Absolute path to the omp-tui binary. */
	binaryPath: string;
	/** Core argv (JSON form passed via --core-command-json and env). */
	core: CoreArgvResult;
	/**
	 * Initial prompt/images/queue for Go to deliver after rpc-ui Ready.
	 * Passed as OMP_TUI_BOOTSTRAP_JSON (and --bootstrap-json) — never on core argv.
	 */
	bootstrap?: GoTuiBootstrap;
	/** Working directory for omp-tui itself (default: process.cwd()). */
	cwd?: string;
	/** Optional core cwd override (flag --core-cwd). */
	coreCwd?: string;
	/** Extra env overlay (never used to dump secrets; caller-controlled). */
	envOverlay?: Record<string, string>;
	/** When true, pass --trace to omp-tui. */
	trace?: boolean;
}

export interface SpawnGoTuiResult {
	exitCode: number;
	signal: NodeJS.Signals | null;
}

/** Signals we forward to the child so Ctrl+C / terminate lifecycle match. */
const PROXIED_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
// SIGWINCH: Go is the foreground process group on the inherited TTY and receives
// winch from the kernel directly — do not proxy.

function buildChildEnv(overlay?: Record<string, string>): Record<string, string> {
	// Bun.spawn rejects undefined values; snapshot defined parent env only.
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	if (overlay) {
		for (const [key, value] of Object.entries(overlay)) {
			env[key] = value;
		}
	}
	env[OMP_TUI_ACTIVE_ENV] = "1";
	return env;
}

function bootstrapHasContent(bootstrap: GoTuiBootstrap | undefined): boolean {
	if (!bootstrap) return false;
	return Boolean(
		bootstrap.initialMessage !== undefined ||
			(bootstrap.initialImages && bootstrap.initialImages.length > 0) ||
			(bootstrap.queuedMessages && bootstrap.queuedMessages.length > 0),
	);
}

export async function spawnGoTuiAndWait(options: SpawnGoTuiOptions): Promise<SpawnGoTuiResult> {
	const args: string[] = [options.binaryPath, "--core-command-json", options.core.json];
	if (options.coreCwd) {
		args.push("--core-cwd", options.coreCwd);
	}

	const bootstrapJson = bootstrapHasContent(options.bootstrap) ? JSON.stringify(options.bootstrap) : undefined;
	if (bootstrapJson) {
		// Flag form (no shell). Env form is the primary fallback if Go only reads env.
		args.push("--bootstrap-json", bootstrapJson);
	}
	if (options.trace) {
		args.push("--trace");
	}

	const env = buildChildEnv({
		...options.envOverlay,
		[OMP_CORE_COMMAND_JSON_ENV]: options.core.json,
		...(options.coreCwd ? { [OMP_CORE_CWD_ENV]: options.coreCwd } : {}),
		...(bootstrapJson ? { [OMP_TUI_BOOTSTRAP_JSON_ENV]: bootstrapJson } : {}),
	});

	let child: Subprocess;
	try {
		child = Bun.spawn({
			cmd: args,
			cwd: options.cwd ?? process.cwd(),
			env,
			// Real TTY for Go UI. Go spawns core with private pipes itself.
			stdin: "inherit",
			stdout: "inherit",
			stderr: "inherit",
			windowsHide: true,
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to spawn omp-tui at ${options.binaryPath}: ${message}`);
	}

	const listeners = new Map<NodeJS.Signals, () => void>();
	const attach = (sig: NodeJS.Signals) => {
		const handler = () => {
			try {
				child.kill(sig);
			} catch {
				// Child may already be gone.
			}
		};
		listeners.set(sig, handler);
		process.on(sig, handler);
	};
	for (const sig of PROXIED_SIGNALS) attach(sig);

	try {
		const exitCode = await child.exited;
		const signal = child.signalCode ?? null;
		if (typeof exitCode === "number") {
			return { exitCode, signal };
		}
		return { exitCode: signal ? 1 : 0, signal };
	} finally {
		for (const [sig, handler] of listeners) {
			process.off(sig, handler);
		}
	}
}
