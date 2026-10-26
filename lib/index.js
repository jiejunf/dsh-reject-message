import z from "@deepseek-ai/schemastery";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
//#region src/escalation-tail.ts
/**
* 宿主终结尾句的整句匹配. 前段与主体词被捕获, 尾句逐字一致才认领,
* 所以宿主改了措辞就不动它; 开头不锚定, 文本块自带的 `Error: ` 一类前缀不受影响.
*/
const HOST_FINAL_REJECTION = /(the user rejected escalating this (\S+) to "[^"]+"); it stays denied, so stop and explain instead of working around it$/;
/** 尾句替换后的续写, 主体词随工具家族 (command / operation) 变化. */
function retryGuidance(subject) {
	return `if this ${subject} is still necessary, re-request it with a clearer justification, though a repeat ask may be rejected again`;
}
/**
* 把一段含宿主终结尾句的文本改写成可重新发起的表述.
* @param text - 工具结果里的一段文本.
* @returns 改写后的文本, 不是这句宿主文案时返回 undefined.
*/
function rewriteEscalationTail(text) {
	const match = HOST_FINAL_REJECTION.exec(text);
	if (match === null) return void 0;
	const head = match[1];
	const subject = match[2];
	if (head === void 0 || subject === void 0) return void 0;
	return `${text.slice(0, match.index)}${head}; ${retryGuidance(subject)}`;
}
/**
* 就地改写 content blocks 里的宿主终结尾句, 其余块 (例如追加的拒绝描述) 原样保留.
* @param content - 进入决策的 content blocks.
* @returns 改写后的 blocks, 没有可改的块时返回 undefined.
*/
function rewriteEscalationTailBlocks(content) {
	let changed = false;
	const blocks = content.map((block) => {
		if (block.type !== "text") return block;
		const text = rewriteEscalationTail(block.text);
		if (text === void 0) return block;
		changed = true;
		return {
			type: "text",
			text
		};
	});
	return changed ? blocks : void 0;
}
/** Host Cordis 插件名. */
const PLUGIN_NAME = "dsh-reject-message";
/** Typert Remote 的服务键 / 线命名空间. */
const REMOTE_NAMESPACE = "rejectMessage";
/** 拒绝描述默认最大字符数. */
const DEFAULT_MAX_LENGTH = 4e3;
/** 拒绝描述允许的最大最大字符数. */
const MAX_MAX_LENGTH = 16e3;
/** Host 暂存拒绝描述的存活时间. */
const REJECT_TTL_MS = 6e4;
/** 把未知值夹到合法的最大字符数. */
function clampMaxLength(value) {
	const n = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(n)) return DEFAULT_MAX_LENGTH;
	return Math.min(MAX_MAX_LENGTH, Math.max(32, Math.round(n)));
}
/**
* 规范化拒绝描述: trim, 超长截断, 空白视为没有描述.
* @param value - 用户输入或 Remote 入参.
* @param maxLength - 截断上限.
* @returns 有效描述, 或空白时的 `undefined`.
*/
function normalizeRejectMessage(value, maxLength = DEFAULT_MAX_LENGTH) {
	if (typeof value !== "string") return void 0;
	const trimmed = value.trim();
	if (trimmed.length === 0) return void 0;
	const limit = Number.isFinite(maxLength) && maxLength > 0 ? Math.floor(maxLength) : DEFAULT_MAX_LENGTH;
	return trimmed.length > limit ? trimmed.slice(0, limit) : trimmed;
}
/**
* 模型可见的拒绝描述正文. 工具结果和 additionalContexts 共用这段英文.
* @param toolName - 被拒绝的工具名.
* @param message - 已经规范化的拒绝描述.
*/
function formatRejectNote(toolName, message) {
	return `The user rejected this privileged request for tool "${toolName}" with this description:\n${message}`;
}
/**
* never 路径自动追加的复核原因正文; 与 ask 路径的拒绝描述保持同一种读法.
* @param reason - `AutoReviewDeniedError` 的错误详情原因.
*/
function formatAutoReviewNote(reason) {
	return `Auto review denied this call: ${reason}`;
}
function asNonEmptyString(value, label) {
	if (typeof value !== "string" || value.length === 0) throw new Error(`${label} 必须是非空字符串`);
	return value;
}
function parseRecordRejectArgs(value) {
	if (typeof value !== "object" || value === null) throw new Error("record args 必须是对象");
	const record = value;
	const args = {
		sessionId: asNonEmptyString(record.sessionId, "sessionId"),
		toolName: asNonEmptyString(record.toolName, "toolName"),
		message: asNonEmptyString(record.message, "message")
	};
	if (record.callId !== void 0) args.callId = asNonEmptyString(record.callId, "callId");
	return args;
}
function parseRecordRejectResult(value) {
	if (typeof value !== "object" || value === null) throw new Error("result 必须是对象");
	const recorded = value.recorded;
	if (typeof recorded !== "boolean") throw new Error("recorded 必须是布尔值");
	return { recorded };
}
function strictCodec(typeSymbol, parse) {
	const schema = { parse };
	return {
		mode: "strict",
		typeSymbol,
		create: () => schema
	};
}
const recordArgsCodec = strictCodec("dsh-reject-message#RecordRejectArgs", parseRecordRejectArgs);
const recordResultCodec = strictCodec("dsh-reject-message#RecordRejectResult", parseRecordRejectResult);
/** Host Typert 清单. */
const REJECT_MANIFEST = {
	package: PLUGIN_NAME,
	face: "host",
	schemas: [],
	model: {
		services: [{
			key: REMOTE_NAMESPACE,
			exportName: "RejectMessageRuntime",
			description: "Record a user reject description for the current approval.",
			tags: [],
			members: [{
				kind: "method",
				name: "record",
				signature: "record(args: RecordRejectArgs): Promise<RecordRejectResult>"
			}],
			types: []
		}],
		events: [],
		objects: []
	},
	invocations: [{
		id: "dsh-reject-message#rejectMessage/record",
		service: REMOTE_NAMESPACE,
		namespace: REMOTE_NAMESPACE,
		method: "record",
		invocation: { kind: "direct" },
		parameters: [{
			name: "args",
			wire: "args",
			source: "json",
			codec: recordArgsCodec
		}],
		result: recordResultCodec
	}]
};
//#endregion
//#region src/attach.ts
/**
* 把暂存的拒绝描述折进 tools/post-execute 决策, 并改写宿主那句 "拒绝即终结" 的尾句.
* 错误结果会把描述追加到模型可见 content, 并额外挂一条 additionalContext.
*/
/** 从工具执行里取出会话 id. */
function sessionIdOf(exec) {
	const id = exec.agent?.session.id;
	return id === void 0 ? void 0 : String(id);
}
/**
* 把一段拒绝描述追加到已有 content blocks 末尾.
* 末块是 text 时直接拼接, 否则再开一块, 避免打散原有投影.
*/
function appendRejectContent(content, note) {
	const last = content[content.length - 1];
	if (last !== void 0 && last.type === "text") return [...content.slice(0, -1), {
		type: "text",
		text: `${last.text}\n\n${note}`
	}];
	return [...content, {
		type: "text",
		text: note
	}];
}
function existingContexts(decision) {
	return decision.additionalContexts ?? [];
}
/** 只在真有上下文时改决策对象, 否则原样返回, 保住下游决策的身份. */
function withContexts(decision, contexts) {
	return contexts.length === 0 ? decision : {
		...decision,
		additionalContexts: contexts
	};
}
/** auto-review 最终拒绝的错误标识, 见 `@deepseek-ai/dsh-experimental-auto-review`. */
const AUTO_REVIEW_DENIED_NAME = "AutoReviewDeniedError";
/**
* 读取 auto-review 最终拒绝在错误详情里保存的复核原因.
*
* `never` 策略 (例如 in-process 子代理) 不经过审批窗口, 原因只存在于
* `error.info.reason`; 这里把它取出来, 由 post-execute 追加进模型可见结果.
*
* @param result - 进入 post-execute 的规范结果.
* @returns 非空复核原因, 或不是该错误时 `undefined`.
*/
function autoReviewDenialReason(result) {
	if (!result.isError) return void 0;
	const info = result.error.info;
	if (typeof info !== "object" || info === null) return void 0;
	const record = info;
	if (record.name !== AUTO_REVIEW_DENIED_NAME) return void 0;
	if (typeof record.reason !== "string") return void 0;
	const reason = record.reason.trim();
	return reason.length === 0 ? void 0 : reason;
}
/**
* 把拒绝描述折进下游决策, 并改写宿主拒绝升权的终结尾句.
*
* 描述要有会话与 callId 才认得出来, 尾句改写则只看文本, 所以没有描述时同样生效.
* 下游已经给出 block 或 value, 以及结果本身是成功时, 都不动 content.
*
* 两条通道互相独立: 用户填写的描述来自 Host 暂存 (ask 路径), auto-review 的复核原因
* 来自错误详情 (never 路径); 两条都命中时按顺序拼进同一段正文.
*
* `never` 路径只追加 content, 不再挂一条 additionalContext: 那里没有用户要通知, 也没有
* 审批卡; 让子代理后续 review 看到历史拒绝原因的价值很弱 (会话通常很短), 而把系统自动
* 决定包装成 user-role notice 语义上也多余. 需要时补一条 context 只是一个循环的事.
*
* @param store - Host 暂存.
* @param exec - 当前工具执行.
* @param result - 进入 post-execute 的规范结果.
* @param downstream - 下游 listener 返回的决策.
*/
function attachRejectMessage(store, exec, result, downstream) {
	const sessionId = sessionIdOf(exec);
	const note = sessionId === void 0 ? void 0 : store.takeFor(sessionId, exec.name, exec.callId);
	const noteText = note === void 0 ? void 0 : formatRejectNote(exec.name, note);
	const denialReason = autoReviewDenialReason(result);
	const denialText = denialReason === void 0 ? void 0 : formatAutoReviewNote(denialReason);
	const extra = noteText === void 0 ? void 0 : createUserMessage({
		content: [{
			type: "text",
			text: noteText
		}],
		source: {
			kind: PLUGIN_NAME,
			form: "notice",
			summary: `The user rejected ${exec.name}.`
		}
	});
	const contexts = [...existingContexts(downstream), ...extra === void 0 ? [] : [extra]];
	const appended = [noteText, denialText].filter((text) => text !== void 0).join("\n\n");
	if (downstream.kind === "block" || "value" in downstream || !result.isError) return withContexts(downstream, contexts);
	const baseContent = downstream.content ?? result.content;
	const rewritten = rewriteEscalationTailBlocks(baseContent);
	const content = appended.length === 0 ? rewritten : appendRejectContent(rewritten ?? baseContent, appended);
	if (content === void 0) return withContexts(downstream, contexts);
	return contexts.length === 0 ? {
		kind: "accept",
		content
	} : {
		kind: "accept",
		content,
		additionalContexts: contexts
	};
}
//#endregion
//#region src/runtime.ts
/** 拒绝描述 Remote 服务, 挂在 `ctx.rejectMessage`. */
var RejectMessageRuntime = class extends TypertRemoteService {
	store;
	maxLength;
	/**
	* @param ctx - 所属 Cordis 上下文.
	* @param store - 与 tools/post-execute 共用的暂存.
	* @param maxLength - 描述截断上限.
	*/
	constructor(ctx, store, maxLength) {
		super(ctx, REMOTE_NAMESPACE);
		this.store = store;
		this.maxLength = maxLength;
	}
	/**
	* 记录一次拒绝描述. 空白描述不写入暂存.
	* @param args - 会话, 工具和描述.
	*/
	async record(args) {
		const message = normalizeRejectMessage(args.message, this.maxLength);
		if (message === void 0) {
			this.ctx.logger.info("%s: skip blank reject description tool=%s", PLUGIN_NAME, args.toolName);
			return { recorded: false };
		}
		const key = this.store.key(args.sessionId, args.toolName, args.callId);
		this.store.put(key, message);
		this.ctx.logger.info("%s: stored reject description tool=%s chars=%d", PLUGIN_NAME, args.toolName, message.length);
		return { recorded: true };
	}
};
//#endregion
//#region src/store.ts
/** 按会话和工具调用索引拒绝描述. */
var RejectMessageStore = class {
	records = /* @__PURE__ */ new Map();
	ttlMs;
	/**
	* @param ttlMs - 条目存活时间, 超时后 take 视为未命中.
	*/
	constructor(ttlMs) {
		this.ttlMs = ttlMs;
	}
	/**
	* 生成暂存键. 有 callId 时优先按调用对齐, 否则退回 session + toolName.
	* @param sessionId - 审批所属会话.
	* @param toolName - 被拒绝的工具名.
	* @param callId - 原生审批可选的工具调用 id.
	*/
	key(sessionId, toolName, callId) {
		if (callId !== void 0 && callId.length > 0) return `call:${sessionId}:${callId}`;
		return `tool:${sessionId}:${toolName}`;
	}
	/**
	* 写入或覆盖一条拒绝描述.
	* @param key - {@link key} 的返回值.
	* @param message - 已经规范化的描述.
	* @param now - 可注入的当前时间, 便于测试.
	*/
	put(key, message, now = Date.now()) {
		this.records.set(key, {
			message,
			storedAt: now
		});
	}
	/**
	* 取出并删除一条描述. 缺失或过期返回 `undefined`.
	* @param key - {@link key} 的返回值.
	* @param now - 可注入的当前时间, 便于测试.
	*/
	take(key, now = Date.now()) {
		const record = this.records.get(key);
		if (record === void 0) return void 0;
		this.records.delete(key);
		if (now - record.storedAt > this.ttlMs) return void 0;
		return record.message;
	}
	/**
	* 按工具执行取出描述: 先试 callId 键, 再试 tool 键.
	* @param sessionId - 审批所属会话.
	* @param toolName - 被拒绝的工具名.
	* @param callId - 工具调用 id.
	* @param now - 可注入的当前时间, 便于测试.
	*/
	takeFor(sessionId, toolName, callId, now = Date.now()) {
		if (callId !== void 0 && callId.length > 0) {
			const byCall = this.take(this.key(sessionId, toolName, callId), now);
			if (byCall !== void 0) return byCall;
		}
		return this.take(this.key(sessionId, toolName), now);
	}
};
//#endregion
//#region src/index.ts
const name = PLUGIN_NAME;
const inject = ["typert"];
/** Loader 校验用 schema. */
const Config = z.object({ maxLength: z.number().step(1).min(32).max(MAX_MAX_LENGTH).default(DEFAULT_MAX_LENGTH) });
/**
* 挂上 Remote 和 post-execute 附加.
* @param ctx - Host 插件上下文.
* @param config - Loader 校验后的行配置.
*/
function apply(ctx, config) {
	const maxLength = clampMaxLength(Config(config).maxLength);
	const store = new RejectMessageStore(REJECT_TTL_MS);
	new RejectMessageRuntime(ctx, store, maxLength);
	ctx.logger.info("%s: host loaded, maxLength=%d", PLUGIN_NAME, maxLength);
	ctx.effect(() => {
		const dispose = ctx.typert.register(REJECT_MANIFEST);
		return () => {
			dispose();
		};
	}, `${PLUGIN_NAME}: typert manifest`);
	ctx.on("tools/post-execute", async (exec, result, next) => {
		const downstream = await next();
		const attached = attachRejectMessage(store, exec, result, downstream);
		if (attached !== downstream) ctx.logger.info("%s: adjusted the rejected tool result: tool=%s", PLUGIN_NAME, exec.name);
		return attached;
	});
}
//#endregion
export { Config, apply, inject, name };

//# sourceMappingURL=index.js.map