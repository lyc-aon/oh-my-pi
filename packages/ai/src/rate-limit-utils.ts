import { extractHttpStatusFromError } from "@oh-my-pi/pi-utils";
import type { AuthAttemptReasonCode } from "./auth-storage";

const AUTH_ERROR_PATTERN =
	/\b(?:authentication_error|oauth_not_allowed_for_organization|permission_error|permission_denied|access_denied|forbidden|unauthorized|unauthenticated|invalid[_ ](?:api[_ ]?key|token|grant)|expired[_ ](?:token|key)|revoked[_ ](?:token|key)|invalid_grant|invalid_token)\b/i;

export function classifyAuthAttemptReason(
	error: unknown,
	options?: { isClassifierRefusal?: boolean; isFireworksFast?: boolean },
): AuthAttemptReasonCode {
	if (options?.isClassifierRefusal) return "classifier_refusal";
	if (options?.isFireworksFast) return "fireworks_fast";
	if (!error) return "unknown";

	const message =
		typeof error === "string"
			? error
			: error instanceof Error
				? error.message
				: typeof error === "object" &&
						error !== null &&
						"errorMessage" in error &&
						typeof error.errorMessage === "string"
					? error.errorMessage
					: typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
						? error.message
						: String(error);

	const status = extractHttpStatusFromError(error) ?? extractHttpStatusFromError({ message });
	const lower = message.toLowerCase();

	if (status === 401 || (status === 403 && AUTH_ERROR_PATTERN.test(message)) || AUTH_ERROR_PATTERN.test(message)) {
		return "authentication";
	}

	if (status === 429 || isUsageLimitError(message) || isUsageLimitOutcome(status, message)) {
		return "rate_limit";
	}

	if (
		(status !== undefined && status >= 500) ||
		/\b(500|502|503|504|529|overloaded|service unavailable|connection|fetch failed|timeout|econnrefused|stream reset|rst_stream|socket hang up)\b/i.test(
			lower,
		) ||
		parseRateLimitReason(message) === "MODEL_CAPACITY_EXHAUSTED" ||
		parseRateLimitReason(message) === "RATE_LIMIT_EXCEEDED" ||
		parseRateLimitReason(message) === "SERVER_ERROR"
	) {
		return "transient";
	}

	return "unknown";
}

/**
 * Rate limit reason classification and backoff calculation utilities.
 * Ported from opencode-antigravity-auth plugin for consistency.
 */

export type RateLimitReason =
	| "QUOTA_EXHAUSTED"
	| "RATE_LIMIT_EXCEEDED"
	| "MODEL_CAPACITY_EXHAUSTED"
	| "SERVER_ERROR"
	| "UNKNOWN";

const QUOTA_EXHAUSTED_BACKOFF_MS = 30 * 60 * 1000; // 30 min
const RATE_LIMIT_EXCEEDED_BACKOFF_MS = 30 * 1000; // 30s
const MODEL_CAPACITY_BASE_MS = 45 * 1000; // 45s base
const MODEL_CAPACITY_JITTER_MS = 30 * 1000; // ±15s
const SERVER_ERROR_BACKOFF_MS = 20 * 1000; // 20s

const ACCOUNT_RATE_LIMIT_PATTERN =
	/\baccount(?:'s)?\b[^\n]{0,80}\brate.?limit\b|\brate.?limit\b[^\n]{0,80}\baccount\b/i;
const INSUFFICIENT_BALANCE_PATTERN = /insufficient.?balance/i;

/**
 * Classify a rate-limit error message into a reason category.
 * Priority order: QUOTA (Antigravity "quota will reset") > MODEL_CAPACITY > QUOTA (account) >
 * RATE_LIMIT > QUOTA (generic) > SERVER_ERROR > UNKNOWN.
 *
 * "resource exhausted" maps to MODEL_CAPACITY (transient, short wait)
 * "quota exceeded" / "quota will reset" maps to QUOTA_EXHAUSTED (long wait, switch account)
 */
export function parseRateLimitReason(errorMessage: string): RateLimitReason {
	const lower = errorMessage.toLowerCase();

	// Antigravity / Cloud Code Assist surface multi-hour daily-quota exhaustion as
	// "You have exhausted your capacity on this model. Your quota will reset after …".
	// The literal "capacity" used to pre-empt the QUOTA branch even though "quota
	// will reset" is the long-wait signal — short-circuit here before the
	// MODEL_CAPACITY fallthrough so credential rotation (not 60s backoff) kicks in.
	if (lower.includes("quota will reset") || lower.includes("exhausted your capacity")) {
		return "QUOTA_EXHAUSTED";
	}

	if (
		lower.includes("capacity") ||
		lower.includes("overloaded") ||
		lower.includes("529") ||
		lower.includes("503") ||
		lower.includes("resource exhausted")
	) {
		return "MODEL_CAPACITY_EXHAUSTED";
	}

	if (ACCOUNT_RATE_LIMIT_PATTERN.test(errorMessage)) {
		return "QUOTA_EXHAUSTED";
	}

	if (
		lower.includes("per minute") ||
		lower.includes("rate limit") ||
		lower.includes("too many requests") ||
		lower.includes("presque")
	) {
		return "RATE_LIMIT_EXCEEDED";
	}

	if (
		lower.includes("exhausted") ||
		lower.includes("quota") ||
		lower.includes("usage limit") ||
		INSUFFICIENT_BALANCE_PATTERN.test(errorMessage)
	) {
		return "QUOTA_EXHAUSTED";
	}

	if (lower.includes("500") || lower.includes("internal error") || lower.includes("internal server error")) {
		return "SERVER_ERROR";
	}

	return "UNKNOWN";
}

/**
 * Calculate backoff delay in ms for a given rate limit reason.
 * MODEL_CAPACITY gets jitter to prevent thundering herd.
 */
export function calculateRateLimitBackoffMs(reason: RateLimitReason): number {
	switch (reason) {
		case "QUOTA_EXHAUSTED":
			return QUOTA_EXHAUSTED_BACKOFF_MS;
		case "RATE_LIMIT_EXCEEDED":
			return RATE_LIMIT_EXCEEDED_BACKOFF_MS;
		case "MODEL_CAPACITY_EXHAUSTED":
			return MODEL_CAPACITY_BASE_MS + Math.random() * MODEL_CAPACITY_JITTER_MS;
		case "SERVER_ERROR":
			return SERVER_ERROR_BACKOFF_MS;
		default:
			return QUOTA_EXHAUSTED_BACKOFF_MS; // conservative default
	}
}

/** Detect usage/quota limit errors in error messages (persistent, requires credential switch). */
const USAGE_LIMIT_PATTERN =
	/usage.?limit|usage_limit_reached|usage_not_included|limit_reached|quota.?exceeded|quota.?reached|resource.?exhausted|exhausted your capacity|quota will reset|insufficient.?(?:balance|quota)/i;

/**
 * HTTP status codes that, absent richer body classification, represent an
 * account-local usage cap rather than a bad credential or a transient blip.
 * Always combine with {@link isUsageLimitOutcome} when a message is available
 * — a 429 carrying transient rate-limit wording is NOT a usage cap.
 */
export function isUsageLimitStatus(status: number | undefined): boolean {
	return status === 429;
}

/**
 * Returns true for failures that should burn one credential and rotate to a
 * sibling account. Decision tree:
 *
 *  1. Body matches {@link isUsageLimitError} (Codex `usage_limit_reached`,
 *     Anthropic account rate-limit, Google `resource_exhausted`, OpenAI
 *     `insufficient_quota`, …) → rotate.
 *  2. Status is not 429 → backoff (caller's domain).
 *  3. Body is absent or {@link isOpaqueStatusBody opaque} (just the status,
 *     empty JSON, HTTP framing only) → rotate conservatively: the server
 *     gave us nothing else to go on.
 *  4. Body has content → defer to {@link parseRateLimitReason}. Only
 *     `QUOTA_EXHAUSTED` rotates; `RATE_LIMIT_EXCEEDED` (`Too many requests`,
 *     per-minute caps), `MODEL_CAPACITY_EXHAUSTED` (`Service overloaded`),
 *     `SERVER_ERROR`, and `UNKNOWN` (`Please retry in 5s`) stay in the
 *     provider's own backoff layer so transient 429s don't burn sibling
 *     credentials.
 */
export function isUsageLimitOutcome(status: number | undefined, message: string | undefined): boolean {
	if (message && isUsageLimitError(message)) return true;
	if (!isUsageLimitStatus(status)) return false;
	if (!message || isOpaqueStatusBody(message)) return true;
	return parseRateLimitReason(message) === "QUOTA_EXHAUSTED";
}

/**
 * A 429 body is opaque when it carries no signal beyond the status itself —
 * empty, whitespace-only, the status digits with HTTP/JSON framing, or
 * generic punctuation. Anything else (retry hints, capacity wording, error
 * descriptions) is informative enough to defer to the classifier.
 */
function isOpaqueStatusBody(message: string): boolean {
	const cleaned = message
		.replace(/\b429\b/g, "")
		.replace(/\b(?:http|https|status|error|code|response|message)\b/gi, "");
	return !/[a-z\d]{3,}/i.test(cleaned);
}

export function isUsageLimitError(errorMessage: string): boolean {
	return USAGE_LIMIT_PATTERN.test(errorMessage) || ACCOUNT_RATE_LIMIT_PATTERN.test(errorMessage);
}
