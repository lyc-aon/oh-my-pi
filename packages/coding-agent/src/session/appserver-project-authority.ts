import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, opendir, readFile, realpath, rename, rm } from "node:fs/promises";
import * as path from "node:path";
import type { ProjectId } from "@oh-my-pi/app-wire";
import { stableProjectId } from "@oh-my-pi/appserver";

const CATALOG_VERSION = 1;
const MAX_CATALOG_PROJECTS = 256;
const MAX_DIRECTORY_ENTRIES = 256;
const MAX_TOKENS = 2_048;
const CLONE_TIMEOUT_MS = 120_000;
const CLONE_KILL_GRACE_MS = 2_000;

interface CatalogFile {
	version: 1;
	projects: Array<{ projectId: string; root: string }>;
}

export interface ProjectCloneRequest {
	repositoryUrl: string;
	destination: string;
	target: string;
	signal: AbortSignal;
}

export type ProjectCloneRunner = (request: ProjectCloneRequest) => Promise<void>;

export interface AppserverProjectAuthorityOptions {
	homeDirectory: string;
	catalogMetadataPath: string;
	cloneRunner?: ProjectCloneRunner;
}

function operationError(message: string, code: string): Error {
	return Object.assign(new Error(message), { code });
}

async function canonicalDirectory(candidate: string): Promise<string> {
	const before = await lstat(candidate);
	if (before.isSymbolicLink() || !before.isDirectory()) throw operationError("unsafe directory", "FORBIDDEN");
	const canonical = await realpath(candidate);
	const after = await lstat(canonical);
	if (!after.isDirectory() || before.dev !== after.dev || before.ino !== after.ino)
		throw operationError("directory changed during validation", "FORBIDDEN");
	return canonical;
}

async function syncDirectory(directory: string): Promise<void> {
	const handle = await open(directory, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function writePrivateCatalog(target: string, value: CatalogFile): Promise<void> {
	const directory = path.dirname(target);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const temporary = path.join(directory, `.${path.basename(target)}.${randomUUID()}.tmp`);
	let committed = false;
	try {
		const handle = await open(temporary, "wx", 0o600);
		try {
			await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(temporary, target);
		await syncDirectory(directory);
		committed = true;
	} finally {
		if (!committed) await rm(temporary, { force: true }).catch(() => undefined);
	}
}

class RegisteredProjectCatalog {
	readonly #metadataPath: string;
	readonly #projects = new Map<ProjectId, string>();
	#ready: Promise<void>;
	#tail: Promise<void> = Promise.resolve();

	constructor(metadataPath: string) {
		this.#metadataPath = metadataPath;
		this.#ready = this.#load();
	}

	async register(root: string): Promise<{ projectId: ProjectId; name: string }> {
		const canonical = await canonicalDirectory(root);
		const projectId = stableProjectId(canonical);
		await this.#mutate(() => {
			this.#projects.delete(projectId);
			this.#projects.set(projectId, canonical);
			while (this.#projects.size > MAX_CATALOG_PROJECTS) {
				const oldest = this.#projects.keys().next().value as ProjectId | undefined;
				if (oldest === undefined) break;
				this.#projects.delete(oldest);
			}
		});
		return { projectId, name: path.basename(canonical) || "Project" };
	}

	async resolve(projectId: ProjectId): Promise<string | undefined> {
		await this.#ready;
		await this.#tail;
		const stored = this.#projects.get(projectId);
		if (!stored) return undefined;
		try {
			const canonical = await canonicalDirectory(stored);
			if (stableProjectId(canonical) !== projectId) return undefined;
			return canonical;
		} catch {
			return undefined;
		}
	}

	async #load(): Promise<void> {
		let raw: string;
		try {
			raw = await readFile(this.#metadataPath, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid project catalog");
		const file = parsed as Partial<CatalogFile>;
		if (file.version !== CATALOG_VERSION || !Array.isArray(file.projects)) throw new Error("invalid project catalog");
		for (const item of file.projects.slice(0, MAX_CATALOG_PROJECTS)) {
			if (
				!item ||
				typeof item.projectId !== "string" ||
				typeof item.root !== "string" ||
				!path.isAbsolute(item.root)
			)
				continue;
			try {
				const canonical = await canonicalDirectory(item.root);
				const projectId = stableProjectId(canonical);
				if (projectId === item.projectId) this.#projects.set(projectId, canonical);
			} catch {}
		}
	}

	#mutate(update: () => void): Promise<void> {
		const operation = this.#tail.then(async () => {
			await this.#ready;
			update();
			await writePrivateCatalog(this.#metadataPath, {
				version: CATALOG_VERSION,
				projects: [...this.#projects].map(([projectId, root]) => ({ projectId, root })),
			});
		});
		this.#tail = operation.catch(() => undefined);
		return operation;
	}
}

/** Validate and normalize the public GitHub repository URL accepted by project.clone. */
export function parseGithubRepositoryUrl(value: string): { repositoryUrl: string; name: string } {
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw operationError("Enter a GitHub HTTPS repository URL.", "INVALID_ARGUMENT");
	}
	const parts = parsed.pathname.split("/").filter(Boolean);
	if (
		parsed.protocol !== "https:" ||
		parsed.hostname !== "github.com" ||
		parsed.port !== "" ||
		parsed.username !== "" ||
		parsed.password !== "" ||
		parsed.search !== "" ||
		parsed.hash !== "" ||
		parts.length !== 2 ||
		!parts.every(part => /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u.test(part.replace(/\.git$/u, "")))
	)
		throw operationError(
			"Enter a public GitHub HTTPS repository URL without credentials or extra parts.",
			"INVALID_ARGUMENT",
		);
	const name = parts[1]!.replace(/\.git$/u, "");
	if (!name || name === "." || name === "..")
		throw operationError("Invalid GitHub repository name.", "INVALID_ARGUMENT");
	parsed.pathname = `/${parts[0]}/${parts[1]}`;
	return { repositoryUrl: parsed.toString(), name };
}

/** Run git without a shell, with bounded lifetime and forced cancellation settlement. */
export const defaultProjectCloneRunner: ProjectCloneRunner = async request => {
	const proc = Bun.spawn(["git", "clone", "--", request.repositoryUrl, request.target], {
		cwd: request.destination,
		stdout: "ignore",
		stderr: "ignore",
	});
	let timedOut = false;
	let forceTimer: ReturnType<typeof setTimeout> | undefined;
	const terminate = () => {
		proc.kill("SIGTERM");
		forceTimer ??= setTimeout(() => proc.kill("SIGKILL"), CLONE_KILL_GRACE_MS);
	};
	const timeout = setTimeout(() => {
		timedOut = true;
		terminate();
	}, CLONE_TIMEOUT_MS);
	request.signal.addEventListener("abort", terminate, { once: true });
	try {
		const exitCode = await proc.exited;
		if (request.signal.aborted) throw operationError("Clone cancelled.", "ABORTED");
		if (timedOut) throw operationError("Clone timed out.", "OPERATION_FAILED");
		if (exitCode !== 0) throw operationError("GitHub clone failed.", "OPERATION_FAILED");
	} finally {
		clearTimeout(timeout);
		clearTimeout(forceTimer);
		request.signal.removeEventListener("abort", terminate);
	}
};

/** Host-authoritative folder tokens, durable project registration, and GitHub cloning. */
export class AppserverProjectAuthority {
	readonly #homeDirectory: string;
	readonly #tokens = new Map<string, string>();
	readonly #catalog: RegisteredProjectCatalog;
	readonly #cloneRunner: ProjectCloneRunner;

	constructor(options: AppserverProjectAuthorityOptions) {
		this.#homeDirectory = path.resolve(options.homeDirectory);
		this.#catalog = new RegisteredProjectCatalog(options.catalogMetadataPath);
		this.#cloneRunner = options.cloneRunner ?? defaultProjectCloneRunner;
	}

	async browse(args: Record<string, unknown>): Promise<Record<string, unknown>> {
		const selected = args.token === undefined ? this.#homeDirectory : this.#tokens.get(String(args.token));
		if (!selected) throw operationError("This folder selection expired. Browse again.", "NOT_FOUND");
		const root = await canonicalDirectory(selected);
		const before = await lstat(root);
		const directory = await opendir(root);
		const entries: Array<{ token: string; name: string }> = [];
		let sawMore = false;
		try {
			for (;;) {
				const entry = await directory.read();
				if (!entry) break;
				if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
				try {
					const child = await canonicalDirectory(path.join(root, entry.name));
					if (entries.length < MAX_DIRECTORY_ENTRIES)
						entries.push({ token: this.#tokenFor(child), name: entry.name });
					else sawMore = true;
				} catch {}
			}
		} finally {
			await directory.close();
		}
		const after = await lstat(root);
		if (before.dev !== after.dev || before.ino !== after.ino)
			throw operationError("Directory changed while it was being listed.", "OPERATION_FAILED");
		const parent = path.dirname(root);
		return {
			directory: {
				token: this.#tokenFor(root),
				name: path.basename(root) || "Filesystem root",
				...(parent === root ? {} : { parentToken: this.#tokenFor(parent) }),
			},
			entries: entries.sort((left, right) => left.name.localeCompare(right.name)),
			truncated: sawMore,
		};
	}

	async register(args: Record<string, unknown>): Promise<Record<string, unknown>> {
		const root = this.#tokens.get(String(args.token));
		if (!root) throw operationError("This folder selection expired. Browse again.", "NOT_FOUND");
		return { project: await this.#catalog.register(root) };
	}

	async clone(args: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>> {
		const destinationToken = this.#tokens.get(String(args.destinationToken));
		if (!destinationToken) throw operationError("This folder selection expired. Browse again.", "NOT_FOUND");
		const destination = await canonicalDirectory(destinationToken);
		const repository = parseGithubRepositoryUrl(String(args.repositoryUrl));
		const target = path.join(destination, repository.name);
		try {
			await lstat(target);
			throw operationError("A folder with that repository name already exists.", "CONFLICT");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		await this.#cloneRunner({ ...repository, destination, target, signal });
		return { project: await this.#catalog.register(target) };
	}

	resolve(projectId: ProjectId): Promise<string | undefined> {
		return this.#catalog.resolve(projectId);
	}

	#tokenFor(root: string): string {
		for (const [token, mapped] of this.#tokens) {
			if (mapped !== root) continue;
			this.#tokens.delete(token);
			this.#tokens.set(token, root);
			return token;
		}
		const token = randomUUID();
		this.#tokens.set(token, root);
		while (this.#tokens.size > MAX_TOKENS) {
			const oldest = this.#tokens.keys().next().value as string | undefined;
			if (oldest === undefined) break;
			this.#tokens.delete(oldest);
		}
		return token;
	}
}
