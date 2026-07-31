import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	buildCoreArgv,
	buildCoreArgvFromFlags,
	buildCoreLaunch,
	extractCoreFlagArgs,
	resolveSelfCorePrefix,
	stripModeFlags,
} from "@oh-my-pi/pi-coding-agent/modes/go-tui/core-argv";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-go-tui-core-argv-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("stripModeFlags", () => {
	it("drops --mode value and --mode=value forms", () => {
		expect(stripModeFlags(["--mode", "rpc-ui", "--continue"])).toEqual(["--continue"]);
		expect(stripModeFlags(["--mode=text", "--model", "x"])).toEqual(["--model", "x"]);
	});

	it("leaves non-mode flags untouched", () => {
		expect(stripModeFlags(["--resume", "sess", "hello"])).toEqual(["--resume", "sess", "hello"]);
	});
});

describe("extractCoreFlagArgs", () => {
	it("keeps session bootstrap flags and their values", () => {
		expect(
			extractCoreFlagArgs(["--continue", "--resume", "abc123", "--model", "gpt-test", "--provider", "openai"]),
		).toEqual(["--continue", "--resume", "abc123", "--model", "gpt-test", "--provider", "openai"]);
	});

	it("preserves --flag=value by splitting into flag + value tokens", () => {
		expect(extractCoreFlagArgs(["--model=claude-x", "--thinking=high"])).toEqual([
			"--model",
			"claude-x",
			"--thinking",
			"high",
		]);
	});

	it("strips positional prompts so they cannot leak onto core argv", () => {
		expect(extractCoreFlagArgs(["--continue", "fix the bug", "and also this"])).toEqual(["--continue"]);
	});

	it("strips @file attachments from core flags", () => {
		expect(extractCoreFlagArgs(["@notes.md", "--model", "m", "@img.png", "prompt"])).toEqual(["--model", "m"]);
	});

	it("strips --mode so core can force rpc-ui later", () => {
		expect(extractCoreFlagArgs(["--mode", "text", "--fork", "sess-id", "prompt here"])).toEqual([
			"--fork",
			"sess-id",
		]);
		expect(extractCoreFlagArgs(["--mode=rpc", "--continue"])).toEqual(["--continue"]);
	});

	it("drops tokens after -- separator (shell-style positionals)", () => {
		expect(extractCoreFlagArgs(["--continue", "--", "--looks-like-flag", "msg"])).toEqual(["--continue"]);
	});

	it("drops print/help/version flags that are not interactive core", () => {
		expect(extractCoreFlagArgs(["-p", "hi", "--print", "--help", "-v", "--continue"])).toEqual(["--continue"]);
	});

	it("does not treat a flag-looking string value as a new flag for known string flags", () => {
		// --system-prompt consumes next token even when it looks like a flag.
		expect(extractCoreFlagArgs(["--system-prompt", "--profile", "extra-msg"])).toEqual([
			"--system-prompt",
			"--profile",
		]);
	});
});

describe("buildCoreArgv / buildCoreArgvFromFlags", () => {
	it("forces trailing --mode rpc-ui on the core argv", () => {
		const { argv, json } = buildCoreArgv(["--continue", "do the thing"]);
		expect(argv.slice(-2)).toEqual(["--mode", "rpc-ui"]);
		expect(argv).not.toContain("do the thing");
		expect(JSON.parse(json)).toEqual(argv);
	});

	it("uses the same self prefix as resolveSelfCorePrefix", () => {
		const prefix = resolveSelfCorePrefix();
		const { argv } = buildCoreArgvFromFlags(["--continue"]);
		expect(argv.slice(0, prefix.length)).toEqual(prefix);
		expect(argv.slice(prefix.length)).toEqual(["--continue", "--mode", "rpc-ui"]);
	});

	it("source/dev shape keeps execPath + entry; never a shell string", () => {
		const { argv, json } = buildCoreArgv(["--model", "m"]);
		expect(argv[0]).toBe(process.execPath);
		// JSON is a real array — no shell joining that would break spaces.
		expect(Array.isArray(JSON.parse(json))).toBe(true);
		expect(json.startsWith("[")).toBe(true);
		expect(json).not.toContain(" --mode rpc-ui");
	});
});

describe("buildCoreLaunch bootstrap", () => {
	it("moves a single positional into bootstrap.initialMessage and off core argv", async () => {
		const launch = await buildCoreLaunch(["--continue", "fix the flaky test"]);
		expect(launch.hasBootstrap).toBe(true);
		expect(launch.bootstrap.initialMessage).toBe("fix the flaky test");
		expect(launch.bootstrap.queuedMessages).toBeUndefined();
		expect(launch.core.argv).not.toContain("fix the flaky test");
		expect(launch.core.argv.slice(-2)).toEqual(["--mode", "rpc-ui"]);
		expect(launch.core.argv).toContain("--continue");
	});

	it("queues remaining positionals after the first prompt", async () => {
		const launch = await buildCoreLaunch(["first prompt", "second", "third"]);
		expect(launch.bootstrap.initialMessage).toBe("first prompt");
		expect(launch.bootstrap.queuedMessages).toEqual(["second", "third"]);
		expect(launch.hasBootstrap).toBe(true);
		for (const msg of ["first prompt", "second", "third"]) {
			expect(launch.core.argv).not.toContain(msg);
		}
	});

	it("folds @text file content into bootstrap and strips @file from core", async () => {
		const dir = await makeTempDir();
		const note = path.join(dir, "note.txt");
		await fs.writeFile(note, "file body\n", "utf8");

		const launch = await buildCoreLaunch([`@${note}`, "user follow-up", "--model", "m1"]);
		expect(launch.hasBootstrap).toBe(true);
		expect(launch.bootstrap.initialMessage).toContain("file body");
		expect(launch.bootstrap.initialMessage).toContain("user follow-up");
		expect(launch.core.argv).toContain("--model");
		expect(launch.core.argv).toContain("m1");
		expect(launch.core.argv.some(a => a.startsWith("@"))).toBe(false);
		expect(launch.core.argv).not.toContain("user follow-up");
	});

	it("puts image @file into bootstrap.initialImages, not core argv", async () => {
		const dir = await makeTempDir();
		// Minimal 1x1 PNG
		const png = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
			"base64",
		);
		const imgPath = path.join(dir, "dot.png");
		await fs.writeFile(imgPath, png);

		const launch = await buildCoreLaunch([`@${imgPath}`, "describe this"], { autoResizeImages: false });
		expect(launch.hasBootstrap).toBe(true);
		expect(launch.bootstrap.initialImages?.length).toBe(1);
		expect(launch.bootstrap.initialImages?.[0]?.type).toBe("image");
		expect(typeof launch.bootstrap.initialImages?.[0]?.data).toBe("string");
		expect(launch.bootstrap.initialMessage !== undefined || (launch.bootstrap.initialImages?.length ?? 0) > 0).toBe(
			true,
		);
		expect(launch.core.argv.some(a => a.startsWith("@"))).toBe(false);
		expect(launch.core.argv).not.toContain("describe this");
	});

	it("reports hasBootstrap false when there is nothing for Go to deliver", async () => {
		const launch = await buildCoreLaunch(["--continue", "--model", "x"]);
		expect(launch.hasBootstrap).toBe(false);
		expect(launch.bootstrap.initialMessage).toBeUndefined();
		expect(launch.bootstrap.initialImages).toBeUndefined();
		expect(launch.bootstrap.queuedMessages).toBeUndefined();
	});
});
