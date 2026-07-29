import { describe, expect, it } from "bun:test";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { LocalProtocolOptions } from "@oh-my-pi/pi-coding-agent/internal-urls";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { SessionTools, type SessionToolsHost } from "@oh-my-pi/pi-coding-agent/session/session-tools";
import { type } from "arktype";

const BASE_MODEL = {
	provider: "openai-codex",
	id: "gpt-5.6-terra",
	api: "openai-codex-responses",
	useResponsesLite: true,
	input: ["text"],
	output: ["text"],
} as unknown as Model;

function makeTool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: `${name} description`,
		parameters: type({}),
		execute: async () => ({ content: [{ type: "text", text: name }] }),
	} as unknown as AgentTool;
}

function makeHarness(
	modelId = "gpt-5.6-terra",
	profileEligible = true,
): {
	tools: SessionTools;
	agent: Agent;
	settings: Settings;
	setModel: (id: string) => void;
	setPlanMode: (enabled: boolean) => void;
} {
	let model = { ...BASE_MODEL, id: modelId } as Model;
	let planModeEnabled = false;
	const registered = ["read", "bash", "eval", "ask"].map(makeTool);
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["initial"], tools: registered, messages: [] },
	});
	const settings = Settings.isolated({ "eval.gpt56CodexProfile": true });
	const host: SessionToolsHost = {
		agent,
		sessionManager: SessionManager.inMemory(),
		settings,
		modelRegistry: {} as ModelRegistry,
		extensionRunner: () => undefined,
		clientBridge: () => undefined,
		agentKind: () => "main",
		isDisposed: () => false,
		isStreaming: () => false,
		queuedMessageCount: () => 0,
		planModeEnabled: () => planModeEnabled,
		model: () => model,
		memoryBackendSession: () => ({}) as AgentSession,
		clearInheritedProviderPromptCacheKey: () => {},
		clearMemoryPromotionSnapshot: () => {},
		captureMemoryPromotionSnapshot: () => {},
		emitNotice: () => {},
		notifyCommandMetadataChanged: () => {},
		localProtocolOptions: () => ({}) as LocalProtocolOptions,
		getInspectImageModeOverride: () => undefined,
		setInspectImageModeOverride: () => {},
	};
	const tools = new SessionTools(host, {
		gpt56CodexProfileEligible: profileEligible,
		toolRegistry: new Map(registered.map(tool => [tool.name, tool])),
		builtInToolNames: registered.map(tool => tool.name),
		baseSystemPrompt: ["initial"],
	});
	return {
		tools,
		agent,
		settings,
		setModel: id => {
			model = { ...model, id };
			agent.setModel(model);
		},
		setPlanMode: enabled => {
			planModeEnabled = enabled;
		},
	};
}

describe("SessionTools GPT-5.6 Codex profile", () => {
	it("projects Terra and Luna to eval plus direct ask while retaining nested enabled tools", async () => {
		for (const id of ["gpt-5.6-terra", "gpt-5.6-luna"]) {
			const harness = makeHarness(id);

			await harness.tools.reconcileGpt56CodexProfile();

			expect(harness.agent.state.tools.map(tool => tool.name)).toEqual(["eval", "ask"]);
			expect(harness.tools.getEnabledToolNames()).toEqual(["read", "bash", "eval", "ask"]);
			expect(harness.tools.getToolsCallableFromEval().map(tool => tool.name)).toEqual(["read", "bash"]);
			expect(harness.tools.getToolForEval("bash")?.name).toBe("bash");
			expect(harness.tools.getToolForEval("ask")).toBeUndefined();
		}
	});

	it("keeps Sol hybrid and restores the underlying selection after a model or setting change", async () => {
		const harness = makeHarness();
		await harness.tools.reconcileGpt56CodexProfile();
		await harness.tools.applyActiveToolsByName(["read", "eval", "ask"]);

		expect(harness.agent.state.tools.map(tool => tool.name)).toEqual(["eval", "ask"]);
		expect(harness.tools.getEnabledToolNames()).toEqual(["read", "eval", "ask"]);

		harness.setModel("gpt-5.6-sol");
		await harness.tools.reconcileGpt56CodexProfile();
		expect(harness.agent.state.tools.map(tool => tool.name)).toEqual(["read", "eval", "ask"]);

		harness.setModel("gpt-5.6-terra");
		await harness.tools.reconcileGpt56CodexProfile();
		harness.settings.override("eval.gpt56CodexProfile", false);
		await harness.tools.reconcileGpt56CodexProfile();
		expect(harness.agent.state.tools.map(tool => tool.name)).toEqual(["read", "eval", "ask"]);
	});

	it("keeps the built-in read helper callable for protocol URLs without advertising excluded tools", async () => {
		const harness = makeHarness();
		await harness.tools.reconcileGpt56CodexProfile();
		await harness.tools.applyActiveToolsByName(["bash", "eval", "ask"]);

		expect(harness.tools.getEnabledToolNames()).toEqual(["bash", "eval", "ask"]);
		expect(harness.tools.getToolsCallableFromEval().map(tool => tool.name)).toEqual(["bash"]);
		expect(harness.tools.getToolForEval("read")?.name).toBe("read");
	});

	it("does not alter Terra when the profile is ineligible", async () => {
		const harness = makeHarness("gpt-5.6-terra", false);

		await harness.tools.reconcileGpt56CodexProfile();
		expect(harness.agent.state.tools.map(tool => tool.name)).toEqual(["read", "bash", "eval", "ask"]);
	});

	it("restores direct tools when JavaScript eval is disabled", async () => {
		const harness = makeHarness();
		await harness.tools.reconcileGpt56CodexProfile();
		expect(harness.agent.state.tools.map(tool => tool.name)).toEqual(["eval", "ask"]);

		harness.settings.override("eval.js", false);
		await harness.tools.reconcileGpt56CodexProfile();
		expect(harness.agent.state.tools.map(tool => tool.name)).toEqual(["read", "bash", "eval", "ask"]);
	});

	it("restores direct tools during plan mode and projects them again afterward", async () => {
		const harness = makeHarness();
		await harness.tools.reconcileGpt56CodexProfile();
		expect(harness.agent.state.tools.map(tool => tool.name)).toEqual(["eval", "ask"]);

		harness.setPlanMode(true);
		await harness.tools.reconcileGpt56CodexProfile();
		expect(harness.agent.state.tools.map(tool => tool.name)).toEqual(["read", "bash", "eval", "ask"]);

		harness.setPlanMode(false);
		await harness.tools.reconcileGpt56CodexProfile();
		expect(harness.agent.state.tools.map(tool => tool.name)).toEqual(["eval", "ask"]);
	});
});
