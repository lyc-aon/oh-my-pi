import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { createLiveAuthGatewayCatalog } from "../src/cli/auth-gateway-cli";

describe("auth-gateway live credential-scoped catalog", () => {
	let tempDir = "";
	let store: SqliteAuthCredentialStore | undefined;
	let storage: AuthStorage | undefined;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-gateway-live-catalog-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		store.saveApiKey("anthropic", "synthetic-anthropic-key");
		storage = new AuthStorage(store);
		await storage.reload();
	});

	afterEach(async () => {
		storage?.close();
		store?.close();
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	test("adds and removes provider models on AuthStorage generation changes", async () => {
		const anthropic = getBundledModels("anthropic")[0];
		const codex = getBundledModels("openai-codex")[0];
		if (!anthropic || !codex) throw new Error("expected bundled gateway models");
		const catalog = createLiveAuthGatewayCatalog(storage!);

		try {
			expect(catalog.resolveModel(`${anthropic.provider}/${anthropic.id}`)?.id).toBe(anthropic.id);
			expect(catalog.resolveModel(`${codex.provider}/${codex.id}`)).toBeUndefined();

			store!.saveApiKey("openai-codex", "synthetic-codex-key");
			await storage!.reload();
			expect(catalog.resolveModel(`${codex.provider}/${codex.id}`)?.id).toBe(codex.id);

			store!.deleteProvider("anthropic");
			await storage!.reload();
			expect(catalog.resolveModel(`${anthropic.provider}/${anthropic.id}`)).toBeUndefined();
			const listed = Array.from(catalog.listModels());
			expect(listed.some(model => model.provider === "anthropic")).toBe(false);
			expect(listed.some(model => model.provider === "openai-codex")).toBe(true);
		} finally {
			catalog.close();
		}
	});
});
