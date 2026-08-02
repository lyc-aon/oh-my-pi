import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import {
	discoverLycorpAuthStorage,
	resolveAuthBrokerConfig,
	resolveLycorpAuthConfig,
} from "../src/auth-broker/discover";
import { LycorpAuthClient } from "../src/auth-broker/lycorpauth-client";
import { LycorpAuthCredentialStore } from "../src/auth-broker/lycorpauth-store";
import { AuthStorage, REMOTE_REFRESH_SENTINEL } from "../src/auth-storage";

const MOCK_TOKEN = "lca_scoped_test_token_12345";

interface MockRecord {
	id: string;
	title: string;
	provider: string;
	credential_type?: string;
	tags?: string[];
	metadata?: Record<string, unknown>;
	identity?: string;
	account_id?: string;
	selection_priority?: number;
	disabled_at?: string | null;
	fields: Array<{ key: string; label?: string; sensitive?: boolean }>;
	secretValues: Record<string, string>;
	denyRead?: boolean;
}

function createMockLycorpAuthServer(records: MockRecord[], validToken = MOCK_TOKEN, usageReports: unknown[] = []) {
	let server: net.Server;
	let address = "";

	server = net.createServer(socket => {
		let buffer = "";
		socket.on("data", chunk => {
			buffer += chunk.toString("utf8");
			const newlineIndex = buffer.indexOf("\n");
			if (newlineIndex !== -1) {
				const line = buffer.slice(0, newlineIndex).trim();
				buffer = buffer.slice(newlineIndex + 1);
				try {
					const req = JSON.parse(line);
					if (req.token !== validToken) {
						socket.write(
							`${JSON.stringify({
								version: 1,
								id: req.id,
								ok: false,
								error: { code: "unauthenticated", message: "invalid bearer token" },
							})}\n`,
						);
						return;
					}

					if (req.action === "records.list") {
						const summaries = records.map(r => {
							const { secretValues: _sv, denyRead: _dr, ...summary } = r;
							return summary;
						});
						socket.write(
							`${JSON.stringify({ version: 1, id: req.id, ok: true, result: { records: summaries } })}\n`,
						);
					} else if (req.action === "records.read") {
						const targetId = req.params?.id;
						const rec = records.find(r => r.id === targetId);
						if (!rec) {
							socket.write(
								`${JSON.stringify({
									version: 1,
									id: req.id,
									ok: false,
									error: { code: "not_found", message: "record not found" },
								})}\n`,
							);
							return;
						}
						if (rec.denyRead) {
							socket.write(
								`${JSON.stringify({
									version: 1,
									id: req.id,
									ok: false,
									error: { code: "forbidden", message: "scope denied for record" },
								})}\n`,
							);
							return;
						}
						const requestedFields = (req.params?.fields as string[]) ?? [];
						const values: Record<string, string> = {};
						for (const f of requestedFields) {
							if (rec.secretValues[f] !== undefined) {
								values[f] = rec.secretValues[f];
							}
						}
						const { secretValues: _sv, denyRead: _dr, ...summary } = rec;
						socket.write(
							`${JSON.stringify({
								version: 1,
								id: req.id,
								ok: true,
								result: { record: summary, values },
							})}\n`,
						);
					} else if (req.action === "oauth.refresh") {
						const rec = records.find(record => record.id === req.params?.id);
						if (!rec) {
							socket.write(
								`${JSON.stringify({
									version: 1,
									id: req.id,
									ok: false,
									error: { code: "record_not_found", message: "record not found" },
								})}\n`,
							);
							return;
						}
						rec.secretValues.access_token = `${rec.secretValues.access_token}-refreshed`;
						rec.metadata = { ...rec.metadata, expires_at_ms: 4_000_000_000_000 };
						const { secretValues: _sv, denyRead: _dr, ...summary } = rec;
						socket.write(
							`${JSON.stringify({
								version: 1,
								id: req.id,
								ok: true,
								result: { record: summary, refreshed: true, revision: 2 },
							})}\n`,
						);
					} else if (req.action === "usage.read") {
						const provider = req.params?.provider;
						const reports =
							typeof provider === "string"
								? usageReports.filter(report => (report as { provider?: string }).provider === provider)
								: usageReports;
						socket.write(
							`${JSON.stringify({
								version: 1,
								id: req.id,
								ok: true,
								result: {
									reports,
									total: usageReports.length,
									matched: reports.length,
									returned: reports.length,
								},
							})}\n`,
						);
					} else {
						socket.write(
							`${JSON.stringify({
								version: 1,
								id: req.id,
								ok: false,
								error: { code: "unknown_action", message: "action not recognized" },
							})}\n`,
						);
					}
				} catch {
					socket.write(
						`${JSON.stringify({
							version: 1,
							id: "error",
							ok: false,
							error: { code: "invalid_json", message: "failed to parse request" },
						})}\n`,
					);
				}
			}
		});
	});

	return new Promise<{ server: net.Server; address: string; port: number }>(resolve => {
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address() as net.AddressInfo;
			address = `127.0.0.1:${addr.port}`;
			resolve({ server, address, port: addr.port });
		});
	});
}

function mockCodexUsage(accountId: string, usedFraction: number): Record<string, unknown> {
	const amount = {
		used: usedFraction * 100,
		limit: 100,
		remaining: (1 - usedFraction) * 100,
		used_fraction: usedFraction,
		remaining_fraction: 1 - usedFraction,
		unit: "percent",
	};
	return {
		provider: "openai-codex",
		fetched_at_ms: Date.now(),
		limits: [
			{
				id: "openai-codex:primary",
				label: "5 hours",
				scope: { provider: "openai-codex", account_id: accountId, window_id: "5h", shared: true },
				window: { id: "5h", label: "5 hours", duration_ms: 18_000_000, resets_at_ms: Date.now() + 9_000_000 },
				amount,
				status: usedFraction >= 1 ? "exhausted" : usedFraction >= 0.9 ? "warning" : "ok",
			},
			{
				id: "openai-codex:secondary",
				label: "7 days",
				scope: { provider: "openai-codex", account_id: accountId, window_id: "7d", shared: true },
				window: { id: "7d", label: "7 days", duration_ms: 604_800_000, resets_at_ms: Date.now() + 302_400_000 },
				amount,
				status: usedFraction >= 1 ? "exhausted" : usedFraction >= 0.9 ? "warning" : "ok",
			},
		],
		metadata: { accountId },
	};
}

function mockCodexRecord(id: string, accountId: string, selectionPriority: number): MockRecord {
	return {
		id,
		title: accountId,
		provider: "openai-codex",
		credential_type: "oauth",
		tags: ["omp-migration"],
		identity: `${accountId}@example.com`,
		account_id: accountId,
		selection_priority: selectionPriority,
		metadata: { expires_at_ms: Date.now() + 60 * 60_000 },
		fields: [{ key: "access_token", sensitive: true }],
		secretValues: { access_token: `access-${accountId}` },
	};
}

describe("LycorpAuth-to-OMP Credential Bridge", () => {
	let mockHandle: { server: net.Server; address: string; port: number } | null = null;

	afterEach(async () => {
		if (mockHandle) {
			await new Promise<void>(res => mockHandle!.server.close(() => res()));
			mockHandle = null;
		}
		delete process.env.LYCORPAUTH_ENABLED;
		delete process.env.LYCORPAUTH_ADDRESS;
		delete process.env.LYCORPAUTH_TOKEN;
		delete process.env.LYCORPAUTH_NETWORK;
		delete process.env.OMP_LYCORPAUTH_ENABLED;
		delete process.env.OMP_LYCORPAUTH_ADDRESS;
		delete process.env.OMP_LYCORPAUTH_TOKEN;
		delete process.env.OMP_AUTH_BROKER_URL;
		delete process.env.OMP_AUTH_BROKER_TOKEN;
		vi.restoreAllMocks();
	});

	test("accepts loopback and Tailscale TCP destinations but rejects public addresses", () => {
		expect(new LycorpAuthClient({ network: "tcp", address: "100.65.141.51:8789", token: MOCK_TOKEN }).address).toBe(
			"100.65.141.51:8789",
		);
		expect(
			new LycorpAuthClient({
				network: "tcp",
				address: "[fd7a:115c:a1e0::493b:8242]:8789",
				token: MOCK_TOKEN,
			}).address,
		).toBe("[fd7a:115c:a1e0::493b:8242]:8789");
		expect(() => new LycorpAuthClient({ network: "tcp", address: "8.8.8.8:8789", token: MOCK_TOKEN })).toThrow(
			"loopback or Tailscale",
		);
	});

	test("resolves API key credential from allowlisted LycorpAuth record", async () => {
		const records: MockRecord[] = [
			{
				id: "rec_openai_key_1",
				title: "OpenAI API Key",
				provider: "openai",
				credential_type: "api_key",
				tags: ["omp"],
				fields: [{ key: "api_key", label: "API Key", sensitive: true }],
				secretValues: { api_key: "sk-proj-synthetic-openai-test-key-123" },
			},
		];
		mockHandle = await createMockLycorpAuthServer(records);

		const client = new LycorpAuthClient({
			network: "tcp",
			address: mockHandle.address,
			token: MOCK_TOKEN,
		});
		const store = new LycorpAuthCredentialStore({ client });
		await store.refreshSnapshot();

		const credentials = store.listAuthCredentials("openai");
		expect(credentials.length).toBe(1);
		expect(credentials[0].provider).toBe("openai");
		expect(credentials[0].credential.type).toBe("api_key");
		expect((credentials[0].credential as { key: string }).key).toBe("sk-proj-synthetic-openai-test-key-123");
	});

	test("builds direct authority storage without broker or SQLite fallback", async () => {
		const records: MockRecord[] = [
			{
				id: "rec_direct_discovery",
				title: "Direct discovery",
				provider: "openai",
				credential_type: "api_key",
				tags: ["omp"],
				fields: [{ key: "api_key", sensitive: true }],
				secretValues: { api_key: "synthetic-direct-discovery-key" },
			},
		];
		mockHandle = await createMockLycorpAuthServer(records);
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "lycorpauth-direct-discovery-"));
		process.env.LYCORPAUTH_ENABLED = "1";
		process.env.LYCORPAUTH_NETWORK = "tcp";
		process.env.LYCORPAUTH_ADDRESS = mockHandle.address;
		process.env.LYCORPAUTH_TOKEN = MOCK_TOKEN;
		try {
			const storage = await discoverLycorpAuthStorage({ agentDir });
			expect(storage?.listStoredCredentials("openai")).toHaveLength(1);
			expect(storage?.describeCredentialSource("openai")).toContain("LycorpAuth");
			storage?.close();
		} finally {
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	test("resolves OAuth credential with redacted diagnostics metadata", async () => {
		const records: MockRecord[] = [
			{
				id: "rec_anthropic_oauth_1",
				title: "Anthropic OAuth",
				provider: "anthropic",
				credential_type: "oauth",
				tags: ["omp-migration"],
				identity: "alice@lycaon.internal",
				selection_priority: 100,
				metadata: { expires_at_ms: 4_000_000_000_000 },
				fields: [{ key: "access_token", sensitive: true }],
				secretValues: {
					access_token: "synth-anthropic-access-token-xyz",
				},
			},
		];
		mockHandle = await createMockLycorpAuthServer(records);

		const client = new LycorpAuthClient({
			network: "tcp",
			address: mockHandle.address,
			token: MOCK_TOKEN,
		});
		const store = new LycorpAuthCredentialStore({ client });
		await store.refreshSnapshot();

		const credentials = store.listAuthCredentials("anthropic");
		expect(credentials.length).toBe(1);
		const oauth = credentials[0].credential as {
			type: string;
			access: string;
			refresh: string;
			expires: number;
			email?: string;
		};
		expect(oauth.type).toBe("oauth");
		expect(oauth.access).toBe("synth-anthropic-access-token-xyz");
		expect(oauth.refresh).toBe(REMOTE_REFRESH_SENTINEL);
		expect(oauth.expires).toBe(4_000_000_000_000);
		expect(oauth.email).toBe("alice@lycaon.internal");
		expect(credentials[0].selectionPriority).toBe(100);
		expect(credentials[0].usageReserveFraction).toBe(0.1);

		const meta = store.getSnapshotMetadata();
		expect(meta.activeCredentialsCount).toBe(1);
		expect(meta.mappedCredentials.length).toBe(1);
		expect(meta.mappedCredentials[0].id).toBe("rec_anthropic_oauth_1");
		expect(meta.mappedCredentials[0].identity).toBe("alice@lycaon.internal");
		const rawMetaJson = JSON.stringify(meta);
		expect(rawMetaJson).not.toContain("synth-anthropic-access-token-xyz");
	});

	test("delegates OAuth refresh to LycorpAuth and reloads the authority snapshot", async () => {
		const records: MockRecord[] = [
			{
				id: "rec_anthropic_refresh",
				title: "Anthropic OAuth",
				provider: "anthropic",
				credential_type: "oauth",
				tags: ["omp-migration"],
				identity: "refresh@example.com",
				metadata: { expires_at_ms: 1 },
				fields: [{ key: "access_token", sensitive: true }],
				secretValues: { access_token: "synthetic-stale-access" },
			},
		];
		mockHandle = await createMockLycorpAuthServer(records);
		const client = new LycorpAuthClient({ network: "tcp", address: mockHandle.address, token: MOCK_TOKEN });
		const store = new LycorpAuthCredentialStore({ client });
		await store.refreshSnapshot();
		const stored = store.listAuthCredentials("anthropic")[0];
		if (stored?.credential.type !== "oauth") throw new Error("missing OAuth fixture");

		const refreshed = await store.refreshOAuthCredential("anthropic", stored.id, stored.credential);
		expect(refreshed.access).toBe("synthetic-stale-access-refreshed");
		expect(refreshed.refresh).toBe(REMOTE_REFRESH_SENTINEL);
		expect(refreshed.expires).toBe(4_000_000_000_000);
		const reloaded = store.getAuthCredential(stored.id);
		expect(reloaded?.credential.type === "oauth" ? reloaded.credential.access : null).toBe(
			"synthetic-stale-access-refreshed",
		);
		store.close();
	});

	test("uses LycorpAuth account priority within the healthy quota class", async () => {
		const records = [
			mockCodexRecord("rec_primary", "acct-primary", 100),
			mockCodexRecord("rec_spare", "acct-spare", 0),
		];
		mockHandle = await createMockLycorpAuthServer(records, MOCK_TOKEN, [
			mockCodexUsage("acct-primary", 0.6),
			mockCodexUsage("acct-spare", 0.1),
		]);
		const client = new LycorpAuthClient({ network: "tcp", address: mockHandle.address, token: MOCK_TOKEN });
		const store = new LycorpAuthCredentialStore({ client });
		await store.refreshSnapshot();
		const authStorage = new AuthStorage(store);
		await authStorage.reload();

		const selected = await authStorage.getOAuthAccess("openai-codex", "priority-selection");
		expect(selected?.accountId).toBe("acct-primary");
		store.close();
	});

	test("moves to a healthy sibling when the priority account enters reserve", async () => {
		const records = [
			mockCodexRecord("rec_primary", "acct-primary", 100),
			mockCodexRecord("rec_spare", "acct-spare", 0),
		];
		mockHandle = await createMockLycorpAuthServer(records, MOCK_TOKEN, [
			mockCodexUsage("acct-primary", 0.95),
			mockCodexUsage("acct-spare", 0.5),
		]);
		const client = new LycorpAuthClient({ network: "tcp", address: mockHandle.address, token: MOCK_TOKEN });
		const store = new LycorpAuthCredentialStore({ client });
		await store.refreshSnapshot();
		const authStorage = new AuthStorage(store);
		await authStorage.reload();
		const storedPrimary = authStorage.listStoredCredentials("openai-codex")[0];
		expect(storedPrimary?.usageReserveFraction).toBe(0.1);
		if (storedPrimary?.credential.type !== "oauth") throw new Error("missing primary OAuth credential");
		const primaryUsage = await store.getUsageReport("openai-codex", storedPrimary.credential);
		expect(primaryUsage?.limits[0]?.amount.usedFraction).toBe(0.95);

		const selected = await authStorage.getOAuthAccess("openai-codex", "reserve-selection");
		expect(selected?.accountId).toBe("acct-spare");
		store.close();
	});

	test("handles scope denial gracefully and captures in redacted diagnostics", async () => {
		const records: MockRecord[] = [
			{
				id: "rec_forbidden_1",
				title: "Forbidden Record",
				provider: "google",
				credential_type: "api_key",
				tags: ["omp"],
				fields: [{ key: "api_key", sensitive: true }],
				secretValues: { api_key: "sk-hidden" },
				denyRead: true,
			},
		];
		mockHandle = await createMockLycorpAuthServer(records);

		const client = new LycorpAuthClient({
			network: "tcp",
			address: mockHandle.address,
			token: MOCK_TOKEN,
		});
		const store = new LycorpAuthCredentialStore({ client });
		await store.refreshSnapshot();

		const credentials = store.listAuthCredentials("google");
		expect(credentials.length).toBe(0);

		const meta = store.getSnapshotMetadata();
		expect(meta.activeCredentialsCount).toBe(0);
		expect(meta.rejectedRecords.length).toBe(1);
		expect(meta.rejectedRecords[0].id).toBe("rec_forbidden_1");
		expect(meta.rejectedRecords[0].reason).toContain("denied");
	});

	test("rejects malformed, ambiguous, disabled, or un-allowlisted records", async () => {
		const records: MockRecord[] = [
			{
				// Record A: OAuth missing access_token field descriptor
				id: "rec_malformed_oauth",
				title: "Malformed OAuth",
				provider: "openai",
				credential_type: "oauth",
				tags: ["omp"],
				fields: [{ key: "unrelated_field", sensitive: false }],
				secretValues: {},
			},
			{
				// Record B: Unsupported credential type
				id: "rec_unsupported_type",
				title: "Unsupported Type",
				provider: "google",
				credential_type: "x509_cert",
				tags: ["omp"],
				fields: [{ key: "cert", sensitive: true }],
				secretValues: { cert: "some-cert" },
			},
			{
				// Record C: Not tagged or marked for OMP
				id: "rec_unmarked",
				title: "Unmarked Record",
				provider: "xai",
				credential_type: "api_key",
				fields: [{ key: "api_key", sensitive: true }],
				secretValues: { api_key: "xai-key-123" },
			},
			{
				// Record D: Soft-disabled record
				id: "rec_disabled",
				title: "Disabled Record",
				provider: "anthropic",
				credential_type: "api_key",
				tags: ["omp"],
				disabled_at: "2026-08-01T00:00:00Z",
				fields: [{ key: "api_key", sensitive: true }],
				secretValues: { api_key: "ant-key-disabled" },
			},
		];
		mockHandle = await createMockLycorpAuthServer(records);

		const client = new LycorpAuthClient({
			network: "tcp",
			address: mockHandle.address,
			token: MOCK_TOKEN,
		});
		const store = new LycorpAuthCredentialStore({ client });
		await store.refreshSnapshot();

		expect(store.listAuthCredentials().length).toBe(0);
		const meta = store.getSnapshotMetadata();
		expect(meta.activeCredentialsCount).toBe(0);
		expect(meta.rejectedRecords.length).toBeGreaterThanOrEqual(2);
	});

	test("keeps authority mutations read-only while allowing snapshot synchronization", async () => {
		const client = new LycorpAuthClient({
			network: "tcp",
			address: "127.0.0.1:8741",
			token: MOCK_TOKEN,
		});
		const store = new LycorpAuthCredentialStore({ client });

		expect(() => store.updateAuthCredential(1, { type: "api_key", key: "k" })).toThrow("snapshot");
		expect(() => store.deleteAuthCredential(1, "test")).toThrow("read-only");
		expect(() => store.tryDisableAuthCredentialIfMatches(1, "expected", "test")).toThrow("read-only");
		expect(() => store.replaceAuthCredentialsForProvider("anthropic", [])).toThrow("read-only");
		expect(() => store.upsertAuthCredentialForProvider("anthropic", { type: "api_key", key: "k" })).toThrow(
			"read-only",
		);
		expect(() => store.deleteAuthCredentialsForProvider("anthropic", "test")).toThrow("read-only");
		expect(
			store.refreshOAuthCredential("anthropic", 1, {
				type: "oauth",
				access: "a",
				refresh: REMOTE_REFRESH_SENTINEL,
				expires: 1,
			}),
		).rejects.toThrow("LycorpAuth");
	});

	test("resolves nested broker and LycorpAuth config without flattening YAML keys", async () => {
		delete process.env.OMP_AUTH_BROKER_URL;
		delete process.env.OMP_AUTH_BROKER_TOKEN;
		delete process.env.LYCORPAUTH_ENABLED;
		delete process.env.OMP_LYCORPAUTH_ENABLED;
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "nested-auth-config-"));
		try {
			await fs.writeFile(
				path.join(agentDir, "config.yml"),
				[
					"auth:",
					"  broker:",
					"    url: http://127.0.0.1:8876",
					"    token: synthetic-broker-token",
					"  lycorpauth:",
					"    enabled: true",
					"    network: tcp",
					"    address: 127.0.0.1:8741",
					"    token: synthetic-lycorpauth-token",
					"",
				].join("\n"),
				"utf8",
			);
			const resolveLiteral = async (value: string): Promise<string> => value;
			await expect(resolveAuthBrokerConfig({ agentDir, configValueResolver: resolveLiteral })).resolves.toEqual({
				url: "http://127.0.0.1:8876",
				token: "synthetic-broker-token",
			});
			await expect(resolveLycorpAuthConfig({ agentDir, configValueResolver: resolveLiteral })).resolves.toEqual({
				network: "tcp",
				address: "127.0.0.1:8741",
				token: "synthetic-lycorpauth-token",
			});
		} finally {
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	test("absent-config fallback leaves discovery behavior unchanged", async () => {
		delete process.env.LYCORPAUTH_ENABLED;
		delete process.env.OMP_LYCORPAUTH_ENABLED;
		delete process.env.OMP_AUTH_BROKER_URL;

		const lycorpConfig = await resolveLycorpAuthConfig();
		expect(lycorpConfig).toBeNull();
	});
});
