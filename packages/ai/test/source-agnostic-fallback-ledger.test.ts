import { describe, expect, it } from "bun:test";
import type { AuthAttemptLedgerEntry, AuthCredentialStore, UsageReport } from "../src";
import { AuthStorage, classifyAuthAttemptReason, claudeRankingStrategy, findNormalizedWindowLimits } from "../src";

describe("source-agnostic window limit ranking", () => {
	it("ranks windows dynamically from UsageReport.limits using duration and reset horizon without hardcoded Anthropic IDs", () => {
		const report: UsageReport = {
			provider: "anthropic",
			fetchedAt: 1000000,
			limits: [
				{
					id: "custom:7d",
					label: "Weekly Cap",
					scope: { provider: "anthropic" },
					window: { id: "7d", label: "7 Day", durationMs: 7 * 24 * 60 * 60 * 1000 },
					amount: { unit: "percent", usedFraction: 0.4 },
				},
				{
					id: "custom:5h",
					label: "Short Window",
					scope: { provider: "anthropic" },
					window: { id: "5h", label: "5 Hour", durationMs: 5 * 60 * 60 * 1000 },
					amount: { unit: "percent", usedFraction: 0.1 },
				},
			],
		};

		const { primary, secondary } = claudeRankingStrategy.findWindowLimits(report);
		expect(primary?.id).toBe("custom:5h");
		expect(secondary?.id).toBe("custom:7d");
	});

	it("applies identical ranking policy to API-key rate-limit header reports and OAuth subscription reports", () => {
		const apiKeyHeaderReport: UsageReport = {
			provider: "anthropic",
			fetchedAt: 2000000,
			limits: [
				{
					id: "api_key_window_long",
					label: "24 Hour",
					scope: { provider: "anthropic" },
					window: { id: "24h", label: "24 Hour", durationMs: 24 * 60 * 60 * 1000 },
					amount: { unit: "tokens", used: 100, limit: 1000 },
				},
				{
					id: "api_key_window_short",
					label: "1 Hour",
					scope: { provider: "anthropic" },
					window: { id: "1h", label: "1 Hour", durationMs: 60 * 60 * 1000 },
					amount: { unit: "tokens", used: 10, limit: 100 },
				},
			],
		};

		const { primary, secondary } = findNormalizedWindowLimits(apiKeyHeaderReport);
		expect(primary?.id).toBe("api_key_window_short");
		expect(secondary?.id).toBe("api_key_window_long");
	});

	it("breaks ties deterministically by limit ID when durations match", () => {
		const report: UsageReport = {
			provider: "anthropic",
			fetchedAt: 1000000,
			limits: [
				{
					id: "limit:b",
					label: "Bucket B",
					scope: { provider: "anthropic" },
					window: { id: "1h", label: "1 Hour", durationMs: 3600000 },
					amount: { unit: "percent", usedFraction: 0.2 },
				},
				{
					id: "limit:a",
					label: "Bucket A",
					scope: { provider: "anthropic" },
					window: { id: "1h", label: "1 Hour", durationMs: 3600000 },
					amount: { unit: "percent", usedFraction: 0.2 },
				},
			],
		};

		const { primary, secondary } = findNormalizedWindowLimits(report);
		expect(primary?.id).toBe("limit:a");
		expect(secondary?.id).toBe("limit:b");
	});
	it("parses month windows after hour windows when duration metadata is absent", () => {
		const report: UsageReport = {
			provider: "anthropic",
			fetchedAt: 1_000_000,
			limits: [
				{
					id: "window:1mo",
					label: "Monthly",
					scope: { provider: "anthropic", windowId: "1mo" },
					amount: { unit: "percent", usedFraction: 0.1 },
				},
				{
					id: "window:1h",
					label: "Hourly",
					scope: { provider: "anthropic", windowId: "1h" },
					amount: { unit: "percent", usedFraction: 0.1 },
				},
			],
		};

		const { primary, secondary } = findNormalizedWindowLimits(report);
		expect(primary?.id).toBe("window:1h");
		expect(secondary?.id).toBe("window:1mo");
	});
});

describe("source-agnostic retry classification", () => {
	it("classifies equivalent OAuth and API-key authentication failures identically", () => {
		const apiKeyAuthError = Object.assign(new Error("401 Invalid API key provided"), { status: 401 });
		const oauthAuthError = Object.assign(new Error("403 oauth_not_allowed_for_organization"), { status: 403 });
		const oauthRefreshError = new Error("OAuth refresh failed: invalid_grant refresh token revoked");

		expect(classifyAuthAttemptReason(apiKeyAuthError)).toBe("authentication");
		expect(classifyAuthAttemptReason(oauthAuthError)).toBe("authentication");
		expect(classifyAuthAttemptReason(oauthRefreshError)).toBe("authentication");
	});

	it("classifies equivalent usage-limit and transient failures identically into allowlisted reason codes", () => {
		const quotaError = Object.assign(new Error("429 You have exceeded your quota"), { status: 429 });
		const transientError = Object.assign(new Error("503 Service Unavailable"), { status: 503 });
		const perMinuteRateLimit = Object.assign(new Error("429 Too many requests, retry in 5s"), { status: 429 });

		expect(classifyAuthAttemptReason(quotaError)).toBe("rate_limit");
		expect(classifyAuthAttemptReason(transientError)).toBe("transient");
		expect(classifyAuthAttemptReason(perMinuteRateLimit)).toBe("rate_limit");
	});

	it("classifies classifier refusals and fireworks fast fallbacks explicitly without raw string leakage", () => {
		const refusalReason = classifyAuthAttemptReason(new Error("Safety check failed"), { isClassifierRefusal: true });
		const fastReason = classifyAuthAttemptReason(new Error("Router error"), { isFireworksFast: true });

		expect(refusalReason).toBe("classifier_refusal");
		expect(fastReason).toBe("fireworks_fast");
		expect(refusalReason).not.toContain("Safety check");
	});
});

describe("attempt ledger payload contract and durable append", () => {
	it("produces secret-free ledger entry and awaits durable append", async () => {
		const recorded: AuthAttemptLedgerEntry[] = [];
		const { promise: delayPromise, resolve: resolveDelay } = Promise.withResolvers<void>();
		const mockStore: Partial<AuthCredentialStore> = {
			close() {},
			listAuthCredentials() {
				return [];
			},
			updateAuthCredential() {},
			deleteAuthCredential() {},
			tryDisableAuthCredentialIfMatches() {
				return false;
			},
			replaceAuthCredentialsForProvider() {
				return [];
			},
			upsertAuthCredentialForProvider() {
				return [
					{
						id: 1,
						provider: "anthropic",
						credential: { type: "api_key", key: "secret-key" },
						disabledCause: null,
					},
				];
			},
			deleteAuthCredentialsForProvider() {},
			getCache() {
				return null;
			},
			setCache() {},
			cleanExpiredCache() {},
			async recordAuthAttempt(entry) {
				await delayPromise;
				recorded.push(entry);
			},
		};

		const storage = new AuthStorage(mockStore as AuthCredentialStore);
		const entry: AuthAttemptLedgerEntry = {
			recordedAt: 1234567890,
			sessionId: "session-abc",
			attempt: 2,
			selector: "anthropic/claude-3-5-sonnet",
			nextSelector: "openai/gpt-4o",
			reasonCode: "rate_limit",
			outcome: "failed",
			usage: { input: 1500, output: 250, cacheRead: 500, cacheWrite: 0, totalTokens: 2250 },
			costUsd: 0.015,
		};

		let appendCompleted = false;
		const appendPromise = storage.recordAuthAttempt(entry).then(() => {
			appendCompleted = true;
		});

		expect(appendCompleted).toBe(false);
		resolveDelay();
		await appendPromise;
		expect(appendCompleted).toBe(true);
		expect(recorded).toHaveLength(1);
		const saved = recorded[0]!;
		expect(saved.recordedAt).toBe(1234567890);
		expect(saved.sessionId).toBe("session-abc");
		expect(saved.attempt).toBe(2);
		expect(saved.selector).toBe("anthropic/claude-3-5-sonnet");
		expect(saved.nextSelector).toBe("openai/gpt-4o");
		expect(saved.reasonCode).toBe("rate_limit");
		expect(saved.outcome).toBe("failed");
		expect(saved.usage).toEqual({ input: 1500, output: 250, cacheRead: 500, cacheWrite: 0, totalTokens: 2250 });
		expect(saved.costUsd).toBe(0.015);

		// Assert no prompt, response text, secrets, or raw errors exist in the recorded payload
		const keys = Object.keys(saved);
		expect(keys).toEqual([
			"recordedAt",
			"sessionId",
			"attempt",
			"selector",
			"nextSelector",
			"reasonCode",
			"outcome",
			"usage",
			"costUsd",
		]);
	});
});
