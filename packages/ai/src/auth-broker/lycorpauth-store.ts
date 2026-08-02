import {
	type ApiKeyCredential,
	type AuthCredential,
	type AuthCredentialStore,
	type OAuthCredential,
	REMOTE_REFRESH_SENTINEL,
	type StoredAuthCredential,
} from "../auth-storage";
import type { Provider } from "../types";
import type { UsageReport, UsageStatus, UsageUnit } from "../usage";
import type { LycorpAuthClient, LycorpAuthRecordGetResult, LycorpAuthRecordSummary } from "./lycorpauth-client";

export interface LycorpAuthStoreOptions {
	client: LycorpAuthClient;
	sourceLabel?: string;
	usageReserveFraction?: number;
}

export interface LycorpAuthMappedCredential {
	id: string;
	numericId: number;
	provider: string;
	credentialType: "api_key" | "oauth";
	identity?: string;
}

export interface LycorpAuthRejectedRecord {
	id: string;
	provider: string;
	reason: string;
}

export interface LycorpAuthSnapshotMetadata {
	clientAddress: string;
	clientNetwork: "unix" | "tcp";
	sourceLabel: string;
	totalSourceRecords: number;
	activeCredentialsCount: number;
	providerCounts: Record<string, number>;
	mappedCredentials: LycorpAuthMappedCredential[];
	rejectedRecords: LycorpAuthRejectedRecord[];
}

function deterministicNumericId(str: string): number {
	let hash = 2166136261;
	for (let i = 0; i < str.length; i++) {
		hash ^= str.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0) % 2147483647 || 1;
}

function isOmpAllowlistedRecord(record: LycorpAuthRecordSummary): boolean {
	if (record.disabled_at != null) {
		return false;
	}
	const tags = (record.tags ?? []).map(t => t.toLowerCase());
	if (
		tags.includes("omp") ||
		tags.includes("oh-my-pi") ||
		tags.includes("omp-credential") ||
		tags.includes("omp-migration")
	) {
		return true;
	}
	const metadata = record.metadata ?? {};
	const rawOmpValue = metadata.omp ?? metadata.harness ?? metadata.target ?? metadata.allow_omp;
	const ompValue =
		typeof rawOmpValue === "string" || typeof rawOmpValue === "number" || typeof rawOmpValue === "boolean"
			? String(rawOmpValue).toLowerCase()
			: "";
	return ompValue === "true" || ompValue === "omp" || ompValue === "1";
}

function normalizeProviderName(raw: string): string {
	const p = raw.trim().toLowerCase();
	if (p === "openai-codex" || p === "codex") return "openai-codex";
	if (p === "google-antigravity" || p === "antigravity") return "google-antigravity";
	if (p === "google-gemini-cli" || p === "gemini-cli") return "google-gemini-cli";
	if (p === "github-copilot" || p === "copilot") return "github-copilot";
	if (p === "xai-oauth") return "xai-oauth";
	return p;
}

function parseExpiresAt(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value > 0 && value < 1_000_000_000_000 ? value * 1_000 : value;
	}
	if (typeof value !== "string" || value.trim().length === 0) return undefined;
	const numeric = Number(value);
	if (Number.isFinite(numeric)) {
		return numeric > 0 && numeric < 1_000_000_000_000 ? numeric * 1_000 : numeric;
	}
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeUsageReport(value: unknown): UsageReport | null {
	const raw = asRecord(value);
	if (!raw || typeof raw.provider !== "string") return null;
	const fetchedAt = finiteNumber(raw.fetched_at_ms);
	if (fetchedAt === undefined || !Array.isArray(raw.limits)) return null;
	const limits = raw.limits.flatMap(limitValue => {
		const limit = asRecord(limitValue);
		const scope = asRecord(limit?.scope);
		const amount = asRecord(limit?.amount);
		if (
			!limit ||
			typeof limit.id !== "string" ||
			typeof limit.label !== "string" ||
			!scope ||
			!amount ||
			typeof amount.unit !== "string"
		) {
			return [];
		}
		const window = asRecord(limit.window);
		return [
			{
				id: limit.id,
				label: limit.label,
				scope: {
					provider: (typeof scope.provider === "string" ? scope.provider : raw.provider) as Provider,
					accountId: typeof scope.account_id === "string" ? scope.account_id : undefined,
					projectId: typeof scope.project_id === "string" ? scope.project_id : undefined,
					orgId: typeof scope.org_id === "string" ? scope.org_id : undefined,
					modelId: typeof scope.model_id === "string" ? scope.model_id : undefined,
					tier: typeof scope.tier === "string" ? scope.tier : undefined,
					windowId: typeof scope.window_id === "string" ? scope.window_id : undefined,
					shared: typeof scope.shared === "boolean" ? scope.shared : undefined,
				},
				window: window
					? {
							id: typeof window.id === "string" ? window.id : "",
							label: typeof window.label === "string" ? window.label : "",
							durationMs: finiteNumber(window.duration_ms),
							resetsAt: finiteNumber(window.resets_at_ms),
						}
					: undefined,
				amount: {
					used: finiteNumber(amount.used),
					limit: finiteNumber(amount.limit),
					remaining: finiteNumber(amount.remaining),
					usedFraction: finiteNumber(amount.used_fraction),
					remainingFraction: finiteNumber(amount.remaining_fraction),
					unit: amount.unit as UsageUnit,
				},
				status:
					limit.status === "ok" ||
					limit.status === "warning" ||
					limit.status === "exhausted" ||
					limit.status === "unknown"
						? (limit.status as UsageStatus)
						: undefined,
				notes: Array.isArray(limit.notes)
					? limit.notes.filter((note): note is string => typeof note === "string")
					: undefined,
			},
		];
	});
	const resetCredits = asRecord(raw.reset_credits);
	return {
		provider: raw.provider as Provider,
		fetchedAt,
		limits,
		resetCredits:
			typeof resetCredits?.available_count === "number"
				? { availableCount: resetCredits.available_count }
				: undefined,
		metadata: asRecord(raw.metadata),
	};
}

export class LycorpAuthCredentialStore implements AuthCredentialStore {
	readonly #client: LycorpAuthClient;
	readonly #sourceLabel: string;
	readonly #usageReserveFraction: number;
	#credentialsMap = new Map<number, StoredAuthCredential>();
	#credentialsList: StoredAuthCredential[] = [];
	#sourceRecordIds = new Map<number, string>();
	#snapshotMetadata: LycorpAuthSnapshotMetadata;
	#cache = new Map<string, { value: string; expiresAtSec: number }>();
	#usageReportsCache?: { expiresAt: number; reports: UsageReport[] };
	#usageReportsInFlight?: Promise<UsageReport[]>;
	#closed = false;

	constructor(opts: LycorpAuthStoreOptions) {
		this.#client = opts.client;
		this.#sourceLabel = opts.sourceLabel ?? `LycorpAuth (${opts.client.address})`;
		const usageReserveFraction = opts.usageReserveFraction ?? 0.1;
		if (!Number.isFinite(usageReserveFraction) || usageReserveFraction < 0 || usageReserveFraction > 1) {
			throw new Error("LycorpAuth usage reserve fraction must be between 0 and 1");
		}
		this.#usageReserveFraction = usageReserveFraction;
		this.#snapshotMetadata = {
			clientAddress: this.#client.address,
			clientNetwork: this.#client.network,
			sourceLabel: this.#sourceLabel,
			totalSourceRecords: 0,
			activeCredentialsCount: 0,
			providerCounts: {},
			mappedCredentials: [],
			rejectedRecords: [],
		};
	}

	get client(): LycorpAuthClient {
		return this.#client;
	}

	get sourceLabel(): string {
		return this.#sourceLabel;
	}

	getSnapshotMetadata(): LycorpAuthSnapshotMetadata {
		return {
			...this.#snapshotMetadata,
			mappedCredentials: [...this.#snapshotMetadata.mappedCredentials],
			rejectedRecords: [...this.#snapshotMetadata.rejectedRecords],
			providerCounts: { ...this.#snapshotMetadata.providerCounts },
		};
	}

	async refreshSnapshot(signal?: AbortSignal): Promise<void> {
		if (this.#closed) {
			throw new Error("LycorpAuthCredentialStore is closed");
		}
		const listResult = await this.#client.fetchRecordsList(signal);
		const records = listResult.records ?? [];

		const nextCredentialsMap = new Map<number, StoredAuthCredential>();
		const nextCredentialsList: StoredAuthCredential[] = [];
		const nextSourceRecordIds = new Map<number, string>();
		const mappedCredentials: LycorpAuthMappedCredential[] = [];
		const rejectedRecords: LycorpAuthRejectedRecord[] = [];
		const providerCounts: Record<string, number> = {};

		for (const record of records) {
			if (record.disabled_at != null) {
				continue;
			}
			if (!isOmpAllowlistedRecord(record)) {
				continue;
			}

			const rawProvider = record.provider ?? "";
			if (!rawProvider) {
				rejectedRecords.push({
					id: record.id,
					provider: "unknown",
					reason: "Record is missing provider field",
				});
				continue;
			}

			const provider = normalizeProviderName(rawProvider);
			const credType = (record.credential_type ?? "").toLowerCase();
			const fieldDescs = record.fields ?? [];

			if (credType === "api_key" || credType === "api-key" || credType === "apikey") {
				const apiKeyField = fieldDescs.find(f => {
					const k = f.key.toLowerCase();
					return k === "api_key" || k === "key" || k === "token" || k === "apikey" || k === "secret_key";
				});

				if (!apiKeyField) {
					rejectedRecords.push({
						id: record.id,
						provider,
						reason: "API key record missing recognized key field descriptor (api_key/key/token)",
					});
					continue;
				}

				let readResult: LycorpAuthRecordGetResult;
				try {
					readResult = await this.#client.fetchRecordRead(record.id, [apiKeyField.key], signal);
				} catch {
					rejectedRecords.push({
						id: record.id,
						provider,
						reason: "LycorpAuth denied or failed the requested API-key field read",
					});
					continue;
				}

				const secretValue = readResult.values?.[apiKeyField.key];
				if (!secretValue || secretValue.trim().length === 0) {
					rejectedRecords.push({
						id: record.id,
						provider,
						reason: "API key field value was empty or missing",
					});
					continue;
				}

				const apiKeyCred: ApiKeyCredential = {
					type: "api_key",
					key: secretValue,
				};
				const numId = deterministicNumericId(record.id);
				const stored: StoredAuthCredential = {
					id: numId,
					provider,
					credential: apiKeyCred,
					selectionPriority:
						typeof record.selection_priority === "number" && Number.isFinite(record.selection_priority)
							? record.selection_priority
							: 0,
					usageReserveFraction: this.#usageReserveFraction,
					disabledCause: null,
				};

				nextCredentialsMap.set(numId, stored);
				nextSourceRecordIds.set(numId, record.id);
				nextCredentialsList.push(stored);
				mappedCredentials.push({
					id: record.id,
					numericId: numId,
					provider,
					credentialType: "api_key",
					identity: record.identity,
				});
				providerCounts[provider] = (providerCounts[provider] ?? 0) + 1;
			} else if (credType === "oauth") {
				const fieldByKey = new Map(fieldDescs.map(field => [field.key.toLowerCase(), field.key]));
				const accessField = fieldByKey.get("access_token") ?? fieldByKey.get("access");
				const expiresField = fieldByKey.get("expires_at") ?? fieldByKey.get("expires");
				if (!accessField) {
					rejectedRecords.push({
						id: record.id,
						provider,
						reason: "OAuth record requires an access_token field descriptor",
					});
					continue;
				}

				const allowedFieldNames = [
					accessField,
					expiresField,
					fieldByKey.get("account_id"),
					fieldByKey.get("email"),
					fieldByKey.get("project_id"),
					fieldByKey.get("enterprise_url"),
					fieldByKey.get("api_endpoint"),
				].filter((field): field is string => field !== undefined);
				let readResult: LycorpAuthRecordGetResult;
				try {
					readResult = await this.#client.fetchRecordRead(record.id, allowedFieldNames, signal);
				} catch {
					rejectedRecords.push({
						id: record.id,
						provider,
						reason: "LycorpAuth denied or failed the requested OAuth field read",
					});
					continue;
				}

				const values = readResult.values ?? {};
				const metadata = record.metadata ?? {};
				const valueFor = (key: string): string | undefined => {
					const sourceKey = fieldByKey.get(key);
					return sourceKey ? values[sourceKey] : undefined;
				};
				const metadataString = (key: string): string | undefined => {
					const value = metadata[key];
					return typeof value === "string" && value.length > 0 ? value : undefined;
				};
				const access = values[accessField];
				const expires = parseExpiresAt(
					(expiresField ? values[expiresField] : undefined) ?? metadata.expires_at_ms ?? metadata.expires_at,
				);
				if (
					!access ||
					access.trim().length === 0 ||
					expires === undefined ||
					!Number.isSafeInteger(expires) ||
					expires <= 0
				) {
					rejectedRecords.push({
						id: record.id,
						provider,
						reason: "OAuth access_token or expiration metadata was empty or invalid",
					});
					continue;
				}

				const accountId = record.account_id || valueFor("account_id") || metadataString("account_id");
				const email = record.identity || valueFor("email") || metadataString("email");
				const oauthCredential: OAuthCredential = {
					type: "oauth",
					access,
					refresh: REMOTE_REFRESH_SENTINEL,
					expires,
					accountId,
					projectId: valueFor("project_id"),
					email,
					enterpriseUrl: valueFor("enterprise_url"),
					apiEndpoint: valueFor("api_endpoint"),
				};

				const numericId = deterministicNumericId(record.id);
				const stored: StoredAuthCredential = {
					id: numericId,
					provider,
					credential: oauthCredential,
					selectionPriority:
						typeof record.selection_priority === "number" && Number.isFinite(record.selection_priority)
							? record.selection_priority
							: 0,
					usageReserveFraction: this.#usageReserveFraction,
					disabledCause: null,
				};

				nextCredentialsMap.set(numericId, stored);
				nextSourceRecordIds.set(numericId, record.id);
				nextCredentialsList.push(stored);
				mappedCredentials.push({
					id: record.id,
					numericId,
					provider,
					credentialType: "oauth",
					identity: email,
				});
				providerCounts[provider] = (providerCounts[provider] ?? 0) + 1;
			} else {
				rejectedRecords.push({
					id: record.id,
					provider,
					reason: `Unsupported or ambiguous credential_type '${record.credential_type}'`,
				});
			}
		}

		this.#credentialsMap = nextCredentialsMap;
		this.#credentialsList = nextCredentialsList;
		this.#sourceRecordIds = nextSourceRecordIds;
		this.#snapshotMetadata = {
			clientAddress: this.#client.address,
			clientNetwork: this.#client.network,
			sourceLabel: this.#sourceLabel,
			totalSourceRecords: records.length,
			activeCredentialsCount: nextCredentialsList.length,
			providerCounts,
			mappedCredentials,
			rejectedRecords,
		};
	}

	async #loadUsageReports(signal?: AbortSignal): Promise<UsageReport[]> {
		if (this.#usageReportsCache && this.#usageReportsCache.expiresAt > Date.now()) {
			return this.#usageReportsCache.reports;
		}
		if (this.#usageReportsInFlight) return this.#usageReportsInFlight;
		const request = this.#client
			.fetchUsage(undefined, signal)
			.then(result =>
				(result.reports ?? []).map(normalizeUsageReport).filter((report): report is UsageReport => report !== null),
			)
			.then(reports => {
				this.#usageReportsCache = { expiresAt: Date.now() + 15_000, reports };
				return reports;
			})
			.finally(() => {
				this.#usageReportsInFlight = undefined;
			});
		this.#usageReportsInFlight = request;
		return request;
	}

	// ─── AuthCredentialStore Interface Implementation ──────────────────────

	close(): void {
		this.#closed = true;
		this.#credentialsMap.clear();
		this.#sourceRecordIds.clear();
		this.#credentialsList = [];
		this.#cache.clear();
		this.#usageReportsCache = undefined;
		this.#usageReportsInFlight = undefined;
	}

	listAuthCredentials(provider?: string): StoredAuthCredential[] {
		if (this.#closed) return [];
		if (!provider) return [...this.#credentialsList];
		const norm = normalizeProviderName(provider);
		return this.#credentialsList.filter(c => c.provider === norm || c.provider === provider);
	}

	getAuthCredential(id: number): StoredAuthCredential | undefined {
		if (this.#closed) return undefined;
		return this.#credentialsMap.get(id);
	}

	updateAuthCredential(id: number, credential: AuthCredential): void {
		const current = this.#credentialsMap.get(id);
		if (!current) throw new Error(`LycorpAuth credential snapshot does not contain id=${id}`);
		const updated = { ...current, credential };
		this.#credentialsMap.set(id, updated);
		const index = this.#credentialsList.findIndex(entry => entry.id === id);
		if (index !== -1) {
			this.#credentialsList[index] = updated;
		}
	}

	deleteAuthCredential(_id: number, _disabledCause: string): void {
		throw new Error("LycorpAuth credential bridge is read-only.");
	}

	tryDisableAuthCredentialIfMatches(_id: number, _expectedData: string, _disabledCause: string): boolean {
		throw new Error("LycorpAuth credential bridge is read-only.");
	}

	replaceAuthCredentialsForProvider(_provider: string, _credentials: AuthCredential[]): StoredAuthCredential[] {
		throw new Error("LycorpAuth credential bridge is read-only.");
	}

	upsertAuthCredentialForProvider(_provider: string, _credential: AuthCredential): StoredAuthCredential[] {
		throw new Error("LycorpAuth credential bridge is read-only.");
	}

	deleteAuthCredentialsForProvider(_provider: string, _disabledCause: string): void {
		throw new Error("LycorpAuth credential bridge is read-only.");
	}

	async tryDisableAuthCredentialIfMatchesRemote(
		id: number,
		_expectedData: string,
		_disabledCause: string,
	): Promise<boolean> {
		if (!this.#credentialsMap.has(id)) return false;
		this.#credentialsMap.delete(id);
		this.#sourceRecordIds.delete(id);
		this.#credentialsList = this.#credentialsList.filter(entry => entry.id !== id);
		return true;
	}

	async markCredentialSuspect(_credentialId: number, opts?: { signal?: AbortSignal }): Promise<void> {
		await this.refreshSnapshot(opts?.signal);
	}

	async fetchUsageReports(signal?: AbortSignal): Promise<UsageReport[]> {
		return this.#loadUsageReports(signal);
	}

	async getUsageReport(
		provider: Provider,
		credential: OAuthCredential,
		signal?: AbortSignal,
	): Promise<UsageReport | null> {
		const reports = (await this.#loadUsageReports(signal)).filter(report => report.provider === provider);
		const matchingAccount = credential.accountId
			? reports.find(
					report =>
						report.metadata?.accountId === credential.accountId ||
						report.limits.some(limit => limit.scope.accountId === credential.accountId),
				)
			: undefined;
		if (matchingAccount) return matchingAccount;
		const matchingEmail = credential.email
			? reports.find(report => report.metadata?.email === credential.email)
			: undefined;
		if (matchingEmail) return matchingEmail;
		return reports.length === 1 ? (reports[0] ?? null) : null;
	}

	async refreshOAuthCredential(
		provider: Provider,
		credentialId: number,
		_credential: OAuthCredential,
		signal?: AbortSignal,
	): Promise<OAuthCredential> {
		const sourceRecordId = this.#sourceRecordIds.get(credentialId);
		if (!sourceRecordId) throw new Error(`LycorpAuth credential snapshot does not contain id=${credentialId}`);
		await this.#client.refreshOAuthRecord(sourceRecordId, true, signal);
		await this.refreshSnapshot(signal);
		const updated = this.#credentialsMap.get(credentialId);
		if (updated?.provider !== normalizeProviderName(provider) || updated.credential.type !== "oauth") {
			throw new Error("LycorpAuth OAuth refresh did not return the requested credential");
		}
		return updated.credential;
	}

	getCache(key: string): string | null {
		const entry = this.#cache.get(key);
		if (!entry) return null;
		if (Math.floor(Date.now() / 1000) > entry.expiresAtSec) {
			this.#cache.delete(key);
			return null;
		}
		return entry.value;
	}

	setCache(key: string, value: string, expiresAtSec: number): void {
		this.#cache.set(key, { value, expiresAtSec });
	}

	cleanExpiredCache(): void {
		const nowSec = Math.floor(Date.now() / 1000);
		for (const [k, v] of this.#cache.entries()) {
			if (nowSec > v.expiresAtSec) {
				this.#cache.delete(k);
			}
		}
	}
}
