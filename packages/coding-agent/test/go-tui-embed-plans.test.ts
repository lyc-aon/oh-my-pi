import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { OMP_TUI_PACKAGE } from "@oh-my-pi/pi-coding-agent/modes/go-tui/constants";
import {
	OMP_TUI_GO_TARGETS,
	ompTuiStagedBinaryName,
	ompTuiStagedBinaryNames,
} from "@oh-my-pi/pi-coding-agent/modes/go-tui/resolve-binary";
import { type OmpTuiGoBuildPlan, planAllTargetBuilds, planGoBuild } from "../scripts/embed-omp-tui";

describe("planGoBuild (single target)", () => {
	const root = "/tmp/ratatui-go-fake";
	const binariesDir = "/tmp/omp-binaries-fake";

	it("emits argv array with trimpath, ldflags, CGO off, and temp -o path", () => {
		const target = OMP_TUI_GO_TARGETS.find(t => t.id === "linux-arm64")!;
		const plan = planGoBuild(target, { root, binariesDir });

		expect(plan.target).toEqual(target);
		expect(plan.cwd).toBe(root);
		expect(plan.env).toEqual({
			CGO_ENABLED: "0",
			GOOS: "linux",
			GOARCH: "arm64",
		});
		expect(plan.outputPath).toBe(path.join(binariesDir, "omp-tui.linux-arm64"));
		expect(plan.command[0]).toBe("go");
		expect(plan.command[1]).toBe("build");
		expect(plan.command).toContain("-trimpath");
		expect(plan.command).toContain("-ldflags=-s -w");
		expect(plan.command).toContain(OMP_TUI_PACKAGE);
		// -o points at unique temp, never directly at the final staged name.
		const oIdx = plan.command.indexOf("-o");
		expect(oIdx).toBeGreaterThanOrEqual(0);
		expect(plan.command[oIdx + 1]).toBe(plan.tempPath);
		expect(plan.tempPath).not.toBe(plan.outputPath);
		expect(path.dirname(plan.tempPath)).toBe(path.dirname(plan.outputPath));
		expect(path.basename(plan.tempPath)).toMatch(/^\.omp-tui\.linux-arm64\./);
		expect(plan.tempPath.endsWith(".tmp")).toBe(true);
		// Never a shell string — joining would break ldflags spaces if re-parsed badly.
		expect(Array.isArray(plan.command)).toBe(true);
		expect(plan.command.every(c => typeof c === "string")).toBe(true);
	});

	it("uses .exe suffix on windows temp and output names", () => {
		const target = OMP_TUI_GO_TARGETS.find(t => t.id === "win32-x64")!;
		const plan = planGoBuild(target, { root, binariesDir });
		expect(plan.env.GOOS).toBe("windows");
		expect(plan.env.GOARCH).toBe("amd64");
		expect(plan.outputPath).toBe(path.join(binariesDir, "omp-tui.win32-x64.exe"));
		expect(plan.tempPath.endsWith(".tmp.exe")).toBe(true);
		expect(plan.command.at(-1)).toBe(OMP_TUI_PACKAGE);
	});

	it("honors explicit outputPath override while keeping temp beside it", () => {
		const target = OMP_TUI_GO_TARGETS[0]!;
		const outputPath = "/var/stage/custom-out";
		const plan = planGoBuild(target, { root, outputPath });
		expect(plan.outputPath).toBe(outputPath);
		expect(path.dirname(plan.tempPath)).toBe("/var/stage");
	});
});

describe("planAllTargetBuilds (five targets)", () => {
	const root = "/repo/ratatui-go";
	const binariesDir = "/repo/coding-agent/src/modes/go-tui/binaries";

	it("returns one plan per OMP_TUI_GO_TARGETS entry in stable order", () => {
		const plans = planAllTargetBuilds({ root, binariesDir });
		expect(plans).toHaveLength(5);
		expect(plans.map(p => p.target.id)).toEqual([
			"darwin-arm64",
			"darwin-x64",
			"linux-arm64",
			"linux-x64",
			"win32-x64",
		]);
	});

	it("sets distinct GOOS/GOARCH/CGO/trimpath/ldflags/temp names per target", () => {
		const plans = planAllTargetBuilds({ root, binariesDir });
		const tempNames = new Set<string>();
		const outputNames = new Set<string>();

		const expectPlan = (plan: OmpTuiGoBuildPlan, goos: string, goarch: string, staged: string) => {
			expect(plan.env).toEqual({ CGO_ENABLED: "0", GOOS: goos, GOARCH: goarch });
			expect(plan.cwd).toBe(root);
			expect(plan.command).toEqual([
				"go",
				"build",
				"-trimpath",
				"-ldflags=-s -w",
				"-o",
				plan.tempPath,
				OMP_TUI_PACKAGE,
			]);
			expect(plan.outputPath).toBe(path.join(binariesDir, staged));
			expect(plan.tempPath).not.toBe(plan.outputPath);
			expect(plan.tempPath.includes(plan.target.id)).toBe(true);
			tempNames.add(plan.tempPath);
			outputNames.add(plan.outputPath);
		};

		expectPlan(plans[0]!, "darwin", "arm64", "omp-tui.darwin-arm64");
		expectPlan(plans[1]!, "darwin", "amd64", "omp-tui.darwin-x64");
		expectPlan(plans[2]!, "linux", "arm64", "omp-tui.linux-arm64");
		expectPlan(plans[3]!, "linux", "amd64", "omp-tui.linux-x64");
		expectPlan(plans[4]!, "windows", "amd64", "omp-tui.win32-x64.exe");

		expect(tempNames.size).toBe(5);
		expect(outputNames.size).toBe(5);
		// Windows temp keeps .exe after .tmp so GO toolchain output type matches.
		expect(plans[4]!.tempPath.endsWith(".tmp.exe")).toBe(true);
		for (const p of plans.slice(0, 4)) {
			expect(p.tempPath.endsWith(".tmp")).toBe(true);
			expect(p.tempPath.endsWith(".tmp.exe")).toBe(false);
		}
	});

	it("staged output basenames match the known reset-packaged cleanup inventory", () => {
		// reset-packaged only unlinks ompTuiStagedBinaryNames() — never arbitrary dir wipes.
		const known = ompTuiStagedBinaryNames();
		const plans = planAllTargetBuilds({ root, binariesDir });
		const fromPlans = plans.map(p => path.basename(p.outputPath));
		expect(fromPlans).toEqual([...known]);
		expect(known).toEqual(OMP_TUI_GO_TARGETS.map(t => ompTuiStagedBinaryName(t)));
		// Defense: no bare omp-tui in the known cleanup set (would clobber wrong files).
		expect(known.includes("omp-tui")).toBe(false);
		expect(known.includes("omp-tui.exe")).toBe(false);
	});
});
