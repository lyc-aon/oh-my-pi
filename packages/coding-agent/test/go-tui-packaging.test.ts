/**
 * Contracts for go-tui binary resolve + pure embed build plans.
 *
 * Untestable without process/compiler or non-injectable seams:
 * - resolveOmpTuiBinary() full chain (env/embed/packaged/dev) — no inject for
 *   tryEnvOverride / tryDevArtifact / isCompiledBinary; host FS can shadow.
 * - defaultRatatuiGoRoot() monorepo walk + RATATUI_GO_ROOT env.
 * - Atomic extract temp basename (pid/Date.now/random) — only final path checked.
 * - planGoBuild tempPath uniqueness entropy — pattern + per-target isolation only.
 * - CLI main / real `go build` / npm pack (explicitly out of scope).
 */

import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { planAllTargetBuilds, planGoBuild } from "../scripts/embed-omp-tui";
import { OMP_TUI_PACKAGE } from "../src/modes/go-tui/constants";
import {
	extractEmbeddedOmpTui,
	OMP_TUI_GO_TARGETS,
	type OmpTuiGoTarget,
	ompTuiBinaryName,
	ompTuiHostStagedBinaryName,
	ompTuiPackagedBinaryDirs,
	ompTuiPlatformTag,
	ompTuiStagedBinaryName,
	ompTuiStagedBinaryNames,
	ompTuiVersionedCacheDir,
	tryPackagedArtifact,
} from "../src/modes/go-tui/resolve-binary";

const EXPECTED_TARGETS: readonly {
	id: string;
	goos: string;
	goarch: string;
	platform: string;
	arch: string;
	filename: string;
}[] = [
	{ id: "darwin-arm64", goos: "darwin", goarch: "arm64", platform: "darwin", arch: "arm64", filename: "omp-tui" },
	{ id: "darwin-x64", goos: "darwin", goarch: "amd64", platform: "darwin", arch: "x64", filename: "omp-tui" },
	{ id: "linux-arm64", goos: "linux", goarch: "arm64", platform: "linux", arch: "arm64", filename: "omp-tui" },
	{ id: "linux-x64", goos: "linux", goarch: "amd64", platform: "linux", arch: "x64", filename: "omp-tui" },
	{ id: "win32-x64", goos: "windows", goarch: "amd64", platform: "win32", arch: "x64", filename: "omp-tui.exe" },
];

const temps: string[] = [];

function mkTempDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	temps.push(dir);
	return dir;
}

function writeExec(filePath: string, body: string | Uint8Array = "#!/bin/sh\n"): string {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, body, { mode: 0o755 });
	if (process.platform !== "win32") fs.chmodSync(filePath, 0o755);
	return filePath;
}

function digest(buf: Uint8Array | string): string {
	return createHash("sha256").update(buf).digest("hex");
}

afterEach(() => {
	while (temps.length) {
		const p = temps.pop();
		if (!p) continue;
		try {
			fs.rmSync(p, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	}
});

describe("OMP_TUI_GO_TARGETS matrix", () => {
	it("exposes exactly five supported targets with GOOS/GOARCH mapping", () => {
		expect(OMP_TUI_GO_TARGETS).toHaveLength(5);
		expect(OMP_TUI_GO_TARGETS.map(t => t.id)).toEqual(EXPECTED_TARGETS.map(t => t.id));
		for (let i = 0; i < EXPECTED_TARGETS.length; i++) {
			const got = OMP_TUI_GO_TARGETS[i]!;
			const exp = EXPECTED_TARGETS[i]!;
			expect(got).toMatchObject(exp);
			expect(ompTuiPlatformTag(got.platform as NodeJS.Platform, got.arch)).toBe(got.id);
		}
	});

	it("names staged binaries with platform tag and win32 .exe only", () => {
		expect(ompTuiStagedBinaryName(OMP_TUI_GO_TARGETS[0]!)).toBe("omp-tui.darwin-arm64");
		expect(ompTuiStagedBinaryName(OMP_TUI_GO_TARGETS[4]!)).toBe("omp-tui.win32-x64.exe");
		expect(ompTuiStagedBinaryNames()).toEqual([
			"omp-tui.darwin-arm64",
			"omp-tui.darwin-x64",
			"omp-tui.linux-arm64",
			"omp-tui.linux-x64",
			"omp-tui.win32-x64.exe",
		]);
		expect(ompTuiBinaryName("darwin")).toBe("omp-tui");
		expect(ompTuiBinaryName("win32")).toBe("omp-tui.exe");
	});
});

describe("host matching and foreign rejection", () => {
	it("returns host staged name only for matrix platforms", () => {
		expect(ompTuiHostStagedBinaryName("darwin", "arm64")).toBe("omp-tui.darwin-arm64");
		expect(ompTuiHostStagedBinaryName("darwin", "x64")).toBe("omp-tui.darwin-x64");
		expect(ompTuiHostStagedBinaryName("linux", "arm64")).toBe("omp-tui.linux-arm64");
		expect(ompTuiHostStagedBinaryName("linux", "x64")).toBe("omp-tui.linux-x64");
		expect(ompTuiHostStagedBinaryName("win32", "x64")).toBe("omp-tui.win32-x64.exe");
		expect(ompTuiHostStagedBinaryName("freebsd" as NodeJS.Platform, "x64")).toBeUndefined();
		expect(ompTuiHostStagedBinaryName("darwin", "ia32")).toBeUndefined();
		expect(ompTuiHostStagedBinaryName("win32", "arm64")).toBeUndefined();
	});

	it("tryPackagedArtifact ignores bare names and foreign tags", () => {
		const dir = mkTempDir("omp-tui-pack-");
		const hostName = ompTuiHostStagedBinaryName("linux", "x64")!;
		const foreign = ompTuiStagedBinaryName(OMP_TUI_GO_TARGETS[0]!);
		writeExec(path.join(dir, "omp-tui"));
		writeExec(path.join(dir, foreign));
		writeExec(path.join(dir, "omp-tui.win32-x64.exe"));

		expect(
			tryPackagedArtifact({
				platform: "linux",
				arch: "x64",
				candidateDirs: [dir],
			}),
		).toBeUndefined();

		const hostPath = writeExec(path.join(dir, hostName), "host-linux-x64");
		const hit = tryPackagedArtifact({
			platform: "linux",
			arch: "x64",
			candidateDirs: [dir],
		});
		expect(hit).toEqual({ path: hostPath, source: "packaged" });

		// Foreign host: only that tag is eligible even if host file sits beside it.
		expect(
			tryPackagedArtifact({
				platform: "darwin",
				arch: "arm64",
				candidateDirs: [dir],
			}),
		).toEqual({ path: path.join(dir, foreign), source: "packaged" });
	});

	it("rejects directories even when named like the host staged binary", () => {
		const dir = mkTempDir("omp-tui-dir-");
		const name = ompTuiHostStagedBinaryName("darwin", "arm64")!;
		fs.mkdirSync(path.join(dir, name));
		expect(
			tryPackagedArtifact({
				platform: "darwin",
				arch: "arm64",
				candidateDirs: [dir],
			}),
		).toBeUndefined();
	});
});

describe("packaged binary dir candidates and precedence", () => {
	it("lists unique candidate dirs from module/entry/cwd probes", () => {
		const moduleDir = "/pkg/src/modes/go-tui";
		const entryPath = "/install/dist/cli.js";
		const cwd = "/ws/coding-agent";
		const dirs = ompTuiPackagedBinaryDirs({ moduleDir, entryPath, cwd });
		const resolved = dirs.map(d => path.resolve(d));
		expect(new Set(resolved).size).toBe(resolved.length);
		expect(resolved).toContain(path.resolve(moduleDir, "binaries"));
		expect(resolved).toContain(path.resolve(moduleDir, "src", "modes", "go-tui", "binaries"));
		expect(resolved).toContain(path.resolve("/install/dist", "src", "modes", "go-tui", "binaries"));
		expect(resolved).toContain(path.resolve("/install", "src", "modes", "go-tui", "binaries"));
		expect(resolved).toContain(path.resolve(cwd, "src", "modes", "go-tui", "binaries"));
		expect(resolved).toContain(path.resolve(cwd, "modes", "go-tui", "binaries"));
	});

	it("walks candidateDirs in order and returns first executable host match", () => {
		const first = mkTempDir("omp-tui-c1-");
		const second = mkTempDir("omp-tui-c2-");
		const name = ompTuiHostStagedBinaryName("linux", "arm64")!;
		writeExec(path.join(second, name), "second");
		// empty first dir → fall through
		expect(
			tryPackagedArtifact({
				platform: "linux",
				arch: "arm64",
				candidateDirs: [first, second],
			}),
		).toEqual({ path: path.join(second, name), source: "packaged" });

		const firstHit = writeExec(path.join(first, name), "first");
		expect(
			tryPackagedArtifact({
				platform: "linux",
				arch: "arm64",
				candidateDirs: [first, second],
			}),
		).toEqual({ path: firstHit, source: "packaged" });
	});
});

describe("extractEmbeddedOmpTui cache checksum/size", () => {
	it("returns undefined when embed missing or platformTag mismatches", () => {
		expect(extractEmbeddedOmpTui({ embedded: null })).toBeUndefined();
		const cacheDir = mkTempDir("omp-tui-emb-miss-");
		const src = path.join(cacheDir, "src.bin");
		const bytes = Buffer.from("payload-a");
		fs.writeFileSync(src, bytes);
		expect(
			extractEmbeddedOmpTui({
				embedded: {
					platformTag: "linux-x64",
					version: "9.9.9",
					filename: "omp-tui",
					size: bytes.byteLength,
					sha256: digest(bytes),
					filePath: src,
				},
				platformTag: "darwin-arm64",
				cacheDir,
			}),
		).toBeUndefined();
	});

	it("extracts valid embed atomically into versioned cache and reuses cache hit", () => {
		const root = mkTempDir("omp-tui-emb-ok-");
		const src = path.join(root, "embedded.bin");
		const cacheDir = path.join(root, "cache");
		const bytes = Buffer.from("valid-omp-tui-bytes");
		fs.writeFileSync(src, bytes);
		const hex = digest(bytes);
		const emb = {
			platformTag: "darwin-arm64",
			version: "1.2.3",
			filename: "omp-tui",
			size: bytes.byteLength,
			sha256: hex,
			filePath: src,
		};

		const first = extractEmbeddedOmpTui({
			embedded: emb,
			platformTag: "darwin-arm64",
			version: "1.2.3",
			cacheDir,
		});
		expect(first).toEqual({ path: path.join(cacheDir, "omp-tui"), source: "embedded" });
		expect(fs.readFileSync(first!.path)).toEqual(bytes);
		if (process.platform !== "win32") {
			expect(fs.statSync(first!.path).mode & 0o111).not.toBe(0);
		}
		// no leftover temps
		const leftovers = fs.readdirSync(cacheDir).filter(n => n.endsWith(".tmp") || n.startsWith(".omp-tui"));
		expect(leftovers.filter(n => n !== "omp-tui")).toEqual([]);

		// mutate source; cache hit must still win on size+sha of target
		fs.writeFileSync(src, Buffer.from("changed-source-ignored"));
		const second = extractEmbeddedOmpTui({
			embedded: emb,
			platformTag: "darwin-arm64",
			version: "1.2.3",
			cacheDir,
		});
		expect(second).toEqual(first);
		expect(fs.readFileSync(second!.path)).toEqual(bytes);
	});

	it("throws on size or sha256 mismatch before cache write", () => {
		const root = mkTempDir("omp-tui-emb-bad-");
		const src = path.join(root, "bad.bin");
		const cacheDir = path.join(root, "cache");
		const bytes = Buffer.from("actual-bytes");
		fs.writeFileSync(src, bytes);

		expect(() =>
			extractEmbeddedOmpTui({
				embedded: {
					platformTag: "linux-x64",
					version: "0.0.1",
					filename: "omp-tui",
					size: bytes.byteLength + 7,
					sha256: digest(bytes),
					filePath: src,
				},
				platformTag: "linux-x64",
				cacheDir,
			}),
		).toThrow(/size mismatch/);

		expect(() =>
			extractEmbeddedOmpTui({
				embedded: {
					platformTag: "linux-x64",
					version: "0.0.1",
					filename: "omp-tui",
					size: bytes.byteLength,
					sha256: "0".repeat(64),
					filePath: src,
				},
				platformTag: "linux-x64",
				cacheDir,
			}),
		).toThrow(/sha256 mismatch/);

		expect(fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir) : []).toEqual([]);
	});

	it("throws when metadata lacks filePath and cache is cold", () => {
		const cacheDir = mkTempDir("omp-tui-emb-nopath-");
		expect(() =>
			extractEmbeddedOmpTui({
				embedded: {
					platformTag: "darwin-x64",
					version: "2.0.0",
					filename: "omp-tui",
					size: 4,
					sha256: digest("nope"),
				},
				platformTag: "darwin-x64",
				cacheDir,
			}),
		).toThrow(/filePath is missing/);
	});

	it("invalidates corrupt cache and re-extracts when size/sha disagree", () => {
		const root = mkTempDir("omp-tui-emb-corrupt-");
		const src = path.join(root, "good.bin");
		const cacheDir = path.join(root, "cache");
		const good = Buffer.from("good-binary");
		fs.writeFileSync(src, good);
		const emb = {
			platformTag: "linux-arm64",
			version: "3.0.0",
			filename: "omp-tui",
			size: good.byteLength,
			sha256: digest(good),
			filePath: src,
		};
		// Seed corrupt cache entry
		fs.mkdirSync(cacheDir, { recursive: true });
		fs.writeFileSync(path.join(cacheDir, "omp-tui"), Buffer.from("CORRUPT"), { mode: 0o755 });

		const hit = extractEmbeddedOmpTui({
			embedded: emb,
			platformTag: "linux-arm64",
			cacheDir,
		});
		expect(hit?.source).toBe("embedded");
		expect(fs.readFileSync(hit!.path)).toEqual(good);
	});

	it("ompTuiVersionedCacheDir nests under cache dirname + version", () => {
		const dir = ompTuiVersionedCacheDir("16.1.15");
		expect(path.basename(dir)).toBe("16.1.15");
		expect(path.basename(path.dirname(dir))).toBe("omp-tui");
	});
});

describe("planGoBuild / planAllTargetBuilds", () => {
	const root = "/tmp/ratatui-go-fixture";
	const binariesDir = "/tmp/omp-binaries-fixture";

	it("plans exact GOOS/GOARCH/CGO/trimpath/ldflags for one target", () => {
		const target = OMP_TUI_GO_TARGETS.find(t => t.id === "linux-x64")!;
		const plan = planGoBuild(target, { root, binariesDir });
		expect(plan.target).toBe(target);
		expect(plan.cwd).toBe(root);
		expect(plan.outputPath).toBe(path.join(binariesDir, "omp-tui.linux-x64"));
		expect(plan.env).toEqual({ CGO_ENABLED: "0", GOOS: "linux", GOARCH: "amd64" });
		expect(plan.command).toEqual([
			"go",
			"build",
			"-trimpath",
			"-ldflags=-s -w",
			"-o",
			plan.tempPath,
			OMP_TUI_PACKAGE,
		]);
		expect(plan.command[5]).toBe(plan.tempPath);
		expect(path.dirname(plan.tempPath)).toBe(binariesDir);
		expect(path.basename(plan.tempPath)).toMatch(/^\.omp-tui\.linux-x64\.\d+\.\d+\.[0-9a-f]+\.tmp$/);
		expect(plan.tempPath).not.toBe(plan.outputPath);
	});

	it("win32 plan keeps .exe on temp and final names", () => {
		const target = OMP_TUI_GO_TARGETS.find(t => t.id === "win32-x64")!;
		const plan = planGoBuild(target, { root, binariesDir, outputPath: path.join(binariesDir, "custom.exe") });
		expect(plan.env).toEqual({ CGO_ENABLED: "0", GOOS: "windows", GOARCH: "amd64" });
		expect(plan.outputPath).toBe(path.join(binariesDir, "custom.exe"));
		expect(path.basename(plan.tempPath)).toMatch(/^\.omp-tui\.win32-x64\.\d+\.\d+\.[0-9a-f]+\.tmp\.exe$/);
	});

	it("planAllTargetBuilds covers every matrix entry with unique scoped paths", () => {
		const plans = planAllTargetBuilds({ root, binariesDir });
		expect(plans).toHaveLength(OMP_TUI_GO_TARGETS.length);
		expect(plans.map(p => p.target.id)).toEqual(OMP_TUI_GO_TARGETS.map(t => t.id));

		const finals = new Set<string>();
		const tempsSet = new Set<string>();
		for (const plan of plans) {
			const t = plan.target as OmpTuiGoTarget;
			expect(plan.env.CGO_ENABLED).toBe("0");
			expect(plan.env.GOOS).toBe(t.goos);
			expect(plan.env.GOARCH).toBe(t.goarch);
			expect(plan.command.slice(0, 4)).toEqual(["go", "build", "-trimpath", "-ldflags=-s -w"]);
			expect(plan.command[4]).toBe("-o");
			expect(plan.command[6]).toBe(OMP_TUI_PACKAGE);
			expect(plan.outputPath).toBe(path.join(binariesDir, ompTuiStagedBinaryName(t)));
			expect(plan.tempPath.includes(t.id)).toBe(true);
			expect(path.dirname(plan.tempPath)).toBe(path.dirname(plan.outputPath));
			finals.add(plan.outputPath);
			tempsSet.add(plan.tempPath);
		}
		expect(finals.size).toBe(5);
		expect(tempsSet.size).toBe(5);
	});
});
