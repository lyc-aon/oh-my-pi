import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { Tool as AiTool, Model } from "@oh-my-pi/pi-ai";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EvalTool, getEvalToolDescription } from "@oh-my-pi/pi-coding-agent/tools/eval";

interface EvalSessionOptions {
	spawns?: string | null;
	backends?: Record<string, boolean>;
	model?: Model;
	evalActive?: boolean;
	gpt56CodexProfile?: boolean;
	nestedTools?: AgentTool[];
}

function makeSession(opts: EvalSessionOptions): ToolSession {
	const settings = Settings.isolated();
	for (const [key, value] of Object.entries(opts.backends ?? {})) settings.set(key as never, value);
	if (opts.gpt56CodexProfile !== undefined) {
		settings.set("eval.gpt56CodexProfile", opts.gpt56CodexProfile);
	}
	return {
		cwd: "/tmp/eval-test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => opts.spawns ?? "*",
		getActiveModel: () => opts.model,
		isToolActive: (name: string) => name === "eval" && (opts.evalActive ?? true),
		getToolsCallableFromEval: () => opts.nestedTools ?? [],
		settings,
	} as unknown as ToolSession;
}

/** Pull the model-facing cell-schema fields (sorted `language` enum + descriptions) from the flat wire schema. */
function wireCellFields(tool: EvalTool): {
	languages: string[];
	languageDescription?: string;
	codeDescription?: string;
} {
	const wire = toolWireSchema(tool as unknown as AiTool) as {
		properties?: {
			language?: { enum?: string[]; const?: string; description?: string };
			code?: { description?: string };
		};
	};
	const props = wire.properties;
	const language = props?.language;
	const languages = Array.isArray(language?.enum)
		? [...language.enum].sort()
		: typeof language?.const === "string"
			? [language.const]
			: [];
	return {
		languages,
		languageDescription: language?.description,
		codeDescription: props?.code?.description,
	};
}

describe("eval tool description", () => {
	it("advertises agent() when spawns are allowed", () => {
		const text = getEvalToolDescription({ py: true, js: true, spawns: true });
		expect(text).toContain("agent(prompt");
	});

	it("omits agent() when the session forbids spawning", () => {
		// Subagents with spawns: undefined (resolved to "") cannot launch tasks.
		// The prelude doc must not promise a helper that always throws.
		const text = getEvalToolDescription({ py: true, js: true, spawns: false });
		expect(text).not.toContain("agent(prompt");
	});

	it("EvalTool description reflects spawn policy from the session", () => {
		const wildcard = new EvalTool(makeSession({ spawns: "*" })).description;
		const denied = new EvalTool(makeSession({ spawns: "" })).description;
		expect(wildcard).toContain("agent(prompt");
		expect(denied).not.toContain("agent(prompt");
	});
});

describe("GPT-5.6 Codex eval profile", () => {
	const POLICY_TEXT = "use one small, bounded `parallel(thunks)` wave in a JavaScript eval cell";
	const CODEX_GPT56_LITE = {
		provider: "openai-codex",
		id: "gpt-5.6-sol",
		api: "openai-codex-responses",
		useResponsesLite: true,
	} as unknown as Model;
	const ENV_FLAGS = ["PI_JS", "PI_CODEX_RESPONSES_LITE"] as const;
	let savedEnv: Record<string, string | undefined>;

	beforeEach(() => {
		savedEnv = {};
		for (const flag of ENV_FLAGS) {
			savedEnv[flag] = Bun.env[flag];
			delete Bun.env[flag];
		}
	});

	afterEach(() => {
		for (const flag of ENV_FLAGS) {
			const prior = savedEnv[flag];
			if (prior === undefined) delete Bun.env[flag];
			else Bun.env[flag] = prior;
		}
	});

	it("keeps the experimental guidance off by default", () => {
		const description = new EvalTool(makeSession({ model: CODEX_GPT56_LITE })).description;

		expect(description).not.toContain(POLICY_TEXT);
	});

	it("adds bounded read-only guidance for the opted-in active JavaScript eval route", () => {
		const description = new EvalTool(makeSession({ model: CODEX_GPT56_LITE, gpt56CodexProfile: true })).description;

		expect(description).toContain(POLICY_TEXT);
		expect(description).toContain("Keep direct writes and dependency-ordered work sequential.");
	});

	it("does not add the guidance outside the exact active GPT-5.6 Sol Codex Lite route", () => {
		const excludedSessions: EvalSessionOptions[] = [
			{
				model: { ...CODEX_GPT56_LITE, provider: "openai" } as Model,
				gpt56CodexProfile: true,
			},
			{
				model: { ...CODEX_GPT56_LITE, api: "openai-responses" } as Model,
				gpt56CodexProfile: true,
			},
			{
				model: { ...CODEX_GPT56_LITE, id: "gpt-5.5" } as Model,
				gpt56CodexProfile: true,
			},
			{
				model: { ...CODEX_GPT56_LITE, id: "gpt-5.6-terra" } as Model,
				gpt56CodexProfile: true,
			},
			{
				model: { ...CODEX_GPT56_LITE, id: "gpt-5.6-luna" } as Model,
				gpt56CodexProfile: true,
			},
			{
				model: { ...CODEX_GPT56_LITE, useResponsesLite: false } as Model,
				gpt56CodexProfile: true,
			},
			{ model: CODEX_GPT56_LITE, evalActive: false, gpt56CodexProfile: true },
			{
				model: CODEX_GPT56_LITE,
				backends: { "eval.js": false },
				gpt56CodexProfile: true,
			},
		];

		for (const options of excludedSessions) {
			expect(new EvalTool(makeSession(options)).description).not.toContain(POLICY_TEXT);
		}
	});

	it("honors an environment override that disables Responses Lite", () => {
		Bun.env.PI_CODEX_RESPONSES_LITE = "0";

		const description = new EvalTool(makeSession({ model: CODEX_GPT56_LITE, gpt56CodexProfile: true })).description;

		expect(description).not.toContain(POLICY_TEXT);
	});

	it("honors an environment override that enables Responses Lite", () => {
		Bun.env.PI_CODEX_RESPONSES_LITE = "1";
		const modelWithoutCatalogLite = { ...CODEX_GPT56_LITE, useResponsesLite: undefined } as Model;

		const description = new EvalTool(makeSession({ model: modelWithoutCatalogLite, gpt56CodexProfile: true }))
			.description;

		expect(description).toContain(POLICY_TEXT);
	});

	it("renders Terra and Luna's nested tool contracts only on the opted-in code-mode-only route", () => {
		const nestedBash = {
			name: "bash",
			label: "Bash",
			description: "Run a command.",
			parameters: {
				type: "object",
				properties: { command: { type: "string", description: "Command to run" } },
				required: ["command"],
			},
		} as unknown as AgentTool;

		for (const id of ["gpt-5.6-terra", "gpt-5.6-luna"]) {
			const model = { ...CODEX_GPT56_LITE, id } as Model;
			const description = new EvalTool(makeSession({ model, gpt56CodexProfile: true, nestedTools: [nestedBash] }))
				.description;

			expect(description).toContain("This model uses eval as its work gateway.");
			expect(description).toContain("`tool.bash` — Bash");
			expect(description).toContain("command: string;");
			expect(description).toContain("ordinary OMP approval, permission, and extension policy remains in force");
			expect(description).not.toContain(POLICY_TEXT);
		}
	});
});

describe("eval tool dynamic schema", () => {
	// resolveEvalBackends lets PI_* env flags override settings; neutralize them per-test
	// so the schema is driven purely by the isolated settings (and restore to avoid leaks).
	const EVAL_ENV_FLAGS = ["PI_PY", "PI_JS", "PI_RB", "PI_JL"] as const;
	let savedEnv: Record<string, string | undefined>;
	beforeEach(() => {
		savedEnv = {};
		for (const flag of EVAL_ENV_FLAGS) {
			savedEnv[flag] = Bun.env[flag];
			delete Bun.env[flag];
		}
	});
	afterEach(() => {
		for (const flag of EVAL_ENV_FLAGS) {
			const prior = savedEnv[flag];
			if (prior === undefined) delete Bun.env[flag];
			else Bun.env[flag] = prior;
		}
	});

	it("hides rb/jl from the wire schema, summary, description, and examples by default", () => {
		const tool = new EvalTool(makeSession({}));
		const fields = wireCellFields(tool);
		// Default config: rb/jl off → the wire schema is byte-identical to the pre-feature py/js one.
		expect(fields.languages).toEqual(["js", "py"]);
		expect(fields.languageDescription).toBe('runtime: "py" for the IPython kernel, "js" for the persistent JS VM');
		expect(fields.codeDescription).toBe("code to run in this eval call, verbatim. Use top-level await freely.");
		expect(tool.summary).toBe("Execute Python or JavaScript code in an in-process eval backend");
		expect(tool.description).not.toMatch(/ruby|julia/i);
		// Examples must not advertise a disabled backend.
		const exampleLangs = tool.examples.map(ex => ("call" in ex ? ex.call.language : null));
		expect(exampleLangs).toEqual(["py", "py", "py"]);
		expect(tool.examples.some(ex => "call" in ex && ex.call.language === "rb")).toBe(false);
	});

	it("advertises rb/jl across enum, descriptions, summary, and prelude once enabled", () => {
		const tool = new EvalTool(makeSession({ backends: { "eval.rb": true, "eval.jl": true } }));
		const fields = wireCellFields(tool);
		expect(fields.languages).toEqual(["jl", "js", "py", "rb"]);
		expect(fields.languageDescription).toBe(
			'runtime: "py" for the IPython kernel, "js" for the persistent JS VM, "rb" for the persistent Ruby kernel, "jl" for the persistent Julia kernel',
		);
		expect(fields.codeDescription).toContain(
			"code to run in this eval call, verbatim. Top-level `await` is available in py/js; rb/jl auto-display the last expression like a REPL.",
		);
		expect(tool.summary).toBe("Execute Python, JavaScript, Ruby, or Julia code in a persistent eval backend");
		expect(tool.description).toMatch(/ruby/i);
		expect(tool.description).toMatch(/julia/i);
		// Ruby examples appear once rb is enabled.
		const rbExampleLangs = tool.examples.filter(ex => "call" in ex && ex.call.language === "rb");
		expect(rbExampleLangs.length).toBe(2);
	});

	it("advertises only the enabled subset of optional backends", () => {
		const tool = new EvalTool(makeSession({ backends: { "eval.rb": true } }));
		const fields = wireCellFields(tool);
		expect(fields.languages).toEqual(["js", "py", "rb"]);
		expect(tool.summary).toBe("Execute Python, JavaScript, or Ruby code in a persistent eval backend");
		expect(tool.description).toMatch(/ruby/i);
		expect(tool.description).not.toMatch(/julia/i);
	});
});
