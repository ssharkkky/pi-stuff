/**
 * Context progress bar footer (true bottom row).
 *
 * Replaces the default footer with:
 *   ctx [██████░░░░░░░░░░░░░░░░] 28%            <model-id>
 *
 * Bar colors by threshold: dim (<70%) / warning (70-90%) / error (>90%).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const BAR_WIDTH = 20;

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setFooter((_tui, theme, _footerData) => {
			return {
				dispose() {},
				invalidate() {},
				render(width: number): string[] {
					const usage = ctx.getContextUsage();
					const window = ctx.model?.contextWindow ?? 0;
					const tokens = usage?.tokens ?? 0;
					const pct = window > 0 ? Math.min(100, (tokens / window) * 100) : 0;
					const filled = Math.round((pct / 100) * BAR_WIDTH);
					const bar = "█".repeat(filled) + "░".repeat(BAR_WIDTH - filled);

					let colored: string;
					if (pct > 90) colored = theme.fg("error", bar);
					else if (pct > 70) colored = theme.fg("warning", bar);
					else colored = theme.fg("dim", bar);

					const left = `ctx ${colored} ${pct.toFixed(0)}%`;
					const right = theme.fg("dim", ctx.model?.id ?? "");

					const pad = " ".repeat(
						Math.max(1, width - visibleWidth(left) - visibleWidth(right)),
					);
					return [truncateToWidth(left + pad + right, width)];
				},
			};
		});
	});
}
