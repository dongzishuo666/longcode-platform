/**
 * AI 起草结果 → 需求表单（R2 之后的第 2 步，2026-10-28）
 *
 * 为什么走【状态级合并】而不是逐控件写 DOM：
 *   项目的唯一真源是 `state.config.req` + `syncReqUI()`（applyPreset 就是"写状态 → 重渲染"）。
 *   逐控件写 DOM 会绕开它，导致"预设填的行"和"AI 填的行"两套结构、删除/编辑逻辑分叉。
 *   这里只负责"把 spec 合并进 req"，渲染交给 syncReqUI —— 动态行/去重/联动全部复用。
 *
 * 纯函数部分（mergeSpecIntoReq / isFieldEmpty）不碰 DOM，可单独测；
 * 编排器（createSpecFillApplier）由页面注入 collectReq / syncReqUI / saveAll。
 */

/** 字段分类：决定"空"怎么判定、合并怎么走 */
export const SPEC_FILL_KINDS = Object.freeze({
    // 文本：空 = 去空白后为空
    text: ['stack', 'conSecurity', 'conPerf', 'conStyle', 'conBanned', 'constraints'],
    // 枚举按钮：空 = 仍是默认值（按钮组始终有选中项，不能用"空字符串"判定）
    enums: ['order', 'contractStrict', 'deliver', 'level'],
    // 布尔勾选：空 = false
    bools: ['withTest', 'withDeploy', 'withMigration', 'withAuthMw', 'withErrorMw', 'withEntry'],
    // 列表：空 = 长度为 0
    lists: ['features', 'invariants'],
    // 嵌套对象：空 = 内部没有任何有效内容
    objects: ['dataModel', 'authz']
});

/** 枚举字段的默认值（与表单初始选中项一致） */
export const ENUM_DEFAULTS = Object.freeze({
    order: 'auto',
    contractStrict: 'strict',
    deliver: 'multi',
    level: 'prototype'
});

const isEmptyText = (v) => !String(v == null ? '' : v).trim();

/** dataModel 是否"没有任何有效内容"（空实体/空枚举行不算内容） */
export function isDataModelEmpty(dm) {
    if (!dm || typeof dm !== 'object') return true;
    if (dm.pkType || dm.moneyUnit) return false;
    const ents = (Array.isArray(dm.entities) ? dm.entities : [])
        .filter(e => e && (e.name || (Array.isArray(e.fields) ? e.fields.length : 0)));
    if (ents.length) return false;
    const enums = (Array.isArray(dm.enums) ? dm.enums : []).filter(e => e && e.field);
    return enums.length === 0;
}

/** authz 是否"没有任何有效内容" */
export function isAuthzEmpty(a) {
    if (!a || typeof a !== 'object') return true;
    const roles = Array.isArray(a.roles) ? a.roles.filter(Boolean) : String(a.roles || '').trim();
    if (Array.isArray(roles) ? roles.length : roles) return false;
    const rules = (Array.isArray(a.rules) ? a.rules : [])
        .map(r => String((r && r.text) || r || '').trim()).filter(Boolean);
    if (rules.length) return false;
    if (a.rowLevel) return false;
    return isEmptyText(a.ownerKey);
}

/** 某字段当前是否算"空"（决定 empty 模式要不要写） */
export function isFieldEmpty(req, key) {
    const r = req || {};
    if (SPEC_FILL_KINDS.text.includes(key)) return isEmptyText(r[key]);
    if (SPEC_FILL_KINDS.enums.includes(key)) {
        return !r[key] || r[key] === ENUM_DEFAULTS[key];
    }
    if (SPEC_FILL_KINDS.bools.includes(key)) return !r[key];
    if (SPEC_FILL_KINDS.lists.includes(key)) return !(Array.isArray(r[key]) && r[key].length);
    if (key === 'dataModel') return isDataModelEmpty(r.dataModel);
    if (key === 'authz') return isAuthzEmpty(r.authz);
    return true;
}

const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

/**
 * 把 spec 合并进 req（**纯函数**，不修改入参）
 *
 * @param {object} req  当前表单状态（state.config.req）
 * @param {object} spec 后端 normalizeSpecFill 的输出
 * @param {'empty'|'overwrite'} mode empty = 只填空字段（默认，安全侧）
 * @param {string} [description] 用户那句话：goal 为空时用它补上
 * @returns {{req:object, applied:string[], skipped:string[]}}
 */
export function mergeSpecIntoReq(req, spec, mode, description) {
    const base = req && typeof req === 'object' ? { ...req } : {};
    const overwrite = mode === 'overwrite';
    const s = spec && typeof spec === 'object' ? spec : {};
    const applied = [];
    const skipped = [];

    const keys = [
        ...SPEC_FILL_KINDS.text,
        ...SPEC_FILL_KINDS.enums,
        ...SPEC_FILL_KINDS.bools,
        ...SPEC_FILL_KINDS.lists,
        ...SPEC_FILL_KINDS.objects
    ];

    for (const key of keys) {
        if (!(key in s)) continue;
        const val = s[key];
        // 后端已做过白名单/枚举/空值过滤，这里只兜"类型明显不对"的情况
        if (val === null || val === undefined) continue;
        if (typeof val === 'object' && !Array.isArray(val) && !Object.keys(val).length) continue;

        if (!overwrite && !isFieldEmpty(base, key)) {
            skipped.push(key);
            continue;
        }
        base[key] = Array.isArray(val) || (val && typeof val === 'object') ? clone(val) : val;
        applied.push(key);
    }

    // goal：spec 里刻意没有这个键（由用户输入框承担）；没有 goal 时用描述补
    if (isEmptyText(base.goal) && !isEmptyText(description)) {
        base.goal = String(description).trim().slice(0, 2000);
        applied.push('goal');
    }

    return { req: base, applied, skipped };
}

/**
 * 编排器：合并 → 写回状态 → 重渲染 → 落盘。
 * 依赖全部注入，便于单测与"调用时解析"（套件会在 boot 后覆盖 showStatus）。
 */
export function createSpecFillApplier(deps) {
    const {
        getReq, setReq, collectReq, syncReqUI, saveAll, showStatus
    } = deps || {};

    /**
     * @param {object} spec 后端返回的 spec
     * @param {object} opt { mode: 'empty'|'overwrite', description?: string }
     * @returns {{applied:string[], skipped:string[], filled:number, degraded:boolean}}
     */
    function applySpecFill(spec, opt) {
        const o = opt || {};
        if (!spec || typeof spec !== 'object' || !Object.keys(spec).length) {
            if (showStatus) showStatus('AI 没有返回可用的字段（已保留原表单）', 'warning');
            return { applied: [], skipped: [], filled: 0, degraded: true };
        }

        // 先把 DOM 上"用户刚敲、还没触发 input"的内容快照进状态，
        // 否则 syncReqUI 会用旧草稿把用户刚填的字冲掉（applyPreset 同款处理）
        if (collectReq) collectReq();

        const cur = getReq ? getReq() : {};
        const merged = mergeSpecIntoReq(cur, spec, o.mode === 'overwrite' ? 'overwrite' : 'empty', o.description);

        if (setReq) setReq(merged.req);
        if (syncReqUI) syncReqUI();
        if (saveAll) saveAll();

        const filled = merged.applied.length;
        if (showStatus) {
            if (filled) {
                const tail = merged.skipped.length
                    ? `（${merged.skipped.length} 项已有内容未覆盖）`
                    : '';
                showStatus(`✨ AI 已补全 ${filled} 项${tail}，可继续编辑`, 'success');
            } else {
                showStatus('AI 给出的字段都已有内容（可用「覆盖已填内容」重试）', 'info');
            }
        }
        return { applied: merged.applied, skipped: merged.skipped, filled, degraded: false };
    }

    return { applySpecFill, mergeSpecIntoReq, isFieldEmpty };
}
