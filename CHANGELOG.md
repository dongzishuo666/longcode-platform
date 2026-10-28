# 更新日志

本文件记录平台本身的更新（功能、修复、平台文档）。仓库运维类操作不在此记录。

---

## 2026-10-28 · AI 辅助填写需求表单

### 新增（AI 辅助填写）
- **`POST /api/spec-fill`**（`deploy-pkg/deepseek-proxy/server.js` + `lib/spec-fill.js`）：用一句话描述需求，模型起草结构化需求表单。与 `/api/review` 同构（非流式 + 强制 JSON + 独立超时），只写表单、不参与生成链路。
- **`lib/spec-fill.js`**（273 行）：固定 system prompt（命中上游前缀缓存）+ 容错解析 + 白名单 + 枚举校验 + 长度/条数上限。**解析失败返回空 spec**（半截污染比不填更糟）；枚举越界一律丢弃，不"就近匹配"成别的选项。
- **`deploy-pkg/web/spec-fill-apply.mjs`**（171 行）：起草结果 → 表单的**状态级合并层**。写 `state.config.req` 后交给 `syncReqUI()` 统一重渲染（与 `applyPreset` 同一套路），动态行/去重/联动全部复用，避免"预设填的行"与"AI 填的行"两套 DOM 分叉。
- **需求表单顶部「✨ AI 辅助填写」卡片**（`index.html`）：一句话输入 + 覆盖策略二选一（🩹 只填空字段 / ♻️ 覆盖已填内容）+ 回填后 1.4s 高亮。**不自动触发**（成本可见）、30s 冷却（防误双击）、失败一律不动表单。两种档位都显示。

### 修复
- **`lib/validate.js`**：新增 `validateSpecFillBody`——`description` 非空且 ≤2000 字符，`overwrite` 默认 `false`（安全侧），`maxTokens` 默认 2000、`timeoutMs` 默认 20s，provider 复用同一套 SSRF / 白名单解析。

### 测试
- 新增 `test_spec_fill.mjs`（后端 8 节）与 `test_spec_fill_ui.mjs`（前端 7 节，含真页面 DOM 更新与 mock fetch 点击流）。其中后端测试会读取前端 `collectReq` 源码做**键名双向交叉校验**，防止前后端字段清单漂移。回归套数 83 → 85 全绿。

---

## 2026-10-28 · R2 架构重构 + 绿终端 UI

### 新增（R2 重构：从 index.html 抽出纯逻辑模块）
- **`deploy-pkg/web/project-mount.mjs`**（122 行）：项目挂载模块，把历史会话的资产挂到当前会话；依赖全部函数注入，零 DOM/window 引用。
- **`deploy-pkg/web/prompt-assembly.mjs`**（84 行）：prompt 组装，只抽「纯文本拼接 + 长度预算」（记忆注入顺序、系统提示词截断），大段中文文案常量仍留页面。
- **`deploy-pkg/web/state-migrate.mjs`**（110 行）：存量配置归一化/迁移纯函数（`normalizeMode`/`normalizeTier`/`ensureContextTokens`/`mergeUsage`/`pickCurrentConvId`/`migrateConfig`），不修改入参、不碰 DOM、不写 localStorage。

### 优化（UI r11「绿终端」换皮）
- **`deploy-pkg/web/index.html`**：紫罗兰配色改为翡翠「绿终端」纵向渐变；token 层降饱和三段渐变、文字层级回落、面板降噪；小白空白态去掉重复主按钮。对比度由 `test_css_health` 的静态 + 真浏览器双断言守住 ≥4.5。

### 测试
- 回归套数 78 → 83 全绿（0 红）；代码与守卫随上述模块拆分同步更新。

---

## 2026-10-25

### 新增
- **`AGENTS.md`**：项目协作规范，固化 8 条红线（自用形态为唯一决策基准、发布层不驱动自用功能、红线回归命令、改完自检、改后端必重启、防并发覆盖、CSS 配色陷阱、测试写法约定）。

### 文档
- **`README.md`**：新增「两种部署形态」小节，说明同一份代码通过环境变量 `LC_MULTI_MODEL` 区分「开源多模型（默认）」与「自用只跑 DeepSeek」，并给出切换命令与线上验证结果（`/api/health` 返回 `{"multiModel":false,"providers":["deepseek"]}`）。
- **`CONTRIBUTING.md`**：新增「提交前必跑（红线）」小节，列出 `run_all_tests.mjs` / `scan_tool_markers.mjs` 全量回归命令，以及「以退出码判定、不为绿改断言、改后端必重启」的规则。
- **`设计总方案_v2附录.md`**：新增 §10.42（多模型界线：开源多模型 / 自用只跑 DeepSeek）与 §10.43（死规矩落地）两节，记录界线设计与测试基线整理。

### 修复
- **`deploy-pkg/web/index.html`**：修复 `renderClosureGaps()` 作用域内缺失 `esc()` 定义的问题。此前渲染「契约闭环检查」结果会抛 `ReferenceError`，导致整块一致性报告渲染为空白；现已与文件中其它 3 处保持一致定义。

## 2026-10-25 · 会话→项目工作区

### 新增（会话 → 项目）
- **「会话→项目」工作区**：把单次会话升级为可持续的项目工作区，让"在上次那个项目里接着改"成为可能，分三步落地：
  - **① 项目资产按会话持久化**（`deploy-pkg/web/quality-text.mjs` + `index.html`）：符号表 / 契约 / 修复记录按会话落盘隔离，切会话不串项目、刷新不丢失；新增 `serializeQuality/hydrateQuality`、`saveAll/loadAll`，`CONV_ASSET_BUDGET=2MB` 超预算丢最旧会话资产。
  - **② 挂载历史会话资产**（`mountProject`）：新会话可挂载其它会话的项目包（符号表 / 契约 / 需求 / spec / 摘要），按名去重合并、契约只补空缺；UI 工具栏「📦 项目挂载」弹窗列出可挂载会话。挂载只带资产不挂代码正文，实现按需取全文（第 3 步）。
  - **③ 按需取全文**（`buildProjectContext` / `withProjectContext`）：命中文件才按 `loc={msg,start,end}` 回原会话切片取真代码、注入本轮 user 消息之后；不污染 systemPrompt、不落盘历史；无关提问零注入，单文件 ≤6000 字符、总 ≤16000。
- **前端依赖 vendored**：`deploy-pkg/web/vendor/` 补齐 `marked.min.js` / `purify.min.js` / `highlight/`（README 与 Docker 构建脚本已引用，此前缺漏）。
- **`deploy-pkg/deepseek-proxy/lib/review.js`**：后端审查逻辑同步更新。

### 测试
- 新增 `test_state_persist.mjs`（45 项）、`test_mount_project.mjs`（40 项）、`test_project_context.mjs`（34 项）；相关回归套数分别 68 / 69 / 70 套全绿。

### 文档
- **`设计总方案_v2附录.md`**：新增 §10.47（项目资产持久化）、§10.48（挂载历史会话）、§10.49（按需取全文），记录设计取舍与端到端验证。

## 2026-10-26 · 双模式档位 + 质量复检增强

### 新增（双模式档位，第 0 层）
- **档位（小白 / 程序员）**：在既有「模式（智能生成 / 工作需求流）」之上新增一层**用户分层**，两层并存、互不替代。档位只决定「下层能力露出多少、需求录入走简版还是完整版」，**绝不改变智能生成 / 质量闸门 / 契约一致性的任何行为**（AGENTS.md 规则 1）。
- **欢迎层**：全新用户（没选过档位且没聊过天）首屏弹欢迎卡选档位；存量用户默认程序员档、不弹（2026-10-26 决策修正）。判定只信任 `<head>` 抢跑标记的 `html[data-tier-welcome]`，避免被 `loadAll` 默认 config 误判。
- **小白简版入口**：模式行 / 供应商高级项 / 场景模板卡 / 带术语副标题收起；工具条仅留「语言 / 数据中心 / 连接测试」，其余折叠进「更多」，质量闸门 / 小模型审查 / 一致性自动对齐 / 记忆库**永远不可见且强制开启**（小白只是看不到开关，不是绕过检查）。
- **小白简版向导**：类型一键（网站 / 小程序 / 后端 API / 脚本工具 / 其它）+ 一句话大白话，组装成一条消息走 `smart` 现有管道（零主流程改动）；温和追问为零 token 启发式（最多 2 问、一键作答），答完即生成。
- **随时切档位**：顶栏「档位」选择器可随时切换，不重置进行中的会话；切回程序员档**不撤销**小白强制开启的开关（语义最简）。

### 增强（质量复检）
- **复检留痕**：被丢弃的修复也进入修复记录（标注「已丢弃 / 复检通过 / 复检未通过 / 复检：无法判定」及原因），便于追溯。
- **复检范围收窄**：`verifyFix` 增加 `scope` 入参，只看「本次替换的那一小段」是否解决本条问题；整段里别处同类问题不再否定本条正确修复（不再误杀）。

### 改动范围
- 前端单文件：`deploy-pkg/web/index.html`（+档位欢迎层 / 简版向导 / 显隐总闸）、`deploy-pkg/web/i18n.mjs`（档位 / 挂载 / 复检词条）。
- `deploy-pkg/web/quality-text.mjs`：`verifyFix` 增加 `scope`（复检范围收窄）。
- **后端 `deepseek-proxy` 零改动**。

### 文档
- **`设计总方案_双模式档位方案.md`**：双模式档位完整方案（两层定位、行为矩阵、欢迎层、小白简版向导、9 条已确认决策、实现落地记录与守卫测试）。

## 2026-10-26 · 质量闸门重构 + 小白温和追问

### 新增（小白温和追问）
- **温和追问气泡**：小白档位下描述太含糊（缺存储 / 登录 / 文件等关键信息）时，生成前最多问 2 个一键问题（每问一行 + 选项按钮），答完自动生成；跳过 = 让模型采用最合理假设。零 token（本地启发式，不调模型）。

### 重构（质量闸门，行为零变化）
- 把 `index.html` 里挤着的 ~210 行「8 分支状态机」主循环拆成三层模块（自托管仓库 R1 三步）：
  - **`quality-orchestrator.mjs`** —— 闸门的 I/O 边界：怎么跟服务端说话（HTTP / 超时 / 重试）；
  - **`quality-state.mjs`** —— 运行态门面：降级、指纹、边界怎么读写；
  - **`quality-gate.mjs`** —— 主循环：一个代码块依次经过什么、产生什么统计。
- `index.html` 只剩「实例化 + 薄包装」。硬约束：新模块不出现 `state` / `window` / `document` / DOM 引用，会话对象参数传入。对外行为与统计口径零变化（回归全绿确认）。

### 改动范围
- 前端：`deploy-pkg/web/index.html`（+温和追问气泡 / 闸门主循环外移）、新增 `quality-gate.mjs` / `quality-orchestrator.mjs` / `quality-state.mjs`。
- **后端 `deepseek-proxy` 零改动**。

## 2026-10-27 · 记忆库增强 + 空白态/模板 UI 修复

### 修复（记忆库，含后端）
- **smart 模式补齐记忆注入（P1）**：此前智能生成模式不注入记忆，「管理不可见」等于「受益为零」；现已接入，小白档位同样受益。
- **质检偏差回流成记忆候选（P2）**：质量闸门检出的偏差（压缩输出、符号冲突等）开始沉淀为记忆候选——踩过的坑下次生成前就能被召回。
- **recall 耗时观测修正（P4①）**：`/api/memories/recall` 日志里的 `ms` 原来记的是 `Date.now()` 时间戳而非耗时，日志完全失真；改为 `Date.now() - startedAt`（与其它端点对齐）。
- **反馈权重 30 天半衰期（P4④）**：此前半年前误判的两次「违反」会永久双倍压分且无自动恢复通道；现在遵守/违反权重按 `0.5^(天数/30)` 衰减（30 天剩一半、90 天剩 1/8），用 `updatedAt` 实现零 schema 变更——最近被互动的规则拿最新权重。

### 修复（UI）
- **空白态补齐 saas 孤儿卡 + 「从空白开始」出口（P4）**：小白档欢迎层关闭后若没有会话，空白态缺 saas 类模板卡与「从空白开始」入口。
- **模板卡死按钮**：默认（智能生成）模式下模板卡点击无任何反应——现已在默认模式下正确路由到结构化需求预填。

### 改动范围
- 后端：`deploy-pkg/deepseek-proxy/lib/memories.js`（反馈半衰期）、`deploy-pkg/deepseek-proxy/server.js`（recall 耗时观测）。
- 前端：`deploy-pkg/web/index.html`、`quality-text.mjs`、`quality-gate.mjs`、`dual-text.mjs`、`i18n.mjs`。
