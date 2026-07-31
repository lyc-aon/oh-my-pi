import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	OMP_CORE_COMMAND_JSON_ENV,
	OMP_CORE_CWD_ENV,
	OMP_TUI_ACTIVE_ENV,
	OMP_TUI_BOOTSTRAP_JSON_ENV,
} from "@oh-my-pi/pi-coding-agent/modes/go-tui/constants";
import { spawnGoTuiAndWait } from "@oh-my-pi/pi-coding-agent/modes/go-tui/spawn-go-tui";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-go-tui-spawn-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

/** Tiny fake omp-tui: records argv+env to FAKE_OMP_DUMP, exits with FAKE_EXIT_CODE. */
async function writeFakeOmpTui(dir: string): Promise<string> {
	const bin = path.join(dir, "fake-omp-tui");
	// Small JS script run by process.execPath — no Go/npm.
	const script = path.join(dir, "fake-omp-tui.mjs");
	await fs.writeFile(
		script,
		`
import fs from "node:fs";
const dumpPath = process.env.FAKE_OMP_DUMP;
const payload = {
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  env: {
    OMP_TUI_ACTIVE: process.env.OMP_TUI_ACTIVE ?? null,
    OMP_CORE_COMMAND_JSON: process.env.OMP_CORE_COMMAND_JSON ?? null,
    OMP_CORE_CWD: process.env.OMP_CORE_CWD ?? null,
    OMP_TUI_BOOTSTRAP_JSON: process.env.OMP_TUI_BOOTSTRAP_JSON ?? null,
    FAKE_OVERLAY: process.env.FAKE_OVERLAY ?? null,
  },
};
fs.writeFileSync(dumpPath, JSON.stringify(payload));
process.exit(Number(process.env.FAKE_EXIT_CODE ?? "0"));
`,
		"utf8",
	);
	const wrapper = `#!/bin/sh
exec "${process.execPath}" "${script}" "$@"
`;
	await fs.writeFile(bin, wrapper, { mode: 0o755 });
	await fs.chmod(bin, 0o755);
	return bin;
}

async function readDump(dir: string): Promise<{
	argv: string[];
	cwd: string;
	env: Record<string, string | null>;
}> {
	const dumpPath = path.join(dir, "dump.json");
	return JSON.parse(await fs.readFile(dumpPath, "utf8"));
}

const core = {
	argv: [process.execPath, "/entry.ts", "--mode", "rpc-ui"],
	json: JSON.stringify([process.execPath, "/entry.ts", "--mode", "rpc-ui"]),
};

describe("spawnGoTuiAndWait argv/env/exit", () => {
	it("passes core json via flag and env, sets recursion guard, propagates exit code", async () => {
		const dir = await makeTempDir();
		const dumpPath = path.join(dir, "dump.json");
		const bin = await writeFakeOmpTui(dir);

		const result = await spawnGoTuiAndWait({
			binaryPath: bin,
			core,
			cwd: dir,
			envOverlay: {
				FAKE_OMP_DUMP: dumpPath,
				FAKE_EXIT_CODE: "7",
				FAKE_OVERLAY: "yes",
			},
		});

		expect(result.exitCode).toBe(7);
		const dump = await readDump(dir);
		// argv is what the fake script saw after node/bun — flags from spawn.
		expect(dump.argv[0]).toBe("--core-command-json");
		expect(dump.argv[1]).toBe(core.json);
		expect(dump.argv).not.toContain("--bootstrap-json");
		expect(dump.env.OMP_TUI_ACTIVE).toBe("1");
		expect(dump.env.OMP_CORE_COMMAND_JSON).toBe(core.json);
		expect(dump.env.OMP_TUI_BOOTSTRAP_JSON).toBeNull();
		expect(dump.env.FAKE_OVERLAY).toBe("yes");
		expect(dump.cwd).toBe(await fs.realpath(dir));
	});

	it("passes core cwd and bootstrap json on both flag and env without shell quoting", async () => {
		const dir = await makeTempDir();
		const dumpPath = path.join(dir, "dump.json");
		const bin = await writeFakeOmpTui(dir);
		const bootstrap = {
			initialMessage: 'fix "quotes" and spaces',
			queuedMessages: ["second msg"],
		};

		const result = await spawnGoTuiAndWait({
			binaryPath: bin,
			core,
			coreCwd: "/tmp/core-cwd",
			bootstrap,
			trace: true,
			cwd: dir,
			envOverlay: {
				FAKE_OMP_DUMP: dumpPath,
				FAKE_EXIT_CODE: "0",
			},
		});

		expect(result.exitCode).toBe(0);
		const dump = await readDump(dir);
		const bootJson = JSON.stringify(bootstrap);

		const flagIdx = dump.argv.indexOf("--bootstrap-json");
		expect(flagIdx).toBeGreaterThanOrEqual(0);
		// Value is a single argv element — not shell-split on spaces/quotes.
		expect(dump.argv[flagIdx + 1]).toBe(bootJson);
		expect(JSON.parse(dump.argv[flagIdx + 1]!)).toEqual(bootstrap);

		const cwdIdx = dump.argv.indexOf("--core-cwd");
		expect(dump.argv[cwdIdx + 1]).toBe("/tmp/core-cwd");
		expect(dump.argv).toContain("--trace");

		expect(dump.env[OMP_TUI_BOOTSTRAP_JSON_ENV]).toBe(bootJson);
		expect(dump.env[OMP_CORE_CWD_ENV]).toBe("/tmp/core-cwd");
		expect(dump.env[OMP_CORE_COMMAND_JSON_ENV]).toBe(core.json);
		expect(dump.env[OMP_TUI_ACTIVE_ENV]).toBe("1");
	});

	it("omits bootstrap flag/env when bootstrap has no content", async () => {
		const dir = await makeTempDir();
		const dumpPath = path.join(dir, "dump.json");
		const bin = await writeFakeOmpTui(dir);

		await spawnGoTuiAndWait({
			binaryPath: bin,
			core,
			bootstrap: {},
			cwd: dir,
			envOverlay: { FAKE_OMP_DUMP: dumpPath, FAKE_EXIT_CODE: "0" },
		});

		const dump = await readDump(dir);
		expect(dump.argv).not.toContain("--bootstrap-json");
		expect(dump.env.OMP_TUI_BOOTSTRAP_JSON).toBeNull();
	});

	it("propagates nonzero child exit codes", async () => {
		const dir = await makeTempDir();
		const dumpPath = path.join(dir, "dump.json");
		const bin = await writeFakeOmpTui(dir);

		const result = await spawnGoTuiAndWait({
			binaryPath: bin,
			core,
			cwd: dir,
			envOverlay: {
				FAKE_OMP_DUMP: dumpPath,
				FAKE_EXIT_CODE: "42",
			},
		});
		expect(result.exitCode).toBe(42);
		expect(result.signal === null || typeof result.signal === "string").toBe(true);
	});

	it("throws a clear error when the binary path cannot be spawned", async () => {
		const dir = await makeTempDir();
		const missing = path.join(dir, "no-such-omp-tui");
		await expect(
			spawnGoTuiAndWait({
				binaryPath: missing,
				core,
				cwd: dir,
			}),
		).rejects.toThrow(/Failed to spawn omp-tui/);
	});
});
