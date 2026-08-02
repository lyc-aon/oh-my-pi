import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import {
	AuthBrokerClient,
	AuthBrokerError,
	type AuthBrokerServerHandle,
	startAuthBroker,
} from "@oh-my-pi/pi-ai/auth-broker";

function failingStorage(): AuthStorage {
	return {
		onGenerationChanged: () => () => {},
		getGeneration: () => 1,
		refreshCredentialById: async () => {
			throw new Error("synthetic refresh persistence failure");
		},
		disableCredentialById: () => {
			throw new Error("synthetic disable persistence failure");
		},
		upsertCredential: () => {
			throw new Error("synthetic upload persistence failure");
		},
	} as unknown as AuthStorage;
}

async function captureBrokerError(request: Promise<unknown>): Promise<AuthBrokerError> {
	try {
		await request;
		throw new Error("expected broker mutation to fail");
	} catch (error) {
		if (!(error instanceof AuthBrokerError)) throw error;
		return error;
	}
}

describe("auth-broker durable mutation errors", () => {
	let handle: AuthBrokerServerHandle | undefined;

	afterEach(async () => {
		await handle?.close();
		handle = undefined;
	});

	test("classifies refresh, disable, and upload persistence failures", async () => {
		handle = startAuthBroker({
			storage: failingStorage(),
			bind: "127.0.0.1:0",
			bearerTokens: ["mutation-test-token"],
			disableRefresher: true,
		});
		const client = new AuthBrokerClient({ url: handle.url, token: "mutation-test-token", maxRetries: 0 });

		const refresh = await captureBrokerError(client.refreshCredential(7));
		expect(refresh).toMatchObject({
			status: 500,
			code: "credential_refresh_failed",
			operation: "refresh",
			durable: false,
			retrySafe: false,
		});

		const disable = await captureBrokerError(client.disableCredential(7, "test failure"));
		expect(disable).toMatchObject({
			status: 500,
			code: "credential_disable_failed",
			operation: "disable",
			durable: false,
			retrySafe: false,
		});

		const upload = await captureBrokerError(
			client.uploadCredential("anthropic", { type: "api_key", key: "synthetic-key" }),
		);
		expect(upload).toMatchObject({
			status: 500,
			code: "credential_upload_failed",
			operation: "upload",
			durable: false,
			retrySafe: false,
		});
	});

	test("SQLite credential and ledger writes never report success after persistence closes", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-broker-mutation-errors-"));
		const store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		try {
			store.saveApiKey("anthropic", "synthetic-key");
			const credential = store.listAuthCredentials("anthropic")[0];
			expect(credential).toBeDefined();
			if (!credential) throw new Error("expected stored credential");
			store.close();

			expect(() => store.updateAuthCredential(credential.id, { type: "api_key", key: "replacement-key" })).toThrow();
			expect(() => store.deleteAuthCredential(credential.id, "test disable")).toThrow();
			expect(() =>
				store.recordAuthAttempt({
					recordedAt: 1,
					sessionId: "session-test",
					attempt: 1,
					selector: "anthropic/claude-test",
					reasonCode: "transient",
					outcome: "failed",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
					costUsd: 0,
				}),
			).toThrow();
		} finally {
			store.close();
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});
