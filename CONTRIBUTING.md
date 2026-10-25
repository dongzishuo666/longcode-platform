# 贡献指南（Contributing）

感谢你关注 **智能长代码生成平台**。本项目采用 **BDFL（Benevolent Dictator For Life）单人主导** 的轻量治理模式：核心方向由维护者（@dongzishuo666）拍板，但**所有 Issue 与 PR 都欢迎**——好的点子、好的补丁，都会被认真看待。

---

## 🧭 治理模式

- **决策**：维护者拥有最终决定权，尤其在架构取舍、API 形态、许可证相关事项上。
- **开放**：代码、Issue、讨论完全公开；不接受任何形式的私下决策。
- **节奏**：这是个人维护项目，响应可能不是 7×24，但每个 Issue / PR 都会在某个时点被处理（合并、给出理由、或关闭）。

---

## 🐛 提交 Issue

在提 Issue 前请先[搜索已有 Issue](https://github.com/dongzishuo666/longcode-platform/issues)，避免重复。一个高质量的 Issue 应当包含：

1. **环境**：操作系统、Node.js 版本、浏览器（前端是纯静态 SPA，浏览器差异可能导致渲染问题）。
2. **复现步骤**：最小可复现的操作序列。
3. **预期 vs 实际**：清晰描述你期望发生什么、实际发生了什么。
4. **日志**：后端代理的日志（`LOG_LEVEL=debug` 启动），以及浏览器控制台报错（F12）。
5. **敏感信息**：**切勿**在 Issue 中贴出你的 DeepSeek API Key、服务器 IP、域名或任何私人配置。

---

## 🔧 本地开发环境

```bash
# 1. 后端代理
cd deploy-pkg/deepseek-proxy
npm install
PORT=8787 HOST=127.0.0.1 node server.js

# 2. 前端（另开一个终端）
cd deploy-pkg/web
npx serve -l 5173 .
```

- 前端是**零构建**单文件 SPA（`index.html` + `*.mjs`），改完刷新即可，无需打包。
- 后端是 Fastify 无状态代理，仅转发 `/api/*` 到 DeepSeek。
- 涉及 Tree-sitter 质量闸门改动时，注意 `deploy-pkg/web/vendor/` 下的 wasm 与 js 需版本匹配。

---

## ✅ 提交 PR 的约定

1. **Fork → 分支 → PR**：从 `main` 切出 `feature/xxx` 或 `fix/xxx` 分支。
2. **保持干净**：
   - 不要把 `_deploy/`（含真实服务器信息的本机镜像）或任何 `.env`、密钥、IP、域名提交进来——`.gitignore` 已经排除，请别用 `-f` 强行加。
   - 个人分析产物（`*.bak.txt`、过程 HTML 等）同样被忽略，请勿提交。
3. **提交信息**：用简洁的祈使句，例如 `fix: 修复续写轮质检首轮统计丢失`、`feat: 新增会话搜索`。
4. **范围**：本项目核心是「长代码生成 + 零 token 闸门 + 自动续写」。与这一主线的偏离（例如想换成别的模型 provider、想加付费后端）建议先在 Issue 里讨论，避免 PR 被拒。
5. **测试**：如果改动质量闸门或契约逻辑，请附上你验证过的样例（脱敏后的输入/输出摘要即可）。

---

## 📜 许可证

所有贡献（包括 PR 中的代码）默认以 **MIT** 许可证授权，与本项目主许可证一致。提交 PR 即表示你同意这一授权。

---

## 🙏 不接受的贡献类型

- 任何会引入**公共后端服务**或**收集用户密钥/代码**的改动（本项目定位是 self-hosted + BYO-key）。
- 任何把模型权重、受版权保护的第三方代码打包进仓库的改动。
- 与安全无关、却会让 API Key 明文暴露面扩大的改动。

## ✅ 提交前必跑（红线）

```bash
node _deploy/run_all_tests.mjs        # 全量回归：真正红的套数必须是 0
node _deploy/scan_tool_markers.mjs     # 工具标记污染扫描 + 语法复检
```

- 判定以**退出码**为准（不少老测试没有"结果"行，只看输出会误判）。
- 不要为了让测试变绿而改断言去迁就实现：先判断"实现对不对"；
  实现是**有意变更**时才改断言，并写清原因。
- 改完后端（`/opt/deepseek-proxy`）必须 `systemctl restart deepseek-proxy`。
- 本项目的完整规矩见 [`AGENTS.md`](AGENTS.md)（含"自用只跑 DeepSeek / 开源多模型"这条界线）。
