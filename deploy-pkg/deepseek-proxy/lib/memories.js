/**
 * 记忆库：服务于下一次代码生成的可执行知识。
 *
 * 定位（不是读书笔记）：每条记忆都能转成两种东西之一——
 *   ① 一条必须遵守的约束（L1/L3，违反就出错）
 *   ② 一个可套用的成熟做法（L2，拿来就提高完成度）
 *
 * 存储选型：JSON 文件而非 SQLite。理由（2026-10-16 实测）：
 *   node:sqlite 在本机 Node 构建下要 --experimental-sqlite 标志且 FTS5 未编译；
 *   而记忆库量级是几百~几千条、低频读写（一次生成 recall 一次），JSON 完全够，
 *   还多三个好处：可直接下载备份/迁移、肉眼可读、零部署风险。
 *   写入用「临时文件 + rename」原子替换，单进程无并发冲突。
 *
 * 数据流：
 *   前端 prompt 组装 → POST /api/memories/recall → 分层召回（L1≤5/L2≤3）→ 拼进 prompt
 *   一致性报告「转记忆」/ 自动候选 → POST /api/memories/ingest → 去重检测 → 入库
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.MEMORY_DATA_DIR || path.join(HERE, '..', 'data');
const STORE_FILE = path.join(DATA_DIR, 'memories.json');

/** 分层召回上限：只带相关的，避免记忆堆爆 prompt 稀释注意力 */
const RECALL_LIMITS = { L1: 5, L2: 3, L3: 4, L4: 2 };
const VALID_TYPES = ['L1', 'L2', 'L3', 'L4'];
const VALID_STATUS = ['active', 'pending', 'retired'];
const VALID_SEVERITY = ['block', 'important', 'suggest'];
const MAX_ITEMS = 5000;            // 硬上限，超了拒绝 ingest（防失控）
const MAX_RULE_LEN = 500;

/** issue type → 场景标签：从沉淀来源自动推断，不用用户手打 */
const ISSUE_TAG_MAP = {
    dto_type_mismatch: ['契约', 'DTO'],
    dto_field_missing: ['契约', 'DTO'],
    dto_field_extra: ['契约', 'DTO'],
    enum_out_of_range: ['状态机', '契约'],
    crud_gap: ['CRUD'],
    auth_gap: ['鉴权'],
    collab_gap: ['协作'],
    state_machine_gap: ['状态机'],
    foreign_key_gap: ['协作'],
    sort_write_gap: ['看板', '排序'],
    unused_query_param: ['分页', '筛选'],
    missing_backend: ['契约'],
    frontend_no_backend: ['契约'],
    unknown_frontend: ['契约'],
    method_mismatch: ['契约'],
};

function emptyStore() {
    return { version: 1, items: [] };
}

/** 读存储：文件不存在 / 损坏都返回空库（损坏不抛，记忆库挂了不该拖垮生成） */
export function loadMemories() {
    try {
        const raw = fs.readFileSync(STORE_FILE, 'utf8');
        const data = JSON.parse(raw);
        if (data && Array.isArray(data.items)) return data;
        return emptyStore();
    } catch {
        return emptyStore();
    }
}

/** 原子写：临时文件 + rename。同步写（记忆写入频率低，没必要引入异步复杂度） */
export function saveMemories(store) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${STORE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8');
    fs.renameSync(tmp, STORE_FILE);
}

function genId() {
    return 'mem_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

/**
 * 归一化一条候选记忆：补默认值、裁剪长度、推断标签、校验枚举。
 * 返回 { ok, memory } 或 { ok:false, error }。**故意严格**——脏数据入库会后患无穷。
 */
export function normalizeCandidate(c, opts = {}) {
    const type = VALID_TYPES.includes(c.type) ? c.type : 'L1';
    const rule = String(c.rule || '').trim();
    if (!rule) return { ok: false, error: 'rule 不能为空（必须写成可执行规则，不写空话）' };
    if (rule.length > MAX_RULE_LEN) return { ok: false, error: `rule 超长（>${MAX_RULE_LEN}）` };

    const sceneTags = Array.isArray(c.sceneTags)
        ? [...new Set(c.sceneTags.map((t) => String(t).slice(0, 20)).filter(Boolean))].slice(0, 8)
        : [];
    // 带 issueType 的候选（来自校验报告）自动打标，不用调用方手填
    if (opts.issueType && ISSUE_TAG_MAP[opts.issueType]) {
        for (const t of ISSUE_TAG_MAP[opts.issueType]) {
            if (!sceneTags.includes(t)) sceneTags.push(t);
        }
    }
    const stack = Array.isArray(c.stack)
        ? [...new Set(c.stack.map((s) => String(s).slice(0, 30)).filter(Boolean))].slice(0, 8)
        : [];

    const now = Date.now();
    return {
        ok: true,
        memory: {
            id: genId(),
            type,
            sceneTags,
            stack,
            trigger: String(c.trigger || '').slice(0, 200),
            rule,
            badCase: String(c.badCase || '').slice(0, 1000),
            goodCase: String(c.goodCase || '').slice(0, 1000),
            severity: VALID_SEVERITY.includes(c.severity) ? c.severity
                : (type === 'L1' ? 'block' : 'important'),
            source: String(c.source || '').slice(0, 300),
            hitCount: 0,
            lastHit: 0,
            feedback: { followed: 0, violated: 0 },
            status: VALID_STATUS.includes(c.status) ? c.status : 'active',
            createdAt: now,
            updatedAt: now,
        },
    };
}

/**
 * 去重检测：与已有记忆是否重复/冲突。
 *
 * 判重：场景标签有交集 且 规则文本相似（关键词重合度 ≥ 0.6）。
 * 冲突（同场景但规则语义相反）检测不了——那需要语义理解，遇到时不自动覆盖，
 * 由 patch 时人工裁决（方案第六节的要求）。
 *
 * @returns {{duplicate: boolean, existing?: object}}
 */
export function findDuplicate(store, candidate) {
    const tags = new Set(candidate.sceneTags || []);
    const words = keywordSet(candidate.rule);
    for (const m of store.items) {
        if (m.status === 'retired') continue;
        const mTags = new Set(m.sceneTags || []);
        const tagOverlap = [...tags].some((t) => mTags.has(t));
        if (!tagOverlap) continue;
        const mWords = keywordSet(m.rule);
        const sim = jaccard(words, mWords);
        if (sim >= 0.6) return { duplicate: true, existing: m };
    }
    return { duplicate: false };
}

/** 规则文本 → 关键词集合（去停用词；中英文按 2+ 字符切） */
function keywordSet(text) {
    const stop = new Set(['的', '了', '和', '与', '或', '及', '在', '是', '要', '不', '不能', '不得', '必须', '禁止', '一个', '该', '此']);
    const words = String(text || '').toLowerCase()
        .split(/[\s,，。；;：:、/()（）\[\]【】"'`]+/)
        .filter((w) => w.length >= 2 && !stop.has(w));
    return new Set(words);
}

function jaccard(a, b) {
    if (!a.size || !b.size) return 0;
    let inter = 0;
    for (const w of a) if (b.has(w)) inter++;
    return inter / (a.size + b.size - inter);
}

/**
 * 分层召回：按 技术栈 + 场景标签 + 关键词 混合匹配，分层取 top N。
 *
 * 打分：标签交集×3 + 关键词命中×2 + 严重度权重 + 命中次数微权重（热的略靠前）
 *       + 反馈权重（遵守 ×0.5、违反 ×-1 —— 违反双倍惩罚）。
 * 反馈权重是「治理」的核心：反复无效的规则得分降低，跌出分层上限被挤出，
 * 实现事实上的淘汰，无需硬删（误杀不可逆，软降权可恢复）。
 *
 * @param {object} q {stack?:string, sceneTags?:string[], keywords?:string[]}
 * @returns {{items:Array, counts:Object}} items 已按层级分组排好序
 */
export function recallMemories(store, q = {}) {
    const reqTags = new Set((q.sceneTags || []).map((t) => String(t).toLowerCase()));
    const reqWords = (q.keywords || []).map((w) => String(w).toLowerCase()).filter(Boolean);
    const stackText = String(q.stack || '').toLowerCase();

    const scored = [];
    for (const m of store.items) {
        if (m.status !== 'active') continue;
        // stack 过滤：记忆限定栈时，请求栈要包含其一
        if (Array.isArray(m.stack) && m.stack.length && stackText) {
            const hit = m.stack.some((s) => stackText.includes(String(s).toLowerCase()));
            if (!hit) continue;
        }
        const mTags = (m.sceneTags || []).map((t) => String(t).toLowerCase());
        const tagHits = mTags.filter((t) => reqTags.has(t)).length;
        const hay = `${m.rule} ${m.trigger} ${m.sceneTags.join(' ')}`.toLowerCase();
        const wordHits = reqWords.filter((w) => hay.includes(w)).length;
        // 完全没关联的不要（防止把整个库都带出去）
        if (tagHits === 0 && wordHits === 0 && reqTags.size + reqWords.length > 0) continue;

        const sevW = m.severity === 'block' ? 3 : (m.severity === 'important' ? 2 : 1);
        const fb = m.feedback || { followed: 0, violated: 0 };
        // 反馈权重：遵守加分、违反扣分（规则被照样违反 = 这条没用，双倍惩罚）
        const fbW = (fb.followed || 0) * 0.5 - (fb.violated || 0) * 1;
        const score = tagHits * 3 + wordHits * 2 + sevW + Math.min(m.hitCount || 0, 10) * 0.1 + fbW;
        scored.push({ m, score });
    }

    scored.sort((a, b) => b.score - a.score);
    const out = [];
    const counts = {};
    const seen = new Set();
    for (const { m } of scored) {
        if (seen.has(m.id)) continue;
        const limit = RECALL_LIMITS[m.type] || 2;
        counts[m.type] = counts[m.type] || 0;
        if (counts[m.type] >= limit) continue;
        counts[m.type]++;
        seen.add(m.id);
        out.push(m);
    }

    // 命中计数：热的记忆会更靠前（正反馈），异步落盘不影响本次返回
    const now = Date.now();
    let touched = false;
    for (const m of out) {
        m.hitCount = (m.hitCount || 0) + 1;
        m.lastHit = now;
        touched = true;
    }
    if (touched) {
        try { saveMemories(store); } catch { /* 命中计数写失败不影响召回结果 */ }
    }
    return { items: out, counts };
}

/**
 * 召回结果 → prompt 注入文本（放在 systemPrompt 最前面的「必须遵守」区）。
 * 没有命中返回空串（调用方直接不拼，不给模型添噪声）。
 */
export function formatMemoriesForPrompt(recalled) {
    const items = (recalled && recalled.items) || [];
    if (!items.length) return '';
    const lines = items.map((m, i) => {
        const tag = m.sceneTags && m.sceneTags.length ? `（场景：${m.sceneTags.join('/')}）` : '';
        return `${i + 1}. [${m.type}] ${m.rule}${tag}`;
    });
    return [
        '【历史经验 · 必须遵守】以下来自以往生成的校验偏差与验证过的做法，优先级高于你的默认习惯：',
        ...lines,
    ].join('\n');
}

/**
 * 入库（带去重）。重复时不覆盖——返回 {ok:false, duplicate, existing} 让调用方决定。
 */
export function ingestMemory(store, candidate, opts = {}) {
    if (store.items.length >= MAX_ITEMS) {
        return { ok: false, error: `记忆库已满（${MAX_ITEMS} 条），请先清理淘汰项` };
    }
    const norm = normalizeCandidate(candidate, opts);
    if (!norm.ok) return { ok: false, error: norm.error };
    const dup = findDuplicate(store, norm.memory);
    if (dup.duplicate) {
        return { ok: false, duplicate: true, existing: dup.existing };
    }
    store.items.push(norm.memory);
    saveMemories(store);
    // 相近但非重复的提示（可能相关/矛盾，交人工确认）
    const related = findRelated(store, norm.memory).filter((r) => r.id !== norm.memory.id);
    return { ok: true, memory: norm.memory, related };
}

/**
 * 批量记录反馈（recurrence check 的结果）：遵守加分、违反扣分。
 *
 * 零 token 的「规则有没有效」判据由前端算好（同类问题在下次校验重现与否），
 * 这里只做落账。violated 双倍惩罚的权重在 recallMemories 里应用。
 *
 * @param {Array<{id:string, outcome:'followed'|'violated'}>} entries
 * @returns {{ok:boolean, updated:number}}
 */
export function recordFeedback(store, entries) {
    let updated = 0;
    for (const e of (entries || [])) {
        if (!e || !e.id) continue;
        const m = store.items.find((x) => x.id === e.id);
        if (!m) continue;
        if (!m.feedback) m.feedback = { followed: 0, violated: 0 };
        if (e.outcome === 'violated') m.feedback.violated = (m.feedback.violated || 0) + 1;
        else if (e.outcome === 'followed') m.feedback.followed = (m.feedback.followed || 0) + 1;
        else continue;
        m.updatedAt = Date.now();
        updated++;
    }
    if (updated > 0) saveMemories(store);
    return { ok: true, updated };
}

/**
 * 找「相近但非重复」的记忆（同场景、文本相似度 0.3~0.6）。
 * 用途：ingest 时提示调用方「可能与已有记忆相关，请人工确认」——
 * 真正的矛盾检测需要语义理解（如两种分页方案），静态做不到，
 * 按方案要求挂起交人工，不自动裁决。
 */
export function findRelated(store, candidate) {
    const tags = new Set(candidate.sceneTags || []);
    const words = keywordSet(candidate.rule);
    const out = [];
    for (const m of store.items) {
        if (m.status === 'retired') continue;
        const mTags = new Set(m.sceneTags || []);
        const tagOverlap = [...tags].some((t) => mTags.has(t));
        if (!tagOverlap) continue;
        const sim = jaccard(words, keywordSet(m.rule));
        if (sim >= 0.3 && sim < 0.6) {
            out.push({ id: m.id, rule: m.rule, type: m.type, similarity: Number(sim.toFixed(2)) });
        }
        if (out.length >= 3) break;
    }
    return out;
}

/** 局部更新（启用/淘汰/改级/反馈）。只允许白名单字段，防止把 id/createdAt 改坏 */
export function patchMemory(store, id, patch = {}) {
    const m = store.items.find((x) => x.id === id);
    if (!m) return { ok: false, error: '记忆不存在' };
    const allowed = ['type', 'sceneTags', 'stack', 'trigger', 'rule', 'badCase', 'goodCase',
        'severity', 'status', 'feedback'];
    for (const k of allowed) {
        if (patch[k] === undefined) continue;
        if (k === 'type' && !VALID_TYPES.includes(patch[k])) return { ok: false, error: 'type 非法' };
        if (k === 'status' && !VALID_STATUS.includes(patch[k])) return { ok: false, error: 'status 非法' };
        if (k === 'severity' && !VALID_SEVERITY.includes(patch[k])) return { ok: false, error: 'severity 非法' };
        if (k === 'feedback' && (typeof patch[k] !== 'object' || patch[k] === null)) {
            return { ok: false, error: 'feedback 必须为对象' };
        }
        m[k] = patch[k];
    }
    m.updatedAt = Date.now();
    saveMemories(store);
    return { ok: true, memory: m };
}

/** 列表（管理面板用）：按状态/层级过滤，新的在前 */
export function listMemories(store, filter = {}) {
    let items = [...store.items];
    if (filter.status) items = items.filter((m) => m.status === filter.status);
    if (filter.type) items = items.filter((m) => m.type === filter.type);
    items.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return items;
}

/**
 * 种子记忆：让记忆库【开箱即用】。
 *
 * 空库对用户没有价值——前几步的闭环（自动候选/召回/治理）都需要库里有东西才看得见效果。
 * 种子分两类：
 *   L2 模式：跨项目通用的成熟工程做法（401 刷新去重、事务、N+1…），stack 为空 = 任何栈适用
 *   L3 场景规则：命中场景才注入的默认常识。**句式与 dual-text.mjs 的 RULE_TEMPLATES
 *    保持一致**——这样校验偏差自动产生的 L1 候选若与种子同主题，会被 findDuplicate
 *    （不限层级的标签+相似度去重）自然拦下，不会两层重复占位。
 *
 * ensureSeeds 只在【库为空】时灌入：用户主动淘汰的种子不会复活。
 */
const SEED_MEMORIES = [
    // ---------- L2 可复用模式（通用工程做法） ----------
    {
        type: 'L2', rule: '401/403 由前端统一拦截处理（跳登录或提示无权），禁止各页面各自为政',
        sceneTags: ['鉴权'], severity: 'important',
        source: 'seed:L2:auth-intercept'
    },
    {
        type: 'L2', rule: 'token 刷新用单例 Promise 去重：多个请求同时 401 时只发一次刷新，避免刷新风暴',
        sceneTags: ['鉴权'], severity: 'important',
        source: 'seed:L2:refresh-dedup'
    },
    {
        type: 'L2', rule: '列表分页参数与前端分页器严格对应（page/pageSize 同名同义），禁止写死 pageSize 一次拉回',
        sceneTags: ['分页'], severity: 'important',
        source: 'seed:L2:paging-consistent'
    },
    {
        type: 'L2', rule: '后端统一错误结构 {code, message, data?}，前端按 code 分支处理；禁止把堆栈或内部细节返给前端',
        sceneTags: ['契约'], severity: 'important',
        source: 'seed:L2:error-shape'
    },
    {
        type: 'L2', rule: '危险操作（删除/批量修改）要二次确认，优先软删除（deletedAt 标记）保留可恢复性',
        sceneTags: ['CRUD'], severity: 'suggest',
        source: 'seed:L2:soft-delete'
    },
    {
        type: 'L2', rule: '多表写入放在一个事务里，失败整体回滚，禁止出现部分成功的中间态',
        sceneTags: ['CRUD'], severity: 'block',
        source: 'seed:L2:transaction'
    },
    {
        type: 'L2', rule: '文件上传前后端双重校验类型与大小，禁止只在前端校验（前端校验可被绕过）',
        sceneTags: ['鉴权'], severity: 'important',
        source: 'seed:L2:upload-validate'
    },
    {
        type: 'L2', rule: '写接口对重复提交要幂等（唯一约束或幂等 token），禁止同一操作重复创建数据',
        sceneTags: ['CRUD'], severity: 'important',
        source: 'seed:L2:idempotent'
    },
    {
        type: 'L2', rule: '列表查询避免 N+1：用 join 或批量查询一次取回，禁止在循环里逐条查库',
        sceneTags: ['CRUD', '分页'], severity: 'important',
        source: 'seed:L2:no-n+1'
    },
    {
        type: 'L2', rule: '后端记录请求日志（方法/路径/耗时/状态码），禁止记录密钥、令牌与完整请求体',
        sceneTags: ['鉴权'], severity: 'important',
        source: 'seed:L2:req-log'
    },

    // ---------- L3 场景规则（句式与 RULE_TEMPLATES 一致，供跨层去重） ----------
    {
        type: 'L3', rule: '协作体系必须内置保护规则：最后一名管理员不可降级或移除、owner 不可被移除、用户不能移除自己',
        sceneTags: ['协作'], severity: 'block',
        source: 'seed:L3:collab-guard'
    },
    {
        type: 'L3', rule: '有登录/令牌端点必须包含 logout，并使 token 失效或轮换；禁止用前端清本地存储代替登出',
        sceneTags: ['鉴权'], severity: 'block',
        source: 'seed:L3:auth-closure'
    },
    {
        type: 'L3', rule: '状态字段必须在契约中声明枚举、初始状态（创建只允许它）与合法流转，前后端都要校验',
        sceneTags: ['状态机'], severity: 'block',
        source: 'seed:L3:state-machine'
    },
    {
        type: 'L3', rule: '排序字段必须有真实写入链路：拖拽后调用批量重排接口事务性更新 position，禁止只在前端本地排序',
        sceneTags: ['看板', '排序'], severity: 'important',
        source: 'seed:L3:sort-write'
    },
];

/**
 * 灌入种子。返回 { seeded, skipped }。
 *
 * 判据是【按 source 逐条看】，不是看总条目数（2026-10-19 线上栽过）：
 * 原实现 `if (store.items.length > 0) return` —— 线上有 45 条 retired 的
 * 污染候选时，种子被永久挡在门外，表现为"记忆库永远没有 L2/L3 种子"。
 *
 * 三条规则：
 *   ① 该种子已在 active → 跳过（不重复）
 *   ② 该种子曾被淘汰（retired 里有同 source）→ 不复活（尊重用户淘汰）
 *   ③ 其余 → 灌入
 */
export function ensureSeeds(store) {
    const activeSources = new Set(
        store.items.filter((m) => m.status === 'active').map((m) => m.source)
    );
    const retiredSources = new Set(
        store.items.filter((m) => m.status === 'retired').map((m) => m.source)
    );
    let seeded = 0;
    for (const s of SEED_MEMORIES) {
        if (activeSources.has(s.source)) continue;
        if (retiredSources.has(s.source)) continue;   // 淘汰过的不复活
        const r = ingestMemory(store, s, {});
        if (r.ok) seeded++;
    }
    return { seeded, skipped: SEED_MEMORIES.length - seeded };
}

export { STORE_FILE, DATA_DIR, RECALL_LIMITS, MAX_ITEMS, ISSUE_TAG_MAP, SEED_MEMORIES };
