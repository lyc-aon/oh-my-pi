import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "arktype";
import {
	AuthBrokerClient,
	AuthBrokerError,
	type AuthBrokerServerHandle,
	authAttemptLedgerEntrySchema,
	RemoteAuthCredentialStore,
	startAuthBroker,
} from "../src/auth-broker";
import {
	type AuthAttemptLedgerEntry,
	AuthStorage,
	SqliteAuthCredentialStore,
	sanitizeAuthAttemptLedgerEntry,
} from "../src/auth-storage";

describe("auth attempt ledger persistence & validation", () => {
	let tempDir = "";
	let store: SqliteAuthCredentialStore | undefined;
	let storage: AuthStorage | undefined;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-attempt-test-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "test.db"));
		storage = new AuthStorage(store);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		storage?.close();
		store?.close();
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	test("local SQLite persistence and bounded querying", async () => {
		const entry1: AuthAttemptLedgerEntry = {
			recordedAt: 1000,
			sessionId: "sess-1",
			attempt: 1,
			selector: "anthropic:primary",
			nextSelector: "anthropic:secondary",
			reasonCode: "rate_limit",
			outcome: "failed",
			usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 0, totalTokens: 160 },
			costUsd: 0.002,
		};

		const entry2: AuthAttemptLedgerEntry = {
			recordedAt: 2000,
			sessionId: "sess-1",
			attempt: 2,
			selector: "anthropic:secondary",
			reasonCode: "transient",
			outcome: "succeeded",
			usage: { input: 80, output: 40, cacheRead: 0, cacheWrite: 0, totalTokens: 120 },
			costUsd: 0.001,
		};

		await storage!.recordAuthAttempt(entry1);
		await storage!.recordAuthAttempt(entry2);

		const allAttempts = (await storage!.listAuthAttempts()) as AuthAttemptLedgerEntry[];
		expect(allAttempts).toHaveLength(2);
		expect(allAttempts[0]).toEqual(entry1);
		expect(allAttempts[1]).toEqual(entry2);

		const filteredBySelector = (await storage!.listAuthAttempts({
			selector: "anthropic:primary",
		})) as AuthAttemptLedgerEntry[];
		expect(filteredBySelector).toHaveLength(1);
		expect(filteredBySelector[0].selector).toBe("anthropic:primary");

		const filteredByReason = (await storage!.listAuthAttempts({
			reasonCode: "rate_limit",
		})) as AuthAttemptLedgerEntry[];
		expect(filteredByReason).toHaveLength(1);
		expect(filteredByReason[0].reasonCode).toBe("rate_limit");

		const bounded = (await storage!.listAuthAttempts({ limit: 1 })) as AuthAttemptLedgerEntry[];
		expect(bounded).toHaveLength(1);
		expect(bounded[0]).toEqual(entry1);
	});

	test("sanitizer strips non-allowlisted metadata and enforces secret-free entries", () => {
		const dirtyEntry = {
			recordedAt: 1500,
			sessionId: "sess-secret",
			attempt: 1,
			selector: "openai:codex",
			reasonCode: "authentication",
			outcome: "failed",
			usage: { input: 200, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 300 },
			costUsd: 0.005,
			// Secret / unallowed fields that MUST be stripped
			rawErrorText: "Bearer secret-token-xyz 401 Unauthorized",
			prompt: "System prompt containing secrets",
			bearerToken: "sk-proj-secret123456",
			email: "user@example.com",
			arbitraryMeta: { foo: "bar" },
		};

		const sanitized = sanitizeAuthAttemptLedgerEntry(dirtyEntry);
		expect(Object.keys(sanitized).sort()).toEqual([
			"attempt",
			"costUsd",
			"outcome",
			"reasonCode",
			"recordedAt",
			"selector",
			"sessionId",
			"usage",
		]);
		expect("rawErrorText" in sanitized).toBe(false);
		expect("bearerToken" in sanitized).toBe(false);
		expect("prompt" in sanitized).toBe(false);
	});

	describe("remote broker attempt ledger persistence", () => {
		let brokerHandle: AuthBrokerServerHandle | undefined;
		let remoteStore: RemoteAuthCredentialStore | undefined;
		let remoteStorage: AuthStorage | undefined;
		const bearerToken = "secret-broker-token";

		beforeEach(async () => {
			brokerHandle = startAuthBroker({
				storage: storage!,
				bind: "127.0.0.1:0",
				bearerTokens: [bearerToken],
				disableRefresher: true,
			});
			const client = new AuthBrokerClient({ url: brokerHandle.url, token: bearerToken });
			remoteStore = new RemoteAuthCredentialStore({ client, streamSnapshots: false });
			remoteStorage = new AuthStorage(remoteStore);
		});

		afterEach(async () => {
			remoteStorage?.close();
			remoteStore?.close();
			await brokerHandle?.close();
		});

		test("remote append POSTs to broker endpoint and awaits durable persistence", async () => {
			const remoteEntry: AuthAttemptLedgerEntry = {
				recordedAt: 3000,
				sessionId: "sess-remote",
				attempt: 1,
				selector: "fireworks:fast",
				nextSelector: "fireworks:fallback",
				reasonCode: "fireworks_fast",
				outcome: "aborted",
				usage: { input: 50, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 50 },
				costUsd: 0.0005,
			};

			await remoteStorage!.recordAuthAttempt(remoteEntry);

			// Verify durable persistence in broker host's local SQLite database
			const brokerHostAttempts = (await storage!.listAuthAttempts()) as AuthAttemptLedgerEntry[];
			expect(brokerHostAttempts).toHaveLength(1);
			expect(brokerHostAttempts[0]).toEqual(remoteEntry);

			// Verify client querying via GET /v1/attempts
			const remoteListed = (await remoteStorage!.listAuthAttempts()) as AuthAttemptLedgerEntry[];
			expect(remoteListed).toHaveLength(1);
			expect(remoteListed[0]).toEqual(remoteEntry);
		});

		test("remote append propagates durable failure when broker persistence fails", async () => {
			vi.spyOn(storage!, "recordAuthAttempt").mockImplementationOnce(() => {
				throw new Error("Disk write failed");
			});

			const remoteEntry: AuthAttemptLedgerEntry = {
				recordedAt: 4000,
				attempt: 1,
				selector: "failing:selector",
				reasonCode: "unknown",
				outcome: "failed",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
				costUsd: 0,
			};

			await expect(remoteStorage!.recordAuthAttempt(remoteEntry)).rejects.toThrow(AuthBrokerError);
		});
	});

	describe("schema rejection", () => {
		test("rejects invalid reasonCode", () => {
			const invalidReason = {
				recordedAt: Date.now(),
				attempt: 1,
				selector: "test",
				reasonCode: "invalid_reason_string",
				outcome: "failed",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
				costUsd: 0,
			};
			const res = authAttemptLedgerEntrySchema(invalidReason);
			expect(res instanceof type.errors).toBe(true);
			expect(() => sanitizeAuthAttemptLedgerEntry(invalidReason)).toThrow(TypeError);
		});

		test("rejects invalid outcome", () => {
			const invalidOutcome = {
				recordedAt: Date.now(),
				attempt: 1,
				selector: "test",
				reasonCode: "rate_limit",
				outcome: "unknown_outcome",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
				costUsd: 0,
			};
			const res = authAttemptLedgerEntrySchema(invalidOutcome);
			expect(res instanceof type.errors).toBe(true);
			expect(() => sanitizeAuthAttemptLedgerEntry(invalidOutcome)).toThrow(TypeError);
		});

		test("rejects unallowed extra fields under strict schema validation", () => {
			const extraField = {
				recordedAt: Date.now(),
				attempt: 1,
				selector: "test",
				reasonCode: "transient",
				outcome: "succeeded",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
				costUsd: 0,
				unallowedSecretKey: "secret_value",
			};
			const res = authAttemptLedgerEntrySchema(extraField);
			expect(res instanceof type.errors).toBe(true);
		});
	});
});
