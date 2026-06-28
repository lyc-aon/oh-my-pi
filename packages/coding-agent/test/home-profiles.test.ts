import type { Mock } from "bun:test";
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	addProfile,
	listProfiles,
	ProfileNotFoundError,
	resolveProfile,
} from "@oh-my-pi/pi-coding-agent/home/profiles";
import * as piUtils from "@oh-my-pi/pi-utils";

describe("home profiles registry", () => {
	let tempDir: string;
	let getConfigRootDirSpy: Mock<() => string>;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-home-profiles-test-"));
		getConfigRootDirSpy = spyOn(piUtils, "getConfigRootDir").mockReturnValue(tempDir);
	});

	afterEach(async () => {
		getConfigRootDirSpy?.mockRestore();
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("prunes registry entries whose agent directory disappeared", async () => {
		const agentDir = path.join(tempDir, "stale", "agent");
		await fs.mkdir(agentDir, { recursive: true });
		await fs.writeFile(path.join(agentDir, "config.yml"), "modelRoles:\n  default: openai/gpt-4o\n");
		const entry = await addProfile(agentDir, "Stale");

		await fs.rm(path.dirname(agentDir), { recursive: true, force: true });

		const profiles = await listProfiles();
		expect(profiles.find(profile => profile.id === entry.id)).toBeUndefined();
		await expect(resolveProfile(entry.id)).rejects.toThrow(ProfileNotFoundError);

		const registry = JSON.parse(await fs.readFile(path.join(tempDir, "home", "profiles.json"), "utf8"));
		expect(registry.profiles.find((profile: { id: string }) => profile.id === entry.id)).toBeUndefined();
	});
});
