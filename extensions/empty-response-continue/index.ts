/**
 * empty-response-continue
 *
 * 针对部分 OpenAI 兼容网关（实测 tokensupply.ts-antigravity / gemini-3.x thinking 模型）
 * 在工具调用后的下一轮概率性返回「空 content + stopReason:stop + output tokens > 0」的
 * 问题：pi 本身不会对这种"静默空回复"重试（仅对 stopReason=error 重试），导致 agent
 * 回合无声结束，需要用户手动发"继续"。
 *
 * 该扩展在 agent_end 时检测最后一条 assistant 消息：
 *   - content 为空 且 stopReason === "stop" 且 usage.output > 0
 * 则自动发送一条续跑提示，让 agent 继续（等效于用户手动输入"继续"）。
 *
 * 防护：
 *   - 每个会话最多连续自动续跑 MAX_AUTO_CONTINUES 次，防止无限循环
 *   - 出现正常（非空）assistant 回复后计数复位
 *   - 轮询等待 agent 空闲后再注入；若用户已抢先输入新消息则不注入
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MAX_AUTO_CONTINUES = 2;

type AssistantLike = {
	role: string;
	content?: unknown;
	stopReason?: string;
	usage?: { output?: number } | null;
	provider?: string;
	model?: string;
};

function lastAssistant(messages: unknown): AssistantLike | undefined {
	if (!Array.isArray(messages)) return undefined;
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as AssistantLike | undefined;
		if (m && m.role === "assistant") return m;
	}
	return undefined;
}

function isSilentEmpty(msg: AssistantLike | undefined): boolean {
	if (!msg) return false;
	if (msg.stopReason !== "stop") return false;
	const content = msg.content;
	if (!Array.isArray(content) || content.length !== 0) return false;
	// output > 0 说明模型确实生成了 token（思考 token 或网关丢弃的文本），
	// 而不是模型主动的空回复。
	return (msg.usage?.output ?? 0) > 0;
}

export default function (pi: ExtensionAPI) {
	const autoContinues = new Map<string, number>();

	pi.on("agent_end", (event, ctx) => {
		const last = lastAssistant(event.messages);

		// 以会话文件路径区分不同会话
		let sessionKey = "default";
		try {
			const p = ctx.sessionManager.getSessionFile?.();
			if (p) sessionKey = p;
		} catch {
			// ignore
		}

		if (!isSilentEmpty(last)) {
			// 正常回复：复位计数
			autoContinues.delete(sessionKey);
			return;
		}

		const count = autoContinues.get(sessionKey) ?? 0;
		if (count >= MAX_AUTO_CONTINUES) {
			ctx.ui.notify(
				`检测到空响应（${last?.provider ?? "?"}/${last?.model ?? "?"} output=${last?.usage?.output ?? 0} tokens），已连续自动续跑 ${count} 次，停止重试，请手动发送"继续"。`,
				"error",
			);
			return;
		}

		autoContinues.set(sessionKey, count + 1);
		ctx.ui.notify(
			`检测到空响应（provider=${last?.provider ?? "?"} model=${last?.model ?? "?"} output=${last?.usage?.output ?? 0} tokens，content 为空），自动续跑第 ${count + 1}/${MAX_AUTO_CONTINUES} 次…`,
			"warning",
		);

		// 延迟到当前 run 完全 settle 后再注入，避免在 agent 事件处理中途重入。
		const nudge =
			"（系统提示：上一条回复的 content 为空（provider 异常，已生成 " +
			String(last?.usage?.output ?? 0) +
			" 个 output tokens 但无可见内容）。请基于以上上下文继续，直接给出你刚才要说的内容或下一步操作。）";
		let attempts = 0;
		const trySend = () => {
			attempts += 1;
			if (ctx.isIdle()) {
				try {
					pi.sendUserMessage(nudge);
				} catch (err) {
					ctx.ui.notify("空响应自动续跑失败: " + String(err), "error");
				}
				return;
			}
			if (attempts < 100) {
				setTimeout(trySend, 100);
			} else {
				ctx.ui.notify("空响应自动续跑取消：agent 未空闲（可能用户已发送新消息）", "warning");
			}
		};
		setTimeout(trySend, 100);
	});
}
