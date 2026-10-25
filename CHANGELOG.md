# 更新日志

本文件记录平台本身的更新（功能、修复、平台文档）。仓库运维类操作不在此记录。

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
