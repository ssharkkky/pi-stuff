/**
 * Context progress bar segment (rendered inside the powerline footer row).
 *
 * Publishes the bar as an extension status; powerline's customItems
 * config elevates it to a dedicated segment in the context slot, e.g.:
 *
 *   ... | git branch | ████░░░░░░ 108k/262k (41%) | cache 98% | ...
 *
 * (A custom setFooter() would conflict with powerline's own footer,
 * so this goes through setStatus() + powerline customItems instead.)
 *
 * Bar colors by threshold: dim (<70%) / warning (70-90%) / error (>90%).
 * Refreshed on session_start and after every message (message_end).
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "ctx-bar";
const BAR_WIDTH = 10;

/** Compact token formatting, matching powerline's own style (108k / 262k). */
function formatTokens(n: number): string {
	if (n < 1000) return n.toString();
	if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
	if (n < 1000000) return `${Math.round(n / 1000)}k`;
	if (n < 10000000) return `${(n / 1000000).toFixed(1)}M`;
	return `${Math.round(n / 1000000)}M`;
}

export default function (pi: ExtensionAPI) {
	let lastText = "";

	const refresh = (ctx: ExtensionContext) => {
		try {
			const usage = ctx.getContextUsage();
			const tokens = usage?.tokens;
			const window = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
			if (tokens == null || window <= 0) {
				if (lastText !== "") {
					ctx.ui.setStatus(STATUS_KEY, undefined);
					lastText = "";
				}
				return;
			}

			const pct = Math.min(100, Math.max(0, (tokens / window) * 100));
			const filled = Math.round((pct / 100) * BAR_WIDTH);
			const bar = "█".repeat(filled) + "░".repeat(BAR_WIDTH - filled);

			const theme = ctx.ui.theme;
			const barColor = pct > 90 ? "error" : pct > 70 ? "warning" : "dim";
			const text = `${theme.fg(barColor, bar)} ${theme.fg("muted", `${formatTokens(tokens)}/${formatTokens(window)} (${pct.toFixed(0)}%)`)}`;

			if (text !== lastText) {
				ctx.ui.setStatus(STATUS_KEY, text);
				lastText = text;
			}
		} catch {
			// never break the session over a cosmetic footer bar
		}
	};

	pi.on("session_start", (_event, ctx) => refresh(ctx));
	pi.on("message_end", (_event, ctx) => refresh(ctx));
}
