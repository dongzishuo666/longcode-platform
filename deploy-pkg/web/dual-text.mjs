/**
 * 纯函数模块：契约双端一致性的「定向修复」文本逻辑。
 *
 * 与 quality-text.mjs 同一模式：只放不碰 DOM、不读全局状态的函数，
 * Node 单测（_deploy/tests/dual-text.test.mjs）直接 import 同一份代码。
 *
 * 这里装的是 P0-2 引入的最复杂的一段逻辑（一致性只报不修 → 定向修复闭环）。
 * 它此前只能通过 jsdom 间接测试；抽出来后可直接用 node:test 覆盖。
 *
 * 注意依赖方向：本模块 import quality-text.mjs（extractCodeBlocks），
 * 而 quality-text.mjs 不 import 本模块 —— 无循环。
 */

import { extractCodeBlocks } from './quality-text.mjs';

// ==================== 记忆库的契约侧推导（纯函数，可单测） ====================

/**
 * 从契约推导场景标签：记忆召回的 filter 参数。
 * 推导规则与 prompt 层规则、findClosureGaps/findStateMachineGap 的判据保持一致
 * （同一套场景词汇，避免三处各说各话）。
 *
 * @param {object} contract
 * @returns {string[]} 场景标签（鉴权/状态机/CRUD/分页/协作/看板/契约）
 */
export function inferSceneTags(contract) {
    const tags = new Set();
    if (!contract) return [];
    const text = JSON.stringify(contract);
    const paths = (contract.apis || []).map(a => String((a && a.path) || ''));

    if (paths.some(p => /login|logout|auth|token|session|signin|signout/i.test(p))) tags.add('鉴权');
    if (/position|sortorder|sort_order|rank|orderindex|order_index/i.test(text)) tags.add('看板');
    if (paths.some(p => /reorder|重排/i.test(p))) tags.add('看板');
    // 有集合端点 → 大概率涉及分页/筛选
    if ((contract.apis || []).some(a => a && String(a.method || '').toUpperCase() === 'GET'
        && ((a.request || {}).query || []).length)) tags.add('分页');
    // 有写方法 → CRUD
    if ((contract.apis || []).some(a => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(String(a.method || '').toUpperCase()))) tags.add('CRUD');
    if (/assigneeId|ownerId|reviewerId|memberId|creatorId|userId|handlerId/i.test(text)) tags.add('协作');
    if (/status|state/i.test(text)) tags.add('状态机');
    tags.add('契约');   // 所有生成都基于契约，恒定带上
    return [...tags];
}

/**
 * 从契约提取召回关键词：接口路径分段 + DTO 字段名 + 请求参数名。
 * 上限 40 个（recall 的 keywords 上限 50，留余量）。
 */
export function contractKeywords(contract) {
    const out = new Set();
    if (!contract) return [];
    for (const a of (contract.apis || [])) {
        for (const seg of String((a && a.path) || '').split('/')) {
            const s = seg.replace(/^\{|\}$/g, '').trim();
            if (s && s.length >= 2 && !/^api$/i.test(s)) out.add(s);
        }
        for (const p of [...((a.request || {}).query || []), ...((a.request || {}).path || [])]) {
            if (p && p.name && String(p.name).length >= 2) out.add(String(p.name));
        }
    }
    for (const cd of (contract.common_dto || [])) {
        for (const f of (cd.fields || [])) {
            if (f && f.name && String(f.name).length >= 2) out.add(String(f.name));
        }
    }
    return [...out].slice(0, 40);
}

/**
 * issue type → 规则句式模板：把校验偏差改写成【可执行规则】。
 * 用户方案的核心要求：rule 不写"注意安全性"这种空话，要写成祈使句规则。
 * 具体案例放 badCase（issue.message 原文），模板保证 rule 可执行。
 */
const RULE_TEMPLATES = {
    dto_type_mismatch: '字段类型必须与契约逐字一致，禁止按语言或数据库习惯替换（如 UUID string 不得改成自增 number、string 不得改成 number）',
    dto_field_missing: '契约声明的必填字段必须实现，不得缺失；可选字段未实现需标注',
    dto_field_extra: '禁止新增契约外字段；确有需要先在契约中定义',
    enum_out_of_range: '枚举取值必须与契约声明一致，禁止使用契约外枚举值，禁止把枚举外的值当默认值',
    crud_gap: '可创建/更新的资源必须配套 DELETE 端点与权限说明；确实不允许删除需在契约中说明理由',
    auth_gap: '有登录/令牌端点必须包含 logout，并使 token 失效或轮换；禁止用前端清本地存储代替登出',
    collab_gap: '协作体系必须内置保护规则：最后一名管理员不可降级或移除、owner 不可被移除、用户不能移除自己',
    state_machine_gap: '状态字段必须在契约中声明枚举、初始状态（创建只允许它）与合法流转，前后端都要校验',
    foreign_key_gap: '指向人的外键字段必须用成员列表下拉选择（禁止手填 ID），并校验成员存在且属于本项目',
    sort_write_gap: '排序字段必须有真实写入链路：拖拽后调用批量重排接口事务性更新 position，禁止只在前端本地排序',
    unused_query_param: '契约声明的查询参数必须在 UI 落地为筛选/排序/分页控件，禁止写死 pageSize 一次性拉回',
    missing_backend: '契约定义的接口必须全部实现，不得缺路由',
    frontend_no_backend: '前端只能调用契约内接口，调用前确认后端已实现',
    unknown_frontend: '禁止调用契约外接口',
    method_mismatch: '接口请求方法必须与契约一致',
};

/** issue type → 场景标签（与后端 lib/memories.js 的 ISSUE_TAG_MAP 保持一致） */
const ISSUE_TYPE_TAGS = {
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

/** issue type → 场景标签（recurrence check 判断"场景是否出现过"用） */
export function issueTypeTag(type) {
    return ISSUE_TYPE_TAGS[type] || [];
}

/** issue → 记忆候选（规则句式 + 原案例）。未覆盖的 type 退回通用句式 */
/**
 * 自动沉淀【不升级】的 issue 类型。
 *
 * 这些类型在 checkConsistency 里就是 medium 提示级，消息原文写着
 * “该侧可能不使用，需人工确认”——把它们自动入库成记忆违背原意：
 * 通用包装/会话类 DTO（PageResult/ApiResponse/AuthSession）在前端没定义是正常的。
 *
 * 2026-10-19 线上实测：一次生成 36 条 dto_missing 全进了 pending 且全是 L1，
 * 占满召回上限、把真硬约束挤出——这是这次加过滤的直接原因。
 */
const NO_MEMORY_TYPES = new Set([
    'dto_missing',        // 该侧可能不使用这个 DTO
    'ambiguous_backend',  // 多个候选后端实现，需人工判断
    'ambiguous_pair',     // 前后端配对不明确，需人工判断
]);

/**
 * issue → 记忆候选。**按严重度分层**，不再无差别升级成 L1。
 *
 * 分层规则（2026-10-19 修，依据线上实测教训）：
 *   high   → L1 block   真硬约束（类型不一致、必填字段缺失），可占用召回上限
 *   medium → L3 important 场景性提示（枚举越界、查询参数未落地），
 *            只在命中场景时注入，不挤占 L1 配额
 *   low / 过滤类型 → null（不入库）
 *
 * @param {object} issue 一致性校验 issue
 * @returns {object|null} 候选，或 null（不该沉淀）
 */
export function issueToMemoryCandidate(issue) {
    if (!issue) return null;
    const sev = issue.severity;
    if (sev !== 'high' && sev !== 'medium') return null;      // low 及未知级别不入库
    if (NO_MEMORY_TYPES.has(String(issue.type || ''))) return null;

    const rule = RULE_TEMPLATES[issue && issue.type]
        || `必须修正契约一致性问题：${String((issue && issue.message) || '').slice(0, 120)}`;
    return {
        type: sev === 'high' ? 'L1' : 'L3',
        rule,
        sceneTags: [],
        trigger: `契约校验发现 ${issue && issue.type || 'unknown'} 偏差时`,
        badCase: String((issue && issue.message) || '').slice(0, 500),
        source: `consistency:${(issue && issue.type) || 'unknown'}:${(issue && issue.path) || ''}`,
        issueType: String((issue && issue.type) || ''),
        severity: sev === 'high' ? 'block' : 'important',
    };
}


/** 自动对齐轮数上限（token 成本最多翻倍） */
export const DUAL_MAX_REPAIR_ROUND = 2;
/** 单轮最多列给模型的问题条数 */
export const DUAL_REPAIR_MAX_ISSUES = 8;
/** 回传给模型的现有代码长度上限 */
export const DUAL_REPAIR_CTX_MAX = 30000;

/**
 * 挑出「与问题相关的文件」作为修复上下文。
 * 整段代码能放下就整段放（模型才能完整重写该端）；放不下时只挑命中接口名的代码块，
 * 其余文件明确要求保持不变，避免 token 爆炸。
 */
export function pickRepairContext(md, issues) {
    if (!md) return '';
    if (md.length <= DUAL_REPAIR_CTX_MAX) return md;
    const blocks = extractCodeBlocks(md);
    const keys = (issues || []).map(i => String(i.path || ''))
        .flatMap(p => p.split('/').filter(s => s && !/^\{/.test(s)))
        .filter(s => s.length > 2);
    const hit = blocks.filter(b => keys.some(k => (b.code || '').includes(k)));
    const picked = hit.length ? hit : blocks;
    let out = picked
        .map(b => '```' + (b.lang || '') + '\n' + (b.code || '') + '\n```')
        .join('\n\n');
    if (out.length > DUAL_REPAIR_CTX_MAX) out = out.slice(0, DUAL_REPAIR_CTX_MAX);
    return out + '\n\n（以上是与问题相关的文件；其余文件保持不变，不要输出）';
}

/** 一致性问题 → 给模型的修复指令 */
export function buildDualRepairPrompt(side, issues, contract, ctx, contractText) {
    const highs = (issues || []).filter(i => i.severity === 'high');
    const todo = highs.slice(0, DUAL_REPAIR_MAX_ISSUES).map(i => {
        switch (i.type) {
            case 'missing_backend':
                return `- 契约已定义 ${i.method || ''} ${i.path}，后端未实现：请补全该路由与控制层`;
            case 'frontend_no_backend':
                return `- 前端调用了 ${i.method || ''} ${i.path}，后端无对应实现：请补全`;
            case 'unknown_frontend':
                return `- 前端调用了契约外接口 ${i.method || ''} ${i.path}：请改为调用契约内接口`;
            case 'method_mismatch':
                return `- ${i.path} 请求方法不一致：${i.message}`;
            default:
                return `- ${i.path}：${i.message}`;
        }
    }).join('\n');

    const origin = side === 'frontend'
        ? '只输出前端文件（页面、组件、接口调用封装），接口严格遵循契约，不写后端实现。'
        : '只输出后端文件（路由 / 控制器、服务层），接口严格遵循契约，不写前端页面。';

    const L = [
        `上一轮生成的${side === 'frontend' ? '前端' : '后端'}代码与接口契约存在严重不一致，`,
        '请修正后【完整重新输出该端所有文件】。',
        '',
        '需要修正的问题：',
        todo,
        ''
    ];
    if (contractText) {
        L.push('API 契约（唯一基准，JSON）：', contractText, '');
    } else {
        L.push('接口契约：', '```json', JSON.stringify(contract, null, 2), '```', '');
    }
    if (ctx) {
        L.push('当前该端代码：', ctx, '');
    }
    L.push(
        '【要求】',
        `1. ${origin}`,
        '2. 只修上述不一致，其余保持不变；不要输出解释，不要新增契约外接口。',
        '3. 每个代码块前标注文件路径，代码块必须指定语言且完整闭合。',
        '4. 接口路径 / 方法 / 字段名必须与契约逐字一致。',
        '5. 禁止纯格式化 / 重排 / 搬家 / 改名 / 换等价写法（如把 axios 换成 fetch、把字符串拼接换成 URLSearchParams、只调整 import 顺序）来冒充修复 —— 每个修改必须让上面列出的某个问题真正消失；确实无法修复的问题保留原状，并在代码注释里标注「修复待确认」。'
    );
    return L.join('\n');
}

/**
 * 修复前后「实质是否变化」的归一化比较。
 *
 * 背景（2026-10-16 实测）：定向修复是「完整重写整端 + 复检只看结构化是否对得上」，
 * 模型可以用搬家、加注释、改名、换等价写法来让 checkDualConsistency 通过，
 * 而真实缺陷零改动。复检（结构化比对）看不到「实质没修」。
 *
 * 这里在【采纳修复前】做一道 diff：把两侧归一化（去注释、去空白、import 排序），
 * 实质内容一模一样就判为「假修复」丢弃。
 *
 * 诚实的边界：归一化能抓「完全没变」（搬家 / 加注释 / 改空白 / 调整 import），
 * 抓不了「改了但改错地方」（改名、换等价写法仍是实质文本变化）。所以它是
 * 「兜住最恶劣的一类假修复」，不是万能检测。
 *
 * @param {string} code
 * @returns {string}
 */
export function normalizeForDiff(code) {
    return String(code == null ? '' : code)
        .replace(/\/\*[\s\S]*?\*\//g, '')            // 块注释
        .replace(/(^|\n)\s*\/\/[^\n]*/g, '')         // 整行注释 //
        .replace(/(^|\n)\s*#[^\n]*/g, '')            // 整行注释 #（Python/Shell）
        .replace(/[ \t]+(?:\/\/|#)[^\n]*/g, '')      // 行内注释（代码后的 // 或 #）
        .replace(/<!--[\s\S]*?-->/g, '')              // HTML 注释
        .replace(/^\s*import[^\n]*$/gm, '')           // import 行（排序差异不算变化）
        .replace(/^\s*from[^\n]*import[^\n]*$/gm, '') // Python from ... import ...
        .replace(/\s+/g, ' ')                          // 压缩空白
        .trim();
}

/**
 * @param {string} before 修复前
 * @param {string} after  修复后
 * @returns {boolean} 是否有实质变化（false = 判为假修复）
 */
export function isSubstantiveChange(before, after) {
    return normalizeForDiff(before) !== normalizeForDiff(after);
}

/** 一致性校验结果 → 报告 markdown */
export function renderConsistencyReport(data, note) {
    const s = (data && data.summary) || {};
    const L = [];
    L.push('## 🔗 契约一致性校验');
    L.push('');
    L.push(`契约 ${s.contract || 0} 个接口 · 前端调用 ${s.frontend || 0} · 后端实现 ${s.backend || 0}`);
    L.push('');
    L.push(`**严重 ${s.high || 0} · 中等 ${s.medium || 0} · 提示 ${s.low || 0}**`);
    L.push('');
    if (!data) {
        L.push('⚠️ 校验服务未返回结果，本次跳过一致性校验（不影响已生成的代码）');
        return L.join('\n');
    }
    L.push(data.ok
        ? '✅ **三方一致**：没有发现严重不一致'
        : '⚠️ **存在严重不一致**：建议以契约为准，修正对应端的代码');

    const issues = data.issues || [];
    if (issues.length) {
        L.push('');
        L.push('| 级别 | 位置 | 接口 | 说明 |');
        L.push('| --- | --- | --- | --- |');
        issues.slice(0, 30).forEach(i => {
            L.push(`| ${i.severity} | ${i.position} | \`${i.path}\` | ${i.message} |`);
        });
        if (issues.length > 30) {
            L.push('');
            L.push(`（另有 ${issues.length - 30} 条未展示）`);
        }
    }
    L.push('');
    if (note) L.push(note, '');
    L.push('> 校验方式：本地模式提取（零 token）+ 结构化比对。语义层面的差异可交由小模型抽查。');
    return L.join('\n');
}

/** 自动对齐结果 → 追加到报告里的一句话说明 */
export function repairNote(log, ok) {
    if (!log || !log.length) return '';
    // 无效轮要单独说：历史症状"严重 9→9"——每轮都输出改动但数字不动。
    // 只在文案里写"剩余问题请人工修正"看不出"自动修复已经空转"，
    // 用户会以为再多等几轮就能修好。ineffective 必须显式。
    const stalled = log.some(x => x.action === 'ineffective');
    const done = log
        .filter(x => x.side)
        .map(x => `第 ${x.round} 轮修${x.side === 'frontend' ? '前端' : '后端'}`)
        .join('、');
    const from = (log.find(x => x.high !== undefined) || {}).high;
    const to = (log[log.length - 1]).high;
    if (ok) {
        return `> 🔧 已自动对齐（${done}）：严重不一致 ${from} → 0，现已三方一致`;
    }
    return stalled
        ? `> 🔧 自动对齐无效（${done}）：严重不一致 ${from} → ${to}，多轮修复后数字未再下降，`
          + '已停止自动修复 —— 请以契约为准人工修正'
        : `> 🔧 已尝试自动对齐（${done}）：严重不一致 ${from} → ${to}，剩余问题请以契约为准人工修正`;
}
