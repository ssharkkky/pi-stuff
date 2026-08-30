/**
 * /context — Claude Code-style context usage report.
 *
 * Registers a `/context` command that renders an inline report (TUI-only
 * custom entry, never sent to the LLM) shaped like Claude Code CLI's:
 *
 *   Context Usage
 *   ⛁ ⛁ ⛁ ⛁ ⛁ ⛁ ⛀                    Opus 5 (1M context)
 *   ⛁ ⛁ ⛁ ⛁ ⛶ ⛶ ⛶                    claude-opus-5[1m]
 *   ...                                114.7k/1m tokens (11%)
 *
 *                                        Estimated usage by category
 *                                        ⛁ System prompt: 2.7k tokens (0.3%)
 *                                        ⛁ System tools: 25.5k tokens (2.6%)
 *                                        ⛁ Skills: 1.9k tokens (0.2%)
 *                                        ⛁ Messages: 84.5k tokens (8.5%)
 *                                        ⛶ Free space: 885.3k (88.5%)
 *
 *   Skills · /skills
 *   └ 14 skills · 1.9k tokens
 *
 *   /context all to expand
 *
 * `/context all` also lists per-tool and per-role breakdowns.
 *
 * Numbers are estimates (chars/4, the same heuristic pi uses internally)
 * except the headline total, which is pi's getContextUsage() — last real
 * API usage plus estimated trailing messages.
 */
import { Box, Text, visibleWidth } from "@earendil-works/pi-tui";
import {
	buildSessionContext,
	estimateTokens,
	type ExtensionAPI,
	type Theme,
	type ThemeColor,
} from "@earendil-works/pi-coding-agent";

interface ToolBreakdown {
	name: string;
	tokens: number;
}

interface RoleBreakdown {
	role: string;
	count: number;
	tokens: number;
}

interface ContextReportData {
	at: number;
	model: string;
	modelId: string;
	contextWindow: number;
	actualTokens: number | null;
	systemPromptTokens: number;
	skillsTokens: number;
	skillsCount: number;
	tools: ToolBreakdown[];
	toolsTotal: number;
	messageCount: number;
	messageRoles: RoleBreakdown[];
	messagesTotal: number;
	expanded: boolean;
}

/** Block-grid columns — Claude Code uses 20. */
const GRID_W = 20;

const est = (s: string): number => Math.ceil(s.length / 4);

/** 114700 -> "114.7k", 1048576 -> "1m", 262144 -> "262k" (Claude Code style). */
const kfmt = (n: number): string => {
	if (n >= 1_000_000) {
		const m = n / 1_000_000;
		const v = m >= 10 ? Math.round(m) : Math.round(m * 10) / 10;
		return `${Number.isInteger(v) ? v : v.toFixed(1)}m`;
	}
	if (n >= 1_000) {
		const k = n / 1_000;
		const v = k >= 100 ? Math.round(k) : Math.round(k * 10) / 10;
		return `${Number.isInteger(v) ? v : v.toFixed(1)}k`;
	}
	return String(n);
};

const pctOf = (tokens: number, total: number): string =>
	total > 0 ? `${((tokens / total) * 100).toFixed(1)}%` : "0%";

/**
 * Category-colored block grid, Claude Code style: the grid is a segmented
 * visualization of the context window — each category fills its proportional
 * run of cells in its own color (gray system prompt/tools, yellow skills,
 * accent messages), remaining cells are empty outlines.
 */
function blockGrid(segments: { tokens: number; color: ThemeColor }[], window: number, theme: Theme, gridRows: number): string[] {
	const rows: string[] = [];
	if (window <= 0) return rows;
	const totalCells = GRID_W * gridRows;
	// Each non-zero category gets at least one cell; round the rest.
	const cells = segments.map((s) =>
		s.tokens > 0 ? Math.max(1, Math.round((s.tokens / window) * totalCells)) : 0,
	);
	const filledTotal = Math.min(totalCells, cells.reduce((a, b) => a + b, 0));
	// Build the flat color list in segment order.
	const flat: { color: ThemeColor }[] = [];
	let budget = filledTotal;
	segments.forEach((s, i) => {
		let n = cells[i];
		if (n > budget) n = budget;
		for (let k = 0; k < n; k++) flat.push({ color: s.color });
		budget -= n;
	});
	for (let r = 0; r < gridRows; r++) {
		let line = "";
		for (let c = 0; c < GRID_W; c++) {
			const idx = r * GRID_W + c;
			const seg = idx < flat.length ? flat[idx] : undefined;
			line += (seg ? theme.fg(seg.color, "⛁") : theme.fg("dim", "⛶")) + " ";
		}
		rows.push(line.replace(/\s+$/, ""));
	}
	return rows;
}

/** Single leading marker for a category row, Claude Code style (each category
 * has its own marker color; free space is an outlined marker). */
function catMarker(color: ThemeColor, theme: Theme, outlined = false): string {
	const ch = outlined ? "⛶" : "⛁";
	return theme.fg(color, ch);
}

/** Extract the skills block from the system prompt (pi injects it as "<available_skills>...</available_skills>"). */
function extractSkills(systemPrompt: string): { text: string; count: number } {
	const match = /<available_skills>([\s\S]*?)<\/available_skills>/.exec(systemPrompt);
	if (!match) return { text: "", count: 0 };
	const count = (match[1].match(/<skill>/g) ?? []).length;
	return { text: match[1], count };
}

export default function (pi: ExtensionAPI): void {
	pi.registerCommand("context", {
		description: "Show context usage breakdown (Claude Code style); /context all for per-tool detail",
		async handler(args, ctx) {
			const expanded = /all/i.test(args.trim());
			const usage = ctx.getContextUsage();
			const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
			const model = ctx.model ? (ctx.model.name || ctx.model.id) : "unknown model";
			const modelId = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "";

			const systemPrompt = ctx.getSystemPrompt();
			const skills = extractSkills(systemPrompt);
			const corePromptTokens = est(systemPrompt.replace(/<available_skills>[\s\S]*?<\/available_skills>/, ""));
			const skillsTokens = est(skills.text);

			const tools: ToolBreakdown[] = pi
				.getAllTools()
				.map((t) => ({
					name: t.name,
					tokens: est(
						JSON.stringify({
							name: t.name,
							description: t.description,
							parameters: t.parameters,
							...(t.promptGuidelines ? { prompt_guidelines: t.promptGuidelines } : {}),
						}),
					),
				}))
				.sort((a, b) => b.tokens - a.tokens);
			const toolsTotal = tools.reduce((sum, t) => sum + t.tokens, 0);

			const entries = ctx.sessionManager.getEntries();
			const { messages } = buildSessionContext(entries, ctx.sessionManager.getLeafId());
			const roles = new Map<string, RoleBreakdown>();
			for (const m of messages) {
				const tokens = estimateTokens(m);
				const cur = roles.get(m.role) ?? { role: m.role, count: 0, tokens: 0 };
				cur.count += 1;
				cur.tokens += tokens;
				roles.set(m.role, cur);
			}
			const messageRoles = [...roles.values()].sort((a, b) => b.tokens - a.tokens);
			const messagesTotal = messageRoles.reduce((sum, r) => sum + r.tokens, 0);

			const data: ContextReportData = {
				at: Date.now(),
				model,
				modelId,
				contextWindow,
				actualTokens: usage?.tokens ?? null,
				systemPromptTokens: corePromptTokens,
				skillsTokens,
				skillsCount: skills.count,
				tools,
				toolsTotal,
				messageCount: messages.length,
				messageRoles,
				messagesTotal,
				expanded,
			};
			pi.appendEntry("context-report", data);

			if (ctx.mode !== "tui") {
				const total = corePromptTokens + skillsTokens + toolsTotal + messagesTotal;
				ctx.ui.notify(
					`/context: ~${kfmt(total)}/${kfmt(contextWindow)} tokens (${pctOf(total, contextWindow)}) — full report is TUI-only`,
					"info",
				);
			}
		},
	});

	pi.registerEntryRenderer("context-report", (entry, _opts, theme) => {
		const d = entry.data as ContextReportData;
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));

		const window = d.contextWindow;
		const used = d.actualTokens ?? d.systemPromptTokens + d.skillsTokens + d.toolsTotal + d.messagesTotal;
		const free = Math.max(0, window - used);

		// Right column content: header lines, then the category list. The
		// block grid spans ALL of these rows (like Claude Code), so build the
		// right side first and size the grid to match.
		const rightLines: string[] = [
			`${d.model} (${kfmt(window)} context)`,
			d.modelId ? theme.fg("dim", d.modelId) : "",
			`${kfmt(used)}/${kfmt(window)} tokens (${pctOf(used, window)})`,
			"",
			theme.italic(theme.fg("dim", "Estimated usage by category")),
		];
		const cat = (color: ThemeColor, label: string, tokens: number): void => {
			rightLines.push(`${catMarker(color, theme)} ${label}: ${kfmt(tokens)} tokens (${pctOf(tokens, window)})`);
		};
		cat("text", "System prompt", d.systemPromptTokens);
		cat("muted", "System tools", d.toolsTotal);
		if (d.skillsCount > 0) cat("warning", "Skills", d.skillsTokens);
		cat("accent", "Messages", d.messagesTotal);
		rightLines.push(`${catMarker("dim", theme, true)} Free space: ${kfmt(free)} (${pctOf(free, window)})`);

		const segments: { tokens: number; color: ThemeColor }[] = [
			{ tokens: d.systemPromptTokens, color: "text" },
			{ tokens: d.toolsTotal, color: "muted" },
			...(d.skillsCount > 0 ? [{ tokens: d.skillsTokens, color: "warning" as ThemeColor }] : []),
			{ tokens: d.messagesTotal, color: "accent" },
		];
		const grid = blockGrid(segments, window, theme, rightLines.length);
		// Each grid cell is "⛁" + a separating space = 2 columns, so the grid
		// occupies GRID_W * 2 columns; Claude Code then leaves 3 spaces before
		// the right column.
		const leftW = GRID_W * 2;
		const padLeft = (s: string): string => {
			const w = visibleWidth(s);
			return w >= leftW ? s : s + " ".repeat(leftW - w);
		};

		const lines: string[] = [];
		lines.push(theme.bold("Context Usage"));
		for (let r = 0; r < rightLines.length; r++) {
			const left = grid[r] ?? "";
			const right = rightLines[r];
			lines.push(right ? `${padLeft(left)}   ${right}` : left);
		}

		if (d.skillsCount > 0) {
			lines.push(" ");
			lines.push(theme.bold("Skills · /skills"));
			lines.push(theme.fg("dim", `└ ${d.skillsCount} skills · ${kfmt(d.skillsTokens)} tokens`));
		}

		if (d.expanded) {
			lines.push(" ")
			lines.push(theme.bold(`System tools (${d.tools.length}) · ${kfmt(d.toolsTotal)} tokens`));
			for (const t of d.tools) {
				lines.push(theme.fg("dim", `  ${t.name.padEnd(24)} ${kfmt(t.tokens).padStart(8)}  ${pctOf(t.tokens, window)}`));
			}
			lines.push(" ")
			lines.push(theme.bold(`Messages (${d.messageCount}) · ${kfmt(d.messagesTotal)} tokens`));
			for (const r of d.messageRoles) {
				lines.push(theme.fg("dim", `  ${r.role.padEnd(24)} ${kfmt(r.tokens).padStart(8)}  ${pctOf(r.tokens, window)}  ×${r.count}`));
			}
			if (d.actualTokens != null) {
				lines.push(" ")
				lines.push(`Actual (last API): ${kfmt(d.actualTokens)} tokens (${pctOf(d.actualTokens, window)})`);
			}
		} else {
			lines.push(" ");
			lines.push(" ");
			lines.push(theme.fg("dim", "/context all to expand"));
		}

		// Single Text so blank lines survive (separate Text children collapse).
		box.addChild(new Text(lines.join("\n"), 0, 0));
		return box;
	});
}
