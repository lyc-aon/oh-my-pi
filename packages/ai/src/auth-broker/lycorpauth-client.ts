import * as net from "node:net";

export interface LycorpAuthClientOptions {
	/** Transport network: "unix" (default when path or socket) or "tcp". */
	network?: "unix" | "tcp";
	/** Address: Unix socket path (e.g. "/tmp/lycorpauth.sock") or TCP host:port ("127.0.0.1:8741"). */
	address: string;
	/** Bearer authentication token. */
	token: string;
	/** Optional harness identifier, defaults to "omp". */
	harness?: string;
	/** Optional connection / request timeout in milliseconds (defaults to 10,000 ms). */
	timeoutMs?: number;
}

export interface LycorpAuthRequest {
	version: number;
	id: string;
	action: string;
	token: string;
	session_id?: string;
	harness?: string;
	params?: Record<string, unknown>;
}

export interface LycorpAuthResponse<T = unknown> {
	version: number;
	id: string;
	ok: boolean;
	result?: T;
	error?: {
		code: string;
		message: string;
		details?: unknown;
	};
}

export interface LycorpAuthRecordFieldDescriptor {
	key: string;
	label?: string;
	sensitive?: boolean;
	section?: string;
}

export interface LycorpAuthRecordSummary {
	id: string;
	title: string;
	provider: string;
	account_id?: string;
	identity?: string;
	environment?: string;
	credential_type?: string;
	rotation_group?: string;
	selection_priority?: number;
	urls?: string[];
	tags?: string[];
	icon?: string;
	favorite?: boolean;
	metadata?: Record<string, unknown>;
	fields?: LycorpAuthRecordFieldDescriptor[];
	has_notes?: boolean;
	has_totp?: boolean;
	mirror_to_onepassword?: boolean;
	disabled_at?: string | null;
	created_at?: string;
	updated_at?: string;
}

export interface LycorpAuthRecordsListResult {
	records: LycorpAuthRecordSummary[];
	revision?: number;
}

export interface LycorpAuthRecordGetResult {
	record: LycorpAuthRecordSummary;
	values: Record<string, string>;
	revision?: number;
}

export interface LycorpAuthOAuthRefreshResult {
	record: LycorpAuthRecordSummary;
	refreshed: boolean;
	revision?: number;
}

export interface LycorpAuthUsageReadResult {
	reports: unknown[];
	total?: number;
	matched?: number;
	returned?: number;
}

export class LycorpAuthError extends Error {
	readonly code: string;
	constructor(code: string) {
		const safeCode = /^[a-z0-9_.-]{1,64}$/i.test(code) ? code : "unknown_error";
		super(`LycorpAuth RPC request failed (${safeCode})`);
		this.name = "LycorpAuthError";
		this.code = safeCode;
	}
}

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const TAILSCALE_IPV6_PREFIX = "fd7a:115c:a1e0:";

function isAllowedTcpHost(host: string): boolean {
	const normalized = host.toLowerCase();
	if (LOOPBACK_HOSTS.has(normalized)) return true;
	if (net.isIP(normalized) === 4) {
		const octets = normalized.split(".").map(Number);
		return octets[0] === 100 && (octets[1] ?? 0) >= 64 && (octets[1] ?? 0) <= 127;
	}
	return net.isIP(normalized) === 6 && normalized.startsWith(TAILSCALE_IPV6_PREFIX);
}

function parseAllowedAddress(address: string): { host: string; port: number } {
	const match = address.match(/^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/);
	if (!match) throw new Error("LycorpAuth TCP address must be loopback or Tailscale host:port");
	const host = match[1] ?? match[2] ?? "";
	const port = Number.parseInt(match[3] ?? "", 10);
	if (!isAllowedTcpHost(host) || !Number.isInteger(port) || port < 1 || port > 65_535) {
		throw new Error("LycorpAuth TCP transport is restricted to a valid loopback or Tailscale host and port");
	}
	return { host, port };
}

export class LycorpAuthClient {
	readonly #network: "unix" | "tcp";
	readonly #address: string;
	readonly #token: string;
	readonly #harness: string;
	readonly #timeoutMs: number;
	readonly #tcpAddress?: { host: string; port: number };

	constructor(opts: LycorpAuthClientOptions) {
		if (!opts.address || opts.address.trim().length === 0) {
			throw new Error("LycorpAuthClient address must not be empty");
		}
		if (!opts.token || opts.token.trim().length === 0) {
			throw new Error("LycorpAuthClient token must not be empty");
		}
		this.#address = opts.address.trim();
		this.#token = opts.token.trim();
		this.#harness = opts.harness ?? "omp";
		this.#timeoutMs = opts.timeoutMs ?? 10_000;
		if (opts.network) {
			this.#network = opts.network;
		} else {
			this.#network = this.#address.includes("/") || this.#address.endsWith(".sock") ? "unix" : "tcp";
		}
		if (this.#network === "tcp") this.#tcpAddress = parseAllowedAddress(this.#address);
	}

	get address(): string {
		return this.#address;
	}

	get network(): "unix" | "tcp" {
		return this.#network;
	}

	async call<T = unknown>(action: string, params?: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
		if (signal?.aborted) {
			throw new Error("LycorpAuth call aborted");
		}
		const reqId = `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
		const requestPayload: LycorpAuthRequest = {
			version: 1,
			id: reqId,
			action,
			token: this.#token,
			harness: this.#harness,
			params: params ?? {},
		};

		const line = `${JSON.stringify(requestPayload)}\n`;
		const timeout = this.#timeoutMs;

		return new Promise<T>((resolve, reject) => {
			let socket: net.Socket | undefined;
			let timer: NodeJS.Timeout | undefined;
			let settled = false;
			let buffer = "";
			const onAbort = (): void => {
				done(new Error("LycorpAuth request aborted"));
			};

			const cleanup = (): void => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				socket?.destroy();
			};

			const done = (err?: Error, result?: T): void => {
				if (settled) return;
				settled = true;
				cleanup();
				if (err) {
					reject(err);
				} else {
					resolve(result as T);
				}
			};

			if (signal) signal.addEventListener("abort", onAbort, { once: true });

			timer = setTimeout(() => {
				done(new Error(`LycorpAuth RPC call '${action}' timed out after ${timeout}ms`));
			}, timeout);

			try {
				if (this.#network === "unix") {
					socket = net.connect(this.#address);
				} else {
					const tcpAddress = this.#tcpAddress;
					if (!tcpAddress) throw new Error("LycorpAuth TCP address is unavailable");
					socket = net.connect(tcpAddress.port, tcpAddress.host);
				}
			} catch (err) {
				return done(err instanceof Error ? err : new Error(String(err)));
			}

			socket.on("error", () => {
				done(new Error("LycorpAuth connection failed"));
			});

			socket.on("data", chunk => {
				buffer += chunk.toString("utf8");
				if (Buffer.byteLength(buffer, "utf8") > MAX_RESPONSE_BYTES) {
					done(new Error("LycorpAuth response exceeded the maximum allowed size"));
					return;
				}
				const newlineIndex = buffer.indexOf("\n");
				if (newlineIndex !== -1) {
					const rawLine = buffer.slice(0, newlineIndex).trim();
					try {
						const response = JSON.parse(rawLine) as LycorpAuthResponse<T>;
						if (!response.ok) {
							done(new LycorpAuthError(response.error?.code ?? "unknown_error"));
						} else {
							done(undefined, response.result);
						}
					} catch {
						done(new Error("Failed to parse LycorpAuth response JSON"));
					}
				}
			});

			socket.on("end", () => {
				if (!settled && !buffer.includes("\n")) {
					done(new Error("LycorpAuth connection closed before receiving complete response line"));
				}
			});

			socket.write(line, "utf8", writeErr => {
				if (writeErr) {
					done(new Error("LycorpAuth request write failed"));
				}
			});
		});
	}

	async fetchRecordsList(signal?: AbortSignal): Promise<LycorpAuthRecordsListResult> {
		return this.call<LycorpAuthRecordsListResult>("records.list", {}, signal);
	}

	async fetchRecordRead(id: string, fields: string[], signal?: AbortSignal): Promise<LycorpAuthRecordGetResult> {
		return this.call<LycorpAuthRecordGetResult>("records.read", { id, fields }, signal);
	}

	async refreshOAuthRecord(id: string, force = false, signal?: AbortSignal): Promise<LycorpAuthOAuthRefreshResult> {
		return this.call<LycorpAuthOAuthRefreshResult>("oauth.refresh", { id, force }, signal);
	}

	async fetchUsage(provider?: string, signal?: AbortSignal): Promise<LycorpAuthUsageReadResult> {
		const params: Record<string, unknown> = { limit: 500 };
		if (provider) params.provider = provider;
		return this.call<LycorpAuthUsageReadResult>("usage.read", params, signal);
	}
}
