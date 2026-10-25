/**
 * 纯函数模块：质量闸门 / 契约驱动的文本与符号操作。
 *
 * 为什么单独一个文件：
 *   这些函数全是行号、偏移、去重逻辑——最容易出 bug 的地方，而早期「零覆盖」
 *   直接导致 replaceCodeInMarkdown 的 indexOf 取首匹配 bug 活了很久
 *   （两份相同代码块，修 B 却写回 A，静默数据损坏）。
 *   抽成 ES Module 后，Node 单测（_deploy/tests/text-ops.test.mjs）直接 import
 *   同一份代码，页面与测试不再各存一份，杜绝「改了这个忘了那个」的漂移。
 *
 * 约束：这里只放【不碰 DOM、不读全局状态】的函数。
 *   需要 state 的（mergeSymbols / symbolTableText / globalSymbolsFor）由页面传对象进来，
 *   模块本身保持纯函数性质，方便单测。
 *
 * 浏览器侧由 index.html 的 <script type="module"> 挂到 window.QT；
 * 模块脚本是 deferred 的，保证在 DOMContentLoaded（init）之前执行完。
 */

/** 语言 → 扩展名 */
export const LANG_EXT = {
    javascript: 'js', js: 'js', jsx: 'jsx', typescript: 'ts', ts: 'ts', tsx: 'tsx',
    python: 'py', py: 'py', java: 'java', go: 'go', rust: 'rs', rs: 'rs',
    cpp: 'cpp', c: 'c', csharp: 'cs', cs: 'cs', php: 'php', ruby: 'rb',
    html: 'html', xml: 'xml', css: 'css', scss: 'scss', less: 'less',
    json: 'json', yaml: 'yml', yml: 'yml', toml: 'toml', ini: 'ini',
    bash: 'sh', sh: 'sh', shell: 'sh', powershell: 'ps1', sql: 'sql',
    markdown: 'md', md: 'md', dockerfile: 'dockerfile', makefile: 'mk',
    kotlin: 'kt', swift: 'swift', vue: 'vue', text: 'txt', txt: 'txt'
};

// 无扩展名的点文件（.gitignore / .editorconfig / .prettierrc / .npmrc / .dockerignore ...）。
// 工业级项目的标配配置文件几乎都是这个形态。早先 looksLikePath 与三处路径捕获正则都
// 要求「必须有 .扩展名」，导致这些文件全被当成普通文本：提取出的名字变成 file-1.txt ——
// zip 里文件名是错的、.gitignore 根本不生效，而且全程不报错。
const DOTFILE_RE = /^\.[A-Za-z0-9][\w\-]*(\.[A-Za-z0-9]+)*$/;

// 路径捕获组（供注释 / 「文件路径:」两种写法复用）：
//   常规「名.扩展名」（.env.production 这类带扩展名的点文件也归这条）
//   或「无扩展名点文件」
const PATH_CAPTURE = '([\\w.\\-/\\\\]+\\.[A-Za-z0-9]+|\\.[A-Za-z0-9][\\w\\-]*)';

/** 判断字符串是否「像一个文件路径」：无空格、无非法字符、有扩展名或为点文件 */
export function looksLikePath(s) {
    const t = String(s == null ? '' : s).trim();
    if (!t || /\s/.test(t)) return false;
    if (/[<>:"|?*]/.test(t)) return false;
    if (/^[\w.\-/\\]+\.[A-Za-z0-9]+$/.test(t)) return true;
    // 无扩展名的点文件：只认 basename（点文件按惯例就在仓库根目录）
    return DOTFILE_RE.test(t);
}

// 路径规整：统一分隔符、去掉前导 / 与 ./ 、防目录穿越
export function sanitizePath(p) {
    // 分段过滤：统一分隔符 + 丢弃空段 / . / ..，彻底防目录穿越
    return String(p)
        .replace(/\\/g, '/')
        .split('/')
        .filter(seg => seg && seg !== '.' && seg !== '..')
        .join('/');
}

/**
 * 从 Markdown 提取代码块并推断文件名。
 * 命名优先级：
 *   ① 块前标题行（### src/foo.ts）
 *   ② 代码首行注释里的路径（兼容「// 文件路径: a/b.ts」与「// a/b.ts」）
 *   ③ 块前 200 字符内的「文件路径: xxx」
 *   ④ 兜底 file-N.ext
 * 另：围栏数为奇数时（长代码被截断的中间态），末尾未闭合的内容也会导出。
 *
 * 每个块带 start/end：代码在 md 中的绝对偏移，写回修复结果必须按偏移切片。
 * 只靠 indexOf(oldCode) 定位时，两份内容相同的代码块（重复的 helper、
 * 前后端同名的 DTO）会命中全文第一个匹配 —— 修的是 B 块却写回 A 块，
 * 属于静默数据损坏。
 */
export function extractCodeBlocks(md) {
    const blocks = [];
    // 类型保护：!md 拦不住 truthy 的非字符串（数字/对象），那时 md.match 会抛
    // TypeError。调用方来源很多（页面 / 测试 / 流式进度），不假设人人都传字符串。
    if (!md || typeof md !== 'string') return blocks;

    // 围栏必须独立成行：开 ```lang + 换行 … 闭 ``` 独占一行
    const re = /^[ \t]*```([A-Za-z0-9_+#.-]*)[ \t]*\r?\n([\s\S]*?)^[ \t]*```[ \t]*$/gm;
    let m;
    let seq = 0;
    while ((m = re.exec(md)) !== null) {
        const raw = m[2];                                   // 原始捕获（含尾部换行）
        const headEnd = m[0].indexOf('\n');                 // 开围栏行的换行
        const codeStart = m.index + headEnd + 1;            // 代码起点
        // 去掉尾部换行；CRLF 场景下闭围栏前还有一个 \r，一起剥掉，
        // 否则导出的文件会带上孤立 \r、行尾不一致
        const code = raw.replace(/[\r\n]+$/, '');
        // 终点只算到「代码本身」结束，不含围栏前的换行：
        // 写回时整体替换 [start,end)，若把换行也算进去会把闭围栏粘到代码后面
        const codeEnd = codeStart + code.length;
        if (!code.trim()) continue;   // 跳过空代码块

        // 只取「最近一个围栏之后」到本块开头的内容，
        // 否则 before 会包含上一个代码块的文件名，导致所有块重名
        let before = md.slice(Math.max(0, m.index - 200), m.index);
        const lastFence = before.lastIndexOf('```');
        if (lastFence !== -1) before = before.slice(lastFence + 3);

        let name = '';

        // ① 块前标题行（先去掉尾部空白，否则 $ 匹配不到行尾）
        const titleM = before.replace(/\s+$/, '').match(/(?:^|\n)#{1,6}[ \t]*([^\n]+?)[ \t]*$/);
        if (titleM && looksLikePath(titleM[1])) name = titleM[1].trim();

        // ② 代码首行注释里的路径
        if (!name) {
            const cm = code.match(new RegExp(
                '^[ \\t]*(?://|#|--|/\\*|<!--)[ \\t]*(?:文件路径|文件|File|file|path)?[ \\t]*[:：]?[ \\t]*' + PATH_CAPTURE, 'm'));
            if (cm && looksLikePath(cm[1])) name = cm[1];
        }

        // ③ 块前的「文件路径: xxx」
        if (!name) {
            const bm = before.match(new RegExp(
                '(?:文件路径|File|file|文件)[ \\t]*[:：][ \\t]*`?' + PATH_CAPTURE + '`?'));
            if (bm && looksLikePath(bm[1])) name = bm[1];
        }

        const lang = (m[1] || '').toLowerCase();
        const ext = LANG_EXT[lang] || lang || 'txt';
        let auto = false;
        if (!name) {
            name = `file-${++seq}.${ext}`;
            auto = true;
        }
        blocks.push({
            name: sanitizePath(name), lang, code, auto, truncated: false,
            start: codeStart, end: codeEnd
        });
    }

    // 未闭合的尾部围栏（截断中间态）：内容一并导出并标记
    const fenceCount = (md.match(/^[ \t]*```/gm) || []).length;
    if (fenceCount % 2 === 1) {
        const fenceRe = /^[ \t]*```([A-Za-z0-9_+#.-]*)[ \t]*\r?$/gm;
        let last = null;
        let fm;
        while ((fm = fenceRe.exec(md)) !== null) last = fm;
        if (last) {
            // 围栏正则的 $ 不含换行，last[0] 停在围栏行末尾，
            // 这里主动跳过行尾的 \n：否则尾块代码会带一个前导空行，
            // 且 [start,end) 与 code 不再严格对应（写回类逻辑的地基）
            let tailStart = last.index + last[0].length;
            if (md[tailStart] === '\n') tailStart += 1;
            const tail = md.slice(tailStart).replace(/[\r\n]+$/, '');
            if (tail.trim()) {
                const lang = (last[1] || '').toLowerCase();
                blocks.push({
                    name: `file-${++seq}.${LANG_EXT[lang] || lang || 'txt'}`,
                    lang, code: tail, auto: true, truncated: true,
                    start: tailStart, end: tailStart + tail.length
                });
            }
        }
    }
    return blocks;
}

/**
 * 把修正后的代码写回 markdown（按原文精确替换，未命中返回 null）。
 * 仅作为无偏移信息时的兜底；正常路径请用 replaceBlockAt。
 */
export function replaceCodeInMarkdown(md, oldCode, newCode) {
    if (typeof md !== 'string' || !oldCode || !newCode || oldCode === newCode) return null;
    const idx = md.indexOf(oldCode);
    if (idx === -1) return null;
    return md.slice(0, idx) + newCode + md.slice(idx + oldCode.length);
}

/**
 * 按「块偏移」把修正后的代码写回 markdown —— 质量闸门专用。
 * 与 replaceCodeInMarkdown 的区别：不靠内容匹配，而是按提取时记录的 start/end 切片，
 * 所以内容完全相同的两个块也只会改到目标块本身。
 *
 * @param {string} md 当前 markdown
 * @param {object} block extractCodeBlocks 产出的块（必须带 start/end）
 * @param {string} newCode 修正后的代码
 * @param {number} delta 本次闸门内此前所有替换累计造成的位移
 * @returns {string|null} 新的 markdown；偏移失效返回 null
 */
export function replaceBlockAt(md, block, newCode, delta = 0) {
    if (typeof md !== 'string' || !block || typeof newCode !== 'string') return null;
    if (typeof block.start !== 'number' || typeof block.end !== 'number') {
        // 没有偏移信息的旧数据：退化成内容匹配（至少还能修，只是不再保证块唯一）
        return newCode ? replaceCodeInMarkdown(md, block.code, newCode) : null;
    }
    const s = block.start + delta;
    const e = block.end + delta;
    if (s < 0 || e > md.length || s >= e) return null;
    if (md.slice(s, e) === newCode) return null;   // 内容没变，不必写回
    return md.slice(0, s) + newCode + md.slice(e);
}

/**
 * 用 fix_code 修正代码：从后往前替换，避免行号偏移。
 * 只接受 high 级：调用方已过滤过一次，这里再兜一道，
 * 防止将来有人传 medium/low 进来把代码改坏。
 */
/**
 * 用 fix_code 修正代码：从后往前替换，避免行号偏移。
 * 只接受 high 级：调用方已过滤过一次，这里再兜一道，
 * 防止将来有人传 medium/low 进来把代码改坏。
 *
 * 重叠区间必须跳过：同一个风险常被模型拆成多条 issue（行区间互相重叠），
 * 若不判断，第二条会 splice 进第一条刚改过的区域，把代码改坏——
 * 而复校验只查语法，改坏后的代码语法仍可能合法，于是坏代码被采纳。
 * 因此这里「宁可不修，不可改坏」：与已应用区间重叠的直接跳过。
 */
export function applyFixes(code, issues, opts = {}) {
    const r = applyFixesEx(code, issues, opts);
    return r.code;
}

/** 锚点比对窗口（行）：模型给的行号允许偏离这么多行，仍按内容找回目标 */
const ANCHOR_WINDOW = 40;

/** 归一化一行用于比对：去首尾空白 + 压缩内部连续空白 */
function normAnchorLine(s) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

/**
 * 在 lines 里找 anchorLines 出现的位置。
 * @returns {{index:number, ambiguous:boolean}|null}
 */
function findAnchor(lines, anchorLines, near, window) {
    const a = anchorLines.map(normAnchorLine);
    const from = Math.max(0, (near == null ? 0 : near) - window);
    const to = Math.min(lines.length - a.length, (near == null ? lines.length : near) + window);
    const hits = [];
    for (let i = from; i <= to; i++) {
        let ok = true;
        for (let k = 0; k < a.length; k++) {
            if (normAnchorLine(lines[i + k]) !== a[k]) { ok = false; break; }
        }
        if (ok) hits.push(i);
    }
    if (!hits.length) return null;
    // 取离「模型声称的行号」最近的一处；两处等距 → 判断为不可靠，宁可跳过
    const dist = (i) => Math.abs(i - (near == null ? hits[0] : near));
    hits.sort((x, y) => dist(x) - dist(y));
    if (hits.length > 1 && dist(hits[0]) === dist(hits[1])) {
        return { index: hits[0], ambiguous: true };
    }
    return { index: hits[0], ambiguous: false };
}

/**
 * 应用修复（带锚点定位 + 逐条审计）。
 *
 * 2026-10-25 改动背景：原实现**只按模型返回的 line_start/line_end 切代码**，
 * 既不校验被切掉的到底是什么，也没有任何兜底。只要模型行号差一行
 * （长文件很常见；审查请求若传 preCheck:true 后端还会先压缩代码，
 * 行号必然漂移），修复就会静默落到别处 —— 语法照样合法，复校验照样通过，
 * 于是"改对了"全靠约定与运气。
 *
 * 现在的策略：
 *   ① 优先按内容锚定：issue.original（被替换的原始行）在 ±ANCHOR_WINDOW 行内查找，
 *      命中就按**实际位置**替换 —— 行号错了也改得对；
 *   ② 锚点找不到 / 有多处等距命中 → **不修**，记入 skipped（交人工），绝不猜；
 *   ③ 没有锚点时才回退行号，且必须 allowLineMode !== false
 *      （调用方在用了 preCheck 压缩时必须传 false，把"约定"变成"机制"）；
 *   ④ 每条修复都留下 applied / skipped 记录，便于界面展示与撤销。
 *
 * @param {string} code 原始代码
 * @param {Array} issues 审查结果
 * @param {{allowLineMode?:boolean, window?:number}} opts
 * @returns {{code:string|null, applied:Array, skipped:Array}}
 */
export function applyFixesEx(code, issues, opts = {}) {
    const allowLineMode = opts.allowLineMode !== false;
    const window = Number.isFinite(opts.window) ? Math.max(1, opts.window) : ANCHOR_WINDOW;
    const lines = String(code || '').split('\n');

    const list = (issues || [])
        .filter(i => i && i.fix_code && i.severity === 'high')
        .slice()
        .sort((a, b) => (b.line_start || 1) - (a.line_start || 1));

    const applied = [];
    const skipped = [];
    // 已应用区间（当前数组坐标系），升序处理时用于重叠判断
    const ranges = [];

    for (const it of list) {
        const fixLines = String(it.fix_code).split('\n');
        const claimed = Math.max(1, Math.trunc(it.line_start || 1)) - 1;

        // ---------- ① 按内容锚定 ----------
        const anchorRaw = String(it.original || '').trim();
        let target = null;    // { start, count }
        let mode = 'anchor';

        if (anchorRaw) {
            const anchorLines = anchorRaw.split('\n');
            const found = findAnchor(lines, anchorLines, claimed, window);
            if (!found) {
                skipped.push({ issue: it, reason: 'anchor-not-found',
                    detail: '在原始代码里找不到 original 片段（可能行号与内容都不符）' });
                continue;
            }
            if (found.ambiguous) {
                skipped.push({ issue: it, reason: 'anchor-ambiguous',
                    detail: 'original 在附近出现多处且无法判断该改哪一处' });
                continue;
            }
            target = { start: found.index, count: anchorLines.length };
        } else {
            // ---------- ③ 无锚点 → 行号模式（受开关控制） ----------
            if (!allowLineMode) {
                skipped.push({ issue: it, reason: 'line-mode-disabled',
                    detail: '本次审查使用了代码压缩（preCheck），行号不可信且缺少 original，拒绝按行号修补' });
                continue;
            }
            const s = claimed;
            const e = Math.min(lines.length, Math.trunc(it.line_end || it.line_start || 1)) - 1;
            if (s > e || s >= lines.length) {
                skipped.push({ issue: it, reason: 'out-of-range',
                    detail: `行号越界（${s + 1}–${e + 1}）` });
                continue;
            }
            target = { start: s, count: e - s + 1 };
            mode = 'line';
        }

        // ---------- 重叠检查（两条修复不能改同一段） ----------
        const ts = target.start, te = target.start + target.count - 1;
        const hit = ranges.find(([as, ae]) => ts <= ae && te >= as);
        if (hit) {
            skipped.push({ issue: it, reason: 'overlap',
                detail: `与已应用的修复区间（${hit[0] + 1}–${hit[1] + 1} 行）重叠` });
            continue;
        }

        // ---------- 应用 ----------
        const before = lines.slice(ts, ts + target.count).join('\n');
        lines.splice(ts, target.count, ...fixLines);
        ranges.push([ts, ts + fixLines.length - 1]);
        applied.push({
            issue: it,
            mode,                       // anchor / line
            start: ts + 1,              // 1-based，便于界面展示
            end: ts + fixLines.length,
            before,
            after: fixLines.join('\n'),
            claimedLine: claimed + 1,   // 模型原本说的行号（可能与实际不同）
        });
    }

    return { code: applied.length ? lines.join('\n') : null, applied, skipped };
}

/* ==========================================================================
 * 修复后复检：这条问题是否真的消失了（2026-10-25 第 3 步）
 *
 * 原来"复校验"只查语法（syntax.errorCount === 0）。但语法合法 ≠ 问题解决：
 * 模型把 `catch (e) {}` 改成 `catch (e) { /* ignore *\/ }` 语法照样过，
 * 空 catch 的问题一点没变，却被当成"修好了"。
 *
 * 这里用**保守的规则复检**兜住这一类：
 *   · 只对"能用正则确定判定"的问题类型下结论（其余一律 checkable=false）；
 *   · 修复后再跑同一条规则，仍命中就判"没解决"，由调用方丢弃该修复；
 *   · 宁可漏判（交人工），也不误判"修好了"。
 * ========================================================================== */

/** 规则表：id → 检测器。每条都能"改好前命中、改好后不命中"才算有效复检。 */
export const FIX_CHECK_RULES = {
    // 空 catch：catch {} / catch (e) {} / catch (e) { /* 注释 */ }
    empty_catch: {
        re: /catch\s*(?:\([^)]*\))?\s*\{\s*(?:\/\*[\s\S]*?\*\/|\/\/[^\n]*)?\s*\}/,
        label: '空 catch（吞异常）',
    },
    // eval / new Function
    eval_usage: {
        re: /(?:^|[^\w$.])eval\s*\(|new\s+Function\s*\(/,
        label: '动态执行代码（eval / new Function）',
    },
    // SQL 字符串拼接
    sql_concat: {
        re: /(?:SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)[^;'"`\n]*(?:['"`]\s*\+\s*[A-Za-z_$]|\$\{)/i,
        label: 'SQL 字符串拼接（未参数化）',
    },
    // innerHTML 直接塞变量
    innerhtml_raw: {
        re: /\.innerHTML\s*=\s*(?![`'"])[A-Za-z_$][\w$.\[\]]*\s*;/,
        label: 'innerHTML 渲染未消毒变量',
    },
    // CORS 通配
    cors_wildcard: {
        re: /(?:Access-Control-Allow-Origin['"]?\s*[,:]\s*['"]\*['"])|(?:origin\s*:\s*['"]\*['"])/i,
        label: 'CORS 允许任意来源',
    },
    // 硬编码密钥
    hardcoded_secret: {
        re: /(?:api[_-]?key|secret|password|passwd|token|access[_-]?key)\s*[:=]\s*['"][A-Za-z0-9_\-]{16,}['"]/i,
        label: '密钥硬编码',
    },
    // 把堆栈返回给客户端
    stack_leak: {
        re: /(?:res|reply|response)\.(?:json|send|end)\s*\([^)]*\b(?:err|error|e)\.stack\b/,
        label: '错误堆栈外泄',
    },
    // target="_blank" 缺 rel=noopener
    rel_noopener: {
        re: /target\s*=\s*['"]_blank['"](?![^>]*\brel\s*=)/,
        label: 'target=_blank 缺 rel=noopener',
    },
};

/**
 * 把一条 issue 映射到可复检的规则。
 * 只认"类型 + 关键词"都明确的情况，判不准就返回 null（不做结论）。
 * @returns {string|null} 规则 id
 */
export function matchIssueRule(issue) {
    if (!issue) return null;
    const type = String(issue.issue_type || '').toLowerCase();
    const text = String(issue.description || '') + ' ' + String(issue.fix_code || '');

    const has = (re) => re.test(text);

    if (has(/eval|new\s*Function|动态执行/i)) return 'eval_usage';
    if (has(/SQL|参数化|拼接查询|injection|注入/i) && has(/SQL|拼接/i)) return 'sql_concat';
    if (has(/innerHTML|XSS|未消毒/i)) return 'innerhtml_raw';
    if (has(/CORS|跨域|origin/i) && has(/通配|\*|任意来源/i)) return 'cors_wildcard';
    if (has(/密钥|secret|api\s*key|硬编码|token/i) && has(/硬编码|明文|hardcod/i)) return 'hardcoded_secret';
    if (has(/堆栈|stack/i) && has(/返回|外泄|leak|暴露/i)) return 'stack_leak';
    if (has(/noopener|rel=/i)) return 'rel_noopener';
    // 空 catch：error_handling 类型 + 提到异常/捕获
    if ((type === 'error_handling' || has(/异常|catch|错误处理/i)) && has(/空|未处理|吞|忽略|catch/i)) {
        return 'empty_catch';
    }
    return null;
}

/**
 * 修复后复检：这条问题在新代码里是否仍在。
 *
 * @param {string} patched 修复后的代码
 * @param {object} issue   原始 issue
 * @returns {{checkable:boolean, resolved:boolean|null, rule:string|null, label?:string}}
 *   checkable=false 表示"这条问题类型没法用规则判定"，调用方应跳过复检（不因此丢弃修复）。
 */
export function verifyFix(patched, issue) {
    const rule = matchIssueRule(issue);
    if (!rule) return { checkable: false, resolved: null, rule: null };
    const def = FIX_CHECK_RULES[rule];
    const still = def.re.test(String(patched == null ? '' : patched));
    return {
        checkable: true,
        resolved: !still,
        rule,
        label: def.label,
    };
}

/**
 * 在文本里按「行」定位一段片段（2026-10-25 第 2 步：撤销/预览应用共用）。
 *
 * 为什么按行而不是 indexOf：代码片段常有缩进差异，且整段 indexOf 对
 * 多行文本的空行/尾随空格很敏感，容易"看起来一样却找不到"。
 * 归一化后逐行比对，位置以【行号】返回，便于 splice。
 *
 * @returns {{start:number, count:number, ambiguous:boolean}|null}
 */
export function findSnippetLines(text, snippet) {
    const sn = String(snippet == null ? '' : snippet);
    if (!sn.trim()) return null;
    const want = sn.split('\n').map(normAnchorLine);
    if (!want.length) return null;
    const lines = String(text == null ? '' : text).split('\n');
    const hits = [];
    for (let i = 0; i + want.length <= lines.length; i++) {
        let ok = true;
        for (let k = 0; k < want.length; k++) {
            if (normAnchorLine(lines[i + k]) !== want[k]) { ok = false; break; }
        }
        if (ok) hits.push(i);
    }
    if (!hits.length) return null;
    return { start: hits[0], count: want.length, ambiguous: hits.length > 1 };
}

/**
 * 把文本里的 from 片段换成 to（用于修复的撤销 / 预览应用）。
 * 找不到或有歧义都不动手 —— 宁可让用户手工改，也不猜错位置。
 *
 * @returns {{ok:boolean, text?:string, reason?:string, hits?:number}}
 */
export function swapSnippet(text, from, to) {
    const src = String(text == null ? '' : text);
    const found = findSnippetLines(src, from);
    if (!found) return { ok: false, reason: 'not-found' };
    if (found.ambiguous) return { ok: false, reason: 'ambiguous' };
    const lines = src.split('\n');
    const repl = String(to == null ? '' : to).split('\n');
    lines.splice(found.start, found.count, ...repl);
    return { ok: true, text: lines.join('\n'), start: found.start + 1, count: repl.length };
}

/* ==========================================================================
 * 项目包（2026-10-25 第 2 步）：把一个会话的资产抽成"可挂载"的纯数据
 *
 * 为什么不是"把代码全带上"：
 *   · 体积：一个会话几十个文件，全带上会直接撑爆 localStorage（我们还只有 2MB 预算）；
 *   · 用途：挂载的目的是让新会话"知道这个项目有什么、按什么契约写"，
 *     真正的代码在需要时按 loc 指向的消息位置去取（第 3 步的按需取全文）。
 * 所以这里只存：符号表 + 契约 + 需求/方案 + 每个文件的摘要与定位 + 修复决定。
 * ========================================================================== */

/** 项目包上限：文件数 / 摘要长度 / 决定条数 */
export const PACK_MAX_FILES = 60;
export const PACK_DIGEST_LEN = 120;
export const PACK_MAX_DECISIONS = 40;

/**
 * 从会话生成项目包。
 *
 * @param {object} conv 会话对象（messages / quality / workflow / title）
 * @returns {object} pack（纯数据，可 JSON 化，体积很小）
 */
export function buildProjectPack(conv) {
    const c = conv || {};
    const msgs = Array.isArray(c.messages) ? c.messages : [];
    const q = c.quality || {};
    const w = c.workflow || {};

    // 代码块：按文件名去重，保留"最后一次出现"（后写的版本更新）
    const byName = new Map();
    let blockSeq = 0;
    for (let mi = 0; mi < msgs.length; mi++) {
        const m = msgs[mi];
        if (!m || m.role !== 'assistant' || typeof m.content !== 'string') continue;
        for (const b of extractCodeBlocks(m.content)) {
            blockSeq++;
            const name = b.name || ('file-' + blockSeq);
            byName.set(name, {
                name,
                lang: b.lang || '',
                bytes: (b.code || '').length,
                // 摘要：首个非空行（限长），给人看/给模型导航用，不是代码
                digest: (b.code || '').split('\n').map(s => s.trim()).filter(Boolean)[0]?.slice(0, PACK_DIGEST_LEN) || '',
                key: hashCode(b.code || '').toString(36),
                // 定位：以后按需取全文用（消息下标 + 在 markdown 里的绝对偏移）
                loc: { msg: mi, start: b.start, end: b.end },
            });
        }
    }
    const files = Array.from(byName.values()).slice(-PACK_MAX_FILES);

    // 修复决定：只留"改了什么类型的问题"，不留 before/after（那是原文，体积大）
    const fixLog = Array.isArray(q.fixLog) ? q.fixLog : [];
    const decisions = fixLog.slice(-PACK_MAX_DECISIONS).map(r => ({
        block: r.blockName || '',
        desc: String(r.desc || '').slice(0, PACK_DIGEST_LEN),
        state: r.state || 'applied',
        at: r.at || 0,
    }));

    return {
        projectId: c.id || '',
        title: c.title || c.titleZh || '',
        at: Date.now(),
        contract: w.contract || null,
        contractText: w.contractText || '',
        requirement: String(w.requirement || '').slice(0, 2000),
        plan: String(w.plan || '').slice(0, 1000),
        spec: w.spec || null,
        symbols: {
            byFile: (q.symbols && q.symbols.byFile) || {},
            exports: Array.from((q.symbols && q.symbols.exports) || []),
        },
        files,
        decisions,
        stats: { ...(q.stats || {}) },
    };
}

/* ==========================================================================
 * 按需取全文（2026-10-25 第 3 步）
 *
 * 第 2 步只挂载了"摘要 + 定位"，模型知道有哪些文件却看不到实现 ——
 * 让它"加个优惠券"，它很可能重新发明一套，而不是复用已有的 order 结构。
 * 这一步把摘要变成真正的代码：**只挑与本次提问相关的文件**，按 loc 去原文取，
 * 带上指纹校验（消息被编辑过就不注入，宁可少给也不给错的）。
 * ========================================================================== */

/** 单文件注入上限 / 本次注入总上限 / 最多挑几个文件 */
export const PCTX_FILE_MAX = 6000;
export const PCTX_TOTAL_MAX = 16000;
export const PCTX_TOP_N = 5;

/** 从提问里抽英文标识符（驼峰/下划线/路径片段），用于匹配文件与符号 */
function queryTokens(query) {
    const q = String(query || '');
    const ids = q.match(/[A-Za-z_$][\w$]{2,}/g) || [];
    const ats = (q.match(/@([\w./-]{2,})/g) || []).map(s => s.slice(1));
    return { ids: [...new Set(ids.map(s => s.toLowerCase()))], explicit: ats };
}

/**
 * 挑出与本次提问相关的文件（纯函数）。
 * @param {object} pack 项目包
 * @param {string} query 用户这次说的话
 * @returns {Array<{file:object, score:number, why:string[]}>} 已按相关度降序、最多 PCTX_TOP_N 个
 */
export function pickProjectFiles(pack, query, opts = {}) {
    const p = pack || {};
    const files = Array.isArray(p.files) ? p.files : [];
    if (!files.length) return [];
    const topN = Number.isFinite(opts.topN) ? opts.topN : PCTX_TOP_N;
    const { ids, explicit } = queryTokens(query);
    const qLower = String(query || '').toLowerCase();
    const decisions = Array.isArray(p.decisions) ? p.decisions : [];

    const scored = files.map(f => {
        const why = [];
        let score = 0;
        const name = String(f.name || '').toLowerCase();
        const base = name.split('/').pop() || name;
        const digest = String(f.digest || '').toLowerCase();

        // 显式 @文件名：最高优先
        const hitExplicit = explicit.some(a => {
            const al = a.toLowerCase();
            return name === al || base === al || name.endsWith('/' + al) || name.includes(al);
        });
        if (hitExplicit) { score += 100; why.push('显式指定'); }

        // 提问里直接点了文件名
        if (base && qLower.includes(base)) { score += 50; why.push('提到文件名'); }

        // 标识符命中：文件名 > 符号 > 摘要
        const syms = (p.symbols && p.symbols.byFile && p.symbols.byFile[f.name]) || [];
        const symNames = syms.map(s => String((s && s.name) || '').toLowerCase()).filter(Boolean);
        for (const id of ids) {
            if (name.includes(id)) { score += 30; why.push('文件名含 ' + id); }
            else if (symNames.some(s => s.includes(id))) { score += 20; why.push('符号含 ' + id); }
            else if (digest.includes(id)) { score += 12; why.push('摘要含 ' + id); }
        }

        // 最近改过 → 只作为"已命中文件"的加权，不能凭空把文件拉进来。
        // 否则任何一句无关的话都会把上次改过的文件带上（实测：问"今天天气"也注入 295 字符）。
        const touched = decisions.some(d => d && d.block === f.name);
        if (touched && score > 0) { score += 5; why.push('最近改过'); }

        return { file: f, score, why };
    });

    return scored
        .filter(x => x.score > 0)
        .sort((a, b) => b.score - a.score || (b.file.bytes || 0) - (a.file.bytes || 0))
        .slice(0, Math.max(1, topN));
}

/**
 * 按 loc 从原始会话里取回代码全文，并校验指纹。
 * 消息被编辑/删除后位置会漂移 —— 指纹不符就不给（避免把错误内容喂给模型）。
 *
 * @returns {{ok:true, code:string} | {ok:false, reason:string}}
 */
export function resolveFileContent(sourceConv, file) {
    const loc = file && file.loc;
    if (!loc) return { ok: false, reason: 'no-loc' };
    const msgs = (sourceConv && Array.isArray(sourceConv.messages)) ? sourceConv.messages : [];
    const m = msgs[loc.msg];
    if (!m || typeof m.content !== 'string') return { ok: false, reason: 'msg-missing' };
    const start = Math.max(0, Math.trunc(loc.start || 0));
    const end = Math.min(m.content.length, Math.trunc(loc.end || 0));
    if (!(end > start)) return { ok: false, reason: 'bad-range' };
    const code = m.content.slice(start, end);
    if (file.key && hashCode(code).toString(36) !== file.key) {
        return { ok: false, reason: 'hash-mismatch' };
    }
    return { ok: true, code };
}

/* ---------- 跨文件引用展开（2026-10-25 第 3 步补强） ----------
 * 只按提问挑文件有个硬伤：A 调用 B 时，模型只看到调用方、看不到被调方，
 * 于是它要么凭空假设 B 的行为，要么另写一个。这里把"被引用且在本项目里"的文件补上。
 * 只展开一层、最多 PCTX_REF_MAX 个 —— 避免一个入口文件把整个项目拖进来。
 */

/** 最多补几个被引用文件 */
export const PCTX_REF_MAX = 3;

const JS_EXTS = ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.vue', '.svelte'];
const OTHER_EXTS = ['.py', '.go', '.java', '.rs', '.php', '.rb', '.cs', '.kt', '.sql'];

/** 从代码里抽 import/require/include 的目标字符串 */
export function parseImports(code) {
    const s = String(code || '');
    const out = new Set();
    // import x from './a' / import './a' / import * as x from "./a"
    for (const m of s.matchAll(/\bimport\s+(?:[^'"`;]*?\s+from\s+)?['"]([^'"]+)['"]/g)) out.add(m[1]);
    // export ... from './a'
    for (const m of s.matchAll(/\bexport\s+[^'"`;]*?\s+from\s+['"]([^'"]+)['"]/g)) out.add(m[1]);
    // require('./a')
    for (const m of s.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) out.add(m[1]);
    // 动态 import('./a')
    for (const m of s.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) out.add(m[1]);
    // Python: from app.order import X  /  import app.order
    for (const m of s.matchAll(/^\s*from\s+([A-Za-z_][\w.]*)\s+import\b/gm)) out.add(m[1]);
    for (const m of s.matchAll(/^\s*import\s+([A-Za-z_][\w.]*)\s*$/gm)) out.add(m[1]);
    // C/ObjC: #include "a.h"
    for (const m of s.matchAll(/^\s*#include\s+["']([^"']+)["']/gm)) out.add(m[1]);
    return Array.from(out);
}

/** 归一化路径：处理 . / .. / 重复斜杠 */
function normalizePath(p) {
    const parts = [];
    for (const seg of String(p || '').split('/')) {
        if (!seg || seg === '.') continue;
        if (seg === '..') { parts.pop(); continue; }
        parts.push(seg);
    }
    return parts.join('/');
}

function dirOf(name) {
    const s = String(name || '');
    const i = s.lastIndexOf('/');
    return i < 0 ? '' : s.slice(0, i);
}

/**
 * 把一个 import 目标解析到项目包里的文件。
 * 只认"本项目内能对上的"：相对路径优先按路径+扩展名/index 试，
 * 裸包名（react、node:fs、@scope/pkg）一律不算。
 *
 * @returns {object|null} pack 里的 file 对象
 */
export function resolveImportTarget(pack, importerName, spec) {
    const files = (pack && Array.isArray(pack.files)) ? pack.files : [];
    if (!files.length || !spec) return null;
    const raw = String(spec).replace(/[?#].*$/, '').trim();
    if (!raw) return null;
    // 裸包名 / 协议 / 绝对路径（都不是项目内相对引用）
    if (/^(node:|https?:)/i.test(raw)) return null;
    if (!raw.startsWith('.') && !raw.startsWith('/')) {
        // 允许 Python 的点号模块（app.order → app/order）作为候选，但不猜外部包
        const dotted = raw.includes('.') && !raw.includes('/');
        if (!dotted) return null;
    }

    const byName = new Map(files.map(f => [normalizePath(f.name), f]));
    const base = raw.startsWith('.')
        ? normalizePath(dirOf(importerName) + '/' + raw)
        : normalizePath(raw.replace(/\./g, '/'));

    const cands = [base];
    for (const ext of [...JS_EXTS, ...OTHER_EXTS]) cands.push(base + ext);
    for (const ext of [...JS_EXTS, ...OTHER_EXTS]) cands.push(base + '/index' + ext);

    for (const c of cands) {
        const hit = byName.get(c);
        if (hit && hit.name !== importerName) return hit;
    }
    // 兜底：按 basename 唯一匹配（同目录没写扩展名/别名的情况）
    const last = base.split('/').pop();
    if (!last) return null;
    const sameBase = files.filter(f => {
        const b = normalizePath(f.name).split('/').pop() || '';
        return b === last || b.replace(/\.[^.]+$/, '') === last;
    });
    if (sameBase.length === 1 && sameBase[0].name !== importerName) return sameBase[0];
    return null;
}

/**
 * 组装"项目上下文"文本（注入到 systemPrompt 用）。
 *
 * @param {object} sourceConv 项目包来源会话（loc 指向它的 messages）
 * @param {object} pack 项目包
 * @param {string} query 本次提问
 * @returns {{text:string, files:string[], dropped:Array, chars:number}}
 */
export function buildProjectContext(sourceConv, pack, query, opts = {}) {
    const p = pack || {};
    const picked = pickProjectFiles(p, query, opts);
    const fileMax = Number.isFinite(opts.fileMax) ? opts.fileMax : PCTX_FILE_MAX;
    const totalMax = Number.isFinite(opts.totalMax) ? opts.totalMax : PCTX_TOTAL_MAX;

    const attached = [];
    const dropped = [];
    const refMax = Number.isFinite(opts.refMax) ? opts.refMax : PCTX_REF_MAX;

    // ---------- ① 先取"直接命中"的文件，再按 import 补被引用文件 ----------
    const queue = picked.map(x => ({ file: x.file, by: '' }));
    const resolved = new Map();     // name → { code, by }
    let qi = 0;
    let refCount = 0;

    while (qi < queue.length) {
        const item = queue[qi++];
        const name = item.file.name;
        if (resolved.has(name)) continue;

        const r = resolveFileContent(sourceConv, item.file);
        if (!r.ok) { dropped.push({ name, reason: r.reason }); continue; }
        resolved.set(name, { code: r.code, by: item.by });

        // 只在"直接命中"的文件上展开引用（一层，不递归套娃）
        if (item.by) continue;
        for (const spec of parseImports(r.code)) {
            if (refCount >= refMax) break;
            const t = resolveImportTarget(p, name, spec);
            if (!t) continue;
            if (resolved.has(t.name) || queue.some(q => q.file.name === t.name)) continue;
            queue.push({ file: t, by: name });
            refCount++;
        }
    }

    // ---------- ② 按顺序做预算裁剪 ----------
    const blocks = [];
    let used = 0;
    for (const item of queue) {
        const name = item.file.name;
        const hit = resolved.get(name);
        if (!hit) continue;

        let code = hit.code;
        let note = '';
        if (code.length > fileMax) {
            code = code.slice(0, fileMax);
            note = `（本文件已截断到 ${fileMax} 字符）`;
        }
        const room = totalMax - used;
        if (room <= 200) { dropped.push({ name, reason: 'budget' }); continue; }
        if (code.length > room) {
            code = code.slice(0, room);
            note = '（受本次上下文预算限制已截断）';
        }
        used += code.length + name.length + 40;
        attached.push(name);
        blocks.push(
            '--- ' + name + ' ---'
            + (hit.by ? `（被 ${hit.by} 引用）` : '')
            + note + '\n```\n' + code + '\n```'
        );
    }

    // 一个文件都没命中 → 什么都不注入（零成本）。
    // 不要"至少带个项目抬头"：无关提问多出的几百字会稀释指令，也让用户莫名其妙。
    if (!blocks.length) {
        return { text: '', files: [], dropped, chars: 0 };
    }

    const apis = (p.contract && Array.isArray(p.contract.apis)) ? p.contract.apis.length : 0;
    const head = [
        '【已挂载项目：' + (p.title || '未命名') + '】',
        apis
            ? `契约已有 ${apis} 个接口 —— 新增接口必须沿用同一套路径/字段风格，**不要改动已有接口**。`
            : '（该项目没有契约，按已有代码风格继续）',
        '下面这些文件是从原项目里取出的**现有实现**，请在此基础上增量修改，不要重写、不要另起一套命名。',
        '',
    ].join('\n');

    const dec = (p.decisions || []).slice(-6)
        .map(d => '- ' + (d.block || '') + '：' + (d.desc || '') + (d.state === 'reverted' ? '（已回滚）' : ''))
        .join('\n');

    const text = head
        + (blocks.length ? blocks.join('\n\n') : '（本次没有匹配到相关文件）')
        + (dec ? '\n\n之前的改动记录：\n' + dec : '');

    return { text, files: attached, dropped, chars: text.length };
}

/** 项目包的一句话概览（给 UI 列表用） */
export function packSummary(pack) {
    const p = pack || {};
    const files = Array.isArray(p.files) ? p.files.length : 0;
    const sym = p.symbols && p.symbols.byFile ? Object.keys(p.symbols.byFile).length : 0;
    const dec = Array.isArray(p.decisions) ? p.decisions.length : 0;
    return {
        files,
        symbolFiles: sym,
        decisions: dec,
        hasContract: !!(p.contract && Array.isArray(p.contract.apis) ? p.contract.apis.length : p.contract),
        empty: !files && !sym && !dec && !p.contract,
    };
}

/** 轻量哈希（FNV-1a 32bit）：给代码块生成指纹，避免把整段代码塞进 Set */
export function hashCode(s) {
    let h = 0x811c9dc5;
    const str = String(s || '');
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
    }
    return h.toString(36);
}

/**
 * 代码块指纹：避免同一块被重复校验。
 *
 * 位置（start）必须参与指纹：只按「文件名 + 长度 + 前 64 字符」算时，
 * 两份同名且内容完全相同的块（同一路径被重复生成）会算出同一个指纹，
 * 第二块被判成「已处理」直接跳过 —— 它带着同样的语法错误却永远不会被修，
 * 界面上仍是「已校验」提示（漏检）。
 * 内容用哈希而不是前 64 字符：只有开头不同、后面不同的代码也算不同块。
 */
export function blockKey(b) {
    const pos = (typeof b.start === 'number') ? b.start : -1;
    return `${b.name || ''}|${b.lang || ''}|${pos}|${(b.code || '').length}|${hashCode(b.code)}`;
}

/**
 * 合并本段提取的符号进符号表（按文件分桶，按 名字+签名 去重）。
 *
 * 符号表按文件维度组织：不同文件可以有同名私有 helper（各自的 formatDate），
 * 只有「同一文件内重名」和「跨文件导出同名」才算冲突。
 * 早期是全局扁平表，跨文件同名一律误报「可能覆盖已有实现」。
 *
 * @param {object} symbols 符号表对象（页面的 state.quality.symbols）
 * @param {object} extracted 后端 static-check 返回的 symbols
 * @param {string} file 该代码块对应的文件路径（b.name）
 */
export function mergeSymbols(symbols, extracted, file) {
    if (!extracted || !extracted.supported) return;
    const f = file || '(未命名文件)';
    const bucket = symbols.byFile[f]
        || (symbols.byFile[f] = { functions: [], classes: [], variables: [] });
    for (const kind of ['functions', 'classes', 'variables']) {
        const seen = new Set(bucket[kind].map(x => `${x.name}|${x.sig}`));
        for (const item of extracted[kind] || []) {
            const name = (item && item.name) || '';
            const sig = (item && item.signature) || name;
            if (!name) continue;
            const key = `${name}|${sig}`;
            if (seen.has(key)) continue;
            seen.add(key);
            bucket[kind].push({ name, sig, method: !!item.method });
        }
        if (bucket[kind].length > 200) bucket[kind] = bucket[kind].slice(-200);
    }
    // 显式导出符号：跨文件同名才是真冲突，单独收集
    for (const n of extracted.exports || []) symbols.exports.add(n);
    if (symbols.exports.size > 500) {
        symbols.exports = new Set([...symbols.exports].slice(-500));   // 防长会话无限增长
    }
}

/** 符号表 → 审查用文本（按文件分组，控制体积） */
export function symbolTableText(symbols) {
    const parts = [];
    let lines = 0;
    const MAX_LINES = 240;      // 与旧的「每类 80 条」上限保持同一量级
    for (const file of Object.keys(symbols.byFile || {})) {
        if (lines >= MAX_LINES) break;
        const b = symbols.byFile[file];
        const group = [];
        for (const kind of ['functions', 'classes', 'variables']) {
            const tag = kind === 'functions' ? 'fn' : kind === 'classes' ? 'class' : 'var';
            for (const x of (b[kind] || []).slice(-40)) {
                if (lines + group.length >= MAX_LINES) break;
                group.push(`${tag} ${x.sig || x.name}`);
            }
        }
        if (group.length) {
            parts.push(`[${file}]\n${group.join('\n')}`);
            lines += group.length;
        }
    }
    const ex = [...(symbols.exports || [])];
    if (ex.length) {
        parts.push(
            `[导出符号 · 跨文件同名即冲突]\n` +
            ex.slice(-60).map(n => `export ${n}`).join('\n')
        );
    }
    return parts.length ? parts.join('\n\n') : '(暂无)';
}

/**
 * 组装某个文件的「判重符号表」——只含两类名字：
 *   ① 同一文件此前已声明的函数 / 类（同文件重定义才是问题）
 *   ② 所有文件显式导出的符号（跨文件同名会互相覆盖）
 * 其它文件的私有 helper 不在此列 —— 各模块完全可以有同名 formatDate。
 *
 * 注意送给后端的是【名字】而不是签名：后端按 name 比对，
 * 传签名会让重定义判定静默失效（早期就是这样，check 等于没开）。
 * 方法类声明排除：两个类各有 render() 是正当写法。
 * 变量排除：Python 重复赋值 / JS 重声明都是合法行为，噪声远大于收益。
 */
export function globalSymbolsFor(symbols, file) {
    const bucket = (symbols.byFile && symbols.byFile[file]) || {};
    const pick = (kind) => (bucket[kind] || [])
        .filter(x => !x.method)
        .map(x => x.name);
    return {
        functions: pick('functions'),
        classes: pick('classes'),
        variables: [],
        names: [...(symbols.exports || [])]
    };
}

/**
 * 流式生成进度摘要：回答"现在生成到哪儿了"。
 *
 * 流式内容天然不完整 —— 尾部往往还有个没闭合的围栏。extractCodeBlocks 已经把
 * 这种情况标成 truncated 块，所以这里直接复用它的结果，不重新解析一遍：
 *   ① 已闭合块数 = 已完成的文件数
 *   ② truncated 块 = 正在写的文件（含已写行数）
 *
 * ⚠ 调用方必须节流：本函数是 O(当前内容长度)，而流式每秒会来十几个 chunk，
 * 每个 chunk 都调就会把 O(n) 放大成 O(n²)（正是要避免的那类问题）。
 *
 * @param {string} md 当前已生成的完整内容
 * @returns {{files:number, lines:number, current:string, currentLang:string,
 *            currentLines:number, writing:boolean}}
 */
export function streamProgress(md) {
    const text = String(md || '');
    const blocks = extractCodeBlocks(text);
    const done = blocks.filter(b => !b.truncated);
    const writing = blocks.find(b => b.truncated) || null;
    const lines = done.reduce((n, b) => n + (b.code ? b.code.split('\n').length : 0), 0);

    let current = '';
    let currentLang = '';
    let currentLines = 0;
    if (writing) {
        currentLang = writing.lang || '';
        currentLines = writing.code ? writing.code.split('\n').length : 0;
        // truncated 块的 name 是 extractCodeBlocks 给的 file-N.ext（自动名）。
        // 这里补一种最常见的真实路径来源：代码首行注释里写的路径。
        // 刻意只做这一种 —— 完整推断逻辑在 extractCodeBlocks 里，不重复实现。
        const cm = (writing.code || '').match(
            /^[ \t]*(?:\/\/|#|--|\/\*|<!--)[ \t]*(?:文件路径|文件|File|file|path)?[ \t]*[:：]?[ \t]*([\w.\-\\/]+\.[A-Za-z0-9]+)/m
        );
        current = (cm && cm[1]) || writing.name;
    }

    return {
        files: done.length,
        lines: lines + currentLines,
        current, currentLang, currentLines,
        writing: !!writing
    };
}
/**
 * 从契约字段的 desc 里提取枚举值（"取值: a/b/c"、"枚举: x,y"、"values: a,b"）。
 * 提取不到返回 null —— 调用方据此跳过枚举检查，不猜。
 * @param {string} desc
 * @returns {string[]|null}
 */
function enumValuesOf(desc) {
    const m = /(?:取值|枚举|enum|values?)\s*[:：]\s*([^\n,，;；]+)/i.exec(String(desc || ''));
    if (!m) return null;
    const vals = m[1]
        .split(/[\/、,，;；|\s]+/)
        .map(s => s.trim().replace(/^['"`]|['"`]$/g, ''))
        .filter(Boolean);
    return vals.length >= 2 ? vals : null;
}

/**
 * 枚举越界检查：契约 desc 声明了取值，代码却传了别的。
 *
 * 背景（2026-10-16）：sortBy 擅自加了契约外的 createdAt、status 初始值直接传 done。
 * 这类"没定义的枚举值"在接口维度看不出来（路径方法都对），必须逐字段比字面量。
 * 放前端是因为：契约和代码块都在前端，零网络开销；后端 /api/consistency 只收
 * 提取结果、拿不到源码，把整份代码再传一遍是浪费。
 *
 * 判 medium（提示级）而非 high：静态推导有上限，宁可提示不错杀。
 *
 * @param {object} contract 契约对象（common_dto + apis）
 * @param {Array<{code:string, lang:string, name:string}>} blocks 代码块
 * @returns {Array<{severity:string, type:string, position:string, path:string, message:string}>}
 */
export function findEnumViolations(contract, blocks) {
    const out = [];
    if (!contract || !Array.isArray(blocks) || !blocks.length) return out;

    // ① 收集「契约明确声明了枚举」的字段：DTO 字段 + 接口参数
    const enumFields = [];
    for (const cd of (contract.common_dto || [])) {
        for (const f of (cd.fields || [])) {
            const vals = enumValuesOf(f.desc);
            if (vals) enumFields.push({ dto: cd.name, field: f.name, vals });
        }
    }
    for (const a of (contract.apis || [])) {
        for (const p of [...((a.request || {}).query || []), ...((a.request || {}).body || [])]) {
            const vals = enumValuesOf(p && p.desc);
            if (vals && p && p.name) enumFields.push({ dto: '', field: p.name, vals });
        }
    }
    if (!enumFields.length) return out;

    // ② 在代码里找这些字段的字面量赋值：`字段: '值'` / `字段 = '值'`
    const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const b of blocks) {
        const code = (b && b.code) || '';
        if (!code) continue;
        for (const { dto, field, vals } of enumFields) {
            const re = new RegExp(`\\b${esc(field)}\\s*[:=]\\s*['"\`]([^'"\`]+)['"\`]`, 'g');
            let m;
            while ((m = re.exec(code)) !== null) {
                if (m[0] === '') { re.lastIndex++; continue; }
                const v = m[1].trim();
                if (!vals.includes(v)) {
                    const where = dto ? `${dto}.${field}` : field;
                    out.push({
                        severity: 'medium',
                        type: 'enum_out_of_range',
                        position: 'contract',
                        path: where,
                        // value 单列一个字段：渲染和测试都该直接取越界的值，
                        // 而不是从 message 文本里反推（message 里含合法值列表，会误判）
                        value: v,
                        allowed: vals,
                        message: `字段 ${where} 被赋值为 "${v}"，不在契约声明的取值（${vals.join('/')}）内`
                            + `——契约未定义的枚举值不要用，需要时先改契约`
                    });
                }
            }
        }
    }
    return out;
}

/**
 * 闭环完整性检查：从契约自身推导"缺了什么"。
 *
 * 对应 2026-10-16 实测踩的三个坑：
 *   ① 契约漏了删除任务/删除评论 → 数据建了删不掉
 *   ② 契约漏了 logout → 登出后 token 仍有效（只清本地存储不算登出）
 *   ③ 契约没有协作保护 → 项目可被锁成"无管理员"、owner 可被删、用户可移除自己
 *
 * 设计原则：**只提示、不自动改**。所有项都是 severity=low，因为静态推导有上限
 * （日志/审计类资源业务上就是不允许删；有的系统用软删除）。缺什么由用户决定补不补，
 * 平台负责把缺口显式摆到桌面上——默默跳过才是事故的来源。
 *
 * @param {object} contract 契约对象 { apis: [{path, method}] }
 * @returns {Array<{severity:string, type:string, path:string, message:string}>}
 */
export function findClosureGaps(contract) {
    const out = [];
    if (!contract || !Array.isArray(contract.apis)) return out;
    const apis = contract.apis.filter(a => a && typeof a.path === 'string' && a.path.trim());
    if (!apis.length) return out;

    // ① CRUD 完整性：按"去掉路径参数后的路径"聚合成资源，看方法覆盖
    //    /api/tasks（POST 创建）+ /api/tasks/{id}（PUT 更新）→ 资源 /api/tasks
    //    动作类端点（login/logout/upload/export…）不是资源，不参与 CRUD 检查——
    //    否则 /api/auth/login 会被当成"可创建资源"误报缺 DELETE。
    const ACTION_RE = /(login|logout|signin|signout|token|refresh|verify|reset|forgot|confirm|activate|upload|search|export|import)/i;
    const byResource = new Map();
    for (const a of apis) {
        if (ACTION_RE.test(a.path)) continue;
        const res = a.path.split('/').filter(s => s && !/^\{.*\}$/.test(s)).join('/');
        if (!res) continue;
        if (!byResource.has(res)) byResource.set(res, new Set());
        byResource.get(res).add(String(a.method || 'GET').toUpperCase());
    }
    for (const [res, methods] of byResource) {
        const writable = ['POST', 'PUT', 'PATCH'].some(m => methods.has(m));
        if (writable && !methods.has('DELETE')) {
            out.push({
                severity: 'low', type: 'crud_gap', path: res,
                message: `资源 ${res} 可创建/更新，但没有 DELETE 端点 —— 数据建了就删不掉。`
                    + '如业务上确实不允许删除（日志、审计、归档类），可忽略'
            });
        }
    }

    // ② 鉴权闭环：有登录/令牌就必须有登出，且要让 token 失效或轮换
    const hasAuth = apis.some(a => /login|auth|token|session|signin/i.test(a.path));
    const hasLogout = apis.some(a => /logout|signout|sign-out/i.test(a.path));
    if (hasAuth && !hasLogout) {
        out.push({
            severity: 'low', type: 'auth_gap', path: '/api/auth/logout',
            message: '契约有登录/令牌相关端点，但没有 logout —— 登出后 token 仍然有效'
                + '（前端只清本地存储不算登出）。建议补一个 logout 端点，并使 token 失效或轮换'
        });
    }

    // ③ 协作保护：涉及角色/成员体系时，默认规则必须进契约
    //    （语义层面只能按关键词提示，不自动改——改契约是用户的决定）
    const text = JSON.stringify(contract);
    if (/角色|权限|成员|管理员|admin|role|member|permission|协作|团队|team|邀请|invite/i.test(text)) {
        const guarded = /最后一名|最后一个|最后一位|owner|超级管理员|不可降级|不能移除自己|self/i.test(text);
        if (!guarded) {
            out.push({
                severity: 'low', type: 'collab_gap', path: 'roles',
                message: '契约涉及角色/成员体系，但看不到协作保护规则。建议默认包含：'
                    + '最后一名管理员不可降级或移除、owner 不可被移除、用户不能移除自己、'
                    + '删除与改权操作必须校验权限'
            });
        }
    }
    return out;
}

/**
 * 检测契约定义的查询参数在前端代码里是否「有调用入口」。
 *
 * 背景（2026-10-16 实测）：后端接口封装了 status/assigneeId/priority/keyword/
 * sortBy/sortOrder/分页全套参数，前端却写死 pageSize:100 一次拉回、自己分组，
 * 筛选/搜索/排序/分页全闲置 —— 参数写了但 UI 没落地，等于没写。
 *
 * 只做「字段名是否出现在前端代码里」的静态判断，severity=medium（提示级、不自动修）：
 * 出现了 ≠ 正确用了，但**没出现基本等于没用**，列出来让用户确认。
 * 分页参数容忍常见别名（page→current/pageNum、pageSize→size/limit），
 * 否则前端用 current 代替 page 会被误报。
 *
 * @param {object} contract 契约对象 { apis: [{method, path, request:{query:[{name,desc}]}}] }
 * @param {Array<{code:string}>} feBlocks 前端代码块
 * @returns {Array<{severity:string, type:string, position:string, path:string, message:string}>}
 */
export function findUnusedQueryParams(contract, feBlocks) {
    const out = [];
    if (!contract || !Array.isArray(feBlocks) || !feBlocks.length) return out;

    // 收集契约所有 query 参数（含分页），去重保留首个出处
    const params = new Map();   // name -> { api, aliases }
    const ALIASES = {
        page: ['page', 'pagenum', 'pageindex', 'current', 'currentpage', 'offset'],
        pagesize: ['pagesize', 'page_size', 'size', 'limit', 'perpage', 'per_page'],
    };
    const hasAny = (code, name) => {
        const low = String(name).toLowerCase();
        const alts = ALIASES[low] || [name];
        return alts.some((a) => new RegExp(`\\b${a}\\b`, 'i').test(code));
    };
    for (const a of (contract.apis || [])) {
        for (const q of ((a.request || {}).query || [])) {
            if (q && q.name && !params.has(q.name)) {
                params.set(q.name, { api: `${a.method} ${a.path}`, desc: q.desc });
            }
        }
    }
    if (!params.size) return out;

    const code = (feBlocks || []).map((b) => b && b.code || '').join('\n');
    for (const [name, info] of params) {
        if (!hasAny(code, name)) {
            out.push({
                severity: 'medium',
                type: 'unused_query_param',
                position: 'frontend',
                path: info.api,
                message: `契约 ${info.api} 声明了查询参数 "${name}"，但前端代码里没找到它的调用入口`
                    + `——参数写了没用等于没写，建议生成对应的筛选/排序/分页控件`
            });
        }
    }
    return out;
}

/**
 * 检测排序字段（position/sortOrder/rank）是否有真实的写入链路。
 *
 * 背景：看板同列排序是假的 —— 前端拖拽只在本地 sort 一下，position 从不回写。
 * 这是「查询入口有了、写入链路没有」的断头路。
 *
 * 判据刻意保守（关键词匹配，静态推导有上限）：
 *   仅当契约【明确声明了排序字段】，且后端没有 reorder/重排端点、前端没有拖拽/回写
 *   迹象时，才报一条 medium 提示 —— 宁可漏报，不因词面巧合误报。
 *
 * @param {object} contract 契约对象
 * @param {Array<{code:string}>} feBlocks 前端代码块
 * @param {Array<{code:string}>} beBlocks 后端代码块
 * @returns {Array<{severity:string, type:string, position:string, path:string, message:string}>}
 */
export function findSortWriteGap(contract, feBlocks, beBlocks) {
    const text = JSON.stringify(contract || {});
    if (!/position|sortorder|sort_order|rank|orderindex|order_index/i.test(text)) return [];
    const beCode = (beBlocks || []).map((b) => b && b.code || '').join('\n');
    const feCode = (feBlocks || []).map((b) => b && b.code || '').join('\n');

    // 后端有批量重排端点（reorder 路径 / 方法名 / 重排语义），或前端有拖拽回写迹象
    const beReorders = /reorder|re-order|重排|排序事务|batch.*(update|sort)|update.*position/i.test(beCode);
    const feWrites = /drag|drop|拖拽|ondrag|ondrop|onDrop|reorder|update.*position|position.*(put|patch|update)/i.test(feCode);

    if (beReorders || feWrites) return [];
    return [{
        severity: 'medium',
        type: 'sort_write_gap',
        position: 'frontend',
        path: 'position',
        message: '契约声明了排序字段（position/sortOrder/rank），但没看到真实的写入链路：'
            + '后端没有批量重排端点、前端也没有拖拽回写。若做看板/排序，'
            + '拖拽后必须调用重排接口事务性更新 position，不能只在本地 sort 一下假装排序'
    }];
}

/**
 * 状态机闭环检查：契约里声明了状态字段（status/state），但规则没写清楚。
 *
 * 背景（2026-10-16 实测）：状态机 todo→doing→review→done 前端写了纯函数 + 单测，
 * 却允许新建直接 done，且后端是否兜底未知 —— 前后端各写各的，联调必炸。
 *
 * 只做「契约层」的静态提示：能查出「状态字段没声明枚举 / 声明了枚举但没标注初始值
 * 与合法流转」。查不出「代码里有没有真的拦截非法流转」——那是运行期语义，静态正则
 * 既认不全也不可信，必须靠运行测试验证（消息里会点明这个边界）。
 *
 * @param {object} contract 契约对象
 * @returns {Array<{severity:string, type:string, position:string, path:string, message:string}>}
 */
export function findStateMachineGap(contract) {
    const out = [];
    if (!contract) return out;

    const candidates = [];
    for (const cd of (contract.common_dto || [])) {
        for (const f of (cd.fields || [])) {
            if (/^(status|state)$/i.test(f.name)) {
                candidates.push({ where: `${cd.name}.${f.name}`, desc: f.desc });
            }
        }
    }
    if (!candidates.length) return out;

    for (const c of candidates) {
        const desc = String(c.desc || '');
        const hasEnum = enumValuesOf(desc) !== null;
        const hasFlow = /初始|流转|transition|初始状态|创建|状态机/i.test(desc);
        if (!hasEnum) {
            out.push({
                severity: 'medium', type: 'state_machine_gap', position: 'contract', path: c.where,
                message: `状态字段 ${c.where} 没有在契约里声明枚举取值 —— 前后端会各写各的状态集，联调必炸。`
                    + '请在 desc 里写「枚举: a / b / c」'
            });
        } else if (!hasFlow) {
            out.push({
                severity: 'medium', type: 'state_machine_gap', position: 'contract', path: c.where,
                message: `状态字段 ${c.where} 声明了枚举但没有标注初始状态与合法流转 —— 创建时允许什么初始态、`
                    + '哪些流转合法，前后端必须一致。请在 desc 里补「初始: xxx」「流转: a→b / b→c」。'
                    + '（静态检查只能看到契约层；代码层是否真的拦截非法流转，需运行验证）'
            });
        }
    }
    return out;
}

/**
 * 外键落地检查：指向人的外键字段，前端是否用了成员下拉而不是手填 ID。
 *
 * 背景：负责人、分类这类外键应默认校验「必须是项目成员」，选人处用成员列表下拉，
 * 而不是让用户手填 ID（手填易错且无法校验）。
 *
 * 只做「前端代码里有没有下拉控件的迹象」的静态判断，severity=medium：
 * 没找到下拉就提示所有指向人的外键字段。查不出「后端是否真的校验成员存在」。
 *
 * @param {object} contract 契约对象
 * @param {Array<{code:string}>} feBlocks 前端代码块
 * @returns {Array<{severity:string, type:string, position:string, path:string, message:string}>}
 */
export function findForeignKeyGap(contract, feBlocks) {
    const out = [];
    if (!contract || !Array.isArray(feBlocks) || !feBlocks.length) return out;

    const fkFields = [];
    for (const cd of (contract.common_dto || [])) {
        for (const f of (cd.fields || [])) {
            if (/^(assigneeId|ownerId|reviewerId|memberId|creatorId|reporterId|userId|handlerId)$/i.test(f.name)) {
                fkFields.push(`${cd.name}.${f.name}`);
            }
        }
    }
    if (!fkFields.length) return out;

    const feCode = (feBlocks || []).map((b) => b && b.code || '').join('\n');
    // 下拉 / 成员列表控件的迹象：不同框架的写法都容忍
    const hasSelect = /<select\b|el-select|a-select|<Select\b|Select\b|dropdown|成员列表|memberList|userList|人员列表/i.test(feCode);
    if (hasSelect) return out;

    out.push({
        severity: 'medium', type: 'foreign_key_gap', position: 'frontend',
        path: fkFields.join('、'),
        message: `以下字段指向人（${fkFields.join('、')}），但前端代码里没找到成员列表下拉控件 —— 手填 ID 易错且无法校验。`
            + '建议用成员列表下拉选择；后端侧还应校验「该成员存在且属于本项目」（静态检查只能看到前端控件，后端校验需运行验证）'
    });
    return out;
}

/**
 * 依赖闭包检查：代码里 import/require 的本地文件是否真实生成。
 *
 * 背景（2026-10-19 用户实测）：生成物 index.js 挂了根本没生成的 auth/cart 路由，
 * 全层 import 悬空 —— 交的是一个编译不过的壳。而 static-check 只查【单块】语法，
 * 看不出"引用了不存在的文件"这类跨文件问题。
 *
 * 判据：
 *   ① 文件清单 = 各代码块的 name（extractCodeBlocks 从首行路径注释提取）；
 *      没有路径注释的块（自动命名 file-N.ext）不参与——无从判断它该叫什么。
 *   ② 只查【相对导入】（./ ../）与 Python 的 from .mod import；
 *      外部包（react/express）不归我们管。
 *   ③ 解析：导入块所在目录 + 相对路径 → 归一化，再到清单里找
 *      （完整路径 / +代码扩展名 / +/index+扩展名，即目录导入）。
 *   ④ 匹配不上 → 悬空。
 *
 * 判 medium（提示级）而非 high：静态推导有上限 —— 路径别名（@/、~/）、
 * 动态 import()、构建工具的魔法解析都可能让合法导入看起来"悬空"。
 * 宁可提示，不错杀；但**悬空的 import 基本等于交了个跑不起来的壳**，
 * 所以必须显式列出来，不能默默放过。
 *
 * @param {Array<{code:string,name:string}>} feBlocks 前端代码块
 * @param {Array<{code:string,name:string}>} beBlocks 后端代码块
 * @returns {Array<{severity:string, type:string, position:string, path:string, message:string}>}
 */
export function findDanglingImports(feBlocks, beBlocks) {
    const out = [];
    const fe = Array.isArray(feBlocks) ? feBlocks : [];
    const be = Array.isArray(beBlocks) ? beBlocks : [];
    if (!fe.length && !be.length) return out;

    // 代码扩展名：只查能解析成代码文件的导入（图片/样式/字体等静态资源不在清单里，跳过）
    const CODE_EXT = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py', '.vue', '.go', '.java'];
    // 路径别名前缀：这些由构建工具解析，静态判不了，直接跳过
    const ALIAS_RE = /^[@~$]|^[a-zA-Z]:[\\/]/;

    /** 归一化相对路径：去 ./、压缩 //、去尾部 / */
    const norm = (p) => String(p || '')
        .replace(/\\/g, '/')
        .replace(/^\.\//, '')
        .replace(/\/+/g, '/')
        .replace(/\/$/, '');

    // ① 文件清单（两端合并：保守做法，避免把跨端引用误判成悬空）
    const files = new Set();
    for (const b of [...fe, ...be]) {
        if (b && b.name && !/^file-\d+\./.test(b.name)) files.add(norm(b.name));
    }
    if (!files.size) return out;

    /** 路径 P 是否落在清单里（含扩展名补全与目录导入） */
    const exists = (p) => {
        if (!p) return false;
        if (files.has(p)) return true;
        const hasExt = CODE_EXT.some(e => p.endsWith(e));
        if (hasExt) return false;
        for (const e of CODE_EXT) {
            if (files.has(p + e)) return true;
            if (files.has(`${p}/index${e}`)) return true;   // 目录导入：./foo → foo/index.js
        }
        return false;
    };

    const seen = new Set();
    const check = (blocks, side) => {
        for (const b of blocks) {
            if (!b || !b.code || !b.name || /^file-\d+\./.test(b.name)) continue;
            const dir = norm(b.name).split('/').slice(0, -1).join('/');

            // ② 提取导入：ES import / export from / require() / Python from
            const specs = [];
            const importRe = /\b(?:import|export)\b[^'"\n]*?\bfrom\s*['"]([^'"]+)['"]/g;
            const bareRe = /^\s*import\s*['"]([^'"]+)['"]/gm;
            const reqRe = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
            const pyRe = /^\s*from\s+(\.[\w./-]+)\s+import\b/gm;
            let m;
            while ((m = importRe.exec(b.code)) !== null) specs.push(m[1]);
            while ((m = bareRe.exec(b.code)) !== null) specs.push(m[1]);
            while ((m = reqRe.exec(b.code)) !== null) specs.push(m[1]);
            while ((m = pyRe.exec(b.code)) !== null) specs.push(m[1]);

            for (let spec of specs) {
                if (ALIAS_RE.test(spec)) continue;              // 别名跳过
                if (!spec.startsWith('.')) continue;            // 只查相对导入（外部包跳过）
                // Python 风格点号：.models → ./models；.services.order → ./services/order
                // （Python 里点就是路径分隔，不转的话永远匹配不上清单里的 services/order.py。
                //  注意只匹配「点后紧跟字母/下划线」，不能把 './x' 也当成 Python 风格）
                if (/^\.[a-zA-Z_]/.test(spec)) spec = './' + spec.slice(1).replace(/\./g, '/');
                // 解析：导入块目录 + 相对路径
                const parts = (dir ? dir.split('/') : []).concat(norm(spec).split('/'));
                const stack = [];
                for (const seg of parts) {
                    if (seg === '.' || seg === '') continue;
                    if (seg === '..') { stack.pop(); continue; }
                    stack.push(seg);
                }
                const target = stack.join('/');
                if (!target) continue;
                // 带非代码扩展名的导入（图片/样式/字体/数据文件）是静态资源，
                // 不在代码块清单里 —— 不跳过就会把 ./logo.png 误报成悬空
                const ext = (target.match(/\.([a-zA-Z0-9]+)$/) || [null, null])[1];
                if (ext && !CODE_EXT.includes('.' + ext.toLowerCase())) continue;
                if (exists(target)) continue;
                const key = `${b.name}→${spec}`;
                if (seen.has(key)) continue;
                seen.add(key);
                out.push({
                    severity: 'medium',
                    type: 'dangling_import',
                    position: side,
                    path: `${b.name} → ${spec}`,
                    message: `${b.name} 引用了 ${spec}，但生成物里没有这个文件 —— `
                        + '依赖闭包不完整，交上去是一个跑不起来的壳。请补上该文件，或把引用删掉'
                });
                if (out.length >= 10) return;   // 上限：防刷屏，同类问题列几条就够
            }
        }
    };
    check(fe, 'frontend');
    check(be, 'backend');
    return out;
}

/**
 * 会话标题清洗：把模型输出的 markdown 原文变成人话标题。
 *
 * 背景（2026-10-17 用户反馈）：会话列表标题出现「- **分类管理模块**：…」
 * 「#### 功能模块 1. **代码片段**」—— updateConvTitle 直接拿消息前 20 字符
 * 当标题，markdown 标记原样进了侧栏。
 *
 * 清洗顺序有讲究：先拆结构（代码块/图片/链接），再剥行级标记（标题/列表/引用），
 * 最后清行内（粗斜体/删除线）与孤零残留符号。
 *
 * @param {string} text 原始文本
 * @returns {string} 清洗后的标题（可能为空串——调用方需回退）
 */
/**
 * 类型归一化桶：跨语言同义类型归到同一桶，避免把 int/number 判成不一致。
 * 与后端 api-contract.js 的 TYPE_BUCKETS 同思路（前端不引后端模块，保持纯函数自足）。
 */
const TYPE_BUCKETS = [
    [/^(string|str|text|uuid|guid|char|varchar|nvarchar|character|clob|ntext)$/i, 'string'],
    [/^(int|integer|long|bigint|smallint|tinyint|short|number|numeric|float|double|decimal|real|serial|bigserial)$/i, 'number'],
    [/^(bool|boolean|bit)$/i, 'boolean'],
    [/^(date|datetime|timestamp|timestamptz)$/i, 'date'],
    [/^(object|json|map|dict|record)$/i, 'object'],
];

/** 归一化字段类型到桶；认不出返回小写原文（按名字比） */
function normTypeBucket(raw) {
    let t = String(raw == null ? '' : raw).trim();
    if (!t) return '';
    t = t.replace(/\([^)]*\)/g, ' ');                 // 'string (UUID)' → 'string '
    t = t.split(/[\/#,;]|--/)[0];                     // 'int, 自增' → 'int'
    t = t.replace(/[<[][\s\S]*$/, '').trim();         // 'List<User>' → 'List'
    t = t.replace(/\[\]$/, '').trim();
    t = t.replace(/^(optional|nullable)[<\s]+/i, '').trim();
    t = t.replace(/\?$/, '').trim();
    if (!t) return '';
    const low = t.toLowerCase();
    for (const [re, v] of TYPE_BUCKETS) if (re.test(low)) return v;
    if (/^(list|array|set|slice)$/i.test(low)) return 'array';
    return low;
}

/**
 * M2 契约自洽性：同一个 ID 类字段在契约多处声明的类型必须一致。
 *
 * 背景（2026-10-19 用户实测）：契约参数是 uuid、另一处契约是 int，
 * 前后端无论怎么实现都必然有一端对不上 —— 这是【契约自身矛盾】，
 * 在校验"代码 vs 契约"之前就该被抓出来。
 *
 * 范围刻意收窄到 ID 类字段（id / userId / taskId / xxxId）：
 * 不同 DTO 里的同名字段（如两个业务都有 status）类型本就可以不同，
 * 无差别全量比对会误报。ID 是贯穿全链路的同一实体标识，必须一致。
 *
 * 判 high：契约自身矛盾无法通过改代码修复，必须改契约 ——
 * 不拦下来，后面所有"代码 vs 契约"校验都是歪的。
 *
 * @param {object} contract 契约对象
 * @returns {Array<{severity,type,position,path,message}>}
 */
export function findContractSelfConflicts(contract, dm) {
    const out = [];
    if (!contract) return out;
    const decl = dataModelToDeclarations(dm);

    // 收集所有字段声明位置
    const decls = [];
    for (const cd of (contract.common_dto || [])) {
        for (const f of (cd.fields || [])) {
            if (f && f.name) decls.push({ field: f.name, type: f.type, where: `DTO ${cd.name}.${f.name}` });
        }
    }
    for (const a of (contract.apis || [])) {
        const api = `${a.method || ''} ${a.path || ''}`.trim();
        const req = a.request || {};
        for (const p of [...(req.path || []), ...(req.query || [])]) {
            if (p && p.name) decls.push({ field: p.name, type: p.type, where: `${api} 参数` });
        }
        if (Array.isArray(req.body)) {
            for (const p of req.body) {
                if (p && p.name) decls.push({ field: p.name, type: p.type, where: `${api} 请求体` });
            }
        }
    }
    if (!decls.length) return out;

    // ① 用户声明的主键类型 vs 契约 id 字段（dm 基准，2026-10-23 加）。
    //    只查名字恰为 id 的字段（主键），xxxId 外键不适用主键声明，
    //    它们的一致性由下面的跨位置检查管。
    if (decl.pkBucket) {
        for (const d of decls) {
            if (String(d.field).toLowerCase() !== 'id') continue;
            const b = normTypeBucket(d.type);
            if (b && b !== decl.pkBucket) {
                out.push({
                    severity: 'high',
                    type: 'contract_self_conflict',
                    position: 'contract',
                    path: d.field,
                    message: `主键类型与数据模型声明矛盾：${d.where} 把 id 声明为 ${d.type}（${b}），`
                        + `但用户在数据模型里声明主键为 ${decl.pkBucket} —— `
                        + '用户声明是最高优先级，请把契约改成一致的类型再生成'
                        + '（这类矛盾靠 desc 正则看不出来，正是要显式声明主键的原因）'
                });
                if (out.length >= 5) return out;
            }
        }
    }

    // ② 跨位置矛盾（原有逻辑）：同一 ID 类字段多处声明不一致
    const ID_RE = /^(?:[a-z_]+_?)?id$/i;
    const byField = new Map();
    for (const d of decls) {
        if (!ID_RE.test(String(d.field))) continue;
        const key = String(d.field).toLowerCase();
        if (!byField.has(key)) byField.set(key, []);
        byField.get(key).push(d);
    }

    for (const [, list] of byField) {
        if (list.length < 2) continue;
        const withBucket = list.map(d => ({ ...d, bucket: normTypeBucket(d.type) }));
        const base = withBucket[0];
        if (!base.bucket) continue;                    // 认不出不判（宁可漏，不错杀）
        const conflict = withBucket.find(b => b.bucket && b.bucket !== base.bucket);
        if (!conflict) continue;
        out.push({
            severity: 'high',
            type: 'contract_self_conflict',
            position: 'contract',
            path: base.field,
            message: `契约自身矛盾：${base.field} 在「${base.where}」声明为 ${base.type}（${base.bucket}），`
                + `在「${conflict.where}」却声明为 ${conflict.type}（${conflict.bucket}）—— `
                + '同一实体 ID 两种类型，前后端无论怎么实现都有一端对不上，联调必炸。请先修正契约再生成'
        });
        if (out.length >= 5) break;                    // 上限防刷屏
    }
    return out;
}

/**
 * M1 边界阈值：契约 desc 里写死的数字约束，代码里的验证必须照抄。
 *
 * 背景（2026-10-19 用户实测）：契约说 category 上限 32，代码里写 50；
 * 价格/库存/备注长度也自己定 —— 边界不一致，脏数据直接进库。
 *
 * 从 desc 提取约束（不超过 N / 最多 N / N-M / ≤N / 长度 N），
 * 再到代码里找该字段附近的验证字面量（max / maxLength / length </> / .size），
 * 数字不一致 → medium。
 *
 * 判 medium 而非 high：代码里验证的写法千奇百怪（可能用常量、可能用正则、
 * 可能压根没写验证），静态只能抓"明确写了数字且不一致"的情况，
 * 抓不到"该验证却没验证"（那是运行期行为）。
 *
 * @param {object} contract 契约对象
 * @param {Array<{code:string}>} blocks 代码块（前端 + 后端合并）
 * @returns {Array<{severity,type,position,path,message}>}
 */
export function findBoundaryViolations(contract, blocks, dm) {
    const out = [];
    if (!contract || !Array.isArray(blocks) || !blocks.length) return out;

    // ① 约束来源：数据模型声明（权威，2026-10-23 加）+ 契约 desc 提取（补充）。
    //    dm 已声明的同名字段不再从 desc 重复提取——用户声明优先。
    const dmDecl = dataModelToDeclarations(dm);
    const limits = [];   // { field, min?, max?, where }
    const taken = new Set();
    for (const b of dmDecl.boundaries) {
        limits.push({ field: b.field, min: b.min, max: b.max, where: `数据模型声明（${b.entity || '实体'}）` });
        taken.add(b.field.toLowerCase());
    }

    // ② desc 提取（只补 dm 未覆盖的字段）
    const extractFrom = (name, desc, where) => {
        if (!name || taken.has(String(name).toLowerCase())) return;
        const d = String(desc || '');
        if (!d) return;
        let m;
        if ((m = /(?:不超过|最多|至多|上限|最大)\s*(\d+)/i.exec(d))) limits.push({ field: String(name), max: +m[1], where });
        else if ((m = /[≤<>]\s*(\d+)/.exec(d))) limits.push({ field: String(name), max: +m[1], where });
        else if ((m = /(\d+)\s*[-~～]\s*(\d+)/.exec(d))) limits.push({ field: String(name), min: +m[1], max: +m[2], where });
        else if ((m = /长度\s*(?:为|是)?\s*(\d+)/i.exec(d))) limits.push({ field: String(name), max: +m[1], where });
    };
    for (const cd of (contract.common_dto || [])) {
        for (const f of (cd.fields || [])) extractFrom(f.name, f.desc, `契约 DTO ${cd.name}.${f.name}`);
    }
    for (const a of (contract.apis || [])) {
        const api = `${a.method || ''} ${a.path || ''}`.trim();
        const req = a.request || {};
        for (const p of [...(req.path || []), ...(req.query || []), ...(Array.isArray(req.body) ? req.body : [])]) {
            if (p) extractFrom(p.name, p.desc, `契约 ${api} 参数 ${p.name}`);
        }
    }
    if (!limits.length) return out;

    // ③ 在代码里找该字段的验证字面量（max 与 min 分别比对）
    const code = blocks.map(b => (b && b.code) || '').join('\n');
    const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const seen = new Set();
    const report = (l, got, kind) => {
        const key = `${l.field}:${kind}:${got}`;
        if (seen.has(key)) return;
        seen.add(key);
        out.push({
            severity: 'medium',
            type: 'boundary_mismatch',
            position: 'contract',
            path: `${l.where}（${l.field}）`,
            message: `边界阈值不一致：${l.where} 限定 ${l.field} ${kind === 'max' ? '不超过' : '不小于'} ${l[kind]}，`
                + `代码里却是 ${got} —— 边界不一致脏数据会直接进库。请照声明修改`
        });
    };
    for (const l of limits) {
        if (l.max !== undefined) {
            // max: 50 / maxLength = 50 / length < 32 / size <= 50 / MAX_X = 50
            const maxRe = new RegExp(
                `${esc(l.field)}[^\\n]{0,80}?(?:max|maxLength|maxlength|limit|size)\\s*[:=]\\s*(\\d+)`, 'i');
            const m1 = maxRe.exec(code);
            if (m1 && +m1[1] !== l.max) { report(l, +m1[1], 'max'); continue; }
            const lenRe = new RegExp(`${esc(l.field)}[^\\n]{0,80}?\\.length\\s*[<>]=?\\s*(\\d+)`, 'i');
            const m2 = lenRe.exec(code);
            if (m2 && +m2[1] !== l.max) { report(l, +m2[1], 'max'); continue; }
            const constRe = new RegExp(`${esc(l.field)}[^\\n]{0,80}?(?:max|limit|MAX)\\w*\\s*=\\s*(\\d+)`, 'i');
            const m3 = constRe.exec(code);
            if (m3 && +m3[1] !== l.max) { report(l, +m3[1], 'max'); continue; }
        }
        if (l.min !== undefined) {
            // 下限只认显式 >= / ≥（裸 > 多半是真值判断而非边界校验，不认）
            const minRe = new RegExp(`${esc(l.field)}[^\\n]{0,80}?(?:>=|≥)\\s*(\\d+)`, 'i');
            const m = minRe.exec(code);
            if (m && +m[1] !== l.min) report(l, +m[1], 'min');
        }
        if (out.length >= 6) break;
    }
    return out;
}

/**
 * M1 流转边：代码里的状态流转不得超出契约声明。
 *
 * 背景（2026-10-19 用户实测）：契约只声明了 todo→doing→done，
 * 代码里多放了 shipped→refunded、done→refunded 两条边 —— 自造流转。
 *
 * 从 desc 提取声明流转（"流转: a→b / b→c"、"a 到 b"），
 * 再到代码里找显式流转定义（箭头语法 'a' → 'b' / 'a' -> 'b'），
 * 契约外 → medium。
 *
 * 判 medium 而非 high：代码里流转的写法太多（switch、状态表、三元、
 * if-else 赋值），静态只能可靠抓"显式箭头声明"这一类，
 * 抓不到藏在 switch 里的流转。宁可漏报，不错杀。
 *
 * @param {object} contract 契约对象
 * @param {Array<{code:string}>} blocks 代码块
 * @returns {Array<{severity,type,position,path,message}>}
 */
export function findTransitionViolations(contract, blocks, dm) {
    const out = [];
    if (!contract || !Array.isArray(blocks) || !blocks.length) return out;

    // ① 每个契约状态字段的流转声明：数据模型声明优先（2026-10-23 加），desc 兜底。
    //    dm 字段名支持 "Order.status" 全名或 "status" 短名匹配。
    const dmDecl = dataModelToDeclarations(dm);
    const fields = [];   // { where, declared:Set, text }
    for (const cd of (contract.common_dto || [])) {
        for (const f of (cd.fields || [])) {
            if (!/^(status|state)$/i.test(f.name)) continue;
            const full = `${cd.name}.${f.name}`;
            const dmEntry = dmDecl.enumFields.find(e => {
                const short = String(e.field || '').split('.').pop();
                return String(e.field) === full || short === f.name;
            });
            const declared = new Set();
            let text = '';
            if (dmEntry && dmEntry.edges.length) {
                for (const e of dmEntry.edges) declared.add(e.join('→'));
                text = dmEntry.edges.map(e => e.join(' → ')).join('、');
            } else {
                // desc 兜底：拆成单条 a→b / a->b / a到b / a~b
                const flowM = /流转[：:]\s*([^\n；;]+)/i.exec(String(f.desc || ''));
                if (flowM) {
                    for (const seg of flowM[1].split(/[\/、，,]/)) {
                        const em = /^\s*([\w一-龥]+)\s*(?:→|->|~|～|到)\s*([\w一-龥]+)\s*$/.exec(seg.trim());
                        if (em) declared.add(`${em[1].toLowerCase()}→${em[2].toLowerCase()}`);
                    }
                    text = [...declared].map(e => e.replace('→', ' → ')).join('、');
                }
            }
            if (declared.size) fields.push({ where: full, declared, text });
        }
    }
    if (!fields.length) return out;   // 没写清流转 → 不查（交给 findStateMachineGap 提示）

    // ② 在代码里找显式流转定义（箭头语法），逐字段比对
    const code = blocks.map(b => (b && b.code) || '').join('\n');
    const re = /['"`]([\w-]+)['"`]\s*(?:→|->|=>|~|～)\s*['"`]([\w-]+)['"`]/g;
    const seen = new Set();
    let m;
    while ((m = re.exec(code)) !== null) {
        const edge = `${m[1].toLowerCase()}→${m[2].toLowerCase()}`;
        if (seen.has(edge)) continue;
        for (const fld of fields) {
            if (fld.declared.has(edge)) continue;
            // 只报与该字段声明状态【相关】的边（起点或终点在声明集合里）——
            // 否则无关模块里一个 'draft' → 'archived' 也会被误报
            const states = new Set([...fld.declared].flatMap(e => e.split('→')));
            if (!states.has(m[1].toLowerCase()) && !states.has(m[2].toLowerCase())) continue;
            seen.add(edge);
            out.push({
                severity: 'medium',
                type: 'transition_extra',
                position: 'contract',
                path: `${m[1]} → ${m[2]}`,
                message: `代码里存在${fld.where}未声明的状态流转 ${m[1]} → ${m[2]} —— `
                    + `声明的流转只有：${fld.text}。`
                    + '自造流转会让前后端状态机不一致，需要时先改声明/契约'
            });
            break;
        }
        if (out.length >= 5) break;
    }
    return out;
}

/**
 * M5 授权矩阵：每个写操作端点附近是否有鉴权/权限校验迹象。
 *
 * 背景（2026-10-19 用户实测）：发货/退款/查改别人订单没区分本人还是 admin，
 * 权限只落在显式提到的地方，其余动作裸奔。
 *
 * 判据：写操作端点（POST/PUT/PATCH/DELETE，排除 login/logout/search 等动作类）
 * 的路由定义处往后 200 字符内，有无鉴权关键词（requireAuth/jwt/permission/
 * 403/req.user…）。
 *
 * 两条保守设计（不错杀）：
 *   ① 代码里有【全局】鉴权中间件（app.use(auth…)）就整体跳过 ——
 *      全局挂了之后单条路由看不出权限，判了就是误报；
 *   ② 路由定义都找不到就跳过（交给 missing_backend 报"没实现"）。
 *
 * 判 medium：中间件的命名千奇百怪，静态只能抓常见关键词；
 * "挂了中间件但中间件是空壳"这种运行期问题抓不到。
 *
 * @param {object} contract 契约对象
 * @param {Array<{code:string}>} beBlocks 后端代码块
 * @returns {Array<{severity,type,position,path,message}>}
 */
/**
 * M5 授权矩阵：写操作端点附近是否有鉴权/权限校验迹象。
 *
 * 背景（2026-10-19 用户实测）：发货/退款/查改别人订单没区分本人还是 admin，
 * 权限只落在显式提到的地方，其余动作裸奔。
 *
 * 判据：写操作端点（POST/PUT/PATCH/DELETE，排除 login/logout/search 等动作类）
 * 的路由定义处往后 200 字符内，有无鉴权关键词（requireAuth/jwt/permission/
 * 403/req.user…）。
 *
 * 三条保守设计（不错杀）：
 *   ① 代码里有【全局】鉴权中间件（app.use(auth…)）就整体跳过 ——
 *      全局挂了之后单条路由看不出权限，判了就是误报；
 *   ② 路由定义都找不到就跳过（交给 missing_backend 报"没实现"）；
 *   ③ 用户声明了授权矩阵（authz）时，声明的【角色名】也计入鉴权词表 ——
 *      否则自定义角色（如"运营"）的校验判不出来；行级归属开启时，
 *      全后端找不到任何归属校验迹象才报一条（只报一次，不逐接口刷屏）。
 *
 * 判 medium：中间件的命名千奇百怪，静态只能抓常见关键词；
 * "挂了中间件但中间件是空壳"这种运行期问题抓不到。
 *
 * @param {object} contract 契约对象
 * @param {Array<{code:string}>} beBlocks 后端代码块
 * @param {object} [authz] 用户声明的授权矩阵 { roles:[], rowLevel:bool, ownerKey:string }
 * @returns {Array<{severity,type,position,path,message}>}
 */
export function findMissingAuthz(contract, beBlocks, authz) {
    const out = [];
    if (!contract || !Array.isArray(beBlocks) || !beBlocks.length) return out;
    const beCode = beBlocks.map(b => (b && b.code) || '').join('\n');
    if (!beCode.trim()) return out;

    // 全局鉴权中间件 → 判不了单条，整体跳过
    if (/app\s*\.\s*use\s*\(\s*[^)]{0,80}\b(auth|authenticate|isAuthenticated|requireAuth|verifyToken|jwt|passport)\b/i.test(beCode)) {
        return out;
    }

    const WRITE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
    const ACTION_RE = /(login|logout|signin|signout|refresh|search|export|import|upload)/i;
    const BASE_AUTHZ_RE = /requireAuth|requireLogin|isAuthenticated|checkAuth|verifyToken|authMiddleware|\bauth\b|jwt|passport|permission|authorize|checkRole|requireRole|adminOnly|ensureAdmin|isAdmin|403|401|forbidden|unauthorized|req\.user|currentUser/i;
    // 用户声明的角色名并入词表：requireRole('operator') 里的 operator 要算鉴权迹象
    const roles = (authz && Array.isArray(authz.roles) ? authz.roles : [])
        .map(r => String(r || '').trim()).filter(r => r.length >= 2);
    const roleRe = roles.length
        ? new RegExp(roles.map(r => r.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i')
        : null;
    const hasAuthz = (ctx) => BASE_AUTHZ_RE.test(ctx) || (roleRe && roleRe.test(ctx));

    const checked = new Set();
    for (const a of (contract.apis || [])) {
        const method = String(a.method || 'GET').toUpperCase();
        const path = String(a.path || '');
        if (!WRITE.has(method) || !path || ACTION_RE.test(path)) continue;
        const key = `${method} ${path}`;
        if (checked.has(key)) continue;
        checked.add(key);

        // 取路径最后一段找路由定义（/{id} 参数段跳过，用资源名）
        const segs = path.split('/').filter(Boolean);
        const seg = (segs[segs.length - 1] || '').replace(/^\{|\}$/g, '');
        if (!seg) continue;
        const segEsc = seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const routeRe = new RegExp(
            `${method.toLowerCase()}\\s*\\(\\s*['"\`][^'"\`]*${segEsc}[^'"\`]*['"\`]`, 'i'
        );
        const m = routeRe.exec(beCode);
        if (!m) continue;   // 路由都没找到 → missing_backend 的事，不重复报

        const ctx = beCode.slice(m.index, m.index + 200);
        if (!hasAuthz(ctx)) {
            out.push({
                severity: 'medium',
                type: 'missing_authz',
                position: 'backend',
                path: key,
                message: `写操作 ${key} 的路由定义附近看不到鉴权/权限校验 —— `
                    + '权限不能只落在显式提到的接口上，其余动作会裸奔。'
                    + '请确认该接口是否应校验登录态/角色/资源归属（本人还是 admin）'
            });
        }
        if (out.length >= 6) break;
    }

    // 行级归属：用户开了这个开关，全后端却找不到任何归属校验迹象 → 报一条
    // （只报一条：这是全局性缺失，逐接口报会是噪声）
    if (authz && authz.rowLevel && !out.length) {
        const OWNER_RE = /userId\s*===|ownerId\s*===|owner\s*===|req\.user|currentUser|session\.user|403|forbidden|checkOwner|isOwner|belongs/i;
        if (!OWNER_RE.test(beCode)) {
            out.push({
                severity: 'medium',
                type: 'missing_authz',
                position: 'backend',
                path: authz.ownerKey || '行级归属',
                message: `你开启了行级归属规则（${authz.ownerKey ? '归属键 ' + authz.ownerKey : '只能看/改自己的'}），`
                    + '但后端代码里找不到任何归属校验（userId === / ownerId === / req.user / 403…）—— '
                    + '没有行级校验，任何人都能看改别人的数据。请补上归属判断'
            });
        }
    }
    return out;
}

/**
 * 授权矩阵 → prompt 追加段（契约生成 / 双端生成 / 需求分析共用）。
 * @param {object} authz { roles:[], rules:[], rowLevel:bool, ownerKey:string }
 * @returns {string} 无内容返回空串
 */
export function authzPrompt(authz) {
    if (!authz) return '';
    const roles = (Array.isArray(authz.roles) ? authz.roles : [])
        .map(r => String(r || '').trim()).filter(Boolean);
    const rules = (Array.isArray(authz.rules) ? authz.rules : [])
        .map(r => String((r && r.text) || r || '').trim()).filter(Boolean);
    const rowLevel = !!authz.rowLevel;
    if (!roles.length && !rules.length && !rowLevel) return '';

    const L = ['【角色与授权 · 用户显式声明（每个写操作都必须落实对应校验）】'];
    if (roles.length) L.push(`- 角色清单：${roles.join('、')}`);
    if (rules.length) {
        L.push('- 授权规则（逐条落实，漏一条就是越权漏洞）：');
        for (const r of rules) L.push(`  · ${r}`);
    }
    if (rowLevel) {
        L.push(`- 行级归属：启用。用户只能访问${authz.ownerKey ? '归属键为 ' + authz.ownerKey + ' 的' : '自己的'}数据，`
            + '每个读/写操作都要校验资源归属，不能只靠前端藏入口');
    }
    L.push('权限校验必须落在服务端（前端隐藏按钮只是体验，不是安全边界）。');
    return L.join('\n');
}

/**
 * M3 需求覆盖矩阵：需求里提到的硬需求，代码里有没有对应实现。
 *
 * 背景（2026-10-19 用户实测）：防超卖、下单事务回滚、价格快照、行级 403、
 * 回补库存、refresh 轮换全缺，且不标注 —— 难点整段不写，用户到联调才发现。
 *
 * 做法：关键词启发式。需求命中触发词 → 代码必须命中对应实现词，
 * 否则列为"疑似未覆盖"，显式摆到桌面上（不静默跳过）。
 *
 * 诚实边界（写进消息）：这是关键词匹配，**一定会有漏报**
 * （需求说"防止重复下单"而表里没这个词）和误报（换了套技术词）。
 * 所以判 medium、消息明说"请确认是漏写还是需求表述太隐晦"，
 * 不声称"需求 100% 覆盖"。要真覆盖得上，得靠运行测试，不是静态检查。
 *
 * @param {string} requirement 需求原文
 * @param {Array<{code:string}>} feBlocks 前端代码块
 * @param {Array<{code:string}>} beBlocks 后端代码块
 * @returns {Array<{severity,type,position,path,message}>}
 */
const REQ_COVERAGE_PATTERNS = [
    {
        trigger: /防超卖|超卖|库存不足|不能超过库存|避免.*超卖/,
        need: /stock|inventory|quantity|库存|for\s+update|compareAndSwap|\bCAS\b|atomic|transaction|lock/i,
        what: '防超卖（库存校验 + 事务/锁）'
    },
    {
        trigger: /事务|回滚|rollback|要么.*要么|原子性|原子操作/,
        need: /BEGIN|COMMIT|ROLLBACK|transaction|atomic|db\.transaction|start_transaction|withTransaction/i,
        what: '事务（失败整体回滚，不留中间态）'
    },
    {
        // 触发词要容忍"价格要快照""记录下单价格"这类表述（冒烟时抓到：
        // 原来的"价格快照"四字连写匹配不到"价格要快照"）
        trigger: /价格.*快照|快照.*价格|下单时.*价格|当时的价格|价格.*锁定|按.*价格.*结算|记录.*价格/,
        need: /priceSnapshot|snapshot.*price|unitPrice|price_at|priceAt|orderPrice|成交价/i,
        what: '价格快照（下单时固化价格）'
    },
    {
        trigger: /只能看自己的|只能.*自己的|仅.*本人|行级|自己的数据|越权|他人.*订单/,
        need: /req\.user|currentUser|session\.user|userId\s*===|ownerId\s*===|403|forbidden|checkOwner|isOwner/i,
        what: '行级权限（只能访问自己的数据）'
    },
    {
        trigger: /回补|恢复库存|返还.*库存|取消.*恢复|退款.*库存/,
        need: /stock\s*[+-]=|increase|restore|replenish|回补|返还|release.*stock|rollback.*stock/i,
        what: '库存回补（取消/退款时恢复）'
    },
    {
        trigger: /refresh|轮换|刷新.*令牌|令牌.*刷新|自动续期/,
        need: /refreshToken|refresh_token|rotate|rotation|轮换|renew/i,
        what: 'refresh 令牌轮换'
    },
];

export function findRequirementGaps(requirement, feBlocks, beBlocks) {
    const out = [];
    const req = String(requirement || '');
    if (!req.trim()) return out;
    const code = [...(Array.isArray(feBlocks) ? feBlocks : []), ...(Array.isArray(beBlocks) ? beBlocks : [])]
        .map(b => (b && b.code) || '').join('\n');
    if (!code.trim()) return out;

    for (const p of REQ_COVERAGE_PATTERNS) {
        if (!p.trigger.test(req)) continue;
        if (p.need.test(code)) continue;
        out.push({
            severity: 'medium',
            type: 'requirement_gap',
            position: 'contract',
            path: p.what,
            message: `需求提到了「${p.what}」，但生成代码里找不到对应实现 —— `
                + '硬需求被静默跳过。请确认是漏写，还是需求表述太隐晦'
                + '（静态关键词匹配，可能有漏报；真正确认要靠运行测试）'
        });
        // 上限随模式数伸缩：写死一个小数字会【任意丢弃】第 N 个合法缺口
        // （曾经设 5，而模式有 6 个，第 6 条永远报不出来）
        if (out.length >= REQ_COVERAGE_PATTERNS.length) break;
    }
    return out;
}

/**
 * M8 后端能力闭环：契约声明的查询参数，后端是否真实使用。
 *
 * 与改进 3 的 findUnusedQueryParams（查前端）对称 —— 那条查的是"前端有没有
 * 调用入口"，这条查"后端有没有在查询层用它"。两端都接了才算能力闭环。
 *
 * 判 medium：参数名出现在代码里 ≠ 真的用进了查询（可能 destructure 出来就扔了），
 * 与前端侧同一局限，消息里如实说明。
 *
 * @param {object} contract 契约对象
 * @param {Array<{code:string}>} beBlocks 后端代码块
 * @returns {Array<{severity,type,position,path,message}>}
 */
export function findBackendCapabilityGaps(contract, beBlocks) {
    const out = [];
    if (!contract || !Array.isArray(beBlocks) || !beBlocks.length) return out;
    const beCode = beBlocks.map(b => (b && b.code) || '').join('\n');
    if (!beCode.trim()) return out;

    const params = new Map();
    for (const a of (contract.apis || [])) {
        for (const q of ((a.request || {}).query || [])) {
            if (q && q.name && !params.has(q.name)) params.set(q.name, `${a.method} ${a.path}`);
        }
    }
    if (!params.size) return out;

    // 分页参数别名容错（与前端侧保持一致，否则后端用 limit 代替 pageSize 会误报）
    const ALIASES = {
        page: ['page', 'pagenum', 'pageindex', 'current', 'offset'],
        pagesize: ['pagesize', 'page_size', 'size', 'limit', 'perpage', 'per_page'],
    };
    const seen = new Set();
    for (const [name, api] of params) {
        const alts = ALIASES[name.toLowerCase()] || [name];
        const used = alts.some(a => new RegExp(`\\b${a}\\b`, 'i').test(beCode));
        if (used) continue;
        if (seen.has(name)) continue;
        seen.add(name);
        out.push({
            severity: 'medium',
            type: 'backend_capability_gap',
            position: 'backend',
            path: api,
            message: `契约 ${api} 声明了查询参数 "${name}"，但后端代码里没用到它 —— `
                + '查询参数必须在查询层真实生效（WHERE / ORDER BY / LIMIT），'
                + '不是全量拉回再内存过滤。请补上实现，或从契约里删掉该参数'
        });
        if (out.length >= 6) break;
    }
    return out;
}

/**
 * M6 弱化版：注释把责任甩给了不存在的模块。
 *
 * 背景（2026-10-19 用户实测）：sortBy 白名单"由仓储层兜底"、删商品清购物车
 * "由 service 处理"—— 结果那两个模块根本没生成，安全/一致性靠一句注释担保。
 *
 * 完整的 M6（"下层真的实现了承诺吗"）需要跨文件语义追踪，静态正则可靠不了，
 * 这是**刻意收窄的弱化版**：只查【注释里明确声明了责任归属、且指向一个
 * 文件样引用、而该文件不在生成物里】的情况。
 *
 * 两条防误报设计：
 *   ① 只认【文件样】引用（带代码扩展名或 ./ ../ 路径）—— 中文角色名
 *      （"仓储层""service 层"）是架构角色不是文件名，判不了，跳过；
 *   ② 必须有责任声明动词（由/交由/委托/交给/依赖/参见/见/handled by/see），
 *      单纯提到一个文件名（"参考 utils.js 的写法"）不报。
 *
 * 判 medium：注释引用外部/计划中的模块也可能是正常文档行为，
 * 报出来是让人确认，不是断定是漏洞。
 *
 * @param {Array<{code:string,name:string}>} feBlocks 前端代码块
 * @param {Array<{code:string,name:string}>} beBlocks 后端代码块
 * @returns {Array<{severity,type,position,path,message}>}
 */
export function findUnsourcedClaims(feBlocks, beBlocks) {
    const out = [];
    const all = [
        ...(Array.isArray(feBlocks) ? feBlocks : []).map(b => ({ b, side: 'frontend' })),
        ...(Array.isArray(beBlocks) ? beBlocks : []).map(b => ({ b, side: 'backend' }))
    ];
    if (!all.length) return out;

    const CODE_EXT = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py', '.vue', '.go', '.java'];
    const norm = (p) => String(p || '')
        .replace(/\\/g, '/')
        .replace(/^\.\//, '')
        .replace(/^\.(?=[a-zA-Z_])/, '')      // Python 点号风格
        .replace(/\/+/g, '/')
        .replace(/\/$/, '');

    // 文件清单（与 findDanglingImports 同源）
    const files = new Set();
    for (const { b } of all) {
        if (b && b.name && !/^file-\d+\./.test(b.name)) files.add(norm(b.name));
    }
    if (!files.size) return out;

    // 注释里的路径是【非正式】的：可能相对项目根（./services/x.js → src/services/x.js），
    // 也可能相对文件所在目录。所以三种解释都试，任一命中就算存在：
    //   ① 原样（项目根相对）② 相对注释所在目录解析 ③ basename 对上任意文件
    const exists = (p, fromDir) => {
        const n = norm(p);
        if (!n) return true;
        if (files.has(n)) return true;
        // 相对注释所在目录解析
        if (fromDir) {
            const parts = (fromDir ? fromDir.split('/') : []).concat(n.split('/'));
            const stack = [];
            for (const seg of parts) {
                if (seg === '.' || seg === '') continue;
                if (seg === '..') { stack.pop(); continue; }
                stack.push(seg);
            }
            if (files.has(stack.join('/'))) return true;
        }
        // basename 对上任意文件（注释里常只写文件名）
        const base = n.split('/').pop();
        for (const f of files) {
            if (f.split('/').pop() === base) return true;
            if (CODE_EXT.some(e => f.endsWith(e)) && f.split('/').pop() === base) return true;
        }
        if (CODE_EXT.some(e => n.endsWith(e))) return false;   // 带扩展名就对文件名
        return CODE_EXT.some(e => files.has(n + e) || files.has(`${n}/index${e}`));
    };

    // 文件样引用：带代码扩展名，或以 ./ ../ 开头。
    // 扩展名后必须跟非标识符字符 —— 否则 js 会匹配到 json 的前缀，
    // 把 package.json 误当成 package.js（第一版就栽了这个）。
    const FILE_LIKE = /((?:[\w.-]+\/)*[\w.-]+\.(?:js|jsx|ts|tsx|mjs|cjs|py|vue|go|java)(?![a-zA-Z0-9_])|\.\.?\/[\w./-]+)/i;
    // 责任声明动词 + 可选职责词
    const CLAIM_RE = new RegExp(
        '(?:由|交由|委托|交给|依赖|参见|见|handled\\s+by|see|depends?\\s+on)\\s*[`\'"]?'
        + FILE_LIKE.source
        + '[`\'"]?\\s*(?:兜底|处理|负责|实现|完成|清理|校验|拦截|过滤)?', 'i'
    );

    const seen = new Set();
    for (const { b, side } of all) {
        if (!b || !b.code || !b.name || /^file-\d+\./.test(b.name)) continue;
        const fromDir = norm(b.name).split('/').slice(0, -1).join('/');
        for (const raw of String(b.code).split('\n')) {
            // 只取注释部分：行注释（// #）或块注释行（* 开头）
            const cm = /(?:\/\/|#)\s*(.+)$/.exec(raw) || /^\s*\*\s*(.+)$/.exec(raw);
            if (!cm) continue;
            const text = cm[1];
            if (/https?:\/\//i.test(text)) continue;           // URL 跳过
            const m = CLAIM_RE.exec(text);
            if (!m) continue;
            const ref = m[1];
            if (/^(node_modules|package\.json|index)$/i.test(ref)) continue;
            if (exists(ref, fromDir)) continue;
            const key = `${b.name}→${ref}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({
                severity: 'medium',
                type: 'unsourced_claim',
                position: side,
                path: `${b.name} → ${ref}`,
                message: `${b.name} 的注释把责任指向 ${ref}（"${text.trim().slice(0, 60)}"），`
                    + '但生成物里没有这个文件 —— 安全或一致性靠一句注释担保，下层没写就是漏洞。'
                    + '请补上该文件，或在本层内实现（静态只查文件样引用，"由仓储层兜底"这类'
                    + '架构角色名判不了，需人工确认）'
            });
            if (out.length >= 8) return out;
        }
    }
    return out;
}

/**
 * 上下文缓存命中率文案（续写 O(n²) 的"实际成本"可视化）。
 *
 * 背景：续写每轮全量重发历史（结构性成本，API 形态决定，消不掉），
 * 但 DeepSeek 的上下文缓存命中部分按 1/10 计价 —— 命中率才是这条成本曲线的
 * 真实折扣。原来只在状态栏显示"缓存命中 X tokens"（绝对值），用户被虚高的
 * prompt 数字吓到，看不出缓存已经救了一半。
 *
 * @param {number} cached 缓存命中 token 数
 * @param {number} prompt 输入 token 总数
 * @returns {string} 如 '62% · 实际输入约 4.4 折'；无数据返回空串
 */
export function cacheHitText(cached, prompt) {
    const c = Number(cached) || 0;
    const p = Number(prompt) || 0;
    if (c <= 0 || p <= 0) return '';
    // 异常数据钳制：命中不可能超过输入总量
    const rate = Math.min(c / p, 1);
    // 实付比例 = 未命中全额 + 命中按 0.1 计价
    const payRatio = (1 - rate) + rate * 0.1;
    const zhe = payRatio * 10;
    return `${(rate * 100).toFixed(0)}% · 实际输入约 ${zhe.toFixed(1)} 折`;
}

// ==================== 数据模型（需求输入第 7 层，2026-10-23） ====================
// 背景：平台原先靠猜主键和字段边界，直接导致 uuid/int 打架、契约 32 被改成 50、
// 金额单位瞎定、枚举自补流转边。这一层让用户【显式声明】，平台从"猜"变成"核对"。

/**
 * 解析字段边界文本 → 数值约束。
 * 认：≤100 / <=100 / 不超过 32 / 最多 50 / 1-50 / 1~50 / ≥0 / 不小于 1 / 长度 32。
 * 认不出返回 null —— 调用方跳过，不猜（裸数字如 "50" 含义不明，刻意不认）。
 *
 * @param {string} text
 * @returns {{min?:number, max?:number}|null}
 */
export function parseBoundaryText(text) {
    const t = String(text == null ? '' : text).trim();
    if (!t) return null;
    let m;
    if ((m = /(\d+)\s*[-~～]\s*(\d+)/.exec(t))) return { min: +m[1], max: +m[2] };
    if ((m = /(?:≤|<=|不超过|最多|至多|上限)\s*(\d+)/.exec(t))) return { max: +m[1] };
    if ((m = /(?:≥|>=|不小于|至少)\s*(\d+)/.exec(t))) return { min: +m[1] };
    if ((m = /长度\s*(?:为|是)?\s*(\d+)/.exec(t))) return { max: +m[1] };
    if ((m = /(\d+)\s*(?:字|个)?(?:以内|之内)/.exec(t))) return { max: +m[1] };
    return null;
}

/**
 * 数据模型对象 → 声明（三个校验函数的基准）。
 *
 * @param {object} dm { pkType, moneyUnit, entities:[{name,fields:[{name,type,required,boundary}]}],
 *                      enums:[{field,states,edges}] }
 * @returns {{pkBucket:string, boundaries:Array, enumFields:Array}}
 */
export function dataModelToDeclarations(dm) {
    const out = { pkBucket: '', boundaries: [], enumFields: [] };
    if (!dm) return out;

    if (dm.pkType === 'int') out.pkBucket = 'number';
    else if (dm.pkType === 'uuid') out.pkBucket = 'string';
    // business：业务键类型不一，不设基准（只进 prompt）

    for (const e of (dm.entities || [])) {
        for (const f of (e.fields || [])) {
            if (!f || !f.name) continue;
            const b = parseBoundaryText(f.boundary);
            if (b) out.boundaries.push({ field: String(f.name), entity: e.name || '', ...b });
        }
    }
    for (const en of (dm.enums || [])) {
        if (!en || !en.field) continue;
        const vals = String(en.states || '')
            .split(/[\/、,，;；|\s]+/).map(s => s.trim()).filter(Boolean);
        const edges = [];
        for (const seg of String(en.edges || '').split(/[\/、,，;；]/)) {
            const em = /^\s*([\w-]+)\s*(?:→|->|~|～|到)\s*([\w-]+)\s*$/.exec(seg.trim());
            if (em) edges.push([em[1].toLowerCase(), em[2].toLowerCase()]);
        }
        if (vals.length >= 2 || edges.length) {
            out.enumFields.push({ field: String(en.field), vals, edges });
        }
    }
    return out;
}

/** 数据模型是否填了实质内容（有空对象就不注入，省 prompt 空间） */
export function hasDataModel(dm) {
    if (!dm) return false;
    const ent = (dm.entities || []).some(e => e && e.name && (e.fields || []).some(f => f && f.name));
    const enu = (dm.enums || []).some(e => e && e.field);
    return !!(dm.pkType || dm.moneyUnit || ent || enu);
}

/**
 * 数据模型 → prompt 追加段（契约生成 / 双端生成共用）。
 *
 * 措辞原则（吃过教训）：声明必须带【禁止反向操作】，只写"主键用 UUID"
 * 模型仍会按 SQLite 习惯改成自增 int。每条都写明"禁止改成 X"。
 *
 * @param {object} dm 数据模型对象
 * @param {number} [maxLen=1400] 长度上限（systemPrompt 总预算 3900，要给契约 JSON 留位）
 * @returns {string} 无内容返回空串
 */
export function dataModelPrompt(dm, maxLen = 1400) {
    if (!hasDataModel(dm)) return '';
    const L = ['【数据模型 · 用户显式声明（最高优先级，高于你的任何默认习惯）】'];

    if (dm.pkType === 'int') {
        L.push('- 主键类型：int 自增。全项目所有实体的主键统一用 int 自增，禁止改用 UUID/string，禁止因为用了某数据库就换类型。');
    } else if (dm.pkType === 'uuid') {
        L.push('- 主键类型：UUID（string 类型）。全项目所有实体的主键统一用 UUID，禁止改成自增 int/number，禁止因为用 SQLite/MySQL 就换成自增。');
    } else if (dm.pkType === 'business') {
        L.push('- 主键类型：业务键（如订单号 orderNo 这类有业务含义的标识），不用数据库自增 ID 作主键。');
    }
    if (dm.moneyUnit === 'yuan') {
        L.push('- 金额单位：元（decimal/NUMERIC 类型）。禁止用整数分表示，禁止用 float 做金额运算（比较与计算用 decimal 或转整数分内核算）。');
    } else if (dm.moneyUnit === 'cent') {
        L.push('- 金额单位：整数分（int 类型存储）。禁止用元的小数表示；仅在前端展示时除以 100 格式化。');
    }

    const ents = (dm.entities || []).filter(e => e && e.name && (e.fields || []).some(f => f && f.name));
    if (ents.length) {
        L.push('- 核心实体与字段（字段名、类型、必填性、边界必须逐字遵守，禁止增删改、禁止替换类型）：');
        for (const e of ents) {
            const fs = (e.fields || []).filter(f => f && f.name);
            L.push(`  · ${e.name}：${fs.map(f =>
                `${f.name}(${f.type || '类型未填'}${f.required ? '，必填' : '，可选'}${f.boundary ? '，' + f.boundary : ''})`
            ).join('、')}`);
        }
    }

    const enus = (dm.enums || []).filter(e => e && e.field);
    if (enus.length) {
        L.push('- 枚举与状态流转（取值集合与允许的边以这里为准：禁止自增状态、禁止添加未列出的流转边、禁止把枚举外的值当默认值）：');
        for (const en of enus) {
            let line = `  · ${en.field}：取值 ${en.states || '（未填）'}`;
            if (en.edges) line += `；只允许流转 ${en.edges}`;
            L.push(line);
        }
    }

    let text = L.join('\n');
    if (text.length > maxLen) {
        // 截断保护：超长时砍实体明细（保留主键/金额/枚举这些全局约束）
        text = text.slice(0, maxLen - 20) + '\n（实体明细过长已截断）';
    }
    return text;
}

// ==================== 业务不变量（需求输入第 8 层，2026-10-23） ====================
// 背景：需求只描述成功流程，平台自然只写 happy path。用户把"绝对不能错"的点
// 逐条列出来，平台才能拿去做覆盖核对（M3 的真正输入端），而不是默认省略。

/**
 * 不变量概念词典：用户不变量文本 → 可静态核对的实现词。
 *
 * keys   触发词（出现在用户不变量文本里即认为"这条不变量涉及该概念"）
 * need   代码里应有的实现迹象（与 REQ_COVERAGE_PATTERNS 同源，保持一套词汇）
 * what   概念名（报告里告诉用户核对的是哪一条）
 *
 * 词典外的概念（如"金额以后端快照为准"里的业务约束）判不了 —— 跳过并在消息里
 * 如实说明，不假装全覆盖。
 */
const INVARIANT_CONCEPTS = [
    { keys: ['库存', '超卖', '扣减', '占用'], need: /stock|inventory|quantity|库存|for\s+update|atomic|transaction|lock/i, what: '库存/防超卖' },
    { keys: ['事务', '回滚', '原子'], need: /BEGIN|COMMIT|ROLLBACK|transaction|atomic|db\.transaction|start_transaction/i, what: '事务回滚' },
    { keys: ['回补', '恢复', '返还'], need: /stock\s*[+-]=|stock\s*=\s*stock\s*[+-]|increase|restore|replenish|回补|返还|release.*stock/i, what: '回补' },
    { keys: ['快照'], need: /priceSnapshot|snapshot.*price|unitPrice|price_at|priceAt|orderPrice|成交价/i, what: '快照' },
    { keys: ['自己的', '本人', '越权', '行级'], need: /req\.user|currentUser|session\.user|userId\s*===|ownerId\s*===|403|forbidden|checkOwner|isOwner/i, what: '行级权限' },
    { keys: ['轮换', 'refresh', '刷新'], need: /refreshToken|refresh_token|rotate|rotation|轮换|renew/i, what: '令牌轮换' },
    { keys: ['重复提交', '幂等'], need: /idempotent|幂等|unique|dedup/i, what: '幂等' },
    { keys: ['并发', '竞争', '同时'], need: /lock|mutex|semaphore|atomic|transaction|version|optimistic|并发|竞争/i, what: '并发控制' },
    { keys: ['限流', '频率'], need: /rateLimit|rate_limit|throttle|限流/i, what: '限流' },
    { keys: ['为空', '空态', '不能为空', '必填'], need: /required|必填|isEmpty|length\s*===?\s*0|empty|空态|placeholder/i, what: '空态/必填' },
];

/**
 * 业务不变量覆盖核对：用户逐条声明的不变量，代码里有没有对应实现。
 *
 * 这是 M3（硬需求静默跳过）的【用户驱动输入端】—— 与内置的
 * findRequirementGaps（平台猜关键词）互补：那里平台猜用户要什么，
 * 这里用户自己说"绝对不能错什么"，平台逐条核对。
 *
 * 判据：不变量文本命中概念词典 → 该概念的实现词必须出现在代码里；
 * 一条不变量涉及多个概念时，只报缺失的那些（部分覆盖也要说）。
 * 词典外的概念跳过（消息如实说明），不假装全覆盖。
 *
 * @param {Array<string|{text:string}>} invariants 用户声明的不变量
 * @param {Array<{code:string}>} feBlocks 前端代码块
 * @param {Array<{code:string}>} beBlocks 后端代码块
 * @returns {Array<{severity,type,position,path,message}>}
 */
export function findInvariantGaps(invariants, feBlocks, beBlocks) {
    const out = [];
    const list = (Array.isArray(invariants) ? invariants : [])
        .map(x => String((x && x.text) || x || '').trim())
        .filter(Boolean);
    if (!list.length) return out;
    const code = [
        ...(Array.isArray(feBlocks) ? feBlocks : []),
        ...(Array.isArray(beBlocks) ? beBlocks : [])
    ].map(b => (b && b.code) || '').join('\n');
    if (!code.trim()) return out;

    for (const text of list) {
        const hits = INVARIANT_CONCEPTS.filter(c => c.keys.some(k => text.includes(k)));
        if (!hits.length) continue;                       // 词典外概念判不了 → 跳过
        const missing = hits.filter(c => !c.need.test(code)).map(c => c.what);
        if (!missing.length) continue;                    // 全部有实现迹象 → 通过
        out.push({
            severity: 'medium',
            type: 'invariant_gap',
            position: 'contract',
            path: text.slice(0, 40),
            message: `你声明了业务不变量「${text.slice(0, 60)}」，但生成代码里找不到 `
                + `${missing.join('、')} 的实现 —— 硬不变量被静默跳过。`
                + '请确认是漏写，还是表述超出了静态可判的范围（需人工/运行测试确认）'
        });
        if (out.length >= 6) break;
    }
    return out;
}

/**
 * 不变量 → prompt 追加段（契约生成 / 双端生成 / 需求分析共用）。
 * @param {Array<string|{text:string}>} invariants
 * @returns {string} 无内容返回空串
 */
export function invariantsPrompt(invariants) {
    const list = (Array.isArray(invariants) ? invariants : [])
        .map(x => String((x && x.text) || x || '').trim())
        .filter(Boolean);
    if (!list.length) return '';
    return '【业务不变量 · 用户逐条声明（必须满足，缺失即缺陷）】\n'
        + list.map((t, i) => `${i + 1}. ${t}`).join('\n')
        + '\n以上每一条都必须在实现中真实成立（含异常、并发、失败路径），'
        + '不允许只写 happy path；确实做不到的在代码注释里标注「不变量待确认」。';
}

// ==================== 契约严格度 + 功能点三态（需求输入第 4 步，2026-10-23） ====================

/**
 * 契约严格度 → prompt 段。
 *
 * 背景：选了"契约双端"却没声明严格程度，模型就会自由发挥 ——
 * `{action}` 被改成 `{status}`、枚举自补取值（用户实测）。两种模式必须说清，
 * 因为"严格"和"可补全"是互斥的指令，不说就等于让它自己挑。
 *
 * @param {'strict'|'lenient'} mode
 * @returns {string} 空串表示未选（沿用原有 prompt）
 */
export function contractStrictPrompt(mode) {
    if (mode === 'strict') {
        return '【契约严格度 · 严格按契约】契约是唯一真源：接口路径、方法、请求/响应字段名与类型、'
            + '枚举取值、状态流转边界，一律与契约逐字一致。禁止改名字段、禁止发明契约没有的字段、'
            + '禁止给枚举补取值、禁止把路径参数名换掉。发现契约确有缺口时，'
            + '不要自行补全 —— 在代码注释里写「契约缺口：…」并在回复末尾列出，由用户改契约。';
    }
    if (mode === 'lenient') {
        return '【契约严格度 · 允许补全但需回写】契约不完整时允许补字段/补枚举，'
            + '但必须同时满足两条：① 在代码注释里标注「契约补全：…」；'
            + '② 在回复末尾给出【契约偏离清单】，逐条列出新增/改动的字段、接口或枚举值及原因。'
            + '没有清单的补全视为悄悄改契约，不可接受。';
    }
    return '';
}

/**
 * 偏离清单缺失检查（仅 lenient 模式）。
 *
 * 选了"允许补全但需回写"，代码里就必须有偏离清单 —— 否则"允许补全"退化成
 * "随便改"，正是用户实测的 `{action}`→`{status}` 那类事故。
 *
 * 判 medium：清单的标记写法有多种（契约偏离/偏离清单/新增字段…），
 * 静态只能查标记词，查不到不代表没写（可能用别的措辞）。
 *
 * @param {'strict'|'lenient'} mode
 * @param {Array<{code:string}>} feBlocks
 * @param {Array<{code:string}>} beBlocks
 * @returns {Array<{severity,type,position,path,message}>}
 */
export function findDriftNoteGap(mode, feBlocks, beBlocks) {
    if (mode !== 'lenient') return [];
    const code = [
        ...(Array.isArray(feBlocks) ? feBlocks : []),
        ...(Array.isArray(beBlocks) ? beBlocks : [])
    ].map(b => (b && b.code) || '').join('\n');
    if (!code.trim()) return [];
    const MARK = /契约偏离|偏离清单|契约补全|新增字段|departure|drift list|补充字段/i;
    if (MARK.test(code)) return [];
    return [{
        severity: 'medium',
        type: 'drift_note_missing',
        position: 'contract',
        path: '契约偏离清单',
        message: '你选了「允许补全但需回写契约」，但代码里找不到偏离清单 —— '
            + '"允许补全"退化成"随便改"，字段改名/枚举自补这类问题会无声发生。'
            + '请在回复末尾补【契约偏离清单】，或改成「严格按契约」'
    }];
}

/**
 * 功能点三态 → prompt 段。
 *
 * 背景（用户 7.1）：选"可运行原型"容易被理解成"壳就行"，核心难点（事务/防超卖）
 * 被跳过。所以把"哪些必须真实实现、哪些可 mock、哪些不做"单独声明，
 * 与完成度解耦 —— 原型也可以要求某几个点必须真实。
 *
 * @param {Array<{name:string, mode:'real'|'mock'|'skip'}>} features
 * @returns {string} 空串表示未填
 */
export function featuresPrompt(features) {
    const list = (Array.isArray(features) ? features : [])
        .map(f => ({ name: String((f && f.name) || '').trim(), mode: (f && f.mode) || '' }))
        .filter(f => f.name);
    if (!list.length) return '';
    const real = list.filter(f => f.mode === 'real');
    const mock = list.filter(f => f.mode === 'mock');
    const skip = list.filter(f => f.mode === 'skip');
    const L = ['【功能点实现方式 · 用户显式声明（与完成度解耦，优先级更高）】'];
    if (real.length) {
        L.push('- 必须真实实现（不许 mock、不许占位、必须含异常与并发处理）：'
            + real.map(f => f.name).join('、'));
    }
    if (mock.length) {
        L.push('- 允许 mock（但必须显式标注「mock」并说明真实实现需要什么依赖）：'
            + mock.map(f => f.name).join('、'));
    }
    if (skip.length) {
        L.push('- 本轮不做（不要生成相关代码，也不要留半成品入口）：'
            + skip.map(f => f.name).join('、'));
    }
    return L.join('\n');
}

/** 项目预设：常见项目类型的数据模型骨架 + 授权 + 不变量（降低从零填写成本） */
export const PROJECT_PRESETS = {
    admin: {
        label: '后台管理',
        dataModel: {
            pkType: 'uuid', moneyUnit: '',
            entities: [
                { name: 'User', fields: [
                    { name: 'id', type: 'string', required: true, boundary: '' },
                    { name: 'email', type: 'string', required: true, boundary: '≤100' },
                    { name: 'name', type: 'string', required: true, boundary: '≤50' },
                    { name: 'role', type: 'string', required: true, boundary: '' }
                ] }
            ],
            enums: [{ field: 'User.role', states: 'admin / editor / viewer', edges: '' }]
        },
        authz: { roles: ['管理员', '编辑', '只读'], rules: ['只有管理员可以删除和修改成员角色', '编辑可以增改但不能删除'], rowLevel: false, ownerKey: '' },
        invariants: ['列表查询必须有分页与上限，禁止全量返回'],
        deliver: { withMigration: true, withAuthMw: true, withErrorMw: true, withEntry: true }
    },
    shop: {
        label: '商城下单',
        dataModel: {
            pkType: 'uuid', moneyUnit: 'cent',
            entities: [
                { name: 'Product', fields: [
                    { name: 'id', type: 'string', required: true, boundary: '' },
                    { name: 'name', type: 'string', required: true, boundary: '≤32' },
                    { name: 'price', type: 'int', required: true, boundary: '≥0' },
                    { name: 'stock', type: 'int', required: true, boundary: '≥0' }
                ] },
                { name: 'Order', fields: [
                    { name: 'id', type: 'string', required: true, boundary: '' },
                    { name: 'userId', type: 'string', required: true, boundary: '' },
                    { name: 'totalAmount', type: 'int', required: true, boundary: '≥0' }
                ] }
            ],
            enums: [{ field: 'Order.status', states: 'pending / paid / shipped / done', edges: 'pending→paid / paid→shipped / shipped→done' }]
        },
        authz: { roles: ['游客', '本人', '管理员'], rules: ['管理员可以发货和退款', '用户只能看自己的订单'], rowLevel: true, ownerKey: 'userId' },
        invariants: ['库存永不为负，并发下单不得超卖', '下单失败要整体回滚，已扣库存要回补', '金额以后端快照为准，前端不传金额'],
        deliver: { withMigration: true, withAuthMw: true, withErrorMw: true, withEntry: true }
    },
    collab: {
        label: '协作工具',
        dataModel: {
            pkType: 'uuid', moneyUnit: '',
            entities: [
                { name: 'Task', fields: [
                    { name: 'id', type: 'string', required: true, boundary: '' },
                    { name: 'title', type: 'string', required: true, boundary: '≤100' },
                    { name: 'assigneeId', type: 'string', required: false, boundary: '' },
                    { name: 'status', type: 'string', required: true, boundary: '' }
                ] }
            ],
            enums: [{ field: 'Task.status', states: 'todo / doing / done', edges: 'todo→doing / doing→done' }]
        },
        authz: { roles: ['成员', '管理员'], rules: ['成员只能改自己创建或指派给自己的任务', '只有管理员可以删除项目'], rowLevel: true, ownerKey: 'assigneeId' },
        invariants: ['状态流转只能按声明允许的边走'],
        deliver: { withMigration: true, withAuthMw: true, withErrorMw: true, withEntry: true }
    },
    saas: {
        label: 'SaaS 多租户',
        dataModel: {
            pkType: 'uuid', moneyUnit: 'cent',
            entities: [
                { name: 'Tenant', fields: [
                    { name: 'id', type: 'string', required: true, boundary: '' },
                    { name: 'name', type: 'string', required: true, boundary: '≤50' }
                ] },
                { name: 'Member', fields: [
                    { name: 'id', type: 'string', required: true, boundary: '' },
                    { name: 'tenantId', type: 'string', required: true, boundary: '' },
                    { name: 'userId', type: 'string', required: true, boundary: '' }
                ] }
            ],
            enums: []
        },
        authz: { roles: ['租户管理员', '普通成员'], rules: ['所有数据查询必须带 tenantId 过滤', '只有租户管理员可以邀请成员'], rowLevel: true, ownerKey: 'tenantId' },
        invariants: ['跨租户数据绝不可见（每条查询都要带 tenantId）', '并发下成员配额不得超限'],
        deliver: { withMigration: true, withAuthMw: true, withErrorMw: true, withEntry: true }
    }
};

export function cleanConvTitle(text) {
    let s = String(text == null ? '' : text);
    s = s
        .replace(/```[\s\S]*?```/g, ' ')            // 代码块整体去掉（代码不该进标题）
        .replace(/`([^`]*)`/g, '$1')                // 行内代码：去反引号留内容
        .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')      // 图片
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')    // 链接：取文字
        .replace(/^\s{0,3}#{1,6}\s*/gm, '')         // ATX 标题标记（#### 等）
        .replace(/^\s{0,3}#{1,6}\s*$/gm, '')        // 单独一行只有 # 的
        .replace(/^\s{0,3}[-*+]\s+/gm, '')          // 无序列表
        .replace(/^\s{0,3}\d+[.)]\s+/gm, '')        // 有序列表
        .replace(/^\s{0,3}>\s?/gm, '')              // 引用
        .replace(/(\*\*|__)(.*?)\1/g, '$2')         // 粗体
        .replace(/(\*|_)(.*?)\1/g, '$2')            // 斜体
        .replace(/~~(.*?)~~/g, '$1')                // 删除线
        .replace(/[*_`~#>|]/g, '')                  // 孤零残留标记
        .replace(/\s+/g, ' ')                       // 压缩空白
        .trim();
    return s;
}

/** 标题是否"疑似模型 markdown 原文"（决定存量标题要不要被清洗） */
export function looksLikeMarkdownTitle(title) {
    return /(^|\s)[#*_`~>]|^\s*[-*+]\s|\*\*|__|#{2,}|```/.test(String(title || ''));
}

/** 从模型输出里抠出契约 JSON（容忍 markdown 代码围栏与前后废话） */
export function parseContract(text) {
    let s = String(text || '').trim();
    const fence = /```(?:json|JSON)?\s*([\s\S]*?)```/.exec(s);
    if (fence) s = fence[1].trim();
    const i = s.indexOf('{');
    const j = s.lastIndexOf('}');
    if (i >= 0 && j > i) s = s.slice(i, j + 1);
    try {
        const obj = JSON.parse(s);
        return obj && typeof obj === 'object' ? obj : null;
    } catch {
        return null;
    }
}

/**
 * 契约精简：后端 systemPrompt 硬限 4000 字符，契约稍大就破限，
 * 因此逐级精简：格式化 → 紧凑 → 去字段说明 → 只留关键字段。
 * @param {string} mode '' | 'noDesc' | 'minimal'
 */
export function slimContract(c, mode) {
    const dto = (c.common_dto || []).map(d => {
        if (mode === 'minimal') {
            return { name: d.name, fields: (d.fields || []).map(f => f.name) };
        }
        return {
            name: d.name,
            fields: (d.fields || []).map(f => mode === 'noDesc'
                ? { name: f.name, type: f.type }
                : f)
        };
    });
    const apis = (c.apis || []).map(a => {
        if (mode === 'minimal') {
            const req = a.request || {};
            return {
                path: a.path, method: a.method, summary: a.summary,
                request: {
                    path: (req.path || []).map(p => p.name),
                    query: (req.query || []).map(p => p.name),
                    body: req.body ? (req.body.type || req.body.name || 'object') : null
                },
                response: { type: (a.response || {}).type }
            };
        }
        if (mode === 'noDesc') {
            // 去掉所有 desc（说明性文字体积大，但不影响接口签名）
            const strip = arr => (arr || []).map(p => ({ name: p.name, type: p.type }));
            const req = a.request || {};
            return {
                path: a.path, method: a.method, summary: a.summary,
                request: {
                    path: strip(req.path), query: strip(req.query),
                    body: req.body ? { name: req.body.name, type: req.body.type } : null
                },
                response: { type: (a.response || {}).type }
            };
        }
        return a;
    });
    const out = { module: c.module, responsibility: c.responsibility, common_dto: dto, apis };
    if (c.apis && c.apis.length && apis.length !== c.apis.length) out.apis = c.apis;
    return out;
}
