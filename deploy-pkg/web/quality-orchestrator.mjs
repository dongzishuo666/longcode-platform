/**
 * 质量闸门与外部世界的边界（R1 第一步，2026-10-26）
 *
 * 为什么单独成文件：index.html 是 8500+ 行单体，质量闸门主循环里有 8 种分支状态
 * （applied / rejected / discarded / ineffective / residue / skipped / pending / blocked），
 * 但真正"跟外面打交道"的只有三件事：
 *   ① callStaticCheck  零 token 静态校验（POST /static-check，429/503 退避重试）
 *   ② callReviewApi    小模型审查（POST /review，degraded 由调用方判断）
 *   ③ requestFix       静默打回重生成（走 streamRequest，不渲染到界面）
 * 把它们收进这里，主循环只剩"编排状态"，新会话读 200 行就能建立心智模型，
 * 不用先啃 HTTP 细节与错误分支。
 *
 * 硬约束（可测试性的来源）：
 *   · 本文件不出现 window / document / state / els / 任何页面全局；
 *   · 页面能力全部通过 createQualityGate(deps) 注入，且用【函数形式】传，
 *     保证每次调用取最新值 —— 切供应商 / 改 Key / 换模型立即生效，不用重建实例；
 *   · Node 单测直接 import 本文件，mock 掉 deps 即可，不需要 jsdom。
 *
 * 注意 requestFix 不是纯 I/O：它调 toRequestMessages + buildFixPrompt + streamRequest
 * + extractCodeBlocks，属于"编排"。把这四个也注入，正是为了让它能在测试里被完整验证。
 */

/**
 * @param {object} deps
 * @param {() => object} deps.config            取 state.config（apiBase/apiKey/provider/providerBase/model）
 * @param {() => string} deps.lastBoundary      取 state.quality.lastBoundary（审查的边界上下文）
 * @param {() => string} deps.symbolTableText   符号表文本（审查用）
 * @param {(file?: string) => object} deps.globalSymbolsFor  判重范围（按文件维度）
 * @param {() => boolean} deps.preCheck         审查前置压缩开关。
 *        单一来源仍在 index.html —— applyFixesEx 的 allowLineMode 也受同一个常量控制，
 *        搬进本文件会变成"两处真源"。
 * @param {Function} deps.fetchWithTimeout      页面通用工具（health/probe 也用），不抽
 * @param {Function} deps.apiHeaders            同左
 * @param {Function} deps.streamRequest         页面 SSE 主链路（requestFix 用）
 * @param {Function} deps.toRequestMessages     会话消息 → 请求消息（requestFix 用）
 * @param {Function} deps.extractCodeBlocks     markdown → 代码块（requestFix 用）
 * @param {Function} [deps.sleep]               仅测试用：注入即时 sleep，跳过退避等待
 */
export function createQualityGate(deps) {
    const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));

    /**
     * 零 token 静态校验（本地 Tree-sitter，不消耗任何 token）。
     *
     * 429 / 503 会重试：nginx 对 /api/static-check 是 2r/s burst 6 的限流，
     * 双端并行生成时两个闸门叠加很容易踩线（线上实测踩到过，见 longcode_heavy zone）。
     * 直接返回 null 会让该代码块【绕过全部检查】——语法错误、符号冲突、安全风险
     * 全都静默漏掉，比慢一点严重得多。因此这里按指数退避重试几次，
     * 只有持续失败才放弃（此时调用方按 null 处理，但已重试过）。
     */
    async function callStaticCheck(code, language, file) {
        const cfg = deps.config() || {};
        const url = `${cfg.apiBase}/static-check`;
        const body = JSON.stringify({
            code,
            language,
            // 判重范围按文件维度：同文件符号 + 跨文件导出符号
            globalSymbols: deps.globalSymbolsFor(file),
            compress: false
        });
        const delays = [0, 800, 2500];
        for (let attempt = 0; attempt < delays.length; attempt++) {
            if (delays[attempt]) await sleep(delays[attempt]);
            try {
                // 10s：本地 Tree-sitter 解析正常 <1s；10s 已留足余量。
                // 超时按网络失败走同一路径（退避重试 → 最终 return null），
                // 不会让调用方拿到"半截结果"。
                const resp = await deps.fetchWithTimeout(
                    url, { method: 'POST', headers: deps.apiHeaders(), body }, 10000
                );
                // 限流 / 过载：退避后重试；其它 4xx/5xx 是请求本身有问题，重试无意义
                if (resp.status === 429 || resp.status === 503) continue;
                if (!resp.ok) return null;
                return await resp.json();
            } catch (e) {
                // 网络层异常：同样退避重试
                continue;
            }
        }
        return null;
    }

    /** 小模型审查（消耗 token；仅在闸门开启且未降级时调用，模型走后端默认快模型） */
    async function callReviewApi(code, language) {
        try {
            const cfg = deps.config() || {};
            const resp = await deps.fetchWithTimeout(`${cfg.apiBase}/review`, {
                method: 'POST',
                headers: deps.apiHeaders(),
                body: JSON.stringify({
                    apiKey: cfg.apiKey,
                    provider: cfg.provider,
                    apiBase: cfg.providerBase || '',
                    // 审查刻意用「快模型」：预设供应商下不传 model，让后端按供应商
                    // 给默认快模型（deepseek-flash / gpt-4o-mini …），省时省钱。
                    // 只有自定义供应商 —— 后端猜不出该用哪个 —— 才把用户填的带上。
                    ...(cfg.provider === 'custom'
                        ? { model: cfg.model }
                        : {}),
                    language,
                    symbolTable: deps.symbolTableText(),
                    boundaryContext: deps.lastBoundary(),
                    // 必须显式关闭前置压缩（后端默认已是 false，这里是双保险）：
                    // 一旦为 true，后端会先删注释 / 压空行再送模型，行数随之变化，
                    // 模型返回的行号就成了压缩后坐标；而修复靠行号去切【原始】代码
                    // → 修改落到错误位置。
                    // 同时它也传给 applyFixesEx 的 allowLineMode（单一来源在 index.html），
                    // 开了压缩就禁止按行号修补，只能靠 original 锚点。
                    preCheck: !!(deps.preCheck && deps.preCheck()),
                    code
                })
                // 15s：后端自身 timeoutMs 默认 1500ms，这里留 10 倍余量。
                // 后端超时会返回 200 + degraded，不会挂住；挂住的是网络层。
            }, 15000);
            if (!resp.ok) return null;
            return await resp.json();
        } catch (e) {
            return null;
        }
    }

    /** 构造「打回重生成」提示：只发错误块 + 精确错误定位，不重发全文 */
    function buildFixPrompt(block, errors, language) {
        const loc = (errors || []).slice(0, 8)
            .map(e => `- 第 ${e.line} 行第 ${e.col} 列：${e.message}`)
            .join('\n');
        return [
            `下面这段 ${language} 代码有语法错误，请修复并【完整重新输出该文件的代码】。`,
            '',
            `文件：${block.name || '(未命名)'}`,
            '',
            '语法错误位置：',
            loc || '- （未定位到具体位置，请仔细检查整体结构）',
            '',
            '待修复代码：',
            '```' + (block.lang || language),
            block.code,
            '```',
            '',
            '【要求】',
            '1. 只输出这一个文件的完整代码，放在代码块内，不要解释、不要输出其他文件。',
            '2. 修复全部语法错误（括号 / 分号 / 缩进 / 关键字等），保持原有功能与命名不变。',
            '3. 代码块必须指定语言且完整闭合。'
        ].join('\n');
    }

    /** 静默请求一次修复（不渲染到对话界面） */
    async function requestFix(conv, block, errors, language) {
        // 先过滤报告，再丢掉最后一条（正在修的代码消息）：
        // 过滤后最后一个才是代码消息，直接 slice(-1) 会误删
        const base = deps.toRequestMessages(conv);
        const msgs = [
            ...base.slice(0, -1),
            { role: 'user', content: buildFixPrompt(block, errors, language) }
        ];
        const r = await deps.streamRequest(msgs, { temperature: 0.2 }, { silent: true });
        if (r.errorCode) return null;
        const blocks = deps.extractCodeBlocks(r.content);
        return blocks.length ? blocks[0].code : null;
    }

    return { callStaticCheck, callReviewApi, requestFix, buildFixPrompt };
}
