# 智能长代码生成平台（Long-Code Generation Platform）

[![Release](https://img.shields.io/github/v/release/dongzishuo666/longcode-platform?color=success)](https://github.com/dongzishuo666/longcode-platform/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
[![Deploy](https://img.shields.io/badge/deploy-self--hosted-blue.svg)](#-生产部署)
[![Key](https://img.shields.io/badge/key-bring--your--own-orange.svg)](#-使用说明)
[![Models](https://img.shields.io/badge/models-Multi--Provider-blueviolet.svg)](#-多模型支持)
[![Docker](https://img.shields.io/badge/deploy-docker-2496ED.svg)](#-docker-一键部署)
[![Gate](https://img.shields.io/badge/gate-zero--token-brightgreen.svg)](#-零-token-质量闸门)
[![Changelog](https://img.shields.io/badge/changelog-CHANGELOG-blue)](./CHANGELOG.md)

一个面向**长代码场景**的 AI 代码生成工具：用「契约驱动双端生成 + 零 token 质量闸门 + 自动续写」把"一次性写完一个超长文件 / 一个完整项目"变得可控、可校验、可续。

> **Self-hosted · Bring Your Own Key.** 本项目不提供任何公共后端服务。你克隆代码后自行部署，使用**自己的模型 API Key**。后端是一个**无状态的多模型代理**：默认对接 DeepSeek，也可以在界面里切换为 OpenAI / OpenRouter / 通义千问 / 月之暗面 Kimi / 本地 Ollama / 自定义 OpenAI 兼容端点。作者不托管、不收集、不存储任何用户密钥或代码。

---

## 🎯 它替你解决什么

不是又一个"打开聊天窗口让 AI 写代码"——那种方式的典型痛点是：**输出被截断、写完没法校验、前后端接口对不上、换个话题就丢上下文**。这个平台针对这些做了四件事：

| 痛点 | 这里的解法 |
|---|---|
| 长文件 / 整项目一次写不完 | 自动续写（最多 10 轮），截断自动接着写 |
| 生成质量没保障 | 零 token 质量闸门：Tree-sitter 本地语法 / 符号 / 压缩校验 + 安全基线，不烧 token |
| 前后端各写各的、契约对不上 | 契约驱动双端生成 + 三方一致性闭环（≤2 轮自动对齐） |
| 换个会话 / 刷新，之前的项目就没了 | 会话→项目工作区：资产按会话持久化、可挂载历史会话、按需取全文 |
| 门槛高、不知道怎么提需求 | 双模式档位：编程小白走一句话大白话 + 类型一键的极简向导，质量闸门强制开启；程序员档给完整控制 |

适合：想用**自己的模型 Key**、**自托管**、并且要**可控且可校验**地生成较长代码 / 完整项目的人。

---

## 📸 界面预览

需求工作流输入面板——自动识别 / 契约双端 / 先端 / 先后端一键选择，质量闸门、自动对齐、项目挂载、安全基线常驻工具栏：

![界面预览：需求工作流](./docs/screenshot-requirements.png)

---

## ✨ 功能特性

- **零 token 质量闸门**：生成后自动做静态校验（Tree-sitter 语法 / 符号冲突 / 压缩检测）与安全基线检测，**不消耗任何模型 token**；仅当发现 high 级问题时才调用小模型审查与自动修复。
- **自动续写**：模型输出被截断时自动接着写，最多 10 轮，并带上下文上限保护，避免无意义报错。
- **契约驱动双端生成**：需求 → 契约（唯一基准）→ 前后端并行生成 → 三方一致性闭环（≤2 轮自动对齐）。
- **需求工作流**：结构化需求采集（三层必填 + 三层可选）→ 需求分析助手 → 方案评审 → 代码生成。
- **会话 → 项目工作区**：把单次会话升级为可持续项目——项目资产（符号表 / 契约 / 修复记录）按会话持久化、刷新不丢；一键挂载历史会话资产，让模型"接着说"而非重新发明；命中文件才按需取真代码注入，不污染提示词、不落盘历史。
- **两种模式**：`智能生成`（自由对话 + 自动续写 + 质量闸门）与 `需求工作流`（结构化引导流水线）。质检开关独立可控。
- **双模式档位（编程小白 / 程序员）**：在「模式（输入方式）」之上新增一层**用户分层**，两者正交、互不替代。小白走极简入口（首屏欢迎层选档位 + 一句话大白话 + 类型一键的简版向导，工具条只留语言 / 数据中心 / 连接测试），质量闸门 / 小模型审查 / 一致性自动对齐**强制开启且默认不可见**；程序员档给完整控制，两档位随时切换、不影响已有内容。详见[双模式档位](#tier)。
- **质量复检留痕与收窄**：自动修复后复检，被丢弃的修复也记入修复记录（标注通过 / 未通过 / 无法判定及原因）；复检范围收窄到「本次替换的那一段」，不再误杀正确的修复。
- **会话搜索** 与 **中英界面切换**。
- **多模型自选**：界面顶栏可切换模型供应商并填写任意模型名，自带 Key 即插即用（详见[多模型支持](#-多模型支持)）。
- **上下文缓存友好**：续写轮之间前缀稳定，命中上游前缀缓存（如 DeepSeek 官方 1/10 计价），命中部分实时展示在状态栏。

---

## 双模式档位（编程小白 / 程序员）<a id="tier"></a>

平台把用户分成两层：**档位（用户分层）× 模式（输入方式）**，两者正交、互不替代。

- **档位是第 0 层**：决定"露出多少能力、需求怎么录入"，**绝不改变生成 / 质量 / 契约行为**（AGENTS.md 规则 1）。
- **模式是第 1 层**：`智能生成`（自由对话 + 自动续写 + 质量闸门）与 `需求工作流`（结构化引导流水线）。

### 编程小白档
- 首屏**欢迎层**选档位（全新用户才弹；存量用户默认程序员档、不弹）。
- **极简向导**：一句话大白话描述 + 类型一键（网站 / 小程序 / 后端 API / 脚本工具 / 其它），组装成一条消息走 `智能生成` 管道；描述含糊时**零 token 温和追问**（最多 2 个一键问题），答完即生成。
- 工具条只留**语言 / 数据中心 / 连接测试**，其余折叠进「更多」。
- **质量闸门 / 小模型审查 / 一致性自动对齐强制开启且默认不可见**——小白只是看不到开关，不是绕过检查。

### 程序员档
- 完整控制：模式行、供应商高级项、场景模板、全部工具按钮、记忆库调优均可见可用。

### 随时切换
- 顶栏「档位」选择器可随时切；**不重置进行中的会话**，切回程序员档也不撤销小白强制开启的开关。

---

## 🏗 架构

```
┌─────────────────────────┐         ┌──────────────────────────┐
│  前端（静态 SPA）         │         │  后端（Fastify 多模型代理） │
│  deploy-pkg/web/         │ ──API──▶│  deploy-pkg/deepseek-proxy │
│  index.html + .mjs       │         │  /api/chat /review /...   │
└─────────────────────────┘         └───────────┬──────────────┘
                                                  │
                                                  ▼
                                        ┌────────────────────┐
                                        │  模型供应商 API      │
                                        │  （用户自带 Key，    │
                                        │   默认 DeepSeek）    │
                                        └────────────────────┘
```

- **前端**：单文件 SPA（`index.html`）+ 纯函数 ES Module（`quality-text.mjs` / `dual-text.mjs` / `quality-gate.mjs` / `quality-orchestrator.mjs` / `quality-state.mjs`），零构建步骤。
- **后端**：Node / Fastify 代理，仅转发请求；核心能力（质量闸门、契约逻辑）在前端编排，后端提供 8 个无状态端点：
  `health / chat / test / title / review / static-check / extract-api / consistency`。
- **零 token 闸门**（`static-check` / `extract-api` / `consistency`）由后端用 Tree-sitter wasm 在本地计算，不调模型。
- **多模型**：传输层为标准 OpenAI Chat Completions（`POST {base}/chat/completions`）；后端按请求里的 `provider` 决定要不要发送某些供应商私有字段，按 `apiBase` 决定转发到哪家。

---

## 📁 目录结构

```
.
├── deploy-pkg/                 # ★ 可部署的产品代码（开源主体）
│   ├── web/                    # 前端：index.html + vendor/ + *.mjs
│   ├── deepseek-proxy/         # 后端：Fastify 多模型代理（历史命名，现已不限于 DeepSeek）
│   └── deploy/                 # 干净部署模板：setup.sh / longcode.conf / *.service
├── 设计总方案.txt              # 设计文档
├── 设计总方案_v2附录.md        # 设计文档 v2 附录（§10.x 逐轮记录）
├── AGENTS.md                   # 项目协作规范 / 施工红线
├── CHANGELOG.md                # 更新日志
├── CONTRIBUTING.md             # 贡献指南
├── LICENSE                     # MIT
├── NOTICE                      # 第三方依赖归属
└── README.md
```

> 注意：仓库**不含** `_deploy/` 目录（那是本机已部署实例的镜像，含真实服务器 IP / 域名 / 路径，已通过 `.gitignore` 排除）。请勿将其提交到公开仓库。

---

## 🔌 多模型支持

平台已放开「用户自选模型」：**传输层是标准 OpenAI Chat Completions**，后端只做转发、注入 Key、跑质量闸门，因此任何 OpenAI 兼容端点都能接。

### 界面怎么选
前端顶栏提供：
- **供应商下拉**：DeepSeek（默认）/ OpenAI / OpenRouter / 通义千问 / 月之暗面 Kimi / Ollama（本地）/ 自定义。
- **模型名输入框**：自由填写（如 `gpt-4o`、`qwen-max`、`moonshot-v1-128k`）；自带 datalist 预设。
- **上游地址**：选「自定义」或「Ollama」时出现，可填任意 `https://.../v1`。
- **上下文窗口**：选「自定义」或「Ollama」时出现，按你模型的真实窗口填写（停止线取 85%，留 15% 余量）。

> 每个请求都会带上 `provider` + `apiBase` + `model` 发往后端；后端据此决定要不要发送某些供应商私有字段（见下），未填上游地址时回落到服务端默认上游。

### 供应商能力差异
各家对 OpenAI 协议的「方言」支持不同，后端按供应商自动开关以下非标准字段，避免发给不兼容的供应商导致 400：
- `thinking:{type:'disabled'}`（关闭思考链）：仅 DeepSeek 发送（审查接口必须关，否则会烧光 token 空转）。
- `stream_options:{include_usage:true}`（流式也拿真实 token 计量）：除极个别端点外都支持；不支持就不发。
- `response_format:{type:'json_object'}`（强制 JSON 输出）：审查接口依赖，多数支持。
- 未知 / 自定义供应商：只发标准字段，最不容易报错。

### 本机 Ollama
连本地 Ollama（`http://localhost:11434/v1`）时，因地址是本地网段，后端 SSRF 防护默认拦截，**必须在后端设 `ALLOW_LOCAL_TARGETS=1`**：
```bash
ALLOW_LOCAL_TARGETS=1 PORT=8787 HOST=127.0.0.1 node server.js
```
此开关仅在**单人自托管**时合理；公网 / 多用户实例请勿开启（否则任何人都能探测宿主机端口）。

### 两种部署形态：开源多模型 / 自用只跑 DeepSeek

同一份代码，两种运行形态，由**一个环境变量**决定：

| 形态 | 配置 | 行为 |
|---|---|---|
| **开源（默认）** | 不设 `LC_MULTI_MODEL` | 多模型全开：顶栏可切供应商、模型名自由填写 |
| **自用（单模型）** | `.env` 里 `LC_MULTI_MODEL=0` | 只认 DeepSeek：隐藏「供应商」入口，模型名回落到 DeepSeek 白名单 |

关闭多模型时：

- `GET /api/health` 返回 `{"multiModel": false, "providers": ["deepseek"]}`
- 前端据此**隐藏整个「供应商」入口**，模型建议只剩 DeepSeek 三个（`deepseek-flash` / `deepseek-chat` / `deepseek-reasoner`）
- 后端把任何 `provider` 都按 `deepseek` 处理，模型名不在白名单时直接报一句人话：
  「当前部署仅启用 DeepSeek（LC_MULTI_MODEL=0），模型名须为：…」

为什么要有这个开关：多模型是**给使用者的能力**，但自建部署通常只想接一家
（也常见于只配了一个 Key、不想暴露供应商选择）。用环境变量而不是改代码，
是为了让"仓库默认形态"与"实际部署形态"**永远一致、可随时切换**，
避免出现"线上跑的文件和仓库不一样"这种隐性错版 —— 那类问题极难复现与定位。

```bash
# 自用：只跑 DeepSeek
echo 'LC_MULTI_MODEL=0' >> .env

# 开源/多模型：确保没有这一行（或设为 1）
grep -v '^LC_MULTI_MODEL=0' .env > .env.tmp && mv .env.tmp .env
```

### 安全说明
放开「每用户每次可带 apiBase」后，后端对上游地址做了 SSRF 防护：只接受 http/https，解析后的 IP 命中链路本地 / 云元数据 / 内网 / 保留段一律拦截；公网明文 http 一律拒绝。已知残留风险是 DNS rebinding（详见 `lib/ssrf.js` 注释）。

---

## 🚀 快速开始（本地试跑）

### 前置条件
- Node.js ≥ 18
- 一个模型供应商的 API Key（默认 DeepSeek；选用其它供应商时填对应 Key，例如 OpenAI / 通义千问 / Kimi 等）

### 1. 启动后端代理
```bash
cd deploy-pkg/deepseek-proxy
npm install
PORT=8787 HOST=127.0.0.1 node server.js
```
可选环境变量：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `8787` | 监听端口 |
| `HOST` | `127.0.0.1` | 监听地址（公网部署改 `0.0.0.0` 并配合反向代理） |
| `DEEPSEEK_API_BASE` | `https://api.deepseek.com` | 服务端**默认**上游地址。用户在前端不填「上游地址」时回落到这里；多模型下可改为任意 OpenAI 兼容端点（如 OpenAI / 通义千问 / Kimi 的 `/v1`）。 |
| `ALLOW_LOCAL_TARGETS` | `''` | 仅当要连**本机 Ollama**（`http://localhost:11434`）时设为 `1`。开启后后端才允许访问本地 / 内网地址；默认关闭（SSRF 防护），公网 / 多用户实例请勿开启。 |
| `ALLOWED_ORIGIN` | `''` | CORS 允许的源（填前端托管地址，如 `http://localhost:5173`） |
| `APP_TOKEN` | `''` | 可选的应用令牌，留空则不校验 |
| `LOG_LEVEL` | `info` | 日志级别 |

> 每个用户请求也可以通过界面自带 `apiBase` + 任意 `model`，不依赖上面的默认上游；默认上游仅用于「前端未填上游地址」的兼容场景。

### 2. 托管前端（静态文件）
后端只处理 `/api/*`，前端需另行托管：
```bash
cd deploy-pkg/web
npx serve -l 5173 .          # 任意静态服务器均可
```
然后浏览器打开 `http://localhost:5173/`，在界面顶栏选择模型供应商并填入对应的 API Key，开始使用。

> 提示：若不设置 `ALLOWED_ORIGIN`，浏览器会因 CORS 拦截请求；把它设为前端的实际访问地址即可。

---

## 🔑 使用说明

1. **选择供应商并填写 API Key**：界面首次使用需在顶栏选择供应商，并填入你自己的对应 Key（仅存于浏览器 `localStorage`，不会上传给任何第三方）。
2. **选择模式**：
   - **智能生成**：自由描述需求，平台自动续写 + 每轮质量闸门。
   - **需求工作流**：用结构化表单采集需求，走「分析 → 评审 → 生成」流水线，支持契约双端。
3. **质检开关**：🧩 按钮可独立开关质量闸门（静态校验 / 小模型审查），按需取舍。

---

## 🛡 零 token 质量闸门

平台的核心成本护城河：**只有 `/api/chat` 与 `/api/review` 消耗模型 token**，其余校验全在本地完成：

| 端点 | 是否耗 token | 作用 |
|------|-------------|------|
| `static-check` | 否（Tree-sitter wasm） | 语法 / 符号冲突 / 压缩检测 |
| `extract-api`  | 否（正则） | 从代码抽取 API / DTO |
| `consistency`  | 否（正则） | 前后端契约一致性 |
| `review`       | 是（小模型） | high 级问题审查与修复 |
| `chat`         | 是（大模型） | 生成 / 续写 |

---

## 📦 生产部署

`deploy-pkg/deploy/` 提供了干净模板：
- `setup.sh`：安装依赖、拉取前端 vendor 库（marked / DOMPurify / highlight.js / jszip）、写入 nginx 配置与服务单元。
- `longcode.conf`：nginx 站点模板（**不含**任何真实 IP / 域名，部署时自行填充）。
- `deepseek-proxy.service`：systemd 单元。

在自有 VPS 上执行 `setup.sh` 即可；反向代理与 Basic 认证请按你的域名自行配置。

---

## 🐳 Docker 一键部署

不想折腾 Node / nginx / 路径？用容器一条命令起整套（前端 + 后端 + 反代）：

```bash
cd deploy-pkg
docker compose up -d      # 构建并后台启动
```

启动后浏览器打开 **http://localhost:8080** 即可使用。前端默认 `apiBase` 为同源 `/api`，由 nginx 反代到后端，**无需配置 CORS**。

> 💡 **一键部署（复制即跑）**：`git clone https://github.com/dongzishuo666/longcode-platform.git && cd longcode-platform/deploy-pkg && docker compose up -d`，然后访问 http://localhost:8080 。首次构建需联网拉取 npm 依赖与前端 CDN 库。

涉及文件（都在 `deploy-pkg/`）：
- `docker-compose.yml`：编排两个服务 `web`（nginx 静态 + 反代）与 `backend`（Fastify 代理）。
- `web/Dockerfile` + `web/nginx.conf`：nginx 镜像，构建时自动补齐前端第三方库（marked / DOMPurify / highlight.js），并反向代理 `/api/` → `backend:8787`。
- `deepseek-proxy/Dockerfile`：后端镜像，仅装运行时依赖。

常用操作：
```bash
docker compose logs -f web      # 看前端 / 反代日志
docker compose logs -f backend  # 看后端日志
docker compose down             # 停止并移除容器（数据卷 proxy_data 保留，记忆不丢）
docker compose up -d --build    # 代码更新后重新构建
```

注意事项：
- **端口**：宿主机映射为 `8080`（避免占用 80），被占用可在 `docker-compose.yml` 改 `"8080:80"`。
- **多模型**：默认开启；想关掉只留 DeepSeek，在 compose 的 `backend.environment` 里把 `LC_MULTI_MODEL` 设为 `"0"`。
- **本机 Ollama**：示例见上方「🦙 连本机 Ollama」；核心是后端 `ALLOW_LOCAL_TARGETS=1` + 让后端能访问宿主机的 11434 端口。
- **记忆持久化**：运行态记忆库挂载到命名卷 `proxy_data`，容器重建不会丢；不要用 `docker compose down -v` 误删。
- 构建时需联网（拉取 npm 依赖与前端 CDN 库）；`backend` 已设 `HOST=0.0.0.0` 以允许容器间通信。

### 🦙 连本机 Ollama（`docker-compose.ollama.yml`）

默认 compose 的后端在桥接网络，容器内 `localhost` ≠ 宿主机，连不到本机 Ollama（`http://localhost:11434`）。仓库提供了 `docker-compose.ollama.yml`：通过 `extra_hosts` 把宿主机暴露给后端容器（`host.docker.internal` → 宿主机网关），从而能访问本机 Ollama，同时保留标准桥接网络（不占宿主机 80 端口、web→backend 仍走服务名）。

```bash
cd deploy-pkg
docker compose -f docker-compose.ollama.yml up -d
```

然后在界面里选「Ollama（本地）」供应商，并把上游地址填为：

```
http://host.docker.internal:11434/v1
```

> ⚠ 仅单人自托管时这样连本机 Ollama；公网 / 多用户实例请勿开 `ALLOW_LOCAL_TARGETS`。
> 想用真正的 `network_mode: host`？把 `web` 与 `backend` 都加 `network_mode: host` 即可（代价：直接占用宿主机 80 与 8787 端口，且 web→backend 要走 `127.0.0.1`）。

---

## 📜 许可证

[MIT](./LICENSE) —— 详见 LICENSE 文件。

第三方依赖归属见 [NOTICE](./NOTICE)。

版本更新见 [CHANGELOG.md](./CHANGELOG.md)，正式发布见 [Releases](https://github.com/dongzishuo666/longcode-platform/releases)。

---

## 🔌 没有后端代理时，前端能做什么？

本项目是 **前端 SPA + 无状态代理** 两段式架构。前端**不直接**调用模型供应商——所有 AI 请求都要经过你自己的后端代理（`deploy-pkg/deepseek-proxy`）转发，代理负责注入 Key、处理 CORS、跑 Tree-sitter 质量闸门。

因此，**只打开前端、不启动后端时**：

| 能力 | 可用？ | 说明 |
|------|--------|------|
| 界面浏览、模式切换（`智能生成` / `需求工作流`） | ✅ | 纯前端状态，无需网络 |
| 会话搜索、中英界面切换 | ✅ | 纯本地 |
| 填入 / 读取 API Key（存于 localStorage） | ✅ | 但因为没有代理，Key 无法被用于任何请求 |
| 发起代码生成 / 续写（`/api/chat`） | ❌ | 无代理转发，请求失败 |
| 质量闸门（`/api/static-check` 等） | ❌ | 闸门由后端 wasm 执行 |
| 需求评审 / 小模型审查（`/api/review`） | ❌ | 需要代理与模型 |

**结论**：后端代理不是"可选加速层"，而是**功能必需**。没有它，前端只是一个能看的空壳。请务必按[快速开始](#-快速开始本地试跑)或[生产部署](#-生产部署)把后端跑起来。

> 为什么不前端直连模型服务？① 浏览器跨域（CORS）会被模型服务拦截；② 直连会把你的 API Key 暴露在前端代码可达处、且无法做服务端质量闸门与限流。代理这一段正是为了**安全 + 零 token 闸门**而存在。

---

## ⚠️ 免责声明

- 本项目是一个**客户端 + 无状态代理**，不重新分发任何模型权重；你调用的模型能力由所选供应商提供（默认 DeepSeek），请遵守其服务条款。
- 使用你**自己的** API Key，产生的费用与内容由你自己负责。
- 作者不提供任何可用性、安全性或合规保证；代码按「原样」提供。
