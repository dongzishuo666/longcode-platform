# AGENTS.md · 本项目的死规矩（任何会话/自动化工具开工前必读）

> 这份文件是**红线**，不是建议。违反其中任何一条，产物一律视为"未完成"。
> 依据：2026-10-24 一次真实事故 —— 连续三轮"改了配色但界面没变"，根因是一行 CSS 注释；
> 以及一次跨会话事故 —— 另一个会话把工具标记 `</new_string>` 写进了 `lib/validate.js`，
> 6 套测试集体崩溃、排查耗时超过两小时。

---

## 规则 1（最高）：自用运行形态是**唯一**决策基准

- **线上/自用**：只跑 DeepSeek。表现 = `.env` 里 `LC_MULTI_MODEL=0`，
  `/api/health` 返回 `{"multiModel": false, "providers": ["deepseek"]}`，
  前端**不显示**「供应商」入口。
- **开源仓库**：多模型默认开（不设该变量即可）。
- 两者**同一份代码**，只有环境变量不同。**不要**为了自用去改代码里的多模型分支，
  也**不要**为了开源去删自用需要的收紧逻辑。

## 规则 2：多模型与"开源发布层"**不驱动**自用功能开发

发布层文件（只服务"开源给别人看"这件事）：

```
README.md  LICENSE  NOTICE  CONTRIBUTING.md
docker-compose*.yml  .github/**  各类 badge/截图
```

对它们的处理原则：

- **不改**：除非用户明确说"要发布/要改文档"。
- **不改就更好**：改它们**不能**改变自用运行行为；如果某个改动让自用行为变了，
  说明改错了地方（应改代码/令牌，而不是改 README）。
- **不引用**：自用回归测试**不得**依赖发布层文件（否则改个 badge 就能让自用测试变红）。
  这条由 `_deploy/test_scope_isolation.mjs` 断言。

## 规则 3：改了代码就必须跑通红线，退出码即结论

```bash
node _deploy/run_all_tests.mjs      # 唯一入口：跑全部 + 汇总；红则非零退出
```

- 提交/交付前**必须**执行；输出里"真正红的套数"必须是 0。
- 不要只看自己改的那几套 —— 本项目有过"改 A 弄坏 B"（改 `normalizeModel` 连带 3 套红）。
- **不要**为了让测试变绿而改断言去迁就实现：先判断"实现对不对"，
  实现错了就修实现；只有当实现是**有意变更**（且已确认语义）时，才改断言，并写清原因注释。

## 规则 4：改完立刻自检，不靠"我以为改上了"

```bash
node _deploy/scan_tool_markers.mjs   # 扫工具标记污染（</new_string> 之类）+ 语法复检
node _deploy/check_syntax.mjs <文件>  # 单文件语法
```

- `replace_in_file` **可能报成功但没落盘** → 改完关键位置立刻 `grep`/读文件核验。
- 改完 `.js`/`.mjs` 立刻语法检查；改完前端立刻看内联 script 是否仍能解析。
- **禁用** PowerShell 的 `ReadAllText`/`WriteAllText` 改关键文件（读失败会写空文件，
  实际发生过）。用 node 脚本（中文路径也更稳）。

## 规则 5：改后端必重启；部署判据唯一

- 改 `/opt/deepseek-proxy` 下任何文件 → `systemctl restart deepseek-proxy`，否则跑的还是旧代码。
- `python remote.py put` **成功判据 = 输出含 `<-`**；`get` 没有这个标记（用文件大小判断）。
- 服务器命令一律写成 `.sh` 再上传执行（`$(...)` 内用单引号），不要在 PowerShell 里拼复杂引号。
- SSH 频繁连接会被限流（25~90s 重试）；`/tmp` 可能被清理。

## 规则 6：并发会话要防互相覆盖

这个仓库**可能同时有多个会话在改**。因此：

- 改完立刻 grep 核验落盘 + 语法检查（规则 4）。
- 不要假设"文件里的东西是我刚写的" —— 先读当前内容。
- 发现别人的改动（新的提交、新的文件、mtime 在动）→ **先看再动**，并在汇报里说明，
  不要静默覆盖。

## 规则 7：CSS 改动（配色/布局）的专属陷阱

- **注释里绝不出现「星号紧邻斜杠」**（如 `--bg-*`）：会提前关闭注释 →
  整条 `:root` 令牌规则被浏览器**静默丢弃** → 所有 `var(--x)` 失效 →
  页面一直显示写死的兜底色（"改了配色没变化"的经典根因）。
- **任何兜底色值必须引用令牌，且与令牌同步**（`var(--bg-primary, #XXXXXX)` 的兜底值
  与 `--bg-primary` 不一致 = 隐性第二真源）。
- 配色改动**先本地渲染 + 取计算样式核对，再部署**：
  Edge headless（本机 Chrome 损坏）：
  ```bash
  msedge --headless=new --dump-dom --virtual-time-budget=4000 --user-data-dir=<tmp> file:///<探针页>.html
  msedge --headless=new --screenshot=out.png --window-size=1440,900 --virtual-time-budget=3000 \
         --user-data-dir=<tmp> file:///<页面>.html
  ```
  判读要点：`getPropertyValue('--x')` 为空 → 令牌规则没被解析；`background-image: none`
  → `var()` 失败；`color: transparent` 且无背景 → 渐变文字隐形。

## 规则 8：测试写法约定（避免下一轮又踩）

- 纯函数模块（`quality-text.mjs` / `dual-text.mjs`）在 jsdom 里**不会**自动加载 →
  一律用 `_deploy/jsdom-boot.mjs` 的 `bootPage(HTML, { beforeParse(w){ stubLibs(w); } })`，
  不要用裸 `new JSDOM(html)`（那样 `window.__req` / `window.QT` 都不存在）。
- 后端 validator 可能是 **async**（内部 await SSRF 校验）→ 测试必须 `await`，
  同步调用拿到的是 Promise，断言会**全部失真但不报错**。
- 状态在闭包 → 用 `localStorage` 预置或 `window.__req` / `window.__quality` 钩子。
- 假 API Key 要满足新校验（`sk-` 前缀 + ≥20 字符）。
- PowerShell 内联 `node -e` 反复被引号吞掉 → 脚本一律写成 `.mjs` 文件再执行。

---

## 快速自检清单

```
□ node _deploy/run_all_tests.mjs        → 真正红的套数 = 0
□ node _deploy/scan_tool_markers.mjs     → 无污染、语法全 OK
□ 改了后端 → systemctl restart deepseek-proxy
□ 改了 .js/.mjs → grep 核验落盘 + 语法检查
□ 自用形态没被多模型/开源发布层影响（multiModel=false、供应商入口不显示）
```
