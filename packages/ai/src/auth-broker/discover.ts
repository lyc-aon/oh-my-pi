/**
 * Broker-aware auth-storage discovery used by both the coding-agent runtime and
 * the catalog model generator. Keeps the precedence logic (env → config.yml →
 * token file → local SQLite) in one place so build-time tooling sees the same
 * credentials as the TUI.
 */
import * as path from "node:path";
import {
	getAgentDbPath,
	getAgentDir,
	getAuthBrokerSnapshotCachePath,
	getConfigRootDir,
	isEnoent,
	logger,
} from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { AuthStorage } from "../auth-storage";
import { AuthBrokerClient } from "./client";
import { LycorpAuthClient } from "./lycorpauth-client";
import { LycorpAuthCredentialStore } from "./lycorpauth-store";
import { RemoteAuthCredentialStore } from "./remote-store";
import { readAuthBrokerSnapshotCache, writeAuthBrokerSnapshotCache } from "./snapshot-cache";
import { DEFAULT_SNAPSHOT_CACHE_TTL_MS, type SnapshotResponse } from "./types";

export interface LycorpAuthConfig {
	network: "unix" | "tcp";
	address: string;
	token: string;
}

export interface ResolveLycorpAuthConfigOptions {
	agentDir?: string;
	configValueResolver?: (config: string) => Promise<string | undefined>;
}

export interface AuthBrokerClientConfig {
	url: string;
	token: string;
}

export interface ResolveAuthBrokerConfigOptions {
	agentDir?: string;
	configValueResolver?: (config: string) => Promise<string | undefined>;
}

export interface DiscoverAuthStorageOptions {
	agentDir?: string;
	configValueResolver?: (config: string) => Promise<string | undefined>;
	cachePath?: string;
	sourceLabel?: string;
}

/** Path to the local bearer token file. Created by `omp auth-broker token`. */
export function getAuthBrokerTokenFilePath(): string {
	return path.join(getConfigRootDir(), "auth-broker.token");
}

/**
 * Default resolver for config values: checks `process.env` first, then treats
 * the value as a literal. Does NOT execute `!command` syntax; such values are
 * left unresolved so the caller can fall back to the token file.
 */
async function defaultResolveConfigValue(config: string): Promise<string | undefined> {
	if (config.startsWith("!")) return undefined;
	const envValue = process.env[config];
	return envValue || config;
}

async function readTokenFile(): Promise<string | null> {
	try {
		const raw = await Bun.file(getAuthBrokerTokenFilePath()).text();
		const trimmed = raw.trim();
		return trimmed.length > 0 ? trimmed : null;
	} catch (err) {
		if (isEnoent(err)) return null;
		logger.warn("auth-broker token file unreadable", { error: String(err) });
		return null;
	}
}

interface ConfigSnapshot {
	url?: string;
	token?: string;
	lycorpauthEnabled?: boolean;
	lycorpauthAddress?: string;
	lycorpauthNetwork?: "unix" | "tcp";
	lycorpauthToken?: string;
	lycorpauthTokenFile?: string;
}

async function readConfigYaml(agentDir: string): Promise<ConfigSnapshot> {
	const configPath = path.join(agentDir, "config.yml");
	try {
		const raw = await Bun.file(configPath).text();
		const parsed = YAML.parse(raw);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		const record = parsed as Record<string, unknown>;
		const asRecord = (value: unknown): Record<string, unknown> | undefined =>
			value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
		const auth = asRecord(record.auth);
		const broker = asRecord(auth?.broker);
		const lycorpauth = asRecord(auth?.lycorpauth);
		const urlValue = record["auth.broker.url"] ?? broker?.url;
		const tokenValue = record["auth.broker.token"] ?? broker?.token;
		const url = typeof urlValue === "string" ? urlValue : undefined;
		const token = typeof tokenValue === "string" ? tokenValue : undefined;
		const lycorpauthEnabledValue = record["auth.lycorpauth.enabled"] ?? lycorpauth?.enabled;
		const lycorpauthEnabled =
			typeof lycorpauthEnabledValue === "boolean"
				? lycorpauthEnabledValue
				: lycorpauthEnabledValue === "true" || lycorpauthEnabledValue === "1";
		const lycorpauthAddressValue =
			record["auth.lycorpauth.address"] ??
			record["auth.lycorpauth.socket"] ??
			lycorpauth?.address ??
			lycorpauth?.socket;
		const lycorpauthAddress = typeof lycorpauthAddressValue === "string" ? lycorpauthAddressValue : undefined;
		const lycorpauthNetworkValue = record["auth.lycorpauth.network"] ?? lycorpauth?.network;
		const lycorpauthNetwork =
			lycorpauthNetworkValue === "unix" || lycorpauthNetworkValue === "tcp" ? lycorpauthNetworkValue : undefined;
		const lycorpauthTokenValue = record["auth.lycorpauth.token"] ?? lycorpauth?.token;
		const lycorpauthToken = typeof lycorpauthTokenValue === "string" ? lycorpauthTokenValue : undefined;
		const lycorpauthTokenFileValue =
			record["auth.lycorpauth.tokenFile"] ?? lycorpauth?.tokenFile ?? lycorpauth?.token_file;
		const lycorpauthTokenFile = typeof lycorpauthTokenFileValue === "string" ? lycorpauthTokenFileValue : undefined;
		return {
			url,
			token,
			lycorpauthEnabled,
			lycorpauthAddress,
			lycorpauthNetwork,
			lycorpauthToken,
			lycorpauthTokenFile,
		};
	} catch (err) {
		if (isEnoent(err)) return {};
		logger.warn("auth-broker config.yml unreadable", { error: String(err) });
		return {};
	}
}

function resolveSnapshotTtlMs(): number {
	const raw = process.env.OMP_AUTH_BROKER_SNAPSHOT_TTL_MS;
	if (raw === undefined) return DEFAULT_SNAPSHOT_CACHE_TTL_MS;
	const value = raw.trim();
	if (value === "") return DEFAULT_SNAPSHOT_CACHE_TTL_MS;
	const ttlMs = Number(value);
	if (Number.isFinite(ttlMs) && ttlMs >= 0) return ttlMs;
	logger.warn("Invalid OMP_AUTH_BROKER_SNAPSHOT_TTL_MS; using default", { value: raw });
	return DEFAULT_SNAPSHOT_CACHE_TTL_MS;
}

/**
 * Resolve LycorpAuth bridge configuration.
 * Precedence:
 * 1. LYCORPAUTH_ENABLED / OMP_LYCORPAUTH_ENABLED env vars.
 * 2. auth.lycorpauth.enabled in config.yml.
 *
 * Returns null when LycorpAuth bridge is not enabled. Throws when enabled but token missing.
 */
export async function resolveLycorpAuthConfig(
	options: ResolveLycorpAuthConfigOptions = {},
): Promise<LycorpAuthConfig | null> {
	const agentDir = options.agentDir ?? getAgentDir();
	const resolveConfig = options.configValueResolver ?? defaultResolveConfigValue;

	const envEnabled =
		process.env.LYCORPAUTH_ENABLED === "true" ||
		process.env.LYCORPAUTH_ENABLED === "1" ||
		process.env.OMP_LYCORPAUTH_ENABLED === "true" ||
		process.env.OMP_LYCORPAUTH_ENABLED === "1";

	const envAddress =
		process.env.LYCORPAUTH_ADDRESS ||
		process.env.LYCORPAUTH_SOCKET ||
		process.env.OMP_LYCORPAUTH_ADDRESS ||
		process.env.OMP_LYCORPAUTH_SOCKET;

	const envNetwork = (process.env.LYCORPAUTH_NETWORK || process.env.OMP_LYCORPAUTH_NETWORK) as
		| "unix"
		| "tcp"
		| undefined;
	const envToken = process.env.LYCORPAUTH_TOKEN || process.env.OMP_LYCORPAUTH_TOKEN;
	const envTokenFile = process.env.LYCORPAUTH_TOKEN_FILE || process.env.OMP_LYCORPAUTH_TOKEN_FILE;

	const fromConfig = await readConfigYaml(agentDir);

	const enabled = envEnabled || fromConfig.lycorpauthEnabled === true;
	if (!enabled) return null;

	let address = envAddress;
	if (!address && fromConfig.lycorpauthAddress) {
		address = await resolveConfig(fromConfig.lycorpauthAddress);
	}
	if (!address) {
		address = "127.0.0.1:8741";
	}

	let network = envNetwork || fromConfig.lycorpauthNetwork;
	if (!network) {
		network = address.includes("/") || address.endsWith(".sock") ? "unix" : "tcp";
	}

	let token = envToken;
	if (!token && fromConfig.lycorpauthToken) {
		token = await resolveConfig(fromConfig.lycorpauthToken);
	}
	if (!token) {
		const tokenFilePath =
			envTokenFile || fromConfig.lycorpauthTokenFile || path.join(getConfigRootDir(), "lycorpauth", "omp.token");
		try {
			const raw = await Bun.file(tokenFilePath).text();
			const trimmed = raw.trim();
			if (trimmed.length > 0) token = trimmed;
		} catch {
			// ignorable
		}
	}

	if (!token) {
		throw new Error(
			`LycorpAuth bridge is enabled for ${address} but no bearer token is available. ` +
				`Set LYCORPAUTH_TOKEN environment variable, auth.lycorpauth.token in config.yml, or place token at ~/.config/lycorpauth/omp.token.`,
		);
	}

	return { network, address, token };
}

/**
 * Resolve broker connection configuration using the same precedence as the TUI:
 *
 * 1. `OMP_AUTH_BROKER_URL` / `OMP_AUTH_BROKER_TOKEN` env vars.
 * 2. `auth.broker.url` / `auth.broker.token` in `<agentDir>/config.yml`.
 * 3. `<config-root>/auth-broker.token` file (paired with a URL from env/config).
 *
 * Returns `null` when no broker URL is configured — callers should fall back to
 * the local SQLite store. Throws when a URL is configured but no token is
 * available, matching the TUI behavior.
 */
export async function resolveAuthBrokerConfig(
	options: ResolveAuthBrokerConfigOptions = {},
): Promise<AuthBrokerClientConfig | null> {
	const agentDir = options.agentDir ?? getAgentDir();
	const resolveConfig = options.configValueResolver ?? defaultResolveConfigValue;

	const envUrl = process.env.OMP_AUTH_BROKER_URL;
	const envToken = process.env.OMP_AUTH_BROKER_TOKEN;

	let url = envUrl && envUrl.length > 0 ? envUrl : undefined;
	let configToken: string | undefined;
	if (!url || !envToken) {
		const fromConfig = await readConfigYaml(agentDir);
		if (!url && fromConfig.url) {
			const resolved = await resolveConfig(fromConfig.url);
			if (resolved && resolved.length > 0) url = resolved;
		}
		if (fromConfig.token) {
			const resolved = await resolveConfig(fromConfig.token);
			if (resolved && resolved.length > 0) configToken = resolved;
		}
	}
	if (!url) return null;

	const token =
		(envToken && envToken.length > 0 ? envToken : undefined) ?? configToken ?? (await readTokenFile()) ?? undefined;
	if (!token) {
		throw new Error(
			`OMP_AUTH_BROKER_URL is set (${url}) but no bearer token is available. ` +
				`Set OMP_AUTH_BROKER_TOKEN, the \`auth.broker.token\` config entry, or place one at ${getAuthBrokerTokenFilePath()}.`,
		);
	}
	return { url, token };
}

/**
 * Create an AuthStorage instance, using the broker when configured and falling
 * back to the local SQLite store otherwise. This is the single source of truth
 * for the TUI and the catalog generator.
 */
export async function discoverAuthStorage(options: DiscoverAuthStorageOptions = {}): Promise<AuthStorage> {
	const agentDir = options.agentDir ?? getAgentDir();
	const lycorpConfig = await resolveLycorpAuthConfig({
		agentDir,
		configValueResolver: options.configValueResolver,
	});

	if (lycorpConfig) {
		const client = new LycorpAuthClient(lycorpConfig);
		const store = new LycorpAuthCredentialStore({
			client,
			sourceLabel: options.sourceLabel ?? `LycorpAuth ${lycorpConfig.address}`,
		});
		await store.refreshSnapshot();
		const storage = new AuthStorage(store, {
			configValueResolver: options.configValueResolver,
			sourceLabel: options.sourceLabel ?? `LycorpAuth ${lycorpConfig.address}`,
		});
		await storage.reload();
		return storage;
	}
	const brokerConfig = await resolveAuthBrokerConfig({
		agentDir,
		configValueResolver: options.configValueResolver,
	});

	if (brokerConfig) {
		const client = new AuthBrokerClient({ url: brokerConfig.url, token: brokerConfig.token });
		const cachePath = options.cachePath ?? getAuthBrokerSnapshotCachePath();
		const ttlMs = resolveSnapshotTtlMs();
		const persist =
			ttlMs > 0
				? (snapshot: SnapshotResponse): void => {
						void writeAuthBrokerSnapshotCache({
							path: cachePath,
							token: brokerConfig.token,
							url: brokerConfig.url,
							snapshot,
						}).catch(error => {
							logger.debug("auth-broker snapshot cache write failed", { error: String(error) });
						});
					}
				: undefined;

		let initialSnapshot: SnapshotResponse | undefined;
		if (ttlMs > 0) {
			initialSnapshot =
				(await readAuthBrokerSnapshotCache({
					path: cachePath,
					token: brokerConfig.token,
					url: brokerConfig.url,
					ttlMs,
				}).catch(error => {
					logger.debug("auth-broker snapshot cache read failed", { error: String(error) });
					return null;
				})) ?? undefined;
		}
		if (!initialSnapshot) {
			const initialResult = await client.fetchSnapshot();
			if (initialResult.status !== 200) throw new Error("Auth broker returned no initial snapshot");
			initialSnapshot = initialResult.snapshot;
			persist?.(initialSnapshot);
		}
		const store = new RemoteAuthCredentialStore({
			client,
			initialSnapshot,
			onSnapshot: persist,
		});
		const storage = new AuthStorage(store, {
			configValueResolver: options.configValueResolver,
			sourceLabel: options.sourceLabel ?? `broker ${brokerConfig.url}`,
		});
		await storage.reload();
		return storage;
	}

	const dbPath = getAgentDbPath(agentDir);
	const storage = await AuthStorage.create(dbPath, {
		configValueResolver: options.configValueResolver,
		sourceLabel: options.sourceLabel ?? `local ${dbPath}`,
	});
	await storage.reload();
	return storage;
}
