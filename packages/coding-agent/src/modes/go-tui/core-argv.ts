/**
 * Build the Bun core argv vector that omp-tui will spawn as --mode rpc-ui,
 * and the bootstrap payload Go sends after Ready (initial prompt / images).
 *
 * Core argv keeps session bootstrap flags (continue/resume/fork/model/…) and
 * forces `--mode rpc-ui`. Positionals and @file args are stripped from core
 * argv (rpc-ui rejects @file; RPC core ignores CLI messages). Those become the
 * structured bootstrap payload instead — no shell quoting.
 *
 * Source/dev:  [bunExec, entrypath, ...flags, --mode, rpc-ui]
 * Compiled:    [ompExec, ...flags, --mode, rpc-ui]
 */
import * as path from "node:path";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { isCompiledBinary, workerHostEntry } from "@oh-my-pi/pi-utils";
import { parseArgs } from "../../cli/args";
import { processFileArguments } from "../../cli/file-processor";
import {
	OPTIONAL_VALUE_FLAGS,
	PROFILE_BOOTSTRAP_BOUNDARY_ARG,
	STRING_VALUE_FLAGS,
	VALUELESS_FLAGS,
} from "../../cli/flag-tables";
import { buildInitialMessage } from "../../cli/initial-message";

export interface CoreArgvResult {
	/** Full argv including argv[0] executable. */
	argv: string[];
	/** JSON string of argv, ready for --core-command-json / OMP_CORE_COMMAND_JSON. */
	json: string;
}

/**
 * Structured initial prompt for Go to deliver after rpc-ui Ready.
 * Wire-stable JSON; images are base64 ImageContent (same as TS interactive).
 */
export interface GoTuiBootstrap {
	/** Combined first prompt text (file text + first message), if any. */
	initialMessage?: string;
	/** Image attachments from @file args. */
	initialImages?: ImageContent[];
	/** Remaining positional messages after the first (queued prompts). */
	queuedMessages?: string[];
}

export interface BuildCoreLaunchResult {
	core: CoreArgvResult;
	bootstrap: GoTuiBootstrap;
	/** True when bootstrap carries anything Go must deliver after Ready. */
	hasBootstrap: boolean;
}

/**
 * Strip --mode and its value (`--mode rpc-ui` and `--mode=rpc-ui`).
 */
export function stripModeFlags(args: readonly string[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const a = args[i]!;
		if (a === "--mode") {
			if (i + 1 < args.length && !args[i + 1]!.startsWith("-")) i++;
			continue;
		}
		if (a.startsWith("--mode=")) continue;
		out.push(a);
	}
	return out;
}

/**
 * Keep only flag tokens for the core. Drop:
 * - positional messages
 * - @file attachments
 * - `--` separator
 * - `--mode` (re-added as rpc-ui)
 *
 * Continues/resumes/forks and every other flag stay so core session bootstrap matches.
 */
export function extractCoreFlagArgs(userArgs: readonly string[]): string[] {
	const args = [...userArgs];
	const out: string[] = [];
	let sawSeparator = false;

	for (let i = 0; i < args.length; i++) {
		let arg = args[i]!;
		if (sawSeparator) continue;
		if (arg === PROFILE_BOOTSTRAP_BOUNDARY_ARG) continue;
		if (arg === "--") {
			sawSeparator = true;
			continue;
		}

		// --flag=value → split like parseArgs so classification matches.
		let equalsValue: string | undefined;
		if (arg.startsWith("--") && arg.includes("=")) {
			const eqIdx = arg.indexOf("=");
			equalsValue = arg.slice(eqIdx + 1);
			arg = arg.slice(0, eqIdx);
		}

		if (arg === "--mode" || arg.startsWith("--mode=")) {
			if (equalsValue === undefined && i + 1 < args.length && !args[i + 1]!.startsWith("-")) i++;
			continue;
		}

		if (arg.startsWith("@")) continue;

		if (!arg.startsWith("-") || arg === "-") {
			// positional / stdin marker — bootstrap only
			continue;
		}

		if (STRING_VALUE_FLAGS.has(arg)) {
			out.push(arg);
			if (equalsValue !== undefined) {
				out.push(equalsValue);
			} else if (i + 1 < args.length && args[i + 1] !== PROFILE_BOOTSTRAP_BOUNDARY_ARG) {
				out.push(args[++i]!);
			}
			continue;
		}

		if (OPTIONAL_VALUE_FLAGS.has(arg)) {
			out.push(arg);
			if (equalsValue !== undefined) {
				if (equalsValue.length > 0) out.push(equalsValue);
			} else {
				const next = args[i + 1];
				if (next !== undefined && !next.startsWith("-") && next.length > 0) {
					out.push(args[++i]!);
				}
			}
			continue;
		}

		if (VALUELESS_FLAGS.has(arg) || arg === "-c" || arg === "-p" || arg === "-h" || arg === "-v" || arg === "-r") {
			if (arg === "--print" || arg === "-p" || arg === "--print-thoughts") continue;
			if (arg === "--help" || arg === "-h" || arg === "--version" || arg === "-v") continue;
			out.push(arg);
			continue;
		}

		// Unknown long option: could be extension string flag. Keep flag + value-like next.
		out.push(arg);
		if (equalsValue !== undefined) {
			out.push(equalsValue);
		} else if (i + 1 < args.length) {
			const next = args[i + 1]!;
			if (!next.startsWith("-") && !next.startsWith("@") && next !== PROFILE_BOOTSTRAP_BOUNDARY_ARG) {
				out.push(args[++i]!);
			}
		}
	}

	return out;
}

/** Resolve how this process was invoked so the core re-enters the same binary/entry. */
export function resolveSelfCorePrefix(): string[] {
	if (isCompiledBinary()) {
		return [process.execPath];
	}

	const hostEntry = workerHostEntry();
	if (hostEntry) {
		return [process.execPath, hostEntry];
	}

	const entry = process.argv[1];
	if (entry) {
		const abs = path.isAbsolute(entry) ? entry : path.resolve(entry);
		return [process.execPath, abs];
	}

	return [process.execPath];
}

/** Build core argv from already-split flag tokens (no positionals / @files / mode). */
export function buildCoreArgvFromFlags(flagArgs: readonly string[]): CoreArgvResult {
	const prefix = resolveSelfCorePrefix();
	const stripped = stripModeFlags(flagArgs);
	const argv = [...prefix, ...stripped, "--mode", "rpc-ui"];
	return { argv, json: JSON.stringify(argv) };
}

/**
 * Build core argv: strip mode + positionals + @file, force rpc-ui.
 */
export function buildCoreArgv(userArgs: readonly string[]): CoreArgvResult {
	return buildCoreArgvFromFlags(extractCoreFlagArgs(userArgs));
}

/**
 * Full launch package: core argv + bootstrap prompt/images for Go after Ready.
 * Resolves @file via the same CLI helpers as the TS interactive path.
 */
export async function buildCoreLaunch(
	userArgs: readonly string[],
	options?: { autoResizeImages?: boolean },
): Promise<BuildCoreLaunchResult> {
	const parsed = parseArgs([...userArgs]);
	const flagArgs = extractCoreFlagArgs(userArgs);

	let fileText: string | undefined;
	let fileImages: ImageContent[] | undefined;
	if (parsed.fileArgs.length > 0) {
		const processed = await processFileArguments(parsed.fileArgs, {
			autoResizeImages: options?.autoResizeImages,
		});
		fileText = processed.text || undefined;
		fileImages = processed.images.length > 0 ? processed.images : undefined;
	}

	// Copy messages — buildInitialMessage mutates parsed.messages via shift().
	const messagesCopy = [...parsed.messages];
	const hasFileContext = fileText !== undefined || (fileImages?.length ?? 0) > 0;
	const { initialMessage, initialImages } = buildInitialMessage({
		parsed: { ...parsed, messages: messagesCopy },
		fileText,
		fileImages,
		// Interactive handoff only runs on a real TTY; stdin is not a prompt pipe.
		stdinContent: undefined,
	});

	const bootstrap: GoTuiBootstrap = {};

	if (hasFileContext) {
		if (initialMessage !== undefined) bootstrap.initialMessage = initialMessage;
		if (initialImages && initialImages.length > 0) bootstrap.initialImages = initialImages;
		// messagesCopy was shifted by buildInitialMessage when a message was folded in.
		if (messagesCopy.length > 0) bootstrap.queuedMessages = [...messagesCopy];
	} else if (parsed.messages.length > 0) {
		// No file context: buildInitialMessage returns empty; first positional is the prompt.
		bootstrap.initialMessage = parsed.messages[0];
		if (parsed.messages.length > 1) bootstrap.queuedMessages = parsed.messages.slice(1);
	}

	const hasBootstrap = Boolean(
		bootstrap.initialMessage !== undefined ||
			(bootstrap.initialImages && bootstrap.initialImages.length > 0) ||
			(bootstrap.queuedMessages && bootstrap.queuedMessages.length > 0),
	);

	return {
		core: buildCoreArgvFromFlags(flagArgs),
		bootstrap,
		hasBootstrap,
	};
}
