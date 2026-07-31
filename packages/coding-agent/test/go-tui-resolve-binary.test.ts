import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { OMP_TUI_BIN_ENV } from "@oh-my-pi/pi-coding-agent/modes/go-tui/constants";
import type { EmbeddedOmpTui } from "@oh-my-pi/pi-coding-agent/modes/go-tui/embedded-omp-tui";
import {
	extractEmbeddedOmpTui,
	OMP_TUI_GO_TARGETS,
	ompTuiBinaryName,
	ompTuiHostStagedBinaryName,
	ompTuiPackagedBinaryDirs,
	ompTuiPlatformTag,
	ompTuiStagedBinaryName,
	ompTuiStagedBinaryNames,
	ompTuiVersionedCacheDir,
	resolveOmpTuiBinary,
	tryPackagedArtifact,
} from "@oh-my-pi/pi-coding-agent/modes/go-tui/resolve-binary";

const tempDirs: string[] = [];
const envKeysTouched = new Set<string>();

function trackEnv(key: string): void {
	envKeysTouched.add(key);
}

async function makeTempDir(prefix = "omp-go-tui-resolve-"): Promise<string> {
	const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function sha256(buf: Buffer | string): string {
	return createHash("sha256").update(buf).digest("hex");
}

function writeExecutable(filePath: string, body = "#!/bin/sh\necho ok\n"): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, body, { mode: 0o755 });
	if (process.platform !== "win32") {
		fs.chmodSync(filePath, 0o755);
	}
}

afterEach(async () => {
	for (const key of envKeysTouched) {
		delete process.env[key];
	}
	envKeysTouched.clear();
	await Promise.all(tempDirs.splice(0).map(dir => fsp.rm(dir, { recursive: true, force: true })));
});

describe("omp-tui platform naming", () => {
	it("builds platform tags and host binary names", () => {
		expect(ompTuiPlatformTag("darwin", "arm64")).toBe("darwin-arm64");
		expect(ompTuiPlatformTag("linux", "x64")).toBe("linux-x64");
		expect(ompTuiBinaryName("darwin")).toBe("omp-tui");
		expect(ompTuiBinaryName("win32")).toBe("omp-tui.exe");
	});

	it("stages every GO target with an explicit platform id in the basename", () => {
		const names = ompTuiStagedBinaryNames();
		expect(names).toHaveLength(OMP_TUI_GO_TARGETS.length);
		expect(names).toEqual([
			"omp-tui.darwin-arm64",
			"omp-tui.darwin-x64",
			"omp-tui.linux-arm64",
			"omp-tui.linux-x64",
			"omp-tui.win32-x64.exe",
		]);
		for (const t of OMP_TUI_GO_TARGETS) {
			expect(ompTuiStagedBinaryName(t)).toContain(t.id);
		}
	});

	it("refuses to invent a staged name for unsupported host platforms", () => {
		expect(ompTuiHostStagedBinaryName("aix" as NodeJS.Platform, "ppc64")).toBeUndefined();
		expect(ompTuiHostStagedBinaryName("darwin", "ia32")).toBeUndefined();
		expect(ompTuiHostStagedBinaryName("darwin", "arm64")).toBe("omp-tui.darwin-arm64");
		expect(ompTuiHostStagedBinaryName("win32", "x64")).toBe("omp-tui.win32-x64.exe");
	});

	it("versioned cache dir nests under omp-tui/<version>", () => {
		const dir = ompTuiVersionedCacheDir("9.9.9-test");
		expect(dir.replaceAll("\\", "/")).toMatch(/omp-tui\/9\.9\.9-test$/);
	});
});

describe("ompTuiPackagedBinaryDirs", () => {
	it("always includes moduleDir/binaries first and dedupes", () => {
		const moduleDir = "/pkg/src/modes/go-tui";
		const dirs = ompTuiPackagedBinaryDirs({
			moduleDir,
			entryPath: "/pkg/dist/cli.js",
			cwd: "/pkg",
		});
		expect(dirs[0]).toBe(path.resolve(moduleDir, "binaries"));
		expect(new Set(dirs).size).toBe(dirs.length);
		expect(dirs).toContain(path.resolve("/pkg/src/modes/go-tui/binaries"));
	});
});

describe("tryPackagedArtifact foreign-platform rejection", () => {
	it("selects only the host-matching staged basename", async () => {
		const dir = await makeTempDir();
		const hostName = ompTuiHostStagedBinaryName("linux", "x64");
		expect(hostName).toBe("omp-tui.linux-x64");
		writeExecutable(path.join(dir, "omp-tui.darwin-arm64"));
		writeExecutable(path.join(dir, "omp-tui")); // bare name must never win
		writeExecutable(path.join(dir, hostName!));

		const hit = tryPackagedArtifact({
			platform: "linux",
			arch: "x64",
			candidateDirs: [dir],
		});
		expect(hit).toEqual({ path: path.join(dir, hostName!), source: "packaged" });
	});

	it("ignores foreign platform assets even when they are the only executables", async () => {
		const dir = await makeTempDir();
		writeExecutable(path.join(dir, "omp-tui.darwin-arm64"));
		writeExecutable(path.join(dir, "omp-tui.win32-x64.exe"));

		const hit = tryPackagedArtifact({
			platform: "linux",
			arch: "arm64",
			candidateDirs: [dir],
		});
		expect(hit).toBeUndefined();
	});

	it("returns undefined for unsupported host instead of picking a neighbor", async () => {
		const dir = await makeTempDir();
		writeExecutable(path.join(dir, "omp-tui.linux-x64"));
		const hit = tryPackagedArtifact({
			platform: "freebsd" as NodeJS.Platform,
			arch: "x64",
			candidateDirs: [dir],
		});
		expect(hit).toBeUndefined();
	});

	it("skips non-executable host-named files", async () => {
		if (process.platform === "win32") return; // execute bit not meaningful
		const dir = await makeTempDir();
		const hostName = ompTuiHostStagedBinaryName("darwin", "arm64")!;
		const p = path.join(dir, hostName);
		fs.writeFileSync(p, "not-exec\n", { mode: 0o644 });
		fs.chmodSync(p, 0o644);
		const hit = tryPackagedArtifact({
			platform: "darwin",
			arch: "arm64",
			candidateDirs: [dir],
		});
		expect(hit).toBeUndefined();
	});
});

describe("extractEmbeddedOmpTui checksum/size/execute/atomic cache", () => {
	it("returns undefined when embed is null or platform mismatches", async () => {
		const cacheDir = await makeTempDir();
		expect(extractEmbeddedOmpTui({ embedded: null, cacheDir })).toBeUndefined();

		const bytesPath = path.join(cacheDir, "payload.bin");
		fs.writeFileSync(bytesPath, "payload-v1");
		const emb: EmbeddedOmpTui = {
			platformTag: "linux-x64",
			version: "1.0.0",
			filename: "omp-tui",
			size: 10,
			sha256: sha256("payload-v1"),
			filePath: bytesPath,
		};
		expect(
			extractEmbeddedOmpTui({
				embedded: emb,
				platformTag: "darwin-arm64",
				cacheDir,
			}),
		).toBeUndefined();
	});

	it("extracts into cache with matching size+sha256 and sets execute bit", async () => {
		const root = await makeTempDir();
		const cacheDir = path.join(root, "cache");
		const bytes = Buffer.from("omp-tui-fake-bytes-v1");
		const bytesPath = path.join(root, "embedded-src.bin");
		fs.writeFileSync(bytesPath, bytes);

		const emb: EmbeddedOmpTui = {
			platformTag: "darwin-arm64",
			version: "2.0.0-test",
			filename: "omp-tui",
			size: bytes.byteLength,
			sha256: sha256(bytes),
			filePath: bytesPath,
		};

		const resolved = extractEmbeddedOmpTui({
			embedded: emb,
			platformTag: "darwin-arm64",
			version: "2.0.0-test",
			cacheDir,
		});
		expect(resolved?.source).toBe("embedded");
		expect(resolved?.path).toBe(path.join(cacheDir, "omp-tui"));
		const st = fs.statSync(resolved!.path);
		expect(st.size).toBe(bytes.byteLength);
		expect(sha256(fs.readFileSync(resolved!.path))).toBe(emb.sha256);
		if (process.platform !== "win32") {
			expect(st.mode & 0o111).not.toBe(0);
		}
		// No leftover temp files from atomic rename.
		const leftovers = fs.readdirSync(cacheDir).filter(n => n.includes(".tmp") || n.startsWith(".omp-tui"));
		expect(leftovers).toEqual([]);
	});

	it("reuses a valid cache hit without rewriting", async () => {
		const root = await makeTempDir();
		const cacheDir = path.join(root, "cache");
		const bytes = Buffer.from("cached-binary-body");
		const target = path.join(cacheDir, "omp-tui");
		fs.mkdirSync(cacheDir, { recursive: true });
		fs.writeFileSync(target, bytes, { mode: 0o755 });
		if (process.platform !== "win32") fs.chmodSync(target, 0o755);
		const mtimeMs = fs.statSync(target).mtimeMs;

		const emb: EmbeddedOmpTui = {
			platformTag: "linux-arm64",
			version: "3.0.0",
			filename: "omp-tui",
			size: bytes.byteLength,
			sha256: sha256(bytes),
			// filePath deliberately missing — cache hit must not need it
		};

		const resolved = extractEmbeddedOmpTui({
			embedded: emb,
			platformTag: "linux-arm64",
			cacheDir,
		});
		expect(resolved?.path).toBe(target);
		expect(fs.statSync(target).mtimeMs).toBe(mtimeMs);
	});

	it("rejects corrupt cache (size mismatch) and re-extracts when source is good", async () => {
		const root = await makeTempDir();
		const cacheDir = path.join(root, "cache");
		const good = Buffer.from("good-bytes-here!!");
		const bytesPath = path.join(root, "src.bin");
		fs.writeFileSync(bytesPath, good);
		fs.mkdirSync(cacheDir, { recursive: true });
		fs.writeFileSync(path.join(cacheDir, "omp-tui"), Buffer.from("CORRUPT"), { mode: 0o755 });

		const emb: EmbeddedOmpTui = {
			platformTag: "darwin-x64",
			version: "4.0.0",
			filename: "omp-tui",
			size: good.byteLength,
			sha256: sha256(good),
			filePath: bytesPath,
		};

		const resolved = extractEmbeddedOmpTui({
			embedded: emb,
			platformTag: "darwin-x64",
			cacheDir,
		});
		expect(fs.readFileSync(resolved!.path).equals(good)).toBe(true);
	});

	it("throws on sha256 mismatch of embedded bytes (no corrupt acceptance)", async () => {
		const root = await makeTempDir();
		const cacheDir = path.join(root, "cache");
		const bytesPath = path.join(root, "src.bin");
		fs.writeFileSync(bytesPath, Buffer.from("actual-bytes"));

		const emb: EmbeddedOmpTui = {
			platformTag: "linux-x64",
			version: "5.0.0",
			filename: "omp-tui",
			size: Buffer.byteLength("actual-bytes"),
			sha256: sha256("different-expected"),
			filePath: bytesPath,
		};

		expect(() =>
			extractEmbeddedOmpTui({
				embedded: emb,
				platformTag: "linux-x64",
				cacheDir,
			}),
		).toThrow(/sha256 mismatch/i);
	});

	it("throws on size mismatch of embedded bytes", async () => {
		const root = await makeTempDir();
		const cacheDir = path.join(root, "cache");
		const bytesPath = path.join(root, "src.bin");
		const body = Buffer.from("twelve-bytes"); // 12
		fs.writeFileSync(bytesPath, body);

		const emb: EmbeddedOmpTui = {
			platformTag: "linux-x64",
			version: "5.1.0",
			filename: "omp-tui",
			size: 99,
			sha256: sha256(body),
			filePath: bytesPath,
		};

		expect(() =>
			extractEmbeddedOmpTui({
				embedded: emb,
				platformTag: "linux-x64",
				cacheDir,
			}),
		).toThrow(/size mismatch/i);
	});

	it("throws when metadata lacks filePath and cache is cold", async () => {
		const cacheDir = await makeTempDir();
		const emb: EmbeddedOmpTui = {
			platformTag: "darwin-arm64",
			version: "6.0.0",
			filename: "omp-tui",
			size: 4,
			sha256: sha256("nope"),
		};
		expect(() =>
			extractEmbeddedOmpTui({
				embedded: emb,
				platformTag: "darwin-arm64",
				cacheDir,
			}),
		).toThrow(/filePath is missing/i);
	});
});

describe("OMP_TUI_BIN env override gate", () => {
	it("throws when OMP_TUI_BIN points at a non-executable path", async () => {
		const dir = await makeTempDir();
		const bad = path.join(dir, "not-a-binary.txt");
		fs.writeFileSync(bad, "nope\n", { mode: 0o644 });
		if (process.platform !== "win32") fs.chmodSync(bad, 0o644);

		trackEnv(OMP_TUI_BIN_ENV);
		process.env[OMP_TUI_BIN_ENV] = bad;

		expect(() => resolveOmpTuiBinary()).toThrow(/OMP_TUI_BIN/);
	});

	it("returns env source when override is an executable file", async () => {
		const dir = await makeTempDir();
		const bin = path.join(dir, "custom-omp-tui");
		writeExecutable(bin, "#!/bin/sh\nexit 0\n");

		trackEnv(OMP_TUI_BIN_ENV);
		process.env[OMP_TUI_BIN_ENV] = bin;

		const resolved = resolveOmpTuiBinary();
		expect(resolved).toEqual({ path: path.resolve(bin), source: "env" });
	});
});
