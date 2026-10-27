/**
 * 中英文切换（2026-10-23）。
 *
 * 设计取舍：不逐处加 data-i18n 标记（界面文案 177 条，改标记既伤可读性又容易漏），
 * 改为【按中文原文查字典】的 DOM 遍历替换：
 *   · 文本节点：trim 后整串命中字典才替换，保留原有空白；
 *   · placeholder / title：同样按原文命中；
 *   · 切回中文时用改之前存下的原文还原（不依赖反向字典，避免双向不一致）。
 *
 * 刻意不翻译的区域（否则会破坏用户数据/代码）：
 *   #chatInner（对话内容，含模型输出的中文注释）、textarea、pre、code、
 *   .plan-editor、#systemPrompt、[data-no-i18n]。
 *
 * 边界（诚实说明）：运行期动态文案（状态栏 showStatus 的模板串、一致性报告正文）
 * 仍是中文 —— 它们是带数据的模板，静态字典匹配不到；后续要用 t() 逐处改造。
 */

export const ZH2EN = {
    // ===== 顶栏 / 侧栏 =====
    '智能代码生成平台': 'AI Code Generation Platform',
    '智能代码生成': 'AI Code Gen',
    '新建对话': 'New chat',
    '新对话': 'New chat',
    // ===== 多模型（2026-10-24 放开多模型接入）=====
    '模式': 'Mode',
    '供应商': 'Provider',
    '通义千问': 'Qwen',
    '月之暗面 Kimi': 'Moonshot Kimi',
    'Ollama（本地）': 'Ollama (local)',
    '自定义…': 'Custom…',
    '模型名': 'Model name',
    '模型上下文窗口（token）。续写估算到 85% 会主动停止，避免撞上下文窗口报错':
        'Model context window (tokens). Continuation stops at 85% to avoid hitting the window limit.',
    '上游地址（留空用默认）': 'Upstream base URL (blank = default)',
    '智能生成': 'Smart generation',
    '普通模式': 'Standard',
    '长代码模式': 'Long code',
    '需求工作流': 'Workflow',
    // ===== 档位（第 0 层，2026-10-26：编程小白 / 程序员）=====
    // 注意与上面「模式」区分：档位是用户分层，模式是输入方式，两层并存。
    '档位': 'Tier',
    '编程小白': 'Beginner',
    '程序员': 'Programmer',
    '编程小白：极简入口，质检强制开启；程序员：完整控制':
        'Beginner: minimal UI, quality gates always on; Programmer: full control',
    '展开高级工具（系统提示词 / 安全基线 / 修复记录等）':
        'Expand advanced tools (system prompt / security baseline / fix log etc.)',
    '编程小白模式': 'Beginner mode',
    '程序员模式': 'Programmer mode',
    '你更想怎么用这个平台？': 'How would you like to use this platform?',
    '选择后可随时在顶部「档位」里切换，不影响已有内容':
        'You can switch anytime via the Tier selector at the top; nothing you made is affected',
    '我只会说人话，你帮我搞定技术细节': 'I describe what I want in plain words — you handle the technical details',
    '我要完整控制技术栈、契约和生成流程': 'I want full control over the stack, contracts and generation flow',
    '开始': 'Start',
    '说说你想做什么': 'Tell me what you want to build',
    '🌐 网站': '🌐 Website',
    '📱 小程序': '📱 Mini program',
    '⚙️ 后端 API': '⚙️ Backend API',
    '📜 脚本工具': '📜 Script tool',
    '✨ 其它': '✨ Other',
    '比如：做一个能记账的网页，数据存本地': 'e.g. a web page for bookkeeping, data stored locally',
    '🚀 开始生成': '🚀 Generate',
    '▸ 高级模式': '▸ Advanced',
    '▾ 收起高级模式': '▾ Collapse advanced',
    '类型与技术栈只是建议，模型可以按需求自行调整': 'Type and stack are only suggestions — the model may adapt them to your needs',
    '更多': 'More',
    '用大白话说说你想要什么，Ctrl+Enter 发送': 'Describe what you want in plain words, Ctrl+Enter to send',
    // ===== 空白态模板卡（2026-10-27：补 saas 孤儿卡 + 从空白开始） =====
    // 注：'SaaS 多租户' 在下方记忆库区已有词条（reqPresets 按钮用），不再重复
    '租户隔离、成员邀请与角色、按租户过滤所有查询':
        'Tenant isolation, member invites & roles, every query filtered by tenant',
    '多租户': 'Multi-tenant',
    '隔离': 'Isolation',
    '配额': 'Quota',
    '从空白开始': 'Start from scratch',
    '不套预设，自由描述你想要什么': 'No preset — describe what you want freely',
    '自定义': 'Custom',
    '预览修复': 'Preview fixes',
    '👁 预览': '👁 Preview',
    '🔧 修复': '🔧 Fixes',
    '修复': 'Fix',
    '记录': 'Log',
    '📦 项目': '📦 Project',
    '挂载': 'Mount',
    '挂载项目': 'Mount project',
    '挂载到此会话': 'Mount into this conversation',
    '已挂载': 'Mounted',
    '把历史会话的项目资产（符号表/契约/改动记录）挂到当前会话': 'Mount a past conversation\'s project assets (symbols, contract, change log) into this conversation',
    '把一个历史会话的项目资产（符号表/契约/改动记录）挂到当前会话': 'Mount a past conversation\'s project assets (symbols, contract, change log) into this conversation',
    '把一个历史会话的资产挂到当前会话：符号表（知道有哪些文件和函数）、契约（一致性校验的基准）、改动记录（之前踩过的坑）。只挂载摘要，不复制代码全文。': 'Mount a past conversation\'s assets: symbols (what files/functions exist), contract (basis for consistency checks), change log (past pitfalls). Only summaries are mounted, not full code.',
    '当前会话还没挂载项目': 'No project mounted in this conversation',
    '没有其他会话可挂载': 'No other conversations to mount',
    '该会话还没有可挂载的资产（没有代码块、契约或符号）': 'That conversation has nothing to mount (no code blocks, contract, or symbols)',
    '不能挂载当前会话自身': 'Cannot mount the current conversation into itself',
    '代码块': 'code blocks',
    '符号文件': 'symbol files',
    '有契约': 'has contract',
    '条改动': 'changes',
    '（无资产）': '(no assets)',
    '未命名项目': 'Untitled project',
    '条改动记录': 'change records',
    '已丢弃': 'Discarded',
    '复检通过': 'Recheck passed',
    '复检未通过': 'Recheck failed',
    '复检：无法判定': 'Recheck: undetermined',
    '别处还有同类': 'similar issue elsewhere',
    '未采纳': 'Not applied',
    '该修复未采纳（复检未通过或没有把握定位），无需回滚': 'This fix was not applied (recheck failed or location uncertain); nothing to revert',
    '复检显示这条问题仍存在，改了等于没改': 'Recheck shows the issue still exists — the change achieved nothing',
    '与原代码没有实质差别（可能只是重排或加注释）': 'No substantive change (reorder or comment only)',
    '在原始代码里找不到要替换的片段': 'The original snippet to replace was not found',
    '同一片段出现多处，无法判断该改哪一处': 'The snippet appears multiple times; cannot tell which one',
    '本次使用了代码压缩，行号不可信且缺少锚点': 'Code was compressed; line numbers are unreliable and no anchor was given',
    '与另一条修复的区间重叠': 'Overlaps another fix',
    '行号越界': 'Line number out of range',
    '条未采纳': 'not applied',
    '修复记录': 'Fix log',
    '开启后，自动修正只登记不写回；在「修复记录」里逐条确认应用': 'When on, auto-fixes are only logged, not written back; confirm each one in Fix log',
    '查看自动修正记录，可逐条回滚（改动前的内容会完整还原）': 'Review auto-fix history and revert individually (original content is fully restored)',
    '自动修正会记在这里。回滚会把改动前的内容完整还原；改不回去时会明确说明原因，不会瞎改。': 'Auto-fixes are logged here. Revert restores the original content exactly; if it cannot be located, you get a clear reason instead of a wrong edit.',
    '全部回滚': 'Revert all',
    '还没有修复记录': 'No fix history yet',
    '已应用': 'Applied',
    '待确认': 'Pending',
    '已回滚': 'Reverted',
    '锚点定位': 'Anchored',
    '行号定位': 'By line number',
    '按行号（无锚点）': 'By line (no anchor)',
    '回滚': 'Revert',
    '应用': 'Apply',
    '重新应用': 'Re-apply',
    '👁 预览修复已开启：自动修正只登记，不直接改代码': '👁 Preview on: auto-fixes are only logged, code is not modified',
    '自动修正已恢复正常（直接改代码，可在修复记录里回滚）': 'Auto-fix restored: code is modified directly and can be reverted from the fix log',
    '✅ 已应用该修复': '✅ Fix applied',
    '↩️ 已回滚该修复': '↩️ Fix reverted',
    '没有可回滚的修复': 'Nothing to revert',
    '当前会话没有可修改的消息': 'No message to modify in this conversation',
    '⚠️ 这段代码在当前内容里出现多处，无法判断该改哪一处，请手工处理': '⚠️ This snippet appears multiple times; cannot tell which one to change — please edit manually',
    '👁 已暂存': '👁 Staged',
    '条修复，点「修复记录」确认应用': 'fix(es); open Fix log to confirm',
    '⚠️ 修正后语法校验未通过，已丢弃本次修正（原代码未改动）': '⚠️ Post-fix syntax check failed; the fix was discarded (code untouched)',
    '条修复无法安全定位': 'fix(es) could not be located safely',
    '已保留原样待人工处理': 'left untouched for manual review',
    '自由对话 + 自动续写 + 质量闸门（🧩 可关）':
        'Chat + auto-continue + quality gate (toggle with 🧩)',
    '结构化引导：需求表单 → 方案评审 → 生成代码':
        'Guided: requirement form → plan review → code',
    '模型': 'Model',
    // 2026-10-24 多模型接入新增的三个顶栏标签
    '供应商': 'Provider',
    '上游地址': 'Upstream URL',
    '上下文': 'Context',
    '温度': 'Temp',
    '接口': 'API',
    '密钥': 'Key',
    '令牌': 'Token',
    '服务端启用 APP_TOKEN 时才需要填；用于防止服务器被当成免费代理':
        'Only needed when APP_TOKEN is enabled server-side',
    '收起会话列表': 'Collapse conversations',
    '展开会话列表': 'Expand conversations',
    '会话列表': 'Conversations',
    '搜索对话': 'Search chats',
    '没有匹配的对话': 'No matching chats',
    '清除': 'Clear',

    // ===== 空状态 / 方案面板 =====
    '开始你的第一次生成': 'Start your first generation',
    '描述需求，': 'Describe it, ',
    '自动交付可运行的双端工程': 'get a runnable full-stack app',
    '先定契约，再并行生成前后端；每段代码都过零 token 静态校验与语义审查。':
        'Contract first, then parallel frontend/backend — every block passes zero-token static checks and semantic review.',
    '契约双端': 'Contract-first',
    '质量闸门': 'Quality gate',
    '一致性自动对齐': 'Auto-reconcile',
    '安全基线': 'Security baseline',
    '项目记忆': 'Project memory',
    '从一个场景开始': 'Start from a scenario',
    '点击预填结构化需求': 'click to prefill structured requirements',
    '迷你商城': 'Mini shop',
    '下单事务、防超卖、金额整数分、行级归属':
        'Order transaction, oversell guard, integer cents, row-level ownership',
    '事务': 'txn',
    '防超卖': 'no oversell',
    '状态机': 'state machine',
    '后台管理': 'Admin console',
    '成员与角色、分页列表、删除权限校验':
        'Members & roles, paginated lists, permission checks on delete',
    '分页': 'paging',
    '审计': 'audit',
    '协作看板': 'Team board',
    '任务状态机、指派归属、只能改自己的':
        'Task state machine, assignee ownership, own-records only',
    '归属': 'ownership',
    '看板': 'board',
    '生成流水线': 'Pipeline',
    '需求解析': 'Requirement',
    '契约生成': 'Contract',
    '代码生成': 'Codegen',
    '审查与对齐': 'Review',
    '等待': 'waiting',
    '进行中': 'running',
    '完成': 'done',
    '📋 实施方案（可直接编辑）': '📋 Plan (editable)',
    '确认后再生成代码': 'Review before generating code',
    '🧩 闭环完整性检查': '🧩 Closure check',
    '🧩 按建议补全契约': '🧩 Complete contract',
    '✅ 按此方案生成代码': '✅ Generate code',
    '🔄 重新分析': '🔄 Re-analyze',
    '✖ 放弃': '✖ Discard',

    // ===== 输入区 =====
    '🖼️ 图片': '🖼️ Image',
    '📄 代码文件': '📄 Code file',
    '支持 Markdown 格式 · Ctrl+Enter 发送': 'Markdown supported · Ctrl+Enter to send',
    '⏹ 停止生成': '⏹ Stop',
    '发送': 'Send',
    '输入消息，Ctrl+Enter 发送': 'Type a message, Ctrl+Enter to send',

    // ===== 需求面板骨架 =====
    '📋 需求输入': '📋 Requirements',
    '前三层必填，高级选项可留空': 'First 3 required; advanced optional',
    '▸ 高级选项（4-7 层）': '▸ Advanced (layers 4-7)',
    '▸ 高级选项（4-9 层）': '▸ Advanced (layers 4-9)',
    '▾ 收起高级选项': '▾ Hide advanced',
    '项目预设：': 'Presets:',
    '后台管理': 'Admin',
    '商城下单': 'E-commerce',
    '协作工具': 'Collaboration',
    'SaaS 多租户': 'SaaS multi-tenant',

    // ===== 第 1-3 层 =====
    '功能与最终效果': 'Goal & outcome',
    '必填': 'Required',
    '技术栈与语言': 'Tech stack',
    '原生三件套': 'Vanilla HTML/CSS/JS',
    '生成顺序': 'Generation order',
    '🤖 自动识别': '🤖 Auto',
    '按需求同时产出前后端': 'Frontend + backend together',
    '⚡ 契约双端': '⚡ Contract-first',
    '先定契约，前后端并行生成': 'Contract first, parallel generation',
    '🎨 先前端': '🎨 Frontend first',
    '含 mock 数据，后端后续补': 'With mocks; backend later',
    '⚙️ 先后端': '⚙️ Backend first',
    '附接口文档，前端后续补': 'With API docs; frontend later',
    '契约严格度': 'Contract strictness',
    '严格模式禁止改字段名/自补枚举': 'Strict mode forbids renaming fields or inventing enum values',
    '🔒 严格按契约': '🔒 Strict',
    '一字不改，缺口只报告': 'No changes; report gaps only',
    '🔧 允许补全': '🔧 Allow completion',
    '但必须写偏离清单': 'Must include a departure list',
    '要做什么？最终达成什么效果？例：团队周报汇总工具，成员提交后自动聚合成一份周报，支持导出 Markdown':
        'What to build and what should it achieve? e.g. a weekly report aggregator that merges submissions and exports Markdown',
    '例：TypeScript + React + Vite 前端，Node.js + Express + SQLite 后端':
        'e.g. TypeScript + React + Vite frontend, Node.js + Express + SQLite backend',

    // ===== 第 4 层约束 =====
    '约束与补充要求': 'Constraints',
    '可按需填': 'Optional',
    '拆成小块是为了让平台逐类落实——挤在一个大文本框里，安全策略容易被性能要求淹没。':
        'Split by category so nothing gets buried in one big text box.',
    '安全策略': 'Security',
    '性能与规模': 'Performance & scale',
    '代码风格': 'Code style',
    '禁用项': 'Banned',
    '其他约束': 'Other',
    '密码长度规则、access/refresh 有效期、refresh 是否轮换、是否限流，例：密码至少 8 位且含大小写':
        'Password rules, token TTL, refresh rotation, rate limiting',
    '列表量级、分页上限、响应时间要求，例：列表预计万级，分页每页最多 50':
        'List size, page limits, response time. e.g. 10k rows, max 50 per page',
    '分层约定、单文件行数、命名规范，例：单文件不超过 300 行、服务层不写 SQL':
        'Layering, file length, naming. e.g. max 300 lines per file',
    '禁止使用的技术/库/特性，例：禁止引入 jQuery、不支持 IE':
        'Banned tech, libraries or features. e.g. no jQuery, no IE',
    '以上四类之外的补充要求': 'Anything outside the four categories',

    // ===== 第 5 层交付 =====
    '交付形态': 'Delivery',
    '📁 多文件工程': '📁 Multi-file project',
    '📄 单文件': '📄 Single file',
    '含单元测试': 'Unit tests',
    '含部署与运行说明': 'Deploy & run docs',
    '数据库建表 / 迁移脚本（含索引、外键）': 'Schema / migration scripts (indexes, FKs)',
    '鉴权中间件 + 路由级权限': 'Auth middleware + route-level permissions',
    '全局错误处理 + 统一响应格式': 'Global error handling + unified responses',
    '可启动入口（主文件 + .env.example）': 'Runnable entry (main file + .env.example)',
    '「所有被引用模块必须落盘、可启动」由依赖闭包检查自动把关（不勾也会查）—— 悬空 import 会列在一致性报告里。':
        '"All referenced modules must exist and be runnable" is always enforced by the dependency-closure check.',

    // ===== 第 6 层完成度 =====
    '完成度': 'Completeness',
    '🧪 可运行原型': '🧪 Prototype',
    '🏗 生产级实现': '🏗 Production',
    '底线始终生效：可启动 + 无悬空引用（引用的本地模块必须真实落盘）。':
        'Baseline always applies: runnable + no dangling imports.',
    '功能点实现方式': 'Feature implementation',
    '与完成度解耦：原型也可以要求个别点必须真实':
        'Independent of completeness: a prototype can still require specific features to be real',
    '＋ 添加功能点': '+ Add feature',

    // ===== 第 7 层数据模型 =====
    '数据模型': 'Data model',
    '建议填写': 'Recommended',
    '把主键类型、字段边界、金额单位、枚举流转显式定下来 —— 定了之后契约与代码都照此校验，不再靠平台猜（不确定的项留空即可）。':
        'Declare primary key, field bounds, money unit and enum transitions — they become the verification baseline. Leave blanks to let the platform decide.',
    '主键类型': 'Primary key',
    '由平台建议': 'Platform decides',
    'int 自增（全项目统一）': 'int auto-increment (project-wide)',
    'UUID（全项目统一）': 'UUID (project-wide)',
    '业务键（如订单号）': 'Business key (e.g. order no.)',
    '金额单位': 'Money unit',
    '元（decimal）': 'Yuan (decimal)',
    '整数分（int）': 'Cents (int)',
    '核心实体与字段': 'Entities & fields',
    '字段名 / 类型 / 必填 / 边界（如 ≤100、≥0、1-50）':
        'Name / type / required / bounds (≤100, ≥0, 1-50)',
    '＋ 添加实体': '+ Add entity',
    '枚举与状态流转': 'Enums & transitions',
    '取值集合 + 允许的边（如 pending→shipped / shipped→refunded）':
        'Values + allowed edges (pending→shipped / shipped→refunded)',
    '＋ 添加枚举字段': '+ Add enum field',

    // ===== 第 8 层不变量 =====
    '业务不变量': 'Invariants',
    '逐条写"绝对不能错"的硬约束（含异常 / 并发 / 失败路径）。生成后会逐条核对代码有没有对应实现，缺了会列进一致性报告。':
        'List hard constraints that must never break (failures, concurrency, rollback). Each is checked against the generated code.',
    '＋ 添加不变量': '+ Add invariant',

    // ===== 第 9 层授权 =====
    '角色与授权': 'Roles & authz',
    '把"谁能做什么"显式定下来。每个写操作都会按这里的规则核对有没有挂权限校验——只给点名接口加权限、其余裸奔，会被列进一致性报告。':
        'Declare who can do what. Every write endpoint is checked for permission guards.',
    '角色清单（逗号分隔）': 'Roles (comma separated)',
    '授权规则': 'Authz rules',
    '逐条写"谁能对什么做什么"，例：管理员可以发货和退款':
        'Who can do what, e.g. admin can ship and refund',
    '＋ 添加规则': '+ Add rule',
    '启用行级归属（用户只能看 / 改自己的数据）': 'Row-level ownership (own data only)',
    '归属键': 'Owner key',
    '例：游客、本人、管理员、运营': 'e.g. guest, owner, admin, operator',
    '例：userId（可留空）': 'e.g. userId (optional)',

    // ===== 工具条 / 弹窗 =====
    '⚙️ 系统': '⚙️ System',
    '提示词': 'prompt',
    '🛡️ 质量': '🛡️ Quality',
    '闸门': 'gate',
    '🔍 审查': '🔍 Review',
    '🔗 自动': '🔗 Auto',
    '对齐': 'align',
    '🔒 安全': '🔒 Security',
    '基线': 'baseline',
    '连接': 'Connect',
    '测试': 'Test',
    '📊 数据': '📊 Data',
    '中心': 'center',
    '🧠 记忆': '🧠 Memory',
    '库': 'bank',
    '系统提示词': 'System prompt',
    '取消': 'Cancel',
    '保存': 'Save',
    '关闭': 'Close',
    '编辑系统提示词（会随每次请求发送给模型）': 'Edit system prompt (sent with every request)',
    '生成每段代码后自动执行：零 token 语法校验 → 小模型审查 → 自动修正':
        'After each code block: zero-token syntax check → model review → auto-fix',
    '闸门内是否启用小模型审查（关闭则只做零 token 静态校验）':
        'Enable model review inside the gate (off = static checks only)',
    '契约一致性校验发现严重不一致时，自动定向修复对应端（最多 2 轮，会消耗额外 token）':
        'Auto-repair the inconsistent side (max 2 rounds, costs tokens)',
    '生成代码时默认追加安全基线规范（输入校验 / 注入防护 / CORS 收敛 / 密钥不硬编码等）':
        'Append a security baseline by default (validation / injection / CORS / no hardcoded secrets)',
    '测试后端连接是否正常': 'Test backend connectivity',
    '切换明暗主题': 'Toggle theme',
    '数据中心：token 消耗与服务状态': 'Data center: token usage & service status',
    '记忆库：把校验偏差变成下次生成必须遵守的约束':
        'Memory: turn check deviations into constraints',
    '输入全局系统提示词，例如：你是资深前端工程师，回答简洁专业，优先给出可运行代码示例':
        'Enter the global system prompt, e.g. you are a senior frontend engineer...',
    '收起 / 展开需求输入': 'Collapse / expand requirements',

    // ===== 数据中心 =====
    '📊 数据中心': '📊 Data center',
    '运行状态': 'Status',
    '后端服务': 'Backend',
    '检测中…': 'Checking…',
    '当前生成': 'Current run',
    '累计消耗（全局 · 历史总量，删会话不减少）': 'Total usage (global, never decreases)',
    '各对话消耗': 'Per conversation',
    '🔄 刷新': '🔄 Refresh',
    '空闲': 'Idle',
    '生成中': 'Generating',
    '暂无消耗记录（完成一次生成后自动记账）': 'No usage yet (recorded after each run)',
    '未命名会话': 'Untitled',

    // ===== 记忆库 =====
    '🧠 记忆库': '🧠 Memory',
    '从契约校验导入（偏差 → 下次必须遵守的约束）':
        'Import from checks (deviations become constraints)',
    '📌 导入 high 偏差': '📌 Import high issues',
    '待确认候选（校验自动沉淀，确认后才参与召回）':
        'Pending candidates (confirm to activate)',
    '✅ 全部确认生效': '✅ Confirm all',
    '🗑 清空待确认': '🗑 Clear pending',
    '手动添加（你自己的经验）': 'Add manually (your own experience)',
    'L1 硬约束（必遵守）': 'L1 Hard constraints',
    'L2 可复用模式': 'L2 Reusable patterns',
    'L3 场景规则': 'L3 Scenario rules',
    'L4 偏好（默认选项）': 'L4 Preferences',
    '➕ 入库': '➕ Save',
    '分层：L1 违反必出错（最高优先）· L2 成熟做法范例 · L3 命中场景才注入 ·\r\n                        L4 团队偏好（技术栈/响应规范，作为生成默认选项）':
        'Layers: L1 must-follow · L2 patterns · L3 scenario rules · L4 preferences',
    '记忆列表（按更新时间）': 'Memory list (by update time)',
    '⬇️ 导出备份': '⬇️ Export',
    '一次生成可能沉淀大量噪声候选（如 36 条同类型 dto_missing），逐条淘汰不现实':
        'A single run may produce many noisy candidates',
    '写成可执行规则，如：删除成员前校验 owner 不可移除、至少保留一名 admin（禁止空话）':
        'Write an actionable rule (no vague statements)',
    '场景标签，逗号分隔（鉴权/CRUD/状态机…）': 'Scene tags, comma separated',
    '没有待确认候选（校验发现偏差时会自动沉淀到这里）':
        'No pending candidates (deviations are collected here)',
    '记忆库加载失败（后端不可达？）': 'Failed to load memory (backend unreachable?)',
    // 语言按钮初始 title（本身是双语的，英文环境下只显示英文）
    'Switch language / 切换语言': 'Switch language',
};

/** Node 环境（单测）下没有 document，统一走这个取值口，避免直接裸用 */
function docOf() {
    return typeof document !== 'undefined' ? document : null;
}

/** 当前语言：'zh' | 'en' */
export function currentLang() {
    const d = docOf();
    if (!d) return 'zh';
    try {
        return d.documentElement.getAttribute('data-lang') === 'en' ? 'en' : 'zh';
    } catch {
        return 'zh';
    }
}

/**
 * 空白归一化查找（2026-10-25）。
 *
 * 为什么需要：字典里有多行文案的键（键里带 \r\n + 缩进），而 HTML 里同一段文字的
 * 换行/缩进取决于文件行尾（CRLF↔LF）—— 只要两者不一致，精确匹配就失效，
 * 那条文案永远翻不出来（实测踩过：改文件行尾后 i18n 完整性测试立刻报缺）。
 *
 * 策略：先精确匹配；不中时把两边都压成单行空格再比。
 */
const normI18nKey = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

const NORM2EN = (() => {
    const m = Object.create(null);
    for (const k of Object.keys(ZH2EN)) {
        const nk = normI18nKey(k);
        if (nk && !(nk in m)) m[nk] = ZH2EN[k];
    }
    return m;
})();

/** 查英文译文：精确优先，退化为空白归一化匹配 */
export function lookupEn(zh) {
    const exact = ZH2EN[zh];
    if (exact !== undefined) return exact;
    return NORM2EN[normI18nKey(zh)];
}

/** 文案取值（新代码用；老代码靠 applyI18n 的字典替换） */
export function t(zh) {
    if (currentLang() !== 'en') return zh;
    const hit = lookupEn(zh);
    return hit === undefined ? zh : hit;
}

// 文本内容不翻译的容器（用户数据 / 代码）
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'PRE', 'CODE', 'TEXTAREA']);
const SKIP_IDS = new Set(['chatInner', 'systemPrompt']);
const SKIP_CLASSES = ['plan-editor'];

/** 文本节点是否在保护区内（TEXTAREA 属于：内容不能动） */
function skipForText(el) {
    if (!el || el.nodeType !== 1) return false;
    if (SKIP_TAGS.has(el.tagName)) return true;
    if (el.id && SKIP_IDS.has(el.id)) return true;
    if (el.hasAttribute && el.hasAttribute('data-no-i18n')) return true;
    if (el.classList && SKIP_CLASSES.some(c => el.classList.contains(c))) return true;
    return false;
}

/**
 * 属性是否在保护区内。
 * 注意与 skipForText 的区别：TEXTAREA 的【内容】不能翻译，但它的
 * placeholder 是界面文案，必须翻译 —— 早期版本把 TEXTAREA 整体跳过，
 * 导致所有输入框的 placeholder 在英文下仍是中文。
 */
function skipForAttr(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.id && SKIP_IDS.has(el.id)) return true;
    if (el.hasAttribute && el.hasAttribute('data-no-i18n')) return true;
    if (el.classList && SKIP_CLASSES.some(c => el.classList.contains(c))) return true;
    return false;
}

// 记下"被我们改过"的节点/属性：切回中文时按记录还原，不依赖反向字典。
// 用记录而非"含中文"过滤 —— 否则英文节点进不了遍历器，切不回中文。
const touchedText = new Set();
const touchedAttrs = [];   // { el, attr, zh }

/**
 * 把 root 下的界面文案换成当前语言（幂等，可反复调用）。
 * @param {Element} [root] 默认 document.body
 */
export function applyI18n(root) {
    const d = docOf();
    if (!d) return;
    const host = root || d.body;
    if (!host) return;

    // ---------- 还原中文 ----------
    if (currentLang() !== 'en') {
        for (const n of touchedText) {
            if (n.__zh !== undefined) {
                n.nodeValue = n.__zh;
                delete n.__zh;
            }
        }
        touchedText.clear();
        for (const it of touchedAttrs) {
            it.el.setAttribute(it.attr, it.zh);
            delete it.el['__zh_' + it.attr];
        }
        touchedAttrs.length = 0;
        return;
    }

    // ---------- 翻译成英文 ----------
    // 1) 文本节点（只处理含中文的：已翻译过的英文节点无需再进）
    const walker = d.createTreeWalker(host, NodeFilter.SHOW_TEXT, {
        acceptNode(n) {
            if (!n.nodeValue || !/[\u4e00-\u9fa5]/.test(n.nodeValue)) return NodeFilter.FILTER_REJECT;
            let p = n.parentNode;
            while (p && p !== host.parentNode) {
                if (skipForText(p)) return NodeFilter.FILTER_REJECT;
                p = p.parentNode;
            }
            return NodeFilter.FILTER_ACCEPT;
        }
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const n of nodes) {
        const raw = n.nodeValue;
        const key = raw.trim();
        if (!key) continue;
        // 用归一化查找（多行文案的换行/缩进可能与字典键不一致）
        const hit = lookupEn(key);
        if (hit === undefined) continue;
        if (n.__zh === undefined) n.__zh = raw;
        n.nodeValue = raw.replace(key, hit);
        touchedText.add(n);
    }

    // 2) placeholder / title（TEXTAREA 的 placeholder 要翻，内容不翻）
    const els = host.querySelectorAll ? host.querySelectorAll('[placeholder],[title]') : [];
    for (const el of els) {
        if (skipForAttr(el)) continue;
        for (const attr of ['placeholder', 'title']) {
            const v = el.getAttribute(attr);
            if (!v || !/[\u4e00-\u9fa5]/.test(v)) continue;   // 已是英文（翻译过）就跳过
            const hit = ZH2EN[v.trim()];
            if (hit === undefined) continue;
            const storeKey = '__zh_' + attr;
            if (el[storeKey] === undefined) {
                el[storeKey] = v;
                touchedAttrs.push({ el, attr, zh: v });
            }
            el.setAttribute(attr, hit);
        }
    }
}

/** 设置语言并持久化（会立即重刷界面） */
export function setLang(lang, opts = {}) {
    const next = lang === 'en' ? 'en' : 'zh';
    const d = docOf();
    if (d) {
        d.documentElement.setAttribute('data-lang', next);
        d.documentElement.setAttribute('lang', next === 'en' ? 'en' : 'zh-CN');
    }
    try {
        if (typeof localStorage !== 'undefined') localStorage.setItem('lang', next);
    } catch { /* 隐私模式忽略 */ }
    if (opts.apply !== false) applyI18n();
    return next;
}

/** 初始化：读取持久化语言（不清空用户选择） */
export function initLang() {
    let saved = 'zh';
    try { saved = localStorage.getItem('lang') || 'zh'; } catch { /* ignore */ }
    return setLang(saved, { apply: false });
}
