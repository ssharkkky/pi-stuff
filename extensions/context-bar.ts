/**
 * Context progress bar (rendered inside the powerline footer row).
 *
 * Uses the extension-status mechanism: powerline renders all extension
 * statuses as a trailing segment, and re-paints immediately whenever a
 * status changes. So the bar lives in the powerline line itself, e.g.:
 *
 *   ... | cache 98% | ctx ██████░░░░ 34%
 *
 * (A custom setFooter() would conflict with powerline's own footer,
 * which is why this goes through setStatus() instead.)
 *
 * Bar colors by threshold: dim (<70%) / warning (70-90%) / error (>90%).
 * Refreshed on session_start and after every message (message_end).
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "ctx-bar";
const BAR_WIDTH = 10;

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
			const color =
				pct > 90 ? "error" : pct > 70 ? "warning" : "dim";

			const text = `ctx ${theme.fg(color, bar)} ${pct.toFixed(0)}%`;
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
