/**
 * 闸门事件日志（2026-10-30）。
 *
 * 记的是三个【零 token 闸门】每次调用的统计：/api/static-check、/api/consistency、
 * /api/review 的 preCheck 分支。目的是回答"闸门到底拦下了多少、省了多少次送审"——
 * 这些数以前只散在 journald 的一行 info 里，没法聚合。
 *
 * 为什么是 NDJSON（一行一次调用）而不是 memories.json 那种整体覆盖：
 *   闸门是事件流，append 天然没有读-改-写竞争，也不需要锁；
 *   混进 memories.json 会让记忆库的写入频率翻几倍，且语义完全不搭。
 *
 * 三条硬约束：
 *   ① 绝不记代码正文、apiKey、IP/UA —— 这里只放计数与短路径，日志不该变成泄密通道；
 *   ② 写失败必须静默（首次 warn 一次）：闸门是主链路，日志坏了不能让它 500；
 *   ③ 同步 appendFileSync 一行（<1KB），不做内存聚合 —— 服务限 512M 内存。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './memories.js';

/** 测试可覆盖（否则一律落在 data/gate-log.ndjson） */
const FILE = process.env.GATE_LOG_FILE || path.join(DATA_DIR, 'gate-log.ndjson');
/** 5MB 轮转（只保留一代 .1）。测试可调小以便验证。 */
const MAX_BYTES = Number(process.env.GATE_LOG_MAX_BYTES) || 5 * 1024 * 1024;
const MAX_TOP = 5;
const MAX_TYPES = 8;

let warned = false;

const len = (x) => (Array.isArray(x) ? x.length : 0);
const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
const str = (x, max) => (typeof x === 'string' ? x.slice(0, max) : '');

function noteFailure(err) {
    if (warned) return;      // 每进程只喊一次，避免刷爆日志
    warned = true;
    console.warn('[gate-log] 写入失败（后续静默，不影响接口）:', err && err.message);
}

/** 只按体积轮转：数行要整文件读一遍，不值当，也多一处竞态 */
function rotateIfNeeded() {
    try {
        if (fs.statSync(FILE).size < MAX_BYTES) return;
        const bak = FILE + '.1';
        try { fs.rmSync(bak, { force: true }); } catch { /* 不存在就算了 */ }
        fs.renameSync(FILE, bak);
    } catch { /* 文件还不存在 → 不需要轮转 */ }
}

function write(record) {
    try {
        fs.mkdirSync(path.dirname(FILE), { recursive: true });
        rotateIfNeeded();
        fs.appendFileSync(FILE, JSON.stringify(record) + '\n', 'utf8');
    } catch (err) {
        noteFailure(err);
    }
}

/** 按 severity 统计安全项（security 是数组，不是 {high,medium,low}） */
function severityCounts(list) {
    const out = { high: 0, medium: 0, low: 0 };
    for (const x of Array.isArray(list) ? list : []) {
        const s = String((x && x.severity) || '').toLowerCase();
        if (s in out) out[s] += 1;
    }
    return out;
}

/**
 * /api/static-check 一次调用。
 * 注意 ok 的语义：它表示"闸门执行成功"，不是"代码没问题"——
 * 语法错误时接口依然 ok:true 并把 blocked 置真。
 */
export function logStaticCheck(st, chars) {
    const r = st || {};
    const syn = r.syntax || {};
    const sym = r.symbols || {};
    const conf = r.conflicts || {};
    const outChars = r.compressed && typeof r.compressed.code === 'string'
        ? r.compressed.code.length : null;
    const errors = num(syn.errorCount);
    write({
        ts: Date.now(),
        route: 'static-check',
        ms: num(r.ms),
        ok: r.ok === true,
        chars: num(chars),
        language: str(r.language, 24),
        supported: r.supported === true,
        syntaxOk: syn.ok === true && errors === 0,
        syntaxErrors: errors,
        blocked: errors > 0,
        symbols: { functions: len(sym.functions), classes: len(sym.classes), variables: len(sym.variables) },
        conflicts: { redefinitions: len(conf.redefinitions), unused: len(conf.unused) },
        security: severityCounts(r.security),
        // savedPct 由压缩前后长度现算（compressed 里没有这个字段，且可能为 null）
        compressed: {
            savedPct: outChars !== null && num(chars) > 0
                ? Math.round((1 - outChars / num(chars)) * 1000) / 10
                : 0
        }
    });
}

/** /api/consistency 一次调用：严重度与类型都从 issues 现算（summary 里没有） */
export function logConsistency(res, chars) {
    const r = res || {};
    const issues = Array.isArray(r.issues) ? r.issues : [];
    const sev = severityCounts(issues);
    const types = {};
    for (const i of issues) {
        const t = str((i && i.type) || 'unknown', 40) || 'unknown';
        types[t] = (types[t] || 0) + 1;
    }
    const topTypes = Object.fromEntries(
        Object.entries(types).sort((a, b) => b[1] - a[1]).slice(0, MAX_TYPES)
    );
    write({
        ts: Date.now(),
        route: 'consistency',
        ms: num(r.ms),
        ok: r.ok === true,
        chars: num(chars),
        summary: {
            contract: num(r.summary && r.summary.contract),
            frontend: num(r.summary && r.summary.frontend),
            backend: num(r.summary && r.summary.backend),
            high: sev.high, medium: sev.medium, low: sev.low
        },
        types: topTypes,
        // 只留 5 条摘要，path 截断 —— 够定位，不至于把日志写成第二份代码
        top: issues.slice(0, MAX_TOP).map(i => ({
            type: str(i && i.type, 40),
            severity: str(i && i.severity, 12),
            path: str(i && i.path, 60)
        }))
    });
}

/** /api/review 的 preCheck 分支：拦下一次 = 省下一次送审 */
export function logReviewPrecheck(st, chars) {
    const r = st || {};
    const syn = r.syntax || {};
    const errors = num(syn.errorCount);
    write({
        ts: Date.now(),
        route: 'review-precheck',
        ms: num(r.ms),
        ok: r.ok === true,
        chars: num(chars),
        language: str(r.language, 24),
        supported: r.supported === true,
        syntaxOk: syn.ok === true && errors === 0,
        syntaxErrors: errors,
        savedReview: errors > 0
    });
}

export { FILE as GATE_LOG_FILE, MAX_BYTES as GATE_LOG_MAX_BYTES };
