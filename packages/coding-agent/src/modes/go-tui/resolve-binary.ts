/**
 * Resolve the omp-tui frontend binary for the Bun launcher.
 *
 * Order:
 * 1. OMP_TUI_BIN env override (must exist + be executable)
 * 2. Embedded binary (compiled builds): extract to ~/.omp/omp-tui/<version>/ with
 *    size + sha256 verify, atomic write, mode 0755
 * 3. Packaged/staged artifact for the *current* platform/arch under
 *    src/modes/go-tui/binaries/ (npm source layout and bundled-dist layouts)
 * 4. Dev sibling artifact: $RATATUI_GO_ROOT/bin/omp-tui(.exe) then
 *    $RATATUI_GO_ROOT/omp-tui(.exe) (default RATATUI_GO_ROOT = sibling checkout)
 *
 * Never runs `go run`. Never fetches over the network.
 * Never selects a foreign platform/arch staged name.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getConfigRootDir, isCompiledBinary, VERSION } from "@oh-my-pi/pi-utils";
import { OMP_TUI_BASENAME, OMP_TUI_BIN_ENV, OMP_TUI_CACHE_DIRNAME, RATATUI_GO_ROOT_ENV } from "./constants";
import { embeddedOmpTui } from "./embedded-omp-tui";

export type OmpTuiResolveSource = "env" | "embedded" | "packaged" | "dev-artifact";

export interface ResolvedOmpTuiBinary {
	path: string;
	source: OmpTuiResolveSource;
}

function hostPlatformTag(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
	return `${platform}-${arch}`;
}

function binaryBasename(platform: NodeJS.Platform = process.platform): string {
	return platform === "win32" ? `${OMP_TUI_BASENAME}.exe` : OMP_TUI_BASENAME;
}

/** Default sibling checkout: <oh-my-pi-parent>/ratatui-go when OMP lives under .../ai/oh-my-pi. */
export function defaultRatatuiGoRoot(): string {
	// packages/coding-agent/src/modes/go-tui → walk to repo root then sibling.
	// import.meta.dir is the go-tui folder in source; in compiled builds this
	// helper is only used for the dev-artifact path (embedded takes precedence).
	const fromEnv = process.env[RATATUI_GO_ROOT_ENV]?.trim();
	if (fromEnv) return path.resolve(fromEnv);

	// Prefer a sibling of the oh-my-pi repo: .../dev/ratatui-go next to .../dev/ai/oh-my-pi
	// Walk up from this file looking for bun.lock + packages/ (OMP monorepo root).
	let current = import.meta.dir;
	for (let i = 0; i < 12; i++) {
		if (fs.existsSync(path.join(current, "bun.lock")) && fs.existsSync(path.join(current, "packages"))) {
			// oh-my-pi root. Sibling ratatui-go: parent/ratatui-go OR parent/../ratatui-go
			// Workstation layout: /Users/.../dev/ai/oh-my-pi and /Users/.../dev/ratatui-go
			const parent = path.dirname(current);
			const grand = path.dirname(parent);
			const candidates = [
				path.join(parent, "ratatui-go"),
				path.join(grand, "ratatui-go"),
				path.join(current, "ratatui-go"),
			];
			for (const c of candidates) {
				if (fs.existsSync(path.join(c, "go.mod"))) return c;
			}
			// Fall through to first candidate even if missing (build scripts mkdir).
			return candidates[1] ?? candidates[0]!;
		}
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	// Last resort: sibling of cwd.
	return path.resolve(process.cwd(), "..", "ratatui-go");
}

function isExecutableFile(filePath: string): boolean {
	try {
		const st = fs.statSync(filePath);
		if (!st.isFile()) return false;
		if (process.platform === "win32") return true;
		// Owner/group/other execute bit.
		return (st.mode & 0o111) !== 0;
	} catch {
		return false;
	}
}

function tryEnvOverride(): ResolvedOmpTuiBinary | undefined {
	const raw = process.env[OMP_TUI_BIN_ENV]?.trim();
	if (!raw) return undefined;
	const resolved = path.resolve(raw);
	if (!isExecutableFile(resolved)) {
		throw new Error(
			`${OMP_TUI_BIN_ENV}=${raw} is set but is not an executable file. ` +
				`Unset it or point it at a built omp-tui binary.`,
		);
	}
	return { path: resolved, source: "env" };
}

function sha256File(filePath: string): string {
	const hash = createHash("sha256");
	hash.update(fs.readFileSync(filePath));
	return hash.digest("hex");
}

function sha256Bytes(buf: Uint8Array): string {
	return createHash("sha256").update(buf).digest("hex");
}

function ompTuiCacheDir(version: string = VERSION): string {
	// Mirror natives: under the config-root cache tree.
	// getConfigRootDir() → ~/.omp (or XDG). Keep a dedicated subdir.
	return path.join(getConfigRootDir(), OMP_TUI_CACHE_DIRNAME, version);
}

/**
 * Extract the embedded omp-tui into the versioned cache when needed.
 * Verifies size + sha256. Atomic write (temp + rename), mode 0755.
 */
export function extractEmbeddedOmpTui(options?: {
	embedded?: typeof embeddedOmpTui;
	platformTag?: string;
	version?: string;
	cacheDir?: string;
}): ResolvedOmpTuiBinary | undefined {
	const emb = options?.embedded !== undefined ? options.embedded : embeddedOmpTui;
	if (!emb) return undefined;

	const platformTag = options?.platformTag ?? hostPlatformTag();
	const version = options?.version ?? VERSION;
	if (emb.platformTag !== platformTag) return undefined;
	// Version mismatch: refuse silent reuse of a foreign embed.
	if (emb.version && emb.version !== version) {
		// Still allow extract under emb.version so a mismatched define doesn't crash;
		// prefer the embedded version as the cache key when they disagree.
	}
	const cacheVersion = emb.version || version;
	const cacheDir = options?.cacheDir ?? ompTuiCacheDir(cacheVersion);
	const targetPath = path.join(cacheDir, emb.filename);

	const cacheHit = (() => {
		try {
			const st = fs.statSync(targetPath);
			if (!st.isFile()) return false;
			if (typeof emb.size === "number" && st.size !== emb.size) return false;
			if (emb.sha256) {
				const digest = sha256File(targetPath);
				if (digest !== emb.sha256.toLowerCase()) return false;
			}
			// Ensure execute bit survives a prior umask glitch.
			if (process.platform !== "win32" && (st.mode & 0o111) === 0) {
				fs.chmodSync(targetPath, 0o755);
			}
			return true;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
			throw err;
		}
	})();
	if (cacheHit) return { path: targetPath, source: "embedded" };

	if (!emb.filePath) {
		throw new Error(
			`Embedded omp-tui metadata is present for ${emb.platformTag} but filePath is missing. ` +
				`Rebuild the binary so scripts/embed-omp-tui.ts can stamp the asset.`,
		);
	}

	const bytes = fs.readFileSync(emb.filePath);
	if (typeof emb.size === "number" && bytes.byteLength !== emb.size) {
		throw new Error(
			`Embedded omp-tui size mismatch: expected ${emb.size}, got ${bytes.byteLength} (${emb.filename})`,
		);
	}
	const digest = sha256Bytes(bytes);
	if (emb.sha256 && digest !== emb.sha256.toLowerCase()) {
		throw new Error(`Embedded omp-tui sha256 mismatch: expected ${emb.sha256}, got ${digest} (${emb.filename})`);
	}

	fs.mkdirSync(cacheDir, { recursive: true });
	// Unique temp name — never a global fixed path — then atomic rename.
	const tempPath = path.join(
		cacheDir,
		`.${emb.filename}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
	);
	try {
		fs.writeFileSync(tempPath, bytes, { mode: 0o755 });
		// Re-chmod in case umask stripped bits on some platforms.
		if (process.platform !== "win32") {
			fs.chmodSync(tempPath, 0o755);
		}
		fs.renameSync(tempPath, targetPath);
		if (process.platform !== "win32") {
			fs.chmodSync(targetPath, 0o755);
		}
	} catch (err) {
		try {
			fs.unlinkSync(tempPath);
		} catch {
			// best-effort
		}
		throw err;
	}

	return { path: targetPath, source: "embedded" };
}

/** Build-time GOOS/GOARCH matrix entry. */
export interface OmpTuiGoTarget {
	id: string;
	goos: string;
	goarch: string;
	/** Bun/Node platform string. */
	platform: NodeJS.Platform | "darwin" | "linux" | "win32";
	arch: "arm64" | "x64";
	filename: string;
}

export const OMP_TUI_GO_TARGETS: readonly OmpTuiGoTarget[] = [
	{ id: "darwin-arm64", goos: "darwin", goarch: "arm64", platform: "darwin", arch: "arm64", filename: "omp-tui" },
	{ id: "darwin-x64", goos: "darwin", goarch: "amd64", platform: "darwin", arch: "x64", filename: "omp-tui" },
	{ id: "linux-arm64", goos: "linux", goarch: "arm64", platform: "linux", arch: "arm64", filename: "omp-tui" },
	{ id: "linux-x64", goos: "linux", goarch: "amd64", platform: "linux", arch: "x64", filename: "omp-tui" },
	{ id: "win32-x64", goos: "windows", goarch: "amd64", platform: "win32", arch: "x64", filename: "omp-tui.exe" },
] as const;

/**
 * On-disk name for a staged multi-target binary under
 * `src/modes/go-tui/binaries/`. Always includes the platform tag so a foreign
 * target can never be confused with the host artifact.
 * e.g. omp-tui.darwin-arm64, omp-tui.win32-x64.exe
 */
export function ompTuiStagedBinaryName(
	target: Pick<OmpTuiGoTarget, "id" | "platform"> | { id: string; platform: string },
): string {
	return target.platform === "win32" ? `omp-tui.${target.id}.exe` : `omp-tui.${target.id}`;
}

/** Every known staged basename (cleanup / pack inventory). */
export function ompTuiStagedBinaryNames(): readonly string[] {
	return OMP_TUI_GO_TARGETS.map(t => ompTuiStagedBinaryName(t));
}

/**
 * Host-matching staged basename, or undefined when the host is not in the
 * supported matrix (never invent a name for an unsupported platform).
 */
export function ompTuiHostStagedBinaryName(
	platform: NodeJS.Platform = process.platform,
	arch: string = process.arch,
): string | undefined {
	const id = hostPlatformTag(platform, arch);
	const target = OMP_TUI_GO_TARGETS.find(t => t.id === id);
	if (!target) return undefined;
	return ompTuiStagedBinaryName(target);
}

/**
 * Candidate directories that may hold `binaries/omp-tui.<platform>-<arch>`.
 * Covers source layout (import.meta.dir), package root walks, and bundled
 * dist/cli.js layouts where the published package keeps `src/` beside `dist/`.
 */
export function ompTuiPackagedBinaryDirs(options?: {
	/** Override for tests. Defaults to import.meta.dir (go-tui module dir). */
	moduleDir?: string;
	/** Override process.argv[1] (entry script path) for bundled-dist probes. */
	entryPath?: string;
	/** Override cwd. */
	cwd?: string;
}): string[] {
	const moduleDir = options?.moduleDir ?? import.meta.dir;
	const entryPath = options?.entryPath ?? process.argv[1];
	const cwd = options?.cwd ?? process.cwd();
	const dirs: string[] = [];
	const seen = new Set<string>();
	const push = (dir: string) => {
		const resolved = path.resolve(dir);
		if (seen.has(resolved)) return;
		seen.add(resolved);
		dirs.push(resolved);
	};

	// 1. Source / published package: next to this module.
	push(path.join(moduleDir, "binaries"));

	// 2. Walk up looking for package root that owns src/modes/go-tui/binaries.
	let current = moduleDir;
	for (let i = 0; i < 10; i++) {
		push(path.join(current, "src", "modes", "go-tui", "binaries"));
		push(path.join(current, "modes", "go-tui", "binaries"));
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}

	// 3. Bundled dist/cli.js: package root is parent of dist/, src/ still published.
	if (entryPath) {
		const entryDir = path.dirname(path.resolve(entryPath));
		// .../node_modules/@oh-my-pi/pi-coding-agent/dist → package root
		push(path.join(entryDir, "src", "modes", "go-tui", "binaries"));
		push(path.join(entryDir, "..", "src", "modes", "go-tui", "binaries"));
		// If entry is the package root itself (bin → src/cli.ts source install)
		push(path.join(entryDir, "modes", "go-tui", "binaries"));
	}

	// 4. cwd package root (npm link / workspace run).
	push(path.join(cwd, "src", "modes", "go-tui", "binaries"));
	push(path.join(cwd, "modes", "go-tui", "binaries"));

	return dirs;
}

/**
 * Resolve the host-matching packaged/staged omp-tui if present and executable.
 * Only the exact current platform/arch name is considered — foreign targets
 * under the same directory are ignored.
 */
export function tryPackagedArtifact(options?: {
	platform?: NodeJS.Platform;
	arch?: string;
	moduleDir?: string;
	entryPath?: string;
	cwd?: string;
	/** Inject candidate dirs (tests). */
	candidateDirs?: readonly string[];
}): ResolvedOmpTuiBinary | undefined {
	const platform = options?.platform ?? process.platform;
	const arch = options?.arch ?? process.arch;
	const name = ompTuiHostStagedBinaryName(platform, arch);
	if (!name) return undefined;

	// Refuse bare omp-tui / foreign tags: only the exact staged name.
	const dirs =
		options?.candidateDirs ??
		ompTuiPackagedBinaryDirs({
			moduleDir: options?.moduleDir,
			entryPath: options?.entryPath,
			cwd: options?.cwd,
		});

	for (const dir of dirs) {
		const candidate = path.join(dir, name);
		if (!isExecutableFile(candidate)) continue;
		// Defense in depth: basename must be exactly the host staged name.
		if (path.basename(candidate) !== name) continue;
		return { path: candidate, source: "packaged" };
	}
	return undefined;
}

function tryDevArtifact(): ResolvedOmpTuiBinary | undefined {
	// Skip the sibling probe inside compiled binaries — they must ship embed.
	if (isCompiledBinary() && embeddedOmpTui) return undefined;

	const root = defaultRatatuiGoRoot();
	const name = binaryBasename();
	const candidates = [path.join(root, "bin", name), path.join(root, name)];
	for (const c of candidates) {
		if (isExecutableFile(c)) return { path: c, source: "dev-artifact" };
	}
	return undefined;
}

/**
 * Resolve omp-tui or return undefined when none is available.
 * Throws only on hard misconfiguration (bad OMP_TUI_BIN, corrupt embed).
 */
export function resolveOmpTuiBinary(): ResolvedOmpTuiBinary | undefined {
	const fromEnv = tryEnvOverride();
	if (fromEnv) return fromEnv;

	// Embedded path is preferred in compiled builds; also works if generate left assets.
	const fromEmbed = extractEmbeddedOmpTui();
	if (fromEmbed) return fromEmbed;

	// npm source / bundled-dist: host-matching staged binary from prepack --all-targets.
	const fromPackaged = tryPackagedArtifact();
	if (fromPackaged) return fromPackaged;

	return tryDevArtifact();
}

/**
 * Host platform tag helper exported for build scripts / tests.
 */
export function ompTuiPlatformTag(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
	return hostPlatformTag(platform, arch);
}

export function ompTuiBinaryName(platform: NodeJS.Platform = process.platform): string {
	return binaryBasename(platform);
}

/** Exported for build scripts that stage into a known cache layout. */
export function ompTuiVersionedCacheDir(version: string = VERSION): string {
	return ompTuiCacheDir(version);
}
