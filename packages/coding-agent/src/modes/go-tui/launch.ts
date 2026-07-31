/**
 * Interactive-mode Go frontend handoff.
 *
 * Call before the heavy TS interactive path. Returns:
 * - { action: "handoff", exitCode } — caller must process.exit(exitCode)
 * - { action: "continue-typescript" } — keep existing InteractiveMode
 * - never returns on hard failure when PI_TUI_FRONTEND=go (exits 1)
 *
 * Topology: Bun launcher → Go (inherits TTY) → Bun rpc-ui core on pipes.
 * Core argv keeps resume/continue/fork/model flags; positionals and @file
 * attachments are resolved here and passed as OMP_TUI_BOOTSTRAP_JSON for Go
 * to prompt after Ready.
 */
import {
	OMP_TUI_ACTIVE_ENV,
	PI_TUI_FRONTEND_ENV,
	parseTuiFrontendPreference,
	type TuiFrontendPreference,
} from "./constants";
import { type BuildCoreLaunchResult, buildCoreLaunch } from "./core-argv";
import { type ResolvedOmpTuiBinary, resolveOmpTuiBinary } from "./resolve-binary";
import { spawnGoTuiAndWait } from "./spawn-go-tui";

export type GoTuiLaunchDecision =
	| { action: "handoff"; exitCode: number; binaryPath: string; source: string }
	| { action: "continue-typescript"; reason: string };

export interface TryLaunchGoTuiInput {
	/**
	 * User argv for the coding-agent launch (no execPath / entry script) —
	 * the same vector runRootCommand / launch command sees as rawArgs.
	 */
	userArgs: readonly string[];
	/** True when this process should consider interactive TUI handoff. */
	isInteractiveCandidate: boolean;
	/** Override preference (tests). Default: env PI_TUI_FRONTEND. */
	preference?: TuiFrontendPreference;
	/** Override active-guard detection (tests). */
	tuiActive?: boolean;
	/** Optional core cwd. */
	coreCwd?: string;
	/** Pass --trace to omp-tui. */
	trace?: boolean;
	/** Image auto-resize for @file attachments (settings default true). */
	autoResizeImages?: boolean;
}

function readPreference(override?: TuiFrontendPreference): TuiFrontendPreference {
	if (override) return override;
	return parseTuiFrontendPreference(process.env[PI_TUI_FRONTEND_ENV]);
}

function isTuiActive(override?: boolean): boolean {
	if (override !== undefined) return override;
	const v = process.env[OMP_TUI_ACTIVE_ENV];
	return v === "1" || v === "true" || v === "yes";
}

/**
 * Decide and possibly hand off to Go. Safe to call from runRootCommand when
 * isInteractive is about to start the TS TUI.
 */
export async function tryLaunchGoTui(input: TryLaunchGoTuiInput): Promise<GoTuiLaunchDecision> {
	if (!input.isInteractiveCandidate) {
		return { action: "continue-typescript", reason: "not-interactive" };
	}

	// Nested core under omp-tui must never re-exec Go.
	if (isTuiActive(input.tuiActive)) {
		return { action: "continue-typescript", reason: "recursion-guard" };
	}

	const preference = readPreference(input.preference);
	if (preference === "typescript") {
		return { action: "continue-typescript", reason: "pi-tui-frontend=typescript" };
	}

	let resolved: ResolvedOmpTuiBinary | undefined;
	try {
		resolved = resolveOmpTuiBinary();
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (preference === "go") {
			process.stderr.write(`Error: PI_TUI_FRONTEND=go but omp-tui is unavailable: ${message}\n`);
			process.exit(1);
		}
		// Hard misconfig (bad OMP_TUI_BIN / corrupt embed) — surface, do not hide.
		process.stderr.write(`Error: ${message}\n`);
		process.exit(1);
	}

	if (!resolved) {
		if (preference === "go") {
			process.stderr.write(
				"Error: PI_TUI_FRONTEND=go requires the omp-tui binary, but none was found.\n" +
					"  Dev: build the sibling checkout (`go build -o bin/omp-tui ./cmd/omp-tui` in $RATATUI_GO_ROOT)\n" +
					"  or set OMP_TUI_BIN to an executable.\n" +
					"  Release: rebuild omp so scripts/embed-omp-tui.ts embeds the matching frontend.\n" +
					"  Emergency fallback: PI_TUI_FRONTEND=typescript\n",
			);
			process.exit(1);
		}
		return { action: "continue-typescript", reason: "omp-tui-not-found" };
	}

	let launch: BuildCoreLaunchResult;
	try {
		launch = await buildCoreLaunch(input.userArgs, {
			autoResizeImages: input.autoResizeImages,
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		// @file resolution failure etc. — fail clearly, do not silent-disable Go.
		process.stderr.write(`Error: failed to prepare Go TUI launch: ${message}\n`);
		process.exit(1);
	}

	const result = await spawnGoTuiAndWait({
		binaryPath: resolved.path,
		core: launch.core,
		bootstrap: launch.hasBootstrap ? launch.bootstrap : undefined,
		coreCwd: input.coreCwd,
		trace: input.trace,
	});

	return {
		action: "handoff",
		exitCode: result.exitCode,
		binaryPath: resolved.path,
		source: resolved.source,
	};
}

/**
 * True when the launch path looks like a default interactive session:
 * no explicit --mode, no -p/--print, and both stdin+stdout are TTYs.
 */
export function isInteractiveTtySession(options: {
	mode: string | undefined;
	print: boolean | undefined;
	stdinIsTTY: boolean | undefined;
	stdoutIsTTY: boolean | undefined;
}): boolean {
	if (options.mode !== undefined) return false;
	if (options.print) return false;
	return options.stdinIsTTY === true && options.stdoutIsTTY === true;
}
