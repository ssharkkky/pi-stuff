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
import { Box, Text } from "@earendil-works/pi-tui";
import {
	buildSessionContext,
	estimateTokens,
	type ExtensionAPI,
	type Theme,
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
/** Cells per row of the category bar on the right. */
const CAT_CELL_W = 10;

const est = (s: string): number => Math.ceil(s.length / 4);
const fmt = (n: number): string => n.toLocaleString("en-US");

/** 114700 -> "114.7k", 1048576 -> "1m" (Claude Code style). */
const kfmt = (n: number): string => {
	if (n >= 1_000_000) {
		const m = n / 1_000_000;
		return `${m >= 10 ? Math.round(m) : Math.round(m * 10) / 10}m`;
	}
	if (n >= 1_000) {
		const k = n / 1_000;
		return `${k >= 100 ? Math.round(k) : Math.round(k * 10) / 10}k`;
	}
	return String(n);
};

const pctOf = (tokens: number, total: number): string =>
	total > 0 ? `${((tokens / total) * 100).toFixed(1)}%` : "0%";

function blockGrid(usedTokens: number, window: number, theme: Theme): string[] {
	const rows: string[] = [];
	if (window <= 0) return rows;
	const totalCells = GRID_W * 4;
	const filled = Math.max(
		usedTokens > 0 ? 1 : 0,
		Math.min(totalCells, Math.round((usedTokens / window) * totalCells)),
	);
	for (let r = 0; r < 4; r++) {
		let line = "";
		for (let c = 0; c < GRID_W; c++) {
			const idx = r * GRID_W + c;
			const ch = idx < filled ? "⛁" : "⛶";
			line += (idx < filled ? theme.fg("accent", ch) : theme.fg("dim", ch)) + " ";
		}
		rows.push(line.replace(/\s+$/, ""));
	}
	return rows;
}

/** One cell row for the category list (filled proportionally, min 1 if > 0). */
function catBar(tokens: number, total: number, theme: Theme): string {
	if (total <= 0) return theme.fg("dim", Array(CAT_CELL_W).fill("⛶").join(""));
	const filled = tokens > 0 ? Math.max(1, Math.min(CAT_CELL_W, Math.round((tokens / total) * CAT_CELL_W))) : 0;
	return (
		theme.fg("accent", Array(filled).fill("⛁").join("")) +
		theme.fg("dim", Array(CAT_CELL_W - filled).fill("⛶").join(""))
	);
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
			const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown model";

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
		const grid = blockGrid(used, window, theme);

		const leftW = GRID_W * 2;
		const padLeft = (s: string): string => (s.length >= leftW ? s : s + " ".repeat(leftW - s.length));
		const row = (left: string, right: string): string =>
			right ? `${padLeft(left)}  ${right}` : left;

		const lines: string[] = [];
		lines.push(theme.bold("Context Usage"));
		for (let r = 0; r < 4; r++) {
			const right =
				r === 0
					? `${d.model} (${kfmt(window)} context)`
					: r === 1
						? theme.fg("dim", new Date(d.at).toLocaleString())
						: r === 2
							? `${kfmt(used)}/${kfmt(window)} tokens (${pctOf(used, window)})`
							: "";
			lines.push(row(grid[r] ?? "", right));
		}
		lines.push("");
		lines.push(row("", theme.bold("Estimated usage by category")));
		const cat = (label: string, tokens: number): void => {
			lines.push(row("", `${catBar(tokens, window, theme)}  ${label}: ${kfmt(tokens)} tokens (${pctOf(tokens, window)})`));
		};
		cat("System prompt", d.systemPromptTokens);
		cat("System tools", d.toolsTotal);
		if (d.skillsCount > 0) cat("Skills", d.skillsTokens);
		cat("Messages", d.messagesTotal);
		cat("Free space", free);

		if (d.skillsCount > 0) {
			lines.push("");
			lines.push(`Skills · /skills`);
			lines.push(theme.fg("dim", `└ ${d.skillsCount} skills · ${kfmt(d.skillsTokens)} tokens`));
		}

		if (d.expanded) {
			lines.push("");
			lines.push(theme.bold(`System tools (${d.tools.length}) · ${kfmt(d.toolsTotal)} tokens`));
			for (const t of d.tools) {
				lines.push(theme.fg("dim", `  ${t.name.padEnd(24)} ${kfmt(t.tokens).padStart(8)}  ${pctOf(t.tokens, window)}`));
			}
			lines.push("");
			lines.push(theme.bold(`Messages (${d.messageCount}) · ${kfmt(d.messagesTotal)} tokens`));
			for (const r of d.messageRoles) {
				lines.push(theme.fg("dim", `  ${r.role.padEnd(24)} ${kfmt(r.tokens).padStart(8)}  ${pctOf(r.tokens, window)}  ×${r.count}`));
			}
			if (d.actualTokens != null) {
				lines.push("");
				lines.push(`Actual (last API): ${kfmt(d.actualTokens)} tokens (${pctOf(d.actualTokens, window)})`);
			}
		} else {
			lines.push("");
			lines.push(theme.fg("dim", "/context all to expand"));
		}
		lines.push(theme.fg("dim", "estimates: chars/4 heuristic; tool counts include schema JSON"));

		for (const line of lines) box.addChild(new Text(line, 0, 0));
		return box;
	});
}
