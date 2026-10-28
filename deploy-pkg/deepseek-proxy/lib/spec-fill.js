/**
 * AI 辅助填写需求表单（/api/spec-fill，2026-10-28）。
 *
 * 职责划分对齐 lib/review.js：
 *   · 固定不变的 system prompt（→ 命中上游前缀缓存）
 *   · user prompt 组装
 *   · 模型输出的容错解析 / 白名单 / 枚举校验
 *
 * 【字段名的唯一真源是前端的 `state.config.req`】（index.html 的 collectReq）：
 * 本模块的白名单必须与它逐字对应，否则会出现"AI 填了但落不下去"或"字段被吞"。
 * 交叉校验由 _deploy/tests/test_spec_fill.mjs 断言（读前端源码比对键名）。
 */

/** 允许模型返回的顶层键（= state.config.req 的可填字段，goal 除外：goal 由用户输入框承担） */
export const SPEC_FILL_KEYS = Object.freeze([
    'stack',
    'conSecurity', 'conPerf', 'conStyle', 'conBanned', 'constraints',
    'order', 'contractStrict', 'deliver', 'level',
    'withTest', 'withDeploy', 'withMigration', 'withAuthMw', 'withErrorMw', 'withEntry',
    'features', 'dataModel', 'invariants', 'authz'
]);

/** 枚举白名单：越界一律丢弃，绝不"就近匹配"成别的选项 */
export const SPEC_FILL_ENUMS = Object.freeze({
    order: ['auto', 'dual', 'frontend', 'backend'],
    contractStrict: ['strict', 'lenient'],
    deliver: ['multi', 'single'],
    level: ['prototype', 'production'],
    pkType: ['int', 'uuid', 'business'],
    moneyUnit: ['yuan', 'cent'],
    featureMode: ['real', 'mock', 'skip']
});

/** 各文本字段的长度上限（防止模型把整篇文章塞进一个字段） */
const TEXT_CAPS = {
    goal: 2000, stack: 200, conSecurity: 500, conPerf: 500,
    conStyle: 500, conBanned: 500, constraints: 1000
};
const MAX_FEATURES = 20;
const MAX_ENTITIES = 12;
const MAX_FIELDS_PER_ENTITY = 30;
const MAX_ENUMS = 12;
const MAX_INVARIANTS = 20;
const MAX_RULES = 20;
const MAX_ROLES = 12;

/**
 * 系统提示词：**静态内容**（不放任何随请求变化的东西，否则前缀缓存失效）。
 * 刻意不放 PROJECT_PRESETS 当 few-shot —— 预设的真源在前端，
 * 复制到后端就是第二真源；每次从请求里传又会破坏缓存。
 */
export const SPEC_FILL_SYSTEM_PROMPT = `你是需求结构化助手。用户会用一两句话描述想做的软件，
你把它翻译成一份"需求表单 JSON"。只输出 JSON，不要任何解释、不要 Markdown 围栏。

字段规范（键名必须逐字一致，未提及的字段不要输出）：
{
  "stack": "技术栈，如 Node.js + Express + SQLite；不确定就空字符串",
  "conSecurity": "安全约束", "conPerf": "性能约束",
  "conStyle": "代码风格约束", "conBanned": "禁止事项", "constraints": "其他约束",
  "order": "auto|dual|frontend|backend",
  "contractStrict": "strict|lenient",
  "deliver": "multi|single",
  "level": "prototype|production",
  "withTest": true, "withDeploy": true, "withMigration": false,
  "withAuthMw": false, "withErrorMw": true, "withEntry": true,
  "features": [{ "name": "功能点，动词开头，如：下单扣库存", "mode": "real|mock|skip" }],
  "dataModel": {
    "pkType": "int|uuid|business（全项目统一；不确定就空字符串）",
    "moneyUnit": "yuan|cent（涉及金额才填）",
    "entities": [{ "name": "Order", "fields": [
      { "name": "id", "type": "int", "required": true, "boundary": "自增" }
    ]}],
    "enums": [{ "field": "Order.status", "states": "pending / shipped / refunded", "edges": "pending→shipped" }]
  },
  "invariants": ["必须始终成立的业务规则，如：库存不得为负"],
  "authz": {
    "roles": ["游客", "本人", "管理员"],
    "rules": [{ "text": "管理员可以发货和退款；用户只能看自己的订单" }],
    "rowLevel": true,
    "ownerKey": "userId"
  }
}

硬性要求：
1. 不确定的字段一律留空（空字符串 / 空数组 / 直接省略），**不要编造**。
2. order 只在需求明确要求时改，默认 "auto"；level 默认 "prototype"。
3. features 3–8 条为宜，每条一个可验证的功能。
4. 数据实体只写需求里明确提到的；没提到就不要造。
5. 输出必须是一个 JSON 对象，不能是数组或纯文本。

示例输入：做一个团队周报工具，成员提交后自动聚合成一份周报，支持导出 Markdown
示例输出：
{"stack":"Node.js + Express + SQLite","order":"dual","contractStrict":"strict","deliver":"multi","level":"prototype","withTest":true,"withErrorMw":true,"withEntry":true,"features":[{"name":"成员提交周报","mode":"real"},{"name":"按周聚合团队周报","mode":"real"},{"name":"导出 Markdown","mode":"real"}],"dataModel":{"pkType":"int","entities":[{"name":"Report","fields":[{"name":"id","type":"int","required":true,"boundary":"自增"},{"name":"memberId","type":"int","required":true,"boundary":"外键"},{"name":"week","type":"string","required":true,"boundary":"ISO 周"}]}],"enums":[]},"invariants":["同一成员同一周只能提交一份周报"],"authz":{"roles":["本人","管理员"],"rules":[{"text":"成员只能查看和编辑自己的周报；管理员可查看全部"}],"rowLevel":true,"ownerKey":"memberId"}}`;

/** user prompt 只放用户这句话（其余全在 system 里，保证前缀稳定） */
export function buildSpecFillUserPrompt({ description }) {
    return `需求描述：\n${String(description || '').trim()}`;
}

const clip = (v, max) => String(v).trim().slice(0, max);

/** 从模型输出里抠出 JSON 文本：剥围栏 → 取首 { 到末 } */
export function extractJsonText(raw) {
    let t = String(raw || '').trim();
    if (!t) return '';
    // ```json ... ``` / ``` ... ```
    const fence = /^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```$/.exec(t);
    if (fence) t = fence[1].trim();
    const first = t.indexOf('{');
    const last = t.lastIndexOf('}');
    if (first >= 0 && last > first) t = t.slice(first, last + 1);
    return t.trim();
}

/** 宽松解析：容错"尾逗号"这类高频小毛病；其余失败一律降级 */
function parseLoose(text) {
    try {
        return { value: JSON.parse(text), repaired: false };
    } catch { /* 继续尝试修复 */ }
    try {
        const fixed = text.replace(/,\s*([}\]])/g, '$1');
        return { value: JSON.parse(fixed), repaired: true };
    } catch (e) {
        return { error: e.message };
    }
}

const str = (v, max) => (typeof v === 'string' ? clip(v, max) : '');
const enumOf = (v, list) => {
    const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
    return list.includes(s) ? s : '';
};
const bool = (v) => (typeof v === 'boolean' ? v : undefined);

/** 归一化 features：只要有名就留，mode 越界回落 real */
function normalizeFeatures(v) {
    if (!Array.isArray(v)) return [];
    const out = [];
    for (const f of v) {
        if (out.length >= MAX_FEATURES) break;
        const name = typeof f === 'string' ? clip(f, 120) : str(f && f.name, 120);
        if (!name) continue;
        const mode = enumOf(f && f.mode, SPEC_FILL_ENUMS.featureMode) || 'real';
        out.push({ name, mode });
    }
    return out;
}

function normalizeDataModel(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const dm = {};
    const pk = enumOf(v.pkType, SPEC_FILL_ENUMS.pkType);
    if (pk) dm.pkType = pk;
    const mu = enumOf(v.moneyUnit, SPEC_FILL_ENUMS.moneyUnit);
    if (mu) dm.moneyUnit = mu;

    const entities = [];
    for (const e of (Array.isArray(v.entities) ? v.entities : [])) {
        if (entities.length >= MAX_ENTITIES) break;
        const name = str(e && e.name, 60);
        if (!name) continue;
        const fields = [];
        for (const f of (Array.isArray(e.fields) ? e.fields : [])) {
            if (fields.length >= MAX_FIELDS_PER_ENTITY) break;
            const fname = str(f && f.name, 60);
            if (!fname) continue;
            const row = { name: fname, type: str(f && f.type, 40) };
            if (f && f.required === true) row.required = true;
            const bd = str(f && f.boundary, 80);
            if (bd) row.boundary = bd;
            fields.push(row);
        }
        entities.push(fields.length ? { name, fields } : { name, fields: [] });
    }
    if (entities.length) dm.entities = entities;

    const enums = [];
    for (const e of (Array.isArray(v.enums) ? v.enums : [])) {
        if (enums.length >= MAX_ENUMS) break;
        const field = str(e && e.field, 60);
        if (!field) continue;
        const row = { field, states: str(e && e.states, 200) };
        const edges = str(e && e.edges, 200);
        if (edges) row.edges = edges;
        enums.push(row);
    }
    if (enums.length) dm.enums = enums;

    return Object.keys(dm).length ? dm : null;
}

function normalizeAuthz(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const out = {};
    if (Array.isArray(v.roles)) {
        const roles = v.roles.map(r => str(r, 40)).filter(Boolean).slice(0, MAX_ROLES);
        if (roles.length) out.roles = roles;
    } else {
        const r = str(v.roles, 400);
        if (r) out.roles = r;
    }
    const rules = [];
    for (const r of (Array.isArray(v.rules) ? v.rules : [])) {
        if (rules.length >= MAX_RULES) break;
        const text = typeof r === 'string' ? clip(r, 300) : str(r && r.text, 300);
        if (text) rules.push({ text });
    }
    if (rules.length) out.rules = rules;
    const rl = bool(v.rowLevel);
    if (rl !== undefined) out.rowLevel = rl;
    const ok = str(v.ownerKey, 60);
    if (ok) out.ownerKey = ok;
    return Object.keys(out).length ? out : null;
}

/**
 * 模型输出 → { spec, filledCount, degraded, parseError, raw }
 *
 * 铁律：**解析失败就一个字段都不返回**（前端据此不写任何字段）——
 * 半截污染比不填更糟：用户会以为 AI 看懂了，实则表单一半是编的。
 */
export function normalizeSpecFill(rawContent) {
    const raw = String(rawContent || '');
    const text = extractJsonText(raw);
    if (!text) {
        return { spec: {}, filledCount: 0, degraded: true, parseError: 'empty content', raw };
    }
    const parsed = parseLoose(text);
    if (parsed.error) {
        return { spec: {}, filledCount: 0, degraded: true, parseError: parsed.error, raw };
    }
    let src = parsed.value;
    // 模型偶尔把结果包成数组（[{...}]）—— 取第一个对象元素，比整份丢弃更有用；
    // 数组里没有对象才降级。这条是显式行为，不是"抠第一个 { 到最后一个 }"的副作用。
    if (Array.isArray(src)) {
        src = src.find(x => x && typeof x === 'object' && !Array.isArray(x)) || null;
    }
    if (!src || typeof src !== 'object' || Array.isArray(src)) {
        return { spec: {}, filledCount: 0, degraded: true, parseError: 'not a JSON object', raw };
    }

    const spec = {};
    // 文本
    for (const k of ['stack', 'conSecurity', 'conPerf', 'conStyle', 'conBanned', 'constraints']) {
        const v = str(src[k], TEXT_CAPS[k] || 500);
        if (v) spec[k] = v;
    }
    // 枚举（越界丢弃，不回落成别的选项）
    for (const k of ['order', 'contractStrict', 'deliver', 'level']) {
        const v = enumOf(src[k], SPEC_FILL_ENUMS[k]);
        if (v) spec[k] = v;
    }
    // 布尔勾选
    for (const k of ['withTest', 'withDeploy', 'withMigration', 'withAuthMw', 'withErrorMw', 'withEntry']) {
        const v = bool(src[k]);
        if (v !== undefined) spec[k] = v;
    }
    // 结构化
    const features = normalizeFeatures(src.features);
    if (features.length) spec.features = features;
    const dm = normalizeDataModel(src.dataModel);
    if (dm) spec.dataModel = dm;
    if (Array.isArray(src.invariants)) {
        const inv = src.invariants.map(x => str(x, 300)).filter(Boolean).slice(0, MAX_INVARIANTS);
        if (inv.length) spec.invariants = inv;
    }
    const authz = normalizeAuthz(src.authz);
    if (authz) spec.authz = authz;

    // 未知键（如模型自己造的 "database"）全部丢弃 —— 白名单之外不落任何东西
    const filledCount = Object.keys(spec).length;
    return { spec, filledCount, degraded: false, parseError: parsed.repaired ? 'repaired-trailing-comma' : null, raw };
}
