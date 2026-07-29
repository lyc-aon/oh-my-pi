import { describe, expect, it, vi } from "bun:test";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

describe("SelectorController prompt-affecting settings", () => {
	it("refreshes the active prompt when xdev docs mode changes", async () => {
		const refreshBaseSystemPrompt = vi.fn(async () => {});
		const ctx = {
			session: { refreshBaseSystemPrompt },
			showError: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new SelectorController(ctx);

		controller.handleSettingChange("tools.xdevDocs", "catalog");
		await Promise.resolve();

		expect(refreshBaseSystemPrompt).toHaveBeenCalledTimes(1);
		expect(ctx.showError).not.toHaveBeenCalled();
	});

	it("refreshes the active prompt when the JavaScript eval backend changes", async () => {
		const refreshBaseSystemPrompt = vi.fn(async () => {});
		const reconcileGpt56CodexProfile = vi.fn(async () => {});
		const ctx = {
			session: { refreshBaseSystemPrompt, reconcileGpt56CodexProfile },
			showError: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new SelectorController(ctx);

		controller.handleSettingChange("eval.js", false);
		await Promise.resolve();

		expect(reconcileGpt56CodexProfile).toHaveBeenCalledTimes(1);
		expect(refreshBaseSystemPrompt).toHaveBeenCalledTimes(1);
		expect(ctx.showError).not.toHaveBeenCalled();
	});

	it("reconciles model routing when the GPT-5.6 Codex profile changes", async () => {
		const reconcileGpt56CodexProfile = vi.fn(async () => {});
		const ctx = {
			session: { reconcileGpt56CodexProfile },
			showError: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new SelectorController(ctx);

		controller.handleSettingChange("eval.gpt56CodexProfile", true);
		await Promise.resolve();

		expect(reconcileGpt56CodexProfile).toHaveBeenCalledTimes(1);
		expect(ctx.showError).not.toHaveBeenCalled();
	});
});
