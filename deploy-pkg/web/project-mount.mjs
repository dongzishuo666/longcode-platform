/**
 * 项目挂载（R2 第一步，2026-10-28 从 index.html 抽出）。
 *
 * 职责：把「历史会话的项目资产」挂到当前会话 —— 符号表 / 契约 / 需求 / 改动记录。
 * 不含：资产怎么提取（那是 quality-text.mjs 的 buildProjectPack）、
 *       资产怎么进 prompt（那是页面里的 projectContextFor）。
 *
 * 依赖全部用函数注入（不直接摸 window/state）：
 *   getState()    → 页面 state（读 conversations / workflow / quality）
 *   QT            → quality-text.mjs 的命名空间（buildProjectPack / packSummary）
 *   showStatus(t, kind)
 *   saveAll()     → 落盘
 *   setStage(s)   → 工作流阶段推进
 *   closeMount()  → 关弹窗
 *   mountBtn()    → 工具条那个按钮（可能不存在）
 *
 * 为什么依赖要"调用时解析"而不是构造时捕获：
 * 既有套件会在 boot 之后覆盖 win.showStatus / win.renderMessages 来打桩；
 * 若在工厂创建时捕获引用，桩会静默失效（测试看着绿、实际测的是旧路径）。
 */
export function createProjectMount(deps) {
    const {
        getState, QT, showStatus, saveAll, setStage, closeMount, mountBtn
    } = deps;

    /** 会话 → 项目包的缓存（同一会话内容没变就不重复提取） */
    const packCache = new Map();

    function packOf(conv) {
        if (!conv) return null;
        const stamp = (conv.updatedAt || 0) + '|' + (conv.messages ? conv.messages.length : 0);
        const hit = packCache.get(conv.id);
        if (hit && hit.stamp === stamp) return hit.pack;
        const pack = QT.buildProjectPack(conv);
        packCache.set(conv.id, { stamp, pack });
        return pack;
    }

    function updateMountBtn() {
        const btn = mountBtn && mountBtn();
        if (!btn) return;
        const p = getState().quality.project;
        btn.classList.toggle('off', !p);
        btn.title = p
            ? `已挂载项目：${p.title || '未命名'}（点开可查看/更换）`
            : '把一个历史会话的项目资产（符号表/契约/改动记录）挂到当前会话';
    }

    /** 合并符号表：同文件按名字去重追加，不整体覆盖（避免丢掉当前会话已有的） */
    function mergeSymbolMap(into, from) {
        let added = 0;
        for (const [file, entries] of Object.entries(from || {})) {
            if (!Array.isArray(entries)) continue;
            const cur = Array.isArray(into[file]) ? into[file] : (into[file] = []);
            const seen = new Set(cur.map(e => e && e.name).filter(Boolean));
            for (const e of entries) {
                const n = e && e.name;
                if (!n || seen.has(n)) continue;
                cur.push(e);
                seen.add(n);
                added++;
            }
        }
        return added;
    }

    /**
     * 把某个历史会话的项目挂载到当前会话。
     * 已有内容不覆盖 —— 契约/需求是"当前会话的事实"，挂载只能补空缺。
     */
    function mountProject(convId) {
        const state = getState();
        const conv = state.conversations.find(c => c.id === convId);
        if (!conv) return { ok: false, reason: 'not-found' };
        if (convId === state.currentConvId) {
            showStatus('不能挂载当前会话自身', 'warning');
            return { ok: false, reason: 'self' };
        }
        const pack = packOf(conv);
        const sum = QT.packSummary(pack);
        if (sum.empty) {
            showStatus('该会话还没有可挂载的资产（没有代码块、契约或符号）', 'warning');
            return { ok: false, reason: 'empty' };
        }

        const added = mergeSymbolMap(state.quality.symbols.byFile, pack.symbols.byFile);
        for (const x of (pack.symbols.exports || [])) state.quality.symbols.exports.add(x);

        const skipped = [];
        if (pack.contract && !state.workflow.contract) {
            state.workflow.contract = pack.contract;
            state.workflow.contractText = pack.contractText || '';
            if (state.workflow.stage === 'idle') setStage('contract');
        } else if (pack.contract) skipped.push('契约');
        if (pack.requirement && !state.workflow.requirement) state.workflow.requirement = pack.requirement;
        else if (pack.requirement) skipped.push('需求');
        if (pack.spec && !state.workflow.spec) state.workflow.spec = pack.spec;
        else if (pack.spec) skipped.push('结构化需求');

        state.quality.project = pack;
        saveAll();
        updateMountBtn();
        closeMount();

        showStatus(
            `📦 已挂载「${pack.title || '未命名项目'}」：${sum.files} 个代码块 · ${sum.symbolFiles} 个符号文件 · ${sum.decisions} 条改动记录`
            + (added ? `（新增 ${added} 个符号）` : '')
            + (skipped.length ? `；当前会话已有 ${skipped.join('/')}，未覆盖` : ''),
            'success'
        );
        return { ok: true, added, skipped, pack };
    }

    return {
        packOf,
        updateMountBtn,
        mergeSymbolMap,
        mountProject,
        /** 自检用：缓存条目数（不该无限增长） */
        cacheSize: () => packCache.size
    };
}
