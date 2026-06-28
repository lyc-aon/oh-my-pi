import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	ConfigValidationError,
	readProfileConfigFor,
	validateConfigEdit,
} from "@oh-my-pi/pi-coding-agent/home/config-service";

describe("home config validation", () => {
	it("accepts known setting values that match schema types", () => {
		validateConfigEdit("modelRoles", { default: "anthropic/claude-opus-4-8:high" });
		validateConfigEdit("cycleOrder", ["smol", "default", "slow"]);
		validateConfigEdit("tools.approvalMode", "write");
		validateConfigEdit("autoResume", false);
	});

	it("accepts record child paths used by focused editors", () => {
		validateConfigEdit("modelRoles.default", "anthropic/claude-opus-4-8:high");
		validateConfigEdit("task.agentModelOverrides.reviewer", "openai-codex/gpt-5.5:xhigh");
		validateConfigEdit("modelRoles.default", undefined);
	});

	it("rejects unknown paths before writes", () => {
		expect(() => validateConfigEdit("not.a.setting", true)).toThrow(ConfigValidationError);
	});

	it("rejects values that would change the persisted YAML type", () => {
		expect(() => validateConfigEdit("cycleOrder", ["smol", 123])).toThrow(/expected string array/);
		expect(() => validateConfigEdit("modelRoles", ["smol"])).toThrow(/expected a record/);
		expect(() => validateConfigEdit("tools.approvalMode", "sometimes")).toThrow(/must be one of/);
		expect(() => validateConfigEdit("autoResume", "false")).toThrow(/expected boolean/);
		expect(() => validateConfigEdit("retry.maxRetries", "3")).toThrow(/expected number/);
		expect(() => validateConfigEdit("modelRoles.default", ["smol"])).toThrow(/expected string/);
	});
	it("rejects writes to hidden config-file-only paths like auth.broker.token", () => {
		// Both set and delete are rejected — a hidden secret is never editable via Home.
		expect(() => validateConfigEdit("auth.broker.token", "super-secret-value")).toThrow(ConfigValidationError);
		expect(() => validateConfigEdit("auth.broker.token", undefined)).toThrow(ConfigValidationError);
		expect(() => validateConfigEdit("auth.broker.url", "https://broker.example")).toThrow(ConfigValidationError);
	});
});

async function tmpProfileConfig(initial: string) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-config-redact-"));
	const configPath = path.join(dir, "config.yml");
	await Bun.write(configPath, initial);
	const profile = {
		id: "redact-test",
		label: "Redact Test",
		agentDir: dir,
		configPath,
		dbPath: path.join(dir, "agent.db"),
	};
	return { profile, dir };
}

describe("home config read redaction", () => {
	const dirs: string[] = [];
	afterEach(async () => {
		await Promise.all(dirs.map(d => fs.rm(d, { recursive: true, force: true })));
		dirs.length = 0;
	});

	it("does not expose auth.broker.token in schema, values, or serialized raw", async () => {
		const initial = `auth:
  broker:
    token: super-secret-value
    url: https://broker.example
modelRoles:
  default: anthropic/claude-opus-4-8:high
`;
		const { profile, dir } = await tmpProfileConfig(initial);
		dirs.push(dir);

		const config = await readProfileConfigFor(profile);

		// schema is UI-only — the hidden broker paths are absent.
		expect(config.schema.find(meta => meta.path === "auth.broker.token")).toBeUndefined();
		expect(config.schema.find(meta => meta.path === "auth.broker.url")).toBeUndefined();
		// values excludes the secret but keeps the visible record.
		expect(config.values["auth.broker.token"]).toBeUndefined();
		expect(config.values["auth.broker.url"]).toBeUndefined();
		expect(config.values.modelRoles).toEqual({ default: "anthropic/claude-opus-4-8:high" });
		// serialized raw must not carry the secret value or its subtree.
		const serialized = JSON.stringify(config.raw);
		expect(serialized).not.toContain("super-secret-value");
		expect(serialized).not.toContain("broker");
		expect(serialized).not.toContain("auth");
	});

	it("still surfaces record/array settings that graph/agent services depend on", async () => {
		const initial = `modelRoles:
  default: anthropic/claude-opus-4-8:high
cycleOrder:
  - smol
  - default
task:
  agentModelOverrides:
    reviewer: openai-codex/gpt-5.5:xhigh
  disabledAgents:
    - researcher
retry:
  fallbackChains:
    default:
      - anthropic/claude-opus-4-8:high
`;
		const { profile, dir } = await tmpProfileConfig(initial);
		dirs.push(dir);

		const config = await readProfileConfigFor(profile);

		// graph-service / agent-service read these from .values — they must survive.
		expect(config.values.modelRoles).toEqual({ default: "anthropic/claude-opus-4-8:high" });
		expect(config.values.cycleOrder).toEqual(["smol", "default"]);
		expect(config.values["task.agentModelOverrides"]).toEqual({ reviewer: "openai-codex/gpt-5.5:xhigh" });
		expect(config.values["task.disabledAgents"]).toEqual(["researcher"]);
		expect(config.values["retry.fallbackChains"]).toEqual({ default: ["anthropic/claude-opus-4-8:high"] });
	});
});
