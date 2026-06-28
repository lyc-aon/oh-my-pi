/**
 * Config read/validate/write service for OMP Home.
 *
 * Operates on a SELECTED profile's config.yml directly (via the comment-
 * preserving config-writer), independent of the live `Settings` singleton.
 * Reads surface schema metadata (type/enum/default/description/tab) so the
 * client can render the General editor generically; writes validate against
 * the schema helpers before touching disk.
 */

import { applyConfigEdits, type ConfigEdit, readConfigDoc } from "../config/config-writer";
import {
	type AnyUiMetadata,
	getDefault,
	getEnumValues,
	getType,
	getUi,
	SETTINGS_SCHEMA,
	type SettingPath,
} from "../config/settings-schema";
import { type ProfileEntry, resolveProfile } from "./profiles";

/** UI-facing schema metadata for one setting. */
export interface SchemaMeta {
	path: string;
	type: string;
	enumValues?: readonly string[];
	default: unknown;
	description: string;
	label: string;
	tab?: string;
	group?: string;
}

/** UI-facing resolved config (file value ?? schema default). */
export interface ResolvedConfig {
	values: Record<string, unknown>;
	/** The raw parsed object (file value only, no defaults applied). */
	raw: Record<string, unknown>;
	schema: SchemaMeta[];
}

function getByPath(obj: Record<string, unknown>, segments: readonly string[]): unknown {
	let current: unknown = obj;
	for (const segment of segments) {
		if (current === null || current === undefined || typeof current !== "object") return undefined;
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}
/**
 * A setting is REDACTED from the Home config surface when it is a scalar
 * (boolean/number/string/enum) WITHOUT UI metadata: these config-file-only
 * values — most importantly credentials like `auth.broker.token` — must never
 * be read or written through the API. Records/arrays without UI (modelRoles,
 * cycleOrder, task.agentModelOverrides, …) stay surfaced because focused
 * editors and the graph/agent services consume them; anything with UI metadata
 * is always editor-visible.
 */
function isRedactedPath(path: SettingPath): boolean {
	if (getUi(path)) return false;
	const type = getType(path);
	return type !== "record" && type !== "array";
}

/** Write a dotted path into a fresh nested object (no shared refs with `raw`). */
function setByPath(obj: Record<string, unknown>, segments: readonly string[], value: unknown): void {
	let current: Record<string, unknown> = obj;
	for (let i = 0; i < segments.length; i++) {
		const segment = segments[i]!;
		if (i === segments.length - 1) {
			current[segment] = value;
			continue;
		}
		const next = current[segment];
		if (next === null || next === undefined || typeof next !== "object" || Array.isArray(next)) {
			const nested: Record<string, unknown> = {};
			current[segment] = nested;
			current = nested;
		} else {
			current = next as Record<string, unknown>;
		}
	}
}

function buildSchemaMeta(): SchemaMeta[] {
	const meta: SchemaMeta[] = [];
	for (const path of Object.keys(SETTINGS_SCHEMA) as SettingPath[]) {
		const ui: AnyUiMetadata | undefined = getUi(path);
		if (!ui) continue; // only settings with UI metadata are editor-visible
		meta.push({
			path,
			type: getType(path),
			enumValues: getEnumValues(path),
			default: getDefault(path),
			description: ui?.description ?? "",
			label: ui?.label ?? path,
			tab: ui?.tab,
			group: ui?.group,
		});
	}
	return meta;
}

/**
 * Read a profile's config.yml, returning resolved values (file ?? default), a
 * raw object reconstructed from VISIBLE file values only (hidden secrets like
 * `auth.broker.token` are never exposed), and UI-only schema metadata.
 */
export async function readProfileConfig(profileId: string): Promise<ResolvedConfig> {
	const profile = await resolveProfile(profileId);
	return readProfileConfigFor(profile);
}

export async function readProfileConfigFor(
	profile: ProfileEntry & { configPath: string; dbPath: string },
): Promise<ResolvedConfig> {
	const schema = buildSchemaMeta();
	const raw = await readConfigDoc(profile.configPath);
	const values: Record<string, unknown> = {};
	// `raw` is reconstructed from visible (non-redacted) file values only, so a
	// hidden secret like `auth.broker.token` can never leak to the web client.
	const sanitizedRaw: Record<string, unknown> = {};
	for (const path of Object.keys(SETTINGS_SCHEMA) as SettingPath[]) {
		if (isRedactedPath(path)) continue;
		const segments = path.split(".");
		const fileValue = getByPath(raw, segments);
		values[path] = fileValue !== undefined ? fileValue : getDefault(path);
		if (fileValue !== undefined) setByPath(sanitizedRaw, segments, fileValue);
	}
	return { values, raw: sanitizedRaw, schema };
}

/** Thrown when a config edit fails validation (caller maps to HTTP 400). */
export class ConfigValidationError extends Error {}

function assertNumber(value: unknown): void {
	if (typeof value === "number" && Number.isFinite(value)) return;
	throw new ConfigValidationError("expected number");
}

function assertStringArray(value: unknown): void {
	if (!Array.isArray(value) || !value.every(item => typeof item === "string")) {
		throw new ConfigValidationError("expected string array");
	}
}

function assertStringRecord(value: unknown): void {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new ConfigValidationError("expected a record/object");
	}
}

function findRecordAncestor(path: string): string | undefined {
	let cursor = path;
	while (cursor.includes(".")) {
		cursor = cursor.slice(0, cursor.lastIndexOf("."));
		const def = SETTINGS_SCHEMA[cursor as SettingPath];
		if (def?.type === "record") return cursor;
	}
	return undefined;
}

function validateRecordChild(path: string, value: unknown): void {
	const ancestor = findRecordAncestor(path);
	if (!ancestor) throw new ConfigValidationError(`Unknown setting path: ${path}`);
	if (value === undefined) return;
	if (ancestor === "modelRoles" || ancestor === "task.agentModelOverrides") {
		if (typeof value !== "string") throw new ConfigValidationError(`${path}: expected string`);
		return;
	}
}

/**
 * Validate a single edit against the schema (type/enum/array/record). Mirrors
 * the type discipline of `parseAndSetValue` without re-implementing its
 * side-effect hooks. Throws ConfigValidationError on reject.
 */
export function validateConfigEdit(path: string, value: unknown): void {
	const def = SETTINGS_SCHEMA[path as SettingPath];
	if (!def) {
		validateRecordChild(path, value);
		return;
	}
	// Hidden config-file-only scalar (e.g. auth.broker.token) is never editable
	// through Home — reject both writes and deletes.
	if (isRedactedPath(path as SettingPath)) {
		throw new ConfigValidationError(`${path}: not editable via Home config`);
	}
	// Delete is always allowed for known paths.
	if (value === undefined) return;

	switch (def.type) {
		case "boolean":
			if (typeof value !== "boolean") throw new ConfigValidationError(`${path}: expected boolean`);
			break;
		case "number":
			assertNumber(value); // throws on invalid
			break;
		case "string":
			if (typeof value !== "string") throw new ConfigValidationError(`${path}: expected string`);
			break;
		case "enum": {
			const allowed = getEnumValues(path as SettingPath);
			if (typeof value !== "string" || !allowed?.includes(value)) {
				throw new ConfigValidationError(`${path}: must be one of ${(allowed ?? []).join(", ")}`);
			}
			break;
		}
		case "array":
			assertStringArray(value); // throws on invalid
			break;
		case "record":
			assertStringRecord(value); // throws on invalid
			break;
	}
}

/**
 * Validate then atomically apply a batch of config edits to the profile's
 * config.yml. Returns the re-read resolved config so the caller syncs the UI.
 */
export async function writeProfileConfig(profileId: string, edits: ConfigEdit[]): Promise<ResolvedConfig> {
	if (!Array.isArray(edits)) throw new ConfigValidationError("edits must be an array");
	// Validate ALL edits before applying ANY (atomicity).
	for (const edit of edits) {
		validateConfigEdit(edit.path, edit.value);
	}
	const profile = await resolveProfile(profileId);
	await applyConfigEdits(profile.configPath, edits);
	return readProfileConfigFor(profile);
}
