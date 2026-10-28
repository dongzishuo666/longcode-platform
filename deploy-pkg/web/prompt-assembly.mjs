/**
 * prompt 组装（R2 第二步，2026-10-28 从 index.html 抽出）。
 *
 * 抽的是【纯文本拼接 + 长度预算】，不抽模板常量：
 *   · 安全基线 / 工程基线 / 迁移基线（withSecurityBaseline 等）连同它们的大段中文常量
 *     仍留在 index.html —— 那部分是"文案资产"，搬走只增加跳转成本，不减少逻辑。
 *   · 这里只放"怎么拼、拼多长"：记忆注入顺序、系统提示词截断、上下文挂到最后一条 user。
 *
 * 依赖注入（调用时解析，别在构造时捕获 —— 套件会在 boot 后覆盖 getter 背后的状态）：
 *   getMemories()    → 当前会话召回到的记忆块
 *   getUserPrompt()  → 用户自定义系统提示词
 *   maxSysLen        → 后端硬限留余量后的上限（index.html 单源）
 *   memoryBudget     → 记忆块预算（超出按行截断，L1 在最前 → 先保硬约束）
 */
export function createPromptAssembly(deps) {
    const {
        getMemories = () => '',
        getUserPrompt = () => '',
        maxSysLen = 3900,
        memoryBudget = 2400
    } = deps || {};

    /**
     * 把 extra 追加到 base 后面，总量不超 maxSysLen；
     * base 本身已超限时原样返回（再加声明只会更糟）。
     */
    function fitSystemPrompt(base, extra, note) {
        base = base || '';
        extra = extra || '';
        if (!extra) return base;
        const room = maxSysLen - base.length - 4;
        if (room <= 0) {
            if (typeof console !== 'undefined' && console.warn) {
                console.warn('[systemPrompt] 固定部分已超长，无法附加声明:', base.length);
            }
            return base;
        }
        const tail = '\n' + (note || '（声明过长已截断）');
        const text = extra.length > room
            ? extra.slice(0, Math.max(0, room - tail.length)) + tail
            : extra;
        return base + '\n\n' + text;
    }

    /** 记忆块按行截断到预算内（L1 排在最前，所以先保硬约束） */
    function trimMemories(text) {
        const s = String(text || '');
        if (s.length <= memoryBudget) return s;
        const cut = s.slice(0, memoryBudget);
        const nl = cut.lastIndexOf('\n');
        return (nl > 0 ? cut.slice(0, nl) : cut) + '\n（更多历史经验因长度省略）';
    }

    /** prompt 拼上历史经验（放在最前面的「必须遵守」区）。无记忆时原样返回 */
    function withMemories(prompt) {
        const m = getMemories();
        return m ? m + '\n\n' + prompt : prompt;
    }

    /** smart / 续写用的 systemPrompt：历史经验在前，用户自定义提示词在后 */
    function smartSystemPrompt() {
        const mem = trimMemories(getMemories());
        const base = getUserPrompt() || '';
        if (!mem) return base;
        // 记忆当"固定部分"，用户提示词当"可截断部分"（两个都超时优先保记忆）
        return fitSystemPrompt(mem, base, '（你的系统提示词过长已截断）');
    }

    /** 把项目上下文追加到最后一条 user 消息（返回新数组，不改原数组） */
    function withProjectContext(messages, ctxText) {
        if (!ctxText) return messages;
        const out = messages.slice();
        for (let i = out.length - 1; i >= 0; i--) {
            if (out[i] && out[i].role === 'user') {
                out[i] = { role: 'user', content: out[i].content + '\n\n' + ctxText };
                return out;
            }
        }
        // 没有 user 消息（极少见）→ 单独补一条，保证上下文不丢
        return [...out, { role: 'user', content: ctxText }];
    }

    return { fitSystemPrompt, trimMemories, withMemories, smartSystemPrompt, withProjectContext };
}
