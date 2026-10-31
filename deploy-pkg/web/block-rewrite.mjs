/**
 * 文件级定点重写（2026-10-31，P1-1 第 1 步）
 *
 * 与质量闸门的「打回重生成」的区别：
 *   · requestFix 是**错误驱动**（"这段代码有语法错误，请修复"）→ 模型只做最小改动；
 *   · 这里是**意图驱动**（"按项目资产重写这个文件"）→ 允许结构性调整。
 * 所以提示词必须另写，不能复用 buildFixPrompt —— 否则用户点"重写"，拿到的是一处补丁。
 *
 * 传输链路（静默 streamRequest + 抽取首个代码块）与 fix 一致，可以共用；复检也共用。
 *
 * 铁律：**复检不过就不落盘**。重写会产出全新代码，直接覆盖等于把没校验的代码写进对话。
 */

/** 重写后的静态复检：语法不过一律拒绝（安全类问题只提示，不阻断） */
const MAX_CTX = 4000;

/**
 * 超过这个体积先让用户确认一次（2026-10-31）。
 * 重写不是"小请求"：要把整份文件 + 符号表 + 契约塞进 prompt，
 * 800 行的文件一次可能几千 token。手滑点一下的代价太大。
 */
export const REWRITE_CONFIRM_CHARS = 12000;
export const REWRITE_CONFIRM_LINES = 400;

/** 该不该先确认（纯函数，便于单测） */
export function needsRewriteConfirm(block) {
    const code = String((block && block.code) || '');
    if (!code) return false;
    const lines = code.split('\n').length;
    return code.length >= REWRITE_CONFIRM_CHARS || lines >= REWRITE_CONFIRM_LINES;
}

const clip = (s, n) => String(s || '').slice(0, n);

/**
 * 构造重写提示词（纯函数）。
 * @param {object} p
 * @param {{name?:string, lang?:string, code:string}} p.block 目标块
 * @param {string} [p.symbolTable] 项目符号表摘要
 * @param {string} [p.contract] 契约里与该文件相关的接口
 * @param {string} [p.boundaries] 边界上下文
 * @param {string} [p.intent] 用户这次的意图（如"这个页面要支持分页"）
 */
export function buildRewritePrompt({ block, symbolTable, contract, boundaries, intent }) {
    const b = block || {};
    const lang = b.lang || 'javascript';
    const parts = [
        '请按下面给定的项目资产，**完整重写**这个文件，不要只给修改片段。',
        '',
        `文件：${b.name || '(未命名)'}`,
        ''
    ];
    if (intent) {
        parts.push('本次改写要求：', String(intent).trim(), '');
    }
    if (symbolTable) {
        parts.push('项目现有符号（不得重名、不得另起一套命名）：', clip(symbolTable, MAX_CTX), '');
    }
    if (contract) {
        parts.push('相关接口契约（路径 / 方法 / 字段名必须逐字一致）：', clip(contract, MAX_CTX), '');
    }
    if (boundaries) {
        parts.push('边界与约束：', clip(boundaries, MAX_CTX), '');
    }
    parts.push(
        '当前代码：',
        '```' + lang,
        b.code || '',
        '```',
        '',
        '【要求】',
        '1. 只输出这一个文件的完整代码，放在一个代码块内；不要解释、不要输出其他文件。',
        '2. 保持与符号表、契约一致的命名与签名；契约里已声明的路径 / 字段名不得改动。',
        '3. 代码块必须指定语言且完整闭合。'
    );
    return parts.join('\n');
}

/**
 * 在消息内容里按块偏移替换代码（纯函数）。
 * start/end 覆盖的正是**代码本体**（不含围栏），所以可以直接切片。
 * @returns {string|null} 新内容；定位失败返回 null
 */
export function replaceBlockCode(content, blocks, index, newCode) {
    if (typeof content !== 'string') return null;
    const b = Array.isArray(blocks) ? blocks[index] : null;
    if (!b || typeof b.start !== 'number' || typeof b.end !== 'number') return null;
    if (typeof newCode !== 'string' || !newCode.trim()) return null;
    const code = newCode.replace(/[\r\n]+$/, '');
    if (code === b.code) return content;          // 没有变化就不动原文
    return content.slice(0, b.start) + code + content.slice(b.end);
}

/**
 * 编排器：请求 → 复检 → 替换 → 留痕 → 重渲染。
 * 依赖全部注入，便于单测（不碰 DOM、不碰网络）。
 */
export function createBlockRewrite(deps) {
    const {
        extractCodeBlocks, toRequestMessages, streamRequest, staticCheck,
        getContext, pushFixLog, render, save,
        temperature = 0.2
    } = deps || {};

    /**
     * @param {object} conv 会话（会直接修改 messages[i].content）
     * @param {number} msgIndex 消息下标
     * @param {number} blockIndex 该消息内的块下标
     * @param {{intent?:string}} [opt]
     * @returns {Promise<{ok:boolean, reason?:string, blockName?:string, changed?:boolean, errors?:number}>}
     */
    async function rewriteBlock(conv, msgIndex, blockIndex, opt) {
        const msg = conv && Array.isArray(conv.messages) ? conv.messages[msgIndex] : null;
        if (!msg || typeof msg.content !== 'string') return { ok: false, reason: 'no-message' };

        const blocks = extractCodeBlocks(msg.content);
        const block = blocks[blockIndex];
        if (!block) return { ok: false, reason: 'no-block' };

        const ctx = typeof getContext === 'function' ? (getContext(block) || {}) : {};
        const userPrompt = buildRewritePrompt({
            block,
            symbolTable: ctx.symbolTable,
            contract: ctx.contract,
            boundaries: ctx.boundaries,
            intent: opt && opt.intent
        });

        const base = typeof toRequestMessages === 'function' ? toRequestMessages(conv) : [];
        const msgs = [...base, { role: 'user', content: userPrompt }];

        const r = await streamRequest(msgs, { temperature }, { silent: true });
        if (!r || r.errorCode) return { ok: false, reason: 'request-failed' };

        const out = extractCodeBlocks(r.content || '');
        const code = out.length ? out[0].code : '';
        if (!code.trim()) return { ok: false, reason: 'empty-output' };

        // 复检：语法不过就不落盘（重写产出的是全新代码，不能未经校验覆盖）
        if (typeof staticCheck === 'function') {
            const st = await staticCheck({ code, language: block.lang || 'javascript' });
            const errs = st && st.syntax ? Number(st.syntax.errorCount) || 0 : 0;
            if (st && st.ok && errs > 0) {
                return { ok: false, reason: 'syntax', errors: errs };
            }
            // 静态校验自身不可用（st.ok === false）时放行，但由调用方提示
        }

        // 落盘前的额外复检（可选注入）：目前用来做"接口回归"——
        // 重写把某个契约接口/字段弄丢了，就该提示（不阻断：用户可能就是要删）。
        let warn = '';
        if (typeof deps.verifyRewrite === 'function') {
            try {
                const v = await deps.verifyRewrite({ block, newCode: code, lang: block.lang || 'javascript' });
                if (v && v.text) warn = String(v.text);
            } catch { /* 复检本身失败不该拦住重写 */ }
        }

        // 用【当前】内容重新取块：请求期间消息可能已经变了
        const freshBlocks = extractCodeBlocks(msg.content);
        const next = replaceBlockCode(msg.content, freshBlocks, blockIndex, code);
        if (next === null) return { ok: false, reason: 'stale' };

        const changed = next !== msg.content;
        if (changed) {
            if (typeof pushFixLog === 'function') {
                pushFixLog({
                    kind: 'rewrite',
                    blockName: block.name || '',
                    before: block.code,
                    after: code,
                    msgIndex,
                    at: Date.now()
                });
            }
            msg.content = next;
        }
        if (typeof render === 'function') render();
        if (typeof save === 'function') save();

        return { ok: true, blockName: block.name || '', changed, warn };
    }

    return { rewriteBlock, buildRewritePrompt, replaceBlockCode, needsRewriteConfirm };
}
