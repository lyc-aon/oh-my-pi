import { describe, expect, it } from "bun:test";
import { expandRoleAliasFor, resolveEffectiveSelector } from "@oh-my-pi/pi-coding-agent/config/model-routing";

const modelRoles = {
	default: "anthropic/claude-opus-4-8:high",
	designer: "zai-coding/glm-5.2:medium",
};

describe("home model routing", () => {
	it("uses agent overrides before frontmatter or defaults", () => {
		const result = resolveEffectiveSelector({
			frontmatterModel: "pi/designer",
			overrides: { Designer: "openai-codex/gpt-5.5:xhigh" },
			disabledAgents: [],
			modelRoles,
			name: "Designer",
		});

		expect(result).toEqual({
			selector: "openai-codex/gpt-5.5:xhigh",
			source: "override",
			disabled: false,
		});
	});

	it("expands pi role aliases and preserves thinking suffixes", () => {
		const result = resolveEffectiveSelector({
			frontmatterModel: "pi/designer:high",
			overrides: {},
			disabledAgents: [],
			modelRoles,
			name: "FrontendDesigner",
		});

		expect(result).toEqual({
			selector: "zai-coding/glm-5.2:medium:high",
			source: "role",
			disabled: false,
		});
	});

	it("inherits modelRoles.default for unset default-inheriting pi roles", () => {
		const defaultOnlyRoles = { default: "anthropic/claude-opus-4-8:high" };
		for (const role of ["smol", "slow", "designer"]) {
			const result = resolveEffectiveSelector({
				frontmatterModel: `pi/${role}`,
				overrides: {},
				disabledAgents: [],
				modelRoles: defaultOnlyRoles,
				name: role,
			});
			expect(result.selector).toBe("anthropic/claude-opus-4-8:high");
			expect(result.source).toBe("role");
		}
	});

	it("uses the first resolvable model from multi-candidate frontmatter", () => {
		const result = resolveEffectiveSelector({
			frontmatterModel: ["pi/plan", "pi/slow"],
			overrides: {},
			disabledAgents: [],
			modelRoles: {},
			name: "plan",
		});

		expect(result.selector).toBeDefined();
		expect(result.selector).not.toBe("pi/plan");
		expect(result.source).toBe("role");
	});

	it("falls back to the configured default and carries disabled state", () => {
		const result = resolveEffectiveSelector({
			overrides: {},
			disabledAgents: ["Reviewer"],
			modelRoles,
			name: "Reviewer",
		});

		expect(result).toEqual({
			selector: "anthropic/claude-opus-4-8:high",
			source: "default",
			disabled: true,
		});
	});

	it("returns concrete selectors unchanged for live preview", () => {
		expect(expandRoleAliasFor("openrouter/deepseek/deepseek-v4-pro:high", modelRoles)).toBe(
			"openrouter/deepseek/deepseek-v4-pro:high",
		);
	});
});
