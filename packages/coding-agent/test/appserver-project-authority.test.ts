import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { hostId, type ProjectId } from "@oh-my-pi/app-wire";
import { stableProjectId } from "@oh-my-pi/appserver";
import { createAppserverRuntime } from "../src/session/appserver-authority";
import {
	AppserverProjectAuthority,
	type ProjectCloneRunner,
	parseGithubRepositoryUrl,
} from "../src/session/appserver-project-authority";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture() {
	const root = await mkdtemp(path.join(tmpdir(), "omp-project-authority-"));
	roots.push(root);
	const home = path.join(root, "home");
	const projects = path.join(home, "projects");
	await mkdir(projects, { recursive: true });
	return { root, home, projects, catalog: path.join(root, "state", "projects.json") };
}

function projectResult(value: Record<string, unknown>): { projectId: ProjectId; name: string } {
	return value.project as { projectId: ProjectId; name: string };
}

describe("appserver project authority", () => {
	test("browses with opaque bounded tokens and ignores symlinked directories", async () => {
		const f = await fixture();
		await mkdir(path.join(f.home, "alpha"));
		await symlink(path.join(f.home, "alpha"), path.join(f.home, "linked-alpha"));
		const authority = new AppserverProjectAuthority({ homeDirectory: f.home, catalogMetadataPath: f.catalog });

		const root = await authority.browse({});
		const serialized = JSON.stringify(root);
		expect(serialized).not.toContain(f.root);
		expect(root.truncated).toBe(false);
		const entries = root.entries as Array<{ token: string; name: string }>;
		expect(entries.map(entry => entry.name)).toEqual(["alpha", "projects"]);
		expect(entries.every(entry => /^[0-9a-f-]{36}$/u.test(entry.token))).toBe(true);
		await expect(authority.browse({ token: "not-issued" })).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	test("persists registration and resolves it for session creation after restart", async () => {
		const f = await fixture();
		const sessions = path.join(f.root, "sessions");
		await mkdir(sessions);
		const options = {
			sessionsDir: sessions,
			lifecycleMetadataPath: path.join(f.root, "state", "lifecycle.json"),
			projectCatalogMetadataPath: f.catalog,
			projectHomeDirectory: f.home,
			projectCatalog: false as const,
		};
		const runtime = createAppserverRuntime(options);
		const context = {
			hostId: hostId("project-test-host"),
			deviceId: "device-test",
			connectionId: "connection-test",
			capabilities: new Set(["projects.manage"]),
			abortSignal: new AbortController().signal,
		};
		const browsed = await runtime.operationsAuthority.projectBrowse!({}, context as never);
		const projectsEntry = (browsed.entries as Array<{ token: string; name: string }>).find(
			entry => entry.name === "projects",
		);
		expect(projectsEntry).toBeDefined();
		const registered = await runtime.operationsAuthority.projectRegister!(
			{ token: projectsEntry!.token },
			context as never,
		);
		const project = projectResult(registered);
		expect(project.projectId).toBe(stableProjectId(await realpath(f.projects)));

		const restarted = createAppserverRuntime(options);
		const resolved = await restarted.projectRootForProject(project.projectId);
		expect(resolved).toBe(await realpath(f.projects));
		const created = await restarted.sessionAuthority.create(resolved, "Registered project session");
		expect(created.cwd).toBe(resolved);
	});

	test("clones through the injected shell-free runner and registers only successful destinations", async () => {
		const f = await fixture();
		const calls: Parameters<ProjectCloneRunner>[0][] = [];
		const runner: ProjectCloneRunner = async request => {
			calls.push(request);
			await mkdir(request.target);
		};
		const authority = new AppserverProjectAuthority({
			homeDirectory: f.home,
			catalogMetadataPath: f.catalog,
			cloneRunner: runner,
		});
		const browsed = await authority.browse({});
		const projectsEntry = (browsed.entries as Array<{ token: string; name: string }>).find(
			entry => entry.name === "projects",
		)!;
		const cloned = await authority.clone(
			{ repositoryUrl: "https://github.com/acme/widgets.git", destinationToken: projectsEntry.token },
			new AbortController().signal,
		);
		const project = projectResult(cloned);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			repositoryUrl: "https://github.com/acme/widgets.git",
			destination: f.projects,
			target: path.join(f.projects, "widgets"),
		});
		expect(await authority.resolve(project.projectId)).toBe(path.join(f.projects, "widgets"));
		await expect(
			authority.clone(
				{ repositoryUrl: "https://github.com/acme/widgets.git", destinationToken: projectsEntry.token },
				new AbortController().signal,
			),
		).rejects.toMatchObject({ code: "CONFLICT" });
	});

	test("rejects unsafe repository URLs and does not register failed clones", async () => {
		for (const value of [
			"git@github.com:acme/widgets.git",
			"https://user:secret@github.com/acme/widgets.git",
			"https://github.com/acme/widgets.git?depth=1",
			"https://example.com/acme/widgets.git",
			"https://github.com/acme/..",
		]) {
			expect(() => parseGithubRepositoryUrl(value)).toThrow();
		}
		const f = await fixture();
		const authority = new AppserverProjectAuthority({
			homeDirectory: f.home,
			catalogMetadataPath: f.catalog,
			cloneRunner: async () => {
				throw Object.assign(new Error("clone failed"), { code: "OPERATION_FAILED" });
			},
		});
		const browsed = await authority.browse({});
		const projectsEntry = (browsed.entries as Array<{ token: string; name: string }>).find(
			entry => entry.name === "projects",
		)!;
		await expect(
			authority.clone(
				{ repositoryUrl: "https://github.com/acme/broken.git", destinationToken: projectsEntry.token },
				new AbortController().signal,
			),
		).rejects.toMatchObject({ code: "OPERATION_FAILED" });
		expect(await authority.resolve(stableProjectId(path.join(f.projects, "broken")))).toBeUndefined();
	});
});
