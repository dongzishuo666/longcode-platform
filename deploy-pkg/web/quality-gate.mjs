/**
 * 质量闸门主循环（R1 第三步，2026-10-26）
 *
 * 到这里，原来挤在 index.html 里的 ~210 行"8 分支状态机"被拆成三层：
 *   ① quality-orchestrator.mjs  —— 怎么跟服务端说话（HTTP / 超时 / 重试）
 *   ② quality-state.mjs         —— 闸门运行态怎么读写（降级、指纹、边界）
 *   ③ 本文件                     —— 一个代码块依次经过什么，产生什么统计
 * index.html 只剩"实例化 + 薄包装"，新人读这三个文件就能完整理解闸门。
 *
 * 硬约束：
 *   · 本文件不出现 state / window / document / els；
 *   · 会话对象由参数传入（只写最后一条消息的 content/updatedAt，这是闸门的分内事）；
 *   · 所有页面能力通过 deps 注入，且页面侧用【调用时解析】的箭头包装传入 ——
 *     测试会在 boot 之后覆盖 win.showStatus / win.renderMessages / win.callStaticCheck，
 *     若在这里捕获稳定引用，覆盖就会静默失效（这条踩过一次，别再踩）。
 *
 * 返回的 stat 字段与改造前完全一致（含 discarded / ineffective / skipped 这类
 * 只在命中分支时才出现的字段 —— 刻意保持原样，行为等价优先）。
 */

/**
 * @param {object} deps
 * @param {object} deps.qs                  状态门面（quality-state.mjs 的实例）
 * @param {Function} deps.staticCheck       (code, language, file) => Promise<obj|null>
 * @param {Function} deps.review            (code, language) => Promise<obj|null>
 * @param {Function} deps.requestFix        (conv, block, errors, language) => Promise<string|null>
 * @param {Function} deps.backfillSymbols   (conv) => Promise<void>
 * @param {Function} deps.normalizeLang     语言归一（text/markdown 会被跳过）
 * @param {Function} deps.blockKey          代码块指纹
 * @param {Function} deps.replaceBlockAt    (content, block, code, delta) => string|null
 * @param {Function} deps.mergeSymbols      (symbols, fileName) => void
 * @param {Function} deps.tailLines         (code, n) => string
 * @param {Function} deps.applyVerifiedFixes (code, issues, opts) => {code, applied, rejected, skipped, discarded, ineffective, residue}
 * @param {Function} deps.pushFixLog        (entries, meta) => void
 * @param {Function} deps.showStatus        (text, level) => void
 * @param {Function} deps.saveAll           持久化
 * @param {Function} deps.renderMessages    重绘对话
 * @param {Function} deps.isStopped         用户是否已点停止
 * @param {Function} deps.config            取 state.config（只用 previewFixes）
 * @param {Function} deps.preCheck          前置压缩开关（同时决定 allowLineMode）
 * @param {{maxBlockBytes?:number, maxFixRetry?:number, boundaryLines?:number}} [deps.limits]
 */
export function createQualityGateLoop(deps) {
    const {
        qs, staticCheck, review, requestFix, backfillSymbols,
        normalizeLang, blockKey, replaceBlockAt, mergeSymbols, tailLines,
        applyVerifiedFixes, pushFixLog, showStatus, saveAll, renderMessages,
        isStopped, config, preCheck, limits
    } = deps;
    const maxBlockBytes = (limits && limits.maxBlockBytes) || 60000;
    const maxFixRetry = (limits && limits.maxFixRetry) || 2;
    const boundaryLines = (limits && limits.boundaryLines) || 30;

    /**
     * 对新产出的代码块跑一遍质量闸门。
     * 已处理过的块靠指纹跳过；未闭合的块等续写完成后再校验（避免半截代码误报）。
     * @returns {{checked:number, fixed:number, blocked:number, issues:number, security:number}}
     */
    async function runQualityGate(conv, blocks) {
        const stat = { checked: 0, fixed: 0, blocked: 0, issues: 0, security: 0 };
        if (!qs.isEnabled() || !blocks || !blocks.length) return stat;

        const lastMsg = conv.messages[conv.messages.length - 1];
        if (!lastMsg || typeof lastMsg.content !== 'string') return stat;

        // 首次进入（含刷新页面后）先把历史代码的符号补进符号表，
        // 否则符号表为空会让后续审查误报「符号未定义」
        if (qs.needBackfill()) {
            qs.markBackfilled();
            await backfillSymbols(conv);
        }

        const fresh = blocks.filter(
            b => !b.truncated && !qs.hasProcessed(blockKey(b))
        );
        if (!fresh.length) return stat;

        let content = lastMsg.content;
        let dirty = false;
        // 同一轮闸门里可能修多个块：每次替换都会改变后续块的绝对位置，
        // 用 delta 累计位移，保证后面的块仍按正确偏移写回。
        let delta = 0;

        // 按起点升序处理，delta 才是单调递增的
        const ordered = fresh.slice().sort((a, b) => (a.start || 0) - (b.start || 0));

        for (const b of ordered) {
            if (isStopped()) break;
            qs.touchProcessed(blockKey(b));

            const lang = normalizeLang(b.lang);
            // 纯文本 / markdown 不校验；超大块不送审（避免超时与浪费 token）
            if (!lang || lang === 'text' || lang === 'markdown') continue;
            if ((b.code || '').length > maxBlockBytes) continue;
            stat.checked++;

            // ---------- ① 零 token 静态校验 ----------
            let st = await staticCheck(b.code, lang, b.name);
            if (st && st.supported && st.syntax && st.syntax.errorCount > 0) {
                showStatus(`🔧 发现语法错误，正在修复 ${b.name || '代码块'}...`);
                for (let retry = 0; retry < maxFixRetry; retry++) {
                    const fixedCode = await requestFix(conv, b, st.syntax.errors, lang);
                    if (!fixedCode) break;
                    const re = await staticCheck(fixedCode, lang, b.name);
                    // 只有「修完确实没语法错」才采纳，否则继续重试
                    if (re && re.supported && re.syntax && re.syntax.errorCount === 0) {
                        const md = replaceBlockAt(content, b, fixedCode, delta);
                        if (md) {
                            delta += fixedCode.length - (b.end - b.start);
                            content = md; b.code = fixedCode; dirty = true;
                            st = re; stat.fixed++;
                        }
                        break;
                    }
                }
                if (st.supported && st.syntax && st.syntax.errorCount > 0) {
                    stat.blocked++;
                    showStatus(`⚠️ ${b.name || '代码块'} 仍有语法错误（已保留原样）`, 'warning');
                }
            }
            if (st && st.symbols) mergeSymbols(st.symbols, b.name);

            // ---------- ①b 安全基线检测（只报告，不自动修） ----------
            // 后端 checkSecurity 是零 token 纯模式匹配，高精度优先。
            // 刻意不接入 applyFixes：安全类误改代码的代价比漏报高得多，
            // 交给用户判断（模型侧另有 review.js 的安全清单做上下文相关的判断）。
            //
            // ⚠ st 可能为 null：限流（429）/ 网络抖动时 staticCheck 返回 null。
            //   早期这里漏了 `st &&`，null.security 直接抛 TypeError，异常一路上抛到
            //   没有 try/catch 的 runDualGeneration，变成 unhandled rejection ——
            //   isGenerating 永为真、状态栏永远停在「并行生成中」，表现为"卡住"。
            if (st && Array.isArray(st.security) && st.security.length) {
                stat.security += st.security.length;
                const top = st.security[0];
                const more = st.security.length > 1 ? ` 等 ${st.security.length} 处` : '';
                showStatus(
                    `⚠️ ${b.name || '代码块'} 第 ${top.line} 行：${top.message}${more}（未自动修改）`,
                    'warning'
                );
            }

            // ---------- ② 小模型审查 ----------
            if (qs.isReviewOn()) {
                const rev = await review(b.code, lang);
                if (!rev || rev.error || rev.degraded) {
                    // 连续异常累计到阈值 → 自动降级；justDegraded 保证只提示一次
                    const bs = qs.bumpFailStreak();
                    if (bs.justDegraded) {
                        showStatus('⚠️ 审查连续异常，已降级为纯静态校验', 'warning');
                    }
                } else {
                    qs.resetFailStreak();
                    if (rev.blocked) {
                        // 后端静态层判定语法不过（此时无 issues）
                        stat.blocked++;
                    }
                    const issues = Array.isArray(rev.issues) ? rev.issues : [];
                    stat.issues += issues.length;
                    // 自动修只针对 high；标了 uncertain 的不自动改，避免误伤
                    const high = issues.filter(i => i.severity === 'high' && !i.uncertain);
                    if (high.length) {
                        // 2026-10-25：走"锚定修复" —— 按 issue.original 在附近找真实位置，
                        // 找不到/有歧义就不修（交人工），不再盲信模型给的行号。
                        // 第 3 步：锚定 → 假修复检测 → 规则复检（语法复检在下面）
                        const fix = applyVerifiedFixes(b.code, high, {
                            allowLineMode: !preCheck(),
                        });
                        // 被丢弃的修复也留痕（第 3 步）：否则用户只看到"没改"，
                        // 不知道是"没有把握定位"还是"改完复检没通过"。
                        // 定位失败而跳过的也留痕：用户需要知道"这 3 条为什么没修"
                        if (fix.skipped && fix.skipped.length) {
                            pushFixLog(fix.skipped.map(s => ({
                                issue: s.issue,
                                mode: 'anchor',
                                start: 0, end: 0,
                                before: (s.issue && s.issue.original) || '',
                                after: (s.issue && s.issue.fix_code) || '',
                                reason: s.reason,
                                fromSkip: true,
                            })), { blockKey: blockKey(b), blockName: b.name, state: 'rejected' });
                        }
                        if (fix.rejected && fix.rejected.length) {
                            pushFixLog(fix.rejected, {
                                blockKey: blockKey(b), blockName: b.name, state: 'rejected',
                            });
                        }
                        if (fix.discarded) {
                            stat.discarded++;
                            showStatus(
                                '⚠️ 修正与原代码没有实质差别（可能只是重排/加注释），已丢弃本次修正',
                                'warning'
                            );
                        }
                        if (fix.ineffective.length) {
                            stat.ineffective += fix.ineffective.length;
                            const labels = [...new Set(fix.ineffective.map(x => x.label).filter(Boolean))];
                            showStatus(
                                `⚠️ ${fix.ineffective.length} 条修复没真正解决问题`
                                + (labels.length ? `（复检仍命中：${labels.join('、')}）` : '')
                                + '，已丢弃，请人工处理',
                                'warning'
                            );
                        }
                        // 本条修好了、但别处还有同类问题：只提示，不否弃这条修复
                        if (fix.residue && fix.residue.length) {
                            const labels = [...new Set(fix.residue.map(x => x.label).filter(Boolean))];
                            showStatus(
                                `ℹ️ 本次修复已生效，但代码里别处还有 ${fix.residue.length} 处同类问题`
                                + (labels.length ? `（${labels.join('、')}）` : '')
                                + '，未自动处理',
                                'info'
                            );
                        }
                        if (fix.skipped.length) {
                            // 让用户知道"有几条没自动改"以及为什么，而不是静默少修
                            const why = fix.skipped.map(s => s.reason).join(',');
                            stat.skipped += fix.skipped.length;
                            showStatus(
                                `⚠️ 有 ${fix.skipped.length} 条修复无法安全定位（${why}），已保留原样待人工处理`,
                                'warning'
                            );
                        }
                        if (fix.applied.length) {
                            if (config().previewFixes) {
                                // 预览修复：只登记为「待确认」，不动代码。
                                // 用户在「修复记录」里逐条点「应用」才真正改。
                                pushFixLog(fix.applied, {
                                    blockKey: blockKey(b), blockName: b.name, state: 'pending',
                                });
                                showStatus(
                                    `👁 已暂存 ${fix.applied.length} 条修复，点「修复记录」确认应用`,
                                    'info'
                                );
                            } else {
                                const patched = fix.code;
                                // 修正后必须复校验：修坏了就丢弃这次修正
                                const re = await staticCheck(patched, lang, b.name);
                                if (re && re.supported && re.syntax && re.syntax.errorCount === 0) {
                                    const md = replaceBlockAt(content, b, patched, delta);
                                    if (md) {
                                        delta += patched.length - (b.end - b.start);
                                        content = md; b.code = patched; dirty = true;
                                        stat.fixed += fix.applied.length;
                                        // 留痕：记下 before/after，之后可逐条回滚
                                        pushFixLog(fix.applied, {
                                            blockKey: blockKey(b), blockName: b.name, state: 'applied',
                                        });
                                    }
                                } else {
                                    showStatus('⚠️ 修正后语法校验未通过，已丢弃本次修正（原代码未改动）', 'warning');
                                }
                            }
                        }
                    }
                }
            }

            // ---------- ③ 更新边界上下文 ----------
            qs.setLastBoundary(tailLines(b.code, boundaryLines));
        }

        if (dirty) {
            lastMsg.content = content;
            lastMsg.updatedAt = Date.now();
            saveAll();
            renderMessages();
        }
        return stat;
    }

    return { runQualityGate };
}
