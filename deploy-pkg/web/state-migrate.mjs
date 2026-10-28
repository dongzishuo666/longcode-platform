/**
 * 存量配置的归一化 / 迁移（R2 第三步，2026-10-28 从 index.html 的 loadAll 抽出）。
 *
 * 只抽【纯函数】：进来的是"从 localStorage 读出来的原始值"，出去的是"可以安全使用的值"，
 * 不碰 DOM、不碰 fetch、不写 localStorage。持久化本身（saveAll）仍留在页面 ——
 * 它要序列化整个 state，和页面状态强耦合，抽出去只会把耦合点从 1 个变成 N 个。
 *
 * 为什么值得单抽：这些分支全是"老用户刷新一次页面就会踩到"的路径，
 * 而它们的失败方式极其隐蔽（下拉选不中、长度保护失效、脏数据带崩整个 loadAll），
 * 只有在纯函数层面才测得干净。
 */

/** 模式归一化：只认 workflow，其余（smart / normal / longcode / 空 / 未知）→ smart。
 *  normal 是 longcode 的真子集，默认选中它等于让新用户一进来就用最弱形态。 */
export function normalizeMode(m) {
    return m === 'workflow' ? 'workflow' : 'smart';
}

/** 档位归一化：只认 novice，其余（空 / 未知 / 存量缺字段）→ pro。
 *  存量用户因此默认程序员档且不弹欢迎层（已确认决策 1）。 */
export function normalizeTier(t) {
    return t === 'novice' ? 'novice' : 'pro';
}

/**
 * 上下文窗口兜底：老配置没有这个字段（或存了脏值）→ 按供应商预设补上。
 * 不补的话长度保护会走 FALLBACK，对 32K 窗口的供应商（Kimi / Ollama）
 * 等于保护失效，续写会一路撞到上游报错。
 *
 * @param {object} cfg 配置对象（读 contextTokens / provider）
 * @param {(provider:string)=>object|null} ctxOfProvider 供应商 → 预设（页面注入）
 * @param {number} fallback 兜底窗口
 */
export function ensureContextTokens(cfg, ctxOfProvider, fallback) {
    const ctx = Number(cfg && cfg.contextTokens);
    if (Number.isFinite(ctx) && ctx >= 1000) return ctx;
    const preset = typeof ctxOfProvider === 'function' ? ctxOfProvider(cfg && cfg.provider) : null;
    if (preset && Number.isFinite(Number(preset.ctx)) && Number(preset.ctx) >= 1000) {
        return Number(preset.ctx);
    }
    return fallback;
}

/**
 * 用量状态的容错合并：历史上 state.usage 未初始化时存出过字符串 "undefined"，
 * JSON.parse 会炸 —— 单条脏数据不该带崩整个 loadAll（那样会走 catch → 新建会话，
 * 用户看起来就是"数据全没了"）。
 *
 * @param {object} prev 现有 usage
 * @param {string} rawText localStorage 里的原文
 */
export function mergeUsage(prev, rawText) {
    const base = prev && typeof prev === 'object' ? prev : {};
    if (typeof rawText !== 'string' || !rawText.trim()) return { ...base };
    try {
        const v = JSON.parse(rawText);
        if (!v || typeof v !== 'object' || Array.isArray(v)) return { ...base };
        return { ...base, ...v };
    } catch {
        return { ...base };
    }
}

/** 当前会话 ID 校正：不存在的 ID（会话被删、脏数据）→ 落到第一条。 */
export function pickCurrentConvId(conversations, currentId) {
    const list = Array.isArray(conversations) ? conversations.filter(c => c && c.id) : [];
    if (!list.length) return currentId || null;
    return list.some(c => c.id === currentId) ? currentId : list[0].id;
}

/**
 * 配置迁移的组合入口（loadAll 里原来那一串 normalizeX 调用）。
 * 供应商 / 模型的归一化规则留在页面（它们绑定 PROVIDERS 表），以函数形式注入。
 *
 * @param {object} raw 从 localStorage 解析出来的配置（可能是残缺的老配置）
 * @param {object} deps { normalizeProvider, normalizeModel, defaultProvider, ctxOfProvider, fallbackCtx }
 * @returns {object} 迁移后的新对象（不修改入参）
 */
export function migrateConfig(raw, deps) {
    const d = deps || {};
    const cfg = { ...(raw || {}) };

    // 存量供应商迁移：老配置没有 provider 字段，缺省 deepseek —— 老用户本来就只连
    // DeepSeek，且 providerBase 也为空（沿用后端部署者配的地址），升级前后行为一致。
    cfg.provider = typeof d.normalizeProvider === 'function'
        ? d.normalizeProvider(cfg.provider || d.defaultProvider)
        : (cfg.provider || d.defaultProvider);

    // 存量模型迁移：V4-Pro 已淘汰、上游不再接受，但老 localStorage 里可能还存着。
    cfg.model = typeof d.normalizeModel === 'function' ? d.normalizeModel(cfg.model) : cfg.model;

    cfg.mode = normalizeMode(cfg.mode);
    cfg.tier = normalizeTier(cfg.tier);
    cfg.contextTokens = ensureContextTokens(cfg, d.ctxOfProvider, d.fallbackCtx);

    return cfg;
}

// 工厂形式（与质量闸门三个模块、prompt-assembly 同款）：页面只挂这一个入口，
// 经典脚本取用，jsdom 侧手动赋给 window。
export function createStateMigrate() {
    return {
        normalizeMode,
        normalizeTier,
        ensureContextTokens,
        mergeUsage,
        pickCurrentConvId,
        migrateConfig
    };
}
