/**
 * goal-autostart — let the MODEL start a pi-goal run on its own initiative.
 *
 * @narumitw/pi-goal is user-initiated: /goal <objective>. This extension adds
 * the model-initiated path on top of pi-goal's official managed-run RPC
 * (channels: pi-goal:start / pi-goal:event:<runId>):
 *
 *   goal_start(objective, tokenBudget?)
 *     — model tool. When the current task is clearly large and multi-step,
 *       the model can start a goal run. After the call returns, pi-goal
 *       continues the work from each agent_settled idle boundary until the
 *       model calls goal_complete / goal_blocked / goal_wait, or a safety
 *       limit stops the run (default: 25 automatic turns; pauses after 3
 *       no-progress runs).
 *
 * The model can TERMINATE goals itself (pi-goal's goal_complete / goal_blocked
 * / goal_wait tools are always registered); goal_start adds model-initiated
 * START. The user keeps full control: /goal manages, pauses, edits, clears.
 *
 * Requires: @narumitw/pi-goal installed, with rpc.enabled = true in
 * ~/.pi/agent/pi-goal.json (create via /goal → Settings… → Managed run RPC).
 * If pi-goal is absent, the RPC times out and the tool reports it.
 */
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const GOAL_RUN_START_CHANNEL = "pi-goal:start";
const RPC_TIMEOUT_MS = 5_000;

/** Must satisfy pi-goal's RUN_ID_PATTERN: /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/ */
function newRunId(): string {
	const rand = Math.random().toString(36).slice(2, 10);
	return `model-${Date.now().toString(36)}-${rand}`;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "goal_start",
		label: "Goal Start",
		description:
			"Start a session goal (pi-goal) and keep working toward it autonomously. " +
			"After this call, pi automatically continues from each idle boundary until you call " +
			"goal_complete (with evidence), goal_blocked, or goal_wait, or a safety limit stops the " +
			"run (default: 25 automatic turns; pauses after 3 no-progress runs). Use it when the " +
			"current task is clearly large and multi-step and should be driven to completion without " +
			"the user re-prompting each step. The user can pause/edit/clear the goal with /goal at " +
			"any time. Requires the @narumitw/pi-goal package with rpc.enabled in its settings.",
		parameters: Type.Object({
			objective: Type.String({
				description:
					"Specific, verifiable objective. State what 'done' means: deliverables and acceptance criteria.",
			}),
			tokenBudget: Type.Optional(
				Type.Number({
					description:
						"Optional token budget. Goal-owned work stops immediately when exhausted.",
				}),
			),
		}),

		async execute(_id, params: { objective: string; tokenBudget?: number }) {
			const runId = newRunId();
			const eventChannel = `pi-goal:event:${runId}`;

			const outcome = await new Promise<{ kind: "state" | "error" | "timeout"; text: string }>(
				(resolve) => {
					let settled = false;
					const off = pi.events.on(eventChannel, (data: unknown) => {
						if (settled || typeof data !== "object" || data === null) return;
						const event = data as {
							type: string;
							status?: string;
							reason?: string;
							error?: { code: string; message: string };
						};
						settled = true;
						off();
						if (event.type === "error") {
							resolve({
								kind: "error",
								text: `pi-goal error [${event.error?.code ?? "UNKNOWN"}]: ${event.error?.message ?? "unknown error"}`,
							});
						} else if (event.type === "state") {
							resolve({
								kind: "state",
								text: `status: ${event.status ?? "unknown"}${event.reason ? ` (${event.reason})` : ""}`,
							});
						}
					});
					setTimeout(() => {
						if (!settled) {
							settled = true;
							off();
							resolve({
								kind: "timeout",
								text:
									"pi-goal did not respond to the start request. Is @narumitw/pi-goal installed, " +
									"and is rpc.enabled = true in ~/.pi/agent/pi-goal.json (/goal → Settings… → Managed run RPC)?",
							});
						}
					}, RPC_TIMEOUT_MS);

					pi.events.emit(GOAL_RUN_START_CHANNEL, {
						runId,
						objective: params.objective,
						...(params.tokenBudget !== undefined ? { tokenBudget: params.tokenBudget } : {}),
					});
				},
			);

			if (outcome.kind !== "state") {
				return {
					content: [{ type: "text", text: `goal_start failed. ${outcome.text}` }],
					isError: true,
				};
			}

			return {
				content: [
					{
						type: "text",
						text:
							`Goal started (runId ${runId}, ${outcome.text}). pi-goal will continue this objective ` +
							`from every idle boundary until you call goal_complete (with evidence), goal_blocked, ` +
							`or goal_wait, or a safety limit stops the run. Start working on the objective now: ` +
							`"${params.objective}". The user manages the goal with /goal at any time.`,
					},
				],
			};
		},
	});
}
