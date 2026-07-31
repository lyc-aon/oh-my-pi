/**
 * Deterministic contracts for Bun → Go TUI launch helpers.
 *
 * Covers exported pure seams in:
 *   constants / core-argv / launch / spawn-go-tui
 *
 * Untestable without source edits (private or process.exit):
 *   - launch.readPreference / launch.isTuiActive (private; covered via
 *     tryLaunchGoTui preference/tuiActive inject + parseTuiFrontendPreference)
 *   - tryLaunchGoTui hard-fail arms that call process.exit(1) when
 *     preference=go and binary missing / resolve throws / buildCoreLaunch throws
 *   - spawn-go-tui.buildChildEnv / bootstrapHasContent (private; observed via
 *     spawnGoTuiAndWait Bun.spawn argv/env)
 *   - spawn signal proxy attach/detach (listeners private; exit/signal mapping
 *     tested via fake Subprocess)
 */
import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	OMP_CORE_COMMAND_JSON_ENV,
	OMP_CORE_CWD_ENV,
	OMP_TUI_ACTIVE_ENV,
	OMP_TUI_BIN_ENV,
	OMP_TUI_BOOTSTRAP_JSON_ENV,
	PI_TUI_FRONTEND_ENV,
	parseTuiFrontendPreference,
} from "@oh-my-pi/pi-coding-agent/modes/go-tui/constants";
import {
	buildCoreArgv,
	buildCoreArgvFromFlags,
	buildCoreLaunch,
	extractCoreFlagArgs,
	resolveSelfCorePrefix,
	stripModeFlags,
} from "@oh-my-pi/pi-coding-agent/modes/go-tui/core-argv";
import { isInteractiveTtySession, tryLaunchGoTui } from "@oh-my-pi/pi-coding-agent/modes/go-tui/launch";
import { resolveOmpTuiBinary } from "@oh-my-pi/pi-coding-agent/modes/go-tui/resolve-binary";
import { spawnGoTuiAndWait } from "@oh-my-pi/pi-coding-agent/modes/go-tui/spawn-go-tui";
import type { Subprocess } from "bun";

const tempDirs: string[] = [];

async function makeTempDir(prefix = "omp-go-tui-launch-"): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

// ── constants ──────────────────────────────────────────────────────────────

describe("parseTuiFrontendPreference", () => {
	test.each([
		[undefined, "auto"],
		["", "auto"],
		["   ", "auto"],
		["auto", "auto"],
		["weird", "auto"],
		["go", "go"],
		["GO", "go"],
		[" golang ", "go"],
		["typescript", "typescript"],
		["TS", "typescript"],
		["js", "typescript"],
	] as const)("%j → %s", (raw, expected) => {
		expect(parseTuiFrontendPreference(raw)).toBe(expected);
	});
});

// ── launch gates ───────────────────────────────────────────────────────────

describe("isInteractiveTtySession", () => {
	test.each([
		[{ mode: undefined, print: undefined, stdinIsTTY: true, stdoutIsTTY: true }, true],
		[{ mode: undefined, print: false, stdinIsTTY: true, stdoutIsTTY: true }, true],
		[{ mode: "rpc-ui", print: undefined, stdinIsTTY: true, stdoutIsTTY: true }, false],
		[{ mode: undefined, print: true, stdinIsTTY: true, stdoutIsTTY: true }, false],
		[{ mode: undefined, print: undefined, stdinIsTTY: false, stdoutIsTTY: true }, false],
		[{ mode: undefined, print: undefined, stdinIsTTY: true, stdoutIsTTY: false }, false],
		[{ mode: undefined, print: undefined, stdinIsTTY: undefined, stdoutIsTTY: true }, false],
	] as const)("%j → %s", (opts, expected) => {
		expect(isInteractiveTtySession(opts)).toBe(expected);
	});
});

describe("tryLaunchGoTui preference + recursion gates", () => {
	test.each([
		{
			name: "not interactive",
			input: { userArgs: [] as const, isInteractiveCandidate: false },
			reason: "not-interactive",
		},
		{
			name: "recursion guard via inject",
			input: { userArgs: [] as const, isInteractiveCandidate: true, tuiActive: true },
			reason: "recursion-guard",
		},
		{
			name: "typescript preference",
			input: {
				userArgs: [] as const,
				isInteractiveCandidate: true,
				tuiActive: false,
				preference: "typescript" as const,
			},
			reason: "pi-tui-frontend=typescript",
		},
	])("$name continues typescript", async ({ input, reason }) => {
		await expect(tryLaunchGoTui(input)).resolves.toEqual({
			action: "continue-typescript",
			reason,
		});
	});

	test("OMP_TUI_ACTIVE env is observed when tuiActive is not injected", async () => {
		const prev = process.env[OMP_TUI_ACTIVE_ENV];
		process.env[OMP_TUI_ACTIVE_ENV] = "1";
		try {
			await expect(tryLaunchGoTui({ userArgs: [], isInteractiveCandidate: true })).resolves.toEqual({
				action: "continue-typescript",
				reason: "recursion-guard",
			});
		} finally {
			if (prev === undefined) delete process.env[OMP_TUI_ACTIVE_ENV];
			else process.env[OMP_TUI_ACTIVE_ENV] = prev;
		}
	});

	test("auto preference continues when no omp-tui binary is resolvable", async () => {
		const emptyRoot = await makeTempDir("omp-tui-empty-root-");
		const prevBin = process.env[OMP_TUI_BIN_ENV];
		const prevRoot = process.env.RATATUI_GO_ROOT;
		// Force env override off and point sibling root at an empty temp tree.
		// Packaged/dev may still resolve on this workstation — if a binary is
		// found we only assert we never process.exit; continue or handoff both ok
		// only when injectable. Prefer continue-typescript via missing path when
		// possible by also poisoning OMP_TUI_BIN with a non-file when we need throw
		// avoidance: leave BIN unset and root empty; packaged may still hit.
		delete process.env[OMP_TUI_BIN_ENV];
		process.env.RATATUI_GO_ROOT = emptyRoot;
		try {
			// Isolate packaged lookup by running with preference typescript already
			// covered; here we only reach resolve when auto + not active.
			// If a packaged/dev binary exists on disk this returns handoff after
			// spawn — so mock spawn and accept either continue(not-found) or handoff.
			const spawnCalls: Array<Record<string, unknown>> = [];
			vi.spyOn(Bun, "spawn").mockImplementation(((opts: { cmd: string[] }) => {
				spawnCalls.push(opts);
				return {
					pid: 1,
					exited: Promise.resolve(0),
					signalCode: null,
					kill: () => true,
				} as unknown as Subprocess;
			}) as typeof Bun.spawn);

			const decision = await tryLaunchGoTui({
				userArgs: [],
				isInteractiveCandidate: true,
				tuiActive: false,
				preference: "auto",
			});

			if (decision.action === "continue-typescript") {
				expect(decision.reason).toBe("omp-tui-not-found");
				expect(spawnCalls).toHaveLength(0);
			} else {
				expect(decision.action).toBe("handoff");
				expect(decision.exitCode).toBe(0);
				expect(typeof decision.binaryPath).toBe("string");
				expect(spawnCalls).toHaveLength(1);
			}
		} finally {
			if (prevBin === undefined) delete process.env[OMP_TUI_BIN_ENV];
			else process.env[OMP_TUI_BIN_ENV] = prevBin;
			if (prevRoot === undefined) delete process.env.RATATUI_GO_ROOT;
			else process.env.RATATUI_GO_ROOT = prevRoot;
		}
	});
});

// ── core argv extraction ───────────────────────────────────────────────────

describe("stripModeFlags", () => {
	test.each([
		[
			["--model", "x", "--mode", "rpc-ui"],
			["--model", "x"],
		],
		[["--mode=text", "--continue"], ["--continue"]],
		[["--mode", "--continue"], ["--continue"]],
		[
			["a", "b"],
			["a", "b"],
		],
	] as const)("%j → %j", (input, expected) => {
		expect(stripModeFlags(input)).toEqual([...expected]);
	});
});

describe("extractCoreFlagArgs", () => {
	test.each([
		{
			name: "keeps string option values (space + equals)",
			input: ["--model", "gpt", "--provider=openai", "--continue", "hello"],
			expected: ["--model", "gpt", "--provider", "openai", "--continue"],
		},
		{
			name: "drops positionals, @files, separator tail, and mode",
			input: ["--mode", "text", "@notes.md", "prompt", "--", "more", "--model", "x"],
			expected: [],
		},
		{
			name: "keeps flags before -- and drops after",
			input: ["--model", "m", "--", "--continue", "x"],
			expected: ["--model", "m"],
		},
		{
			name: "drops UI-only print/help/version flags",
			input: ["--print", "-p", "--print-thoughts", "--help", "-h", "--version", "-v", "--continue"],
			expected: ["--continue"],
		},
		{
			name: "keeps optional resume value and bare resume",
			input: ["--resume", "abc", "-r", "--session=xyz", "--model", "m"],
			expected: ["--resume", "abc", "-r", "--session", "xyz", "--model", "m"],
		},
		{
			name: "drops profile bootstrap boundary marker",
			input: ["--model", "m", "--omp-profile-boundary", "work"],
			expected: ["--model", "m"],
		},
		{
			name: "keeps unknown long option + value-like next",
			input: ["--ext-flag", "val", "positional"],
			expected: ["--ext-flag", "val"],
		},
		{
			name: "does not treat @file as unknown-option value",
			input: ["--ext-flag", "@file.md"],
			expected: ["--ext-flag"],
		},
	] as const)("$name", ({ input, expected }) => {
		expect(extractCoreFlagArgs(input)).toEqual([...expected]);
	});
});

describe("buildCoreArgv / resolveSelfCorePrefix", () => {
	test("forces trailing --mode rpc-ui and json mirrors argv", () => {
		const { argv, json } = buildCoreArgv(["--model", "gpt", "please help", "--mode", "text"]);
		expect(argv.slice(-2)).toEqual(["--mode", "rpc-ui"]);
		expect(argv).toContain("--model");
		expect(argv).toContain("gpt");
		expect(argv).not.toContain("please help");
		expect(argv).not.toContain("text");
		expect(JSON.parse(json)).toEqual(argv);
	});

	test("source-vs-compiled core prefix shape", () => {
		const prefix = resolveSelfCorePrefix();
		expect(prefix.length).toBeGreaterThanOrEqual(1);
		expect(prefix[0]).toBe(process.execPath);
		// Under bun test (source), expect entry script as argv[1] when present.
		// Compiled builds collapse to [execPath] only — both are valid contracts.
		if (prefix.length === 1) {
			expect(prefix).toEqual([process.execPath]);
		} else {
			expect(prefix[1]).toBeTruthy();
			expect(path.isAbsolute(prefix[1]!)).toBe(true);
		}
		const fromFlags = buildCoreArgvFromFlags(["--continue"]);
		expect(fromFlags.argv.slice(0, prefix.length)).toEqual(prefix);
		expect(fromFlags.argv.slice(prefix.length)).toEqual(["--continue", "--mode", "rpc-ui"]);
	});
});

// ── bootstrap package ──────────────────────────────────────────────────────

describe("buildCoreLaunch bootstrap", () => {
	test("primary prompt + queued messages stay off core argv", async () => {
		const result = await buildCoreLaunch(["--model", "gpt", "first", "second", "third"]);
		expect(result.hasBootstrap).toBe(true);
		expect(result.bootstrap).toEqual({
			initialMessage: "first",
			queuedMessages: ["second", "third"],
		});
		expect(result.core.argv).toContain("--model");
		expect(result.core.argv).toContain("gpt");
		expect(result.core.argv).not.toContain("first");
		expect(result.core.argv).not.toContain("second");
		expect(result.core.argv.slice(-2)).toEqual(["--mode", "rpc-ui"]);
	});

	test("empty args → no bootstrap", async () => {
		const result = await buildCoreLaunch(["--continue"]);
		expect(result.hasBootstrap).toBe(false);
		expect(result.bootstrap).toEqual({});
		expect(result.core.argv).toContain("--continue");
	});

	test("@file text becomes initialMessage; images pass through when present", async () => {
		const dir = await makeTempDir();
		const textPath = path.join(dir, "notes.md");
		await Bun.write(textPath, "file body");

		const textOnly = await buildCoreLaunch([`@${textPath}`, "follow-up"]);
		expect(textOnly.hasBootstrap).toBe(true);
		expect(textOnly.bootstrap.initialMessage).toContain("file body");
		// follow-up is folded or queued depending on buildInitialMessage; either way
		// it must not appear on core argv.
		expect(textOnly.core.argv.some(a => a.startsWith("@"))).toBe(false);
		expect(textOnly.core.argv).not.toContain("follow-up");

		// Minimal 1x1 PNG
		const pngPath = path.join(dir, "dot.png");
		const png = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
			"base64",
		);
		await Bun.write(pngPath, png);

		const withImage = await buildCoreLaunch([`@${pngPath}`, "see image"], { autoResizeImages: false });
		expect(withImage.hasBootstrap).toBe(true);
		if (withImage.bootstrap.initialImages && withImage.bootstrap.initialImages.length > 0) {
			expect(withImage.bootstrap.initialImages[0]?.type).toBe("image");
		} else {
			// Some hosts may inline image metadata differently; still require bootstrap content.
			expect(
				withImage.bootstrap.initialMessage !== undefined || (withImage.bootstrap.queuedMessages?.length ?? 0) > 0,
			).toBe(true);
		}
		expect(withImage.core.argv.some(a => a.includes("dot.png"))).toBe(false);
	});
});

// ── spawnGoTuiAndWait ──────────────────────────────────────────────────────

describe("spawnGoTuiAndWait", () => {
	type SpawnOpts = {
		cmd: string[];
		cwd?: string;
		env?: Record<string, string | undefined>;
		stdin?: unknown;
		stdout?: unknown;
		stderr?: unknown;
	};

	function mockSpawn(result: { exitCode: number | null; signal?: NodeJS.Signals | null }) {
		const calls: SpawnOpts[] = [];
		const kills: NodeJS.Signals[] = [];
		vi.spyOn(Bun, "spawn").mockImplementation(((opts: SpawnOpts) => {
			calls.push(opts);
			return {
				pid: 4242,
				exited: Promise.resolve(result.exitCode as number),
				signalCode: result.signal ?? null,
				kill: (sig?: NodeJS.Signals) => {
					if (sig) kills.push(sig);
					return true;
				},
			} as unknown as Subprocess;
		}) as typeof Bun.spawn);
		return { calls, kills };
	}

	test("maps argv, env, stdin inherit, cwd, bootstrap, trace", async () => {
		const { calls } = mockSpawn({ exitCode: 0 });
		const core = {
			argv: ["/bin/omp", "--mode", "rpc-ui"],
			json: JSON.stringify(["/bin/omp", "--mode", "rpc-ui"]),
		};
		const bootstrap = {
			initialMessage: "hi",
			queuedMessages: ["next"],
		};
		const cwd = await makeTempDir();
		const prevActive = process.env[OMP_TUI_ACTIVE_ENV];
		delete process.env[OMP_TUI_ACTIVE_ENV];

		try {
			const out = await spawnGoTuiAndWait({
				binaryPath: "/tmp/fake-omp-tui",
				core,
				bootstrap,
				cwd,
				coreCwd: "/work",
				trace: true,
				envOverlay: { EXTRA_FLAG: "1" },
			});

			expect(out).toEqual({ exitCode: 0, signal: null });
			expect(calls).toHaveLength(1);
			const call = calls[0]!;
			expect(call.cmd[0]).toBe("/tmp/fake-omp-tui");
			expect(call.cmd).toContain("--core-command-json");
			expect(call.cmd).toContain(core.json);
			expect(call.cmd).toContain("--core-cwd");
			expect(call.cmd).toContain("/work");
			expect(call.cmd).toContain("--bootstrap-json");
			expect(call.cmd).toContain(JSON.stringify(bootstrap));
			expect(call.cmd).toContain("--trace");
			expect(call.cwd).toBe(cwd);
			expect(call.stdin).toBe("inherit");
			expect(call.stdout).toBe("inherit");
			expect(call.stderr).toBe("inherit");

			const env = call.env as Record<string, string>;
			expect(env[OMP_TUI_ACTIVE_ENV]).toBe("1");
			expect(env[OMP_CORE_COMMAND_JSON_ENV]).toBe(core.json);
			expect(env[OMP_CORE_CWD_ENV]).toBe("/work");
			expect(env[OMP_TUI_BOOTSTRAP_JSON_ENV]).toBe(JSON.stringify(bootstrap));
			expect(env.EXTRA_FLAG).toBe("1");
		} finally {
			if (prevActive === undefined) delete process.env[OMP_TUI_ACTIVE_ENV];
			else process.env[OMP_TUI_ACTIVE_ENV] = prevActive;
		}
	});

	test("omits bootstrap flag/env when bootstrap is empty", async () => {
		const { calls } = mockSpawn({ exitCode: 7 });
		const core = { argv: ["omp"], json: '["omp"]' };
		const out = await spawnGoTuiAndWait({
			binaryPath: "/bin/omp-tui",
			core,
			bootstrap: {},
		});
		expect(out.exitCode).toBe(7);
		const cmd = calls[0]!.cmd;
		expect(cmd).not.toContain("--bootstrap-json");
		expect(calls[0]!.env?.[OMP_TUI_BOOTSTRAP_JSON_ENV]).toBeUndefined();
	});

	test.each([
		[
			{ exitCode: 0, signal: null as NodeJS.Signals | null },
			{ exitCode: 0, signal: null },
		],
		[
			{ exitCode: 3, signal: null as NodeJS.Signals | null },
			{ exitCode: 3, signal: null },
		],
		[
			{ exitCode: null, signal: "SIGTERM" as NodeJS.Signals },
			{ exitCode: 1, signal: "SIGTERM" },
		],
	] as const)("exit/signal mapping %#", async (child, expected) => {
		mockSpawn(child);
		const out = await spawnGoTuiAndWait({
			binaryPath: "/bin/omp-tui",
			core: { argv: ["x"], json: '["x"]' },
		});
		expect(out).toEqual(expected);
	});

	test("spawn failure becomes Error without exiting the test process", async () => {
		vi.spyOn(Bun, "spawn").mockImplementation((() => {
			throw new Error("ENOENT");
		}) as typeof Bun.spawn);

		await expect(
			spawnGoTuiAndWait({
				binaryPath: "/missing/omp-tui",
				core: { argv: ["x"], json: '["x"]' },
			}),
		).rejects.toThrow(/Failed to spawn omp-tui at \/missing\/omp-tui: ENOENT/);
	});
});

// ── missing-required-binary error surface (pure closest public path) ───────

describe("missing-required-binary error surface", () => {
	test("bad OMP_TUI_BIN throws a clear misconfig Error from resolveOmpTuiBinary", async () => {
		const dir = await makeTempDir();
		const bogus = path.join(dir, "not-a-binary");
		const prev = process.env[OMP_TUI_BIN_ENV];
		process.env[OMP_TUI_BIN_ENV] = bogus;
		try {
			expect(() => resolveOmpTuiBinary()).toThrow(/OMP_TUI_BIN/);
		} finally {
			if (prev === undefined) delete process.env[OMP_TUI_BIN_ENV];
			else process.env[OMP_TUI_BIN_ENV] = prev;
		}
	});

	// Gap: tryLaunchGoTui(preference:"go") on missing binary calls process.exit(1).
	// No injectable exit seam — covered above via resolveOmpTuiBinary throw path
	// and auto→continue-typescript not-found when no binary is present.
	test("PI_TUI_FRONTEND env constant is the preference key", () => {
		expect(PI_TUI_FRONTEND_ENV).toBe("PI_TUI_FRONTEND");
		expect(OMP_TUI_ACTIVE_ENV).toBe("OMP_TUI_ACTIVE");
	});
});
