/**
 * DeepSeek 官方 API 轻量代理层（智能代码生成平台后端）。
 *
 * 路由：
 *   POST /api/chat    流式对话（SSE，标准化事件）
 *   POST /api/review  增量代码审查（非流式 + 强制 JSON + 关闭思考链 + 独立超时）
 *   POST /api/spec-fill AI 辅助填写需求表单（非流式 + 强制 JSON，只写表单不参与生成）
 *   POST /api/static-check 零 token 静态校验（Tree-sitter 语法/符号/冲突/压缩）
 *   POST /api/extract-api  零 token 接口提取（前端调用 / 后端路由定义）
 *   POST /api/consistency  零 token 三方一致性比对（契约 / 前端 / 后端）
 *   POST /api/test    连接测试（非流式）
 *   GET  /api/health  健康检查
 *
 * 错误通道分流（总方案 3.6）：
 *   流式前 → HTTP 状态码 + JSON { code, message }
 *   流式后 → SSE { type:"error", data:{ code, message } }
 *
 * Prompt 注入（总方案 3.3）：后端唯一注入点，只注入用户自定义 systemPrompt。
 */

import Fastify from 'fastify';

import {
  validateChatBody,
  validateTestBody,
  validateReviewBody,
  validateSpecFillBody,
  validateStaticCheckBody,
  validateExtractApiBody,
  validateConsistencyBody,
  validateRecallBody,
  validateIngestBody,
  validateImportBody,
  validateFeedbackBody,
  validateTitleBody,
  MAX_BODY_BYTES,
} from './lib/validate.js';
import { staticCheck, loadedLanguages } from './lib/static-check.js';
import {
  acquireStaticSlot,
  releaseStaticSlot,
  MAX_STATIC_CONCURRENCY,
} from './lib/static-check.js';
import {
  loadMemories,
  saveMemories,
  recallMemories,
  formatMemoriesForPrompt,
  ingestMemory,
  patchMemory,
  listMemories,
  recordFeedback,
  ensureSeeds,
  MAX_ITEMS,
} from './lib/memories.js';
import { extractApis, extractDtos, checkConsistency } from './lib/api-contract.js';
import { ErrorCodes, toErrorBody, httpStatusOf } from './lib/errors.js';
import { callWithRetry, pipeStream, callReview } from './lib/deepseek.js';
import { sseLine, sseKeepalive, toErrorEvent } from './lib/sse.js';
// 多模型界线（2026-10-24）：开关与可用供应商列表，由 /api/health 暴露给前端
import { MULTI_MODEL_ENABLED, enabledProviderKeys } from './lib/providers.js';
import {
  REVIEW_SYSTEM_PROMPT,
  buildReviewUserPrompt,
  normalizeIssues,
  hasBlockingIssue,
} from './lib/review.js';
import { TITLE_SYSTEM_PROMPT, TITLE_TIMEOUT_MS, normalizeTitle } from './lib/title.js';
import {
  SPEC_FILL_SYSTEM_PROMPT,
  buildSpecFillUserPrompt,
  normalizeSpecFill,
} from './lib/spec-fill.js';
// 闸门事件日志（2026-10-30）：只记统计，fire-and-forget，写失败静默
import { logStaticCheck, logConsistency, logReviewPrecheck } from './lib/gate-log.js';

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
// 默认上游地址（部署者配，可信）。
// 2026-10-24 放开多模型后，请求里可自带 apiBase（用户在前端选的供应商地址），
// 此时以请求为准；不传才回落到这个默认值（老客户端 / 直接调 API 的场景）。
// 请求带来的 apiBase 会过 ssrf.js 的 SSRF 校验，默认值本身不校验（部署者可控）。
const API_BASE = (
  process.env.DEEPSEEK_API_BASE || 'https://api.deepseek.com'
).replace(/\/+$/, '');
// CORS 允许来源。默认【空】= 不回显 CORS 头 = 只允许同源。
// 前端 apiBase 是相对路径 '/api'，与页面同源，同源请求本就不需要 CORS 头；
// 早先默认 '*' 等于对任何网站放行，没必要。确需跨源（如前后端分域名部署）时
// 用环境变量显式列出：ALLOWED_ORIGIN=https://a.com,https://b.com
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '';
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
// 可选应用令牌：未配置则完全跳过校验（不影响现有部署）。
// 目的不是"安全"（/api/chat 本来就要用户自带 apiKey），而是防止服务器被当成免费代理：
// 任何人拿到域名就能用自己的 key 白用这里的带宽与转发。
const APP_TOKEN = process.env.APP_TOKEN || '';
// static-check 的并发闸与字符配额已搬进 lib/static-check.js 的 acquireStaticSlot/releaseStaticSlot：
// 两个入口（/api/static-check 与 /api/review 的 preCheck）共用同一套计数器，
// 避免 preCheck 旁路绕过限流。取值仍由环境变量控制。

// 支持逗号分隔的多来源白名单（域名入口与 IP:端口入口并存时都要放行）
const ALLOWED_ORIGINS = String(ALLOWED_ORIGIN)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// 按请求的 Origin 回显命中的来源；通配 '*' 直接回显；未命中则不返回该头
function resolveOrigin(req) {
  if (ALLOWED_ORIGINS.includes('*')) return '*';
  const origin = req && req.headers ? req.headers.origin : undefined;
  if (origin && ALLOWED_ORIGINS.includes(origin)) return origin;
  return '';
}

const CONNECT_TIMEOUT_MS = 30_000;
const TEST_CONNECT_TIMEOUT_MS = 10_000;
const HEARTBEAT_MS = 15_000;

const app = Fastify({
  logger: { level: LOG_LEVEL },
  bodyLimit: MAX_BODY_BYTES,
});

// ---------- CORS ----------
app.addHook('onRequest', async (req, reply) => {
  const corsOrigin = resolveOrigin(req);
  if (corsOrigin) reply.header('Access-Control-Allow-Origin', corsOrigin);
  reply.header('Vary', 'Origin');
  reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  reply.header('Access-Control-Allow-Headers', 'Content-Type, X-App-Token');
  reply.header('Access-Control-Max-Age', '600');

  if (req.method === 'OPTIONS') {
    return reply.code(204).send();
  }

  // 可选应用令牌：只有配置了 APP_TOKEN 才校验，未配置时零影响。
  // /api/health 是探测入口，必须放行 —— 否则前端拿不到「是否需要令牌」，形成死锁。
  if (APP_TOKEN && req.url.startsWith('/api/') && !req.url.startsWith('/api/health')) {
    if (req.headers['x-app-token'] !== APP_TOKEN) {
      return reply.code(401).send({
        code: ErrorCodes.AUTH_FAILED,
        message: '应用校验失败：缺少或错误的 X-App-Token',
      });
    }
  }
});

// ---------- 健康检查 ----------
// appTokenRequired 供前端探测：只有服务端启用了 APP_TOKEN 才显示令牌输入框
app.get('/api/health', async () => ({
  ok: true,
  ts: Date.now(),
  appTokenRequired: !!APP_TOKEN,
  // 界线（2026-10-24）：多模型能力总开关。
  //   true  = 开源形态：用户可自选供应商与模型名
  //   false = 自用形态：只跑 DeepSeek（LC_MULTI_MODEL=0），前端据此隐藏供应商入口
  multiModel: MULTI_MODEL_ENABLED,
  providers: enabledProviderKeys(),
}));

// ---------- /api/chat（流式） ----------
app.post('/api/chat', async (req, reply) => {
  // 阶段 1：校验（失败 → HTTP + JSON）
  let parsed;
  try {
    parsed = await validateChatBody(req.body);
  } catch (err) {
    const body = toErrorBody(err);
    req.log.warn({ code: body.code, message: body.message }, 'chat validate failed');
    return reply.code(httpStatusOf(body.code)).send(body);
  }

  // 阶段 1.5：Prompt 注入（后端唯一注入点）
  // systemPrompt 非空 → 作为 {role:'system'} 置于 messages 最前
  const requestMsgs = parsed.systemPrompt
    ? [{ role: 'system', content: parsed.systemPrompt }, ...parsed.messages]
    : parsed.messages;

  // 客户端断开联动上游
  const clientAbort = new AbortController();
  reply.raw.once('close', () => clientAbort.abort());

  // 阶段 2：建立上游连接（含重试；流式开始前，尚未发出任何 chunk）
  const startedAt = Date.now();
  let upstream;
  try {
    upstream = await callWithRetry({
      apiBase: parsed.apiBase,
      apiKey: parsed.apiKey,
      model: parsed.model,
      provider: parsed.provider,
      messages: requestMsgs,
      temperature: parsed.temperature,
      stream: true,
      connectTimeoutMs: CONNECT_TIMEOUT_MS,
      externalSignal: clientAbort.signal,
    });
  } catch (err) {
    if (err && err.name === 'ClientAborted') {
      return reply; // 客户端已断开
    }
    const body = toErrorBody(err);
    req.log.warn(
      { code: body.code, ms: Date.now() - startedAt },
      'chat upstream failed'
    );
    return reply.code(httpStatusOf(body.code)).send(body);
  }

  // 阶段 3：切换到 SSE（此后错误只能走 SSE error 事件）
  reply.hijack();
  const sseHeaders = {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  };
  const corsOrigin = resolveOrigin(req);
  if (corsOrigin) sseHeaders['Access-Control-Allow-Origin'] = corsOrigin;
  reply.raw.writeHead(200, sseHeaders);

  const heartbeat = setInterval(() => {
    if (!reply.raw.writableEnded) {
      try {
        reply.raw.write(sseKeepalive());
      } catch {
        /* ignore */
      }
    }
  }, HEARTBEAT_MS);

  // 统计：是否产出过内容 / 是否已发过 chunk（发过则禁止重试，总方案 7.6）
  let sentBytes = 0;
  let hasPayload = false;

  const writeEvent = (event) => {
    if (reply.raw.writableEnded) return;
    if (event.type === 'content' || event.type === 'reasoning') {
      hasPayload = true;
    }
    try {
      const line = sseLine(event);
      reply.raw.write(line);
      sentBytes += line.length;
    } catch {
      /* ignore */
    }
  };

  try {
    await pipeStream(upstream, writeEvent, clientAbort.signal);

    // 空回复兜底（总方案 7.5）：既无正文也无思考链 → 视为 UPSTREAM_ERROR
    if (!hasPayload && !clientAbort.signal.aborted) {
      writeEvent(
        toErrorEvent(ErrorCodes.UPSTREAM_ERROR, '上游返回空内容，请重试')
      );
      req.log.warn({ ms: Date.now() - startedAt }, 'chat empty response');
    }

    req.log.info({ ms: Date.now() - startedAt, sentBytes }, 'chat stream done');
  } catch (err) {
    if (err && err.name === 'ClientAborted') {
      // 客户端断开，静默
    } else if (!clientAbort.signal.aborted) {
      const body = toErrorBody(err);
      writeEvent(toErrorEvent(body.code, body.message));
      req.log.warn(
        { code: body.code, ms: Date.now() - startedAt },
        'chat stream error'
      );
    }
  } finally {
    clearInterval(heartbeat);
    if (!reply.raw.writableEnded) {
      try {
        reply.raw.end();
      } catch {
        /* ignore */
      }
    }
  }
  return reply;
});

// ---------- /api/test ----------
app.post('/api/test', async (req, reply) => {
  let parsed;
  try {
    parsed = await validateTestBody(req.body);
  } catch (err) {
    const body = toErrorBody(err);
    return reply.code(httpStatusOf(body.code)).send(body);
  }

  const startedAt = Date.now();
  try {
    const resp = await callWithRetry({
      apiBase: parsed.apiBase,
      apiKey: parsed.apiKey,
      model: parsed.model,
      provider: parsed.provider,
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 1,
      stream: false,
      connectTimeoutMs: TEST_CONNECT_TIMEOUT_MS,
    });
    try {
      await resp.text(); // 消费响应释放连接
    } catch {
      /* ignore */
    }
    req.log.info(
      { ms: Date.now() - startedAt, model: parsed.model, provider: parsed.provider },
      'test ok'
    );
    return reply.send({ ok: true });
  } catch (err) {
    const body = toErrorBody(err);
    req.log.warn(
      { code: body.code, ms: Date.now() - startedAt },
      'test failed'
    );
    return reply.code(httpStatusOf(body.code)).send(body);
  }
});

// ---------- /api/title（会话标题：AI 总结项目名，中英双版） ----------
// 背景（2026-10-23 用户反馈）：标题原先取用户消息前 20 字，侧栏里是一堆
// 半句话（"做一个电商下单，要防止超卖…"），看着乱且中英切换无法跟随。
// 改为让模型给出一个"项目名"（zh 2-8 汉字 / en 2-4 词），两条一起返回，
// 前端按当前语言选一条显示 —— 切换语言时标题也跟着切。
//
// 成本控制：一次会话只跑一次（前端 titleAi 标记），maxTokens 120，
// 超时 5s，失败/超时都返回空串让前端保留原标题，绝不阻塞主流程。
app.post('/api/title', async (req, reply) => {
  let parsed;
  try {
    parsed = await validateTitleBody(req.body);
  } catch (err) {
    const body = toErrorBody(err);
    return reply.code(httpStatusOf(body.code)).send(body);
  }

  const startedAt = Date.now();
  try {
    const { content, usage } = await callReview({
      apiBase: parsed.apiBase,
      apiKey: parsed.apiKey,
      model: parsed.model,
      provider: parsed.provider,
      systemPrompt: TITLE_SYSTEM_PROMPT,
      userPrompt: parsed.text,
      temperature: 0.3,
      maxTokens: 120,
      timeoutMs: TITLE_TIMEOUT_MS,
    });
    const t = normalizeTitle(content);
    req.log.info(
      { ms: Date.now() - startedAt, model: parsed.model, hasZh: !!t.zh, hasEn: !!t.en },
      'title done'
    );
    return reply.send({
      ok: true,
      zh: t.zh,
      en: t.en,
      ms: Date.now() - startedAt,
      usage,
      model: parsed.model,
    });
  } catch (err) {
    // 超时/上游抖动：返回 200 + 空标题 —— 标题是锦上添花，不能让它变成报错
    if (err && err.code === ErrorCodes.TIMEOUT) {
      req.log.warn({ ms: Date.now() - startedAt }, 'title timeout -> keep fallback');
      return reply.send({ ok: true, zh: '', en: '', timedOut: true });
    }
    const body = toErrorBody(err);
    req.log.warn({ code: body.code, message: body.message, ms: Date.now() - startedAt }, 'title failed');
    return reply.code(httpStatusOf(body.code)).send(body);
  }
});

// ---------- /api/review（增量代码审查：非流式 + 强制 JSON + 关闭思考链 + 独立超时） ----------
// 定位：紧跟代码生成节点的即时增量审查，只审本次新生成片段，严格增量、不回溯全量代码。
app.post('/api/review', async (req, reply) => {
  let parsed;
  try {
    parsed = await validateReviewBody(req.body);
  } catch (err) {
    const body = toErrorBody(err);
    req.log.warn({ code: body.code, message: body.message }, 'review validate failed');
    return reply.code(httpStatusOf(body.code)).send(body);
  }

  const startedAt = Date.now();
  try {
    // ---- 前置静态过滤（零 token）：语法错误直接打回重生成，不进入模型 ----
    let codeToReview = parsed.code;
    let preCheck = null;
    if (parsed.preCheck) {
      // 与 /api/static-check 共用同一套并发闸与字符配额。
      // 这里以前是裸调 staticCheck() —— 等于给静态校验开了个不限流的旁门：
      // 双端并行时几个 review 同时打进来就能把 CPU 吃满，而 /api/static-check
      // 那边反倒在被限流。
      //
      // 拿不到名额时的取舍与 /api/static-check 【刻意不同】：跳过静态前置、照常送审，
      // 而不是返回 429 —— preCheck 只是省 token 的优化，它失败不该让整次审查失败。
      const slot = acquireStaticSlot(parsed.code.length);
      if (!slot.ok) {
        req.log.info(
          { reason: slot.reason, limit: MAX_STATIC_CONCURRENCY },
          'review preCheck skipped by static-check quota'
        );
      } else {
        // 注意 try/finally：中间有提前 return（语法不过直接打回），
        // 没有 finally 的话并发名额就漏放了。
        try {
          const st = await staticCheck({
            code: parsed.code,
            language: parsed.language,
            globalSymbols: parsed.symbolTable,
            compress: true,
          });

          // 静态校验自身不可用（解析器加载失败 / 解析抛错）时，staticCheck 返回
          // { ok:false, supported:true, reason }，且【没有 syntax 字段】。
          // 此前这里只看 st.supported，后果有两个：
          //   ① 不 blocked → 静默继续送审，白花一次审查 token；
          //   ② preCheck 里 syntax / symbols / conflicts 全是 undefined，
          //      但 HTTP 层 ok:true —— 降级被静默吞掉，没人看得出"这次其实没检"。
          // /api/static-check 路由对同一情况返回 500；这里更温和：跳过压缩与审查，
          // 返回明确标记让调用方知道静态层没生效。
          // 注意【不能】用 degraded:true 表达这件事：前端把 degraded 当"审查失败"，
          // 会累加 failStreak 并最终把整个审查功能降级 —— 那是另一回事，不能误触。
          if (!st.ok) {
            req.log.warn(
              { reason: st.reason, language: parsed.language },
              'review preCheck skipped: static check unavailable'
            );
            return reply.send({
              ok: true,
              blocked: false,
              issues: [],
              staticSkipped: true,
              reason: st.reason || '静态校验不可用，已跳过前置检查',
              ms: Date.now() - startedAt,
              model: parsed.model,
            });
          }

          // 记一笔"这次送审前被静态拦下 / 放过"，用于统计省了多少次模型调用
          logReviewPrecheck(st, parsed.code.length);

          preCheck = {
            supported: st.supported,
            syntax: st.syntax,
            symbols: st.symbols,
            conflicts: st.conflicts,
            compressed: st.compressed,
          };

          if (st.supported && st.syntax && st.syntax.errorCount > 0) {
            req.log.warn(
              { errors: st.syntax.errorCount, language: parsed.language },
              'review blocked by static syntax check'
            );
            return reply.send({
              ok: true,
              blocked: true,
              stage: 'static',
              reason: '语法校验未通过，建议打回重生成（本次未消耗任何 token）',
              syntax: st.syntax,
              symbols: st.symbols,
              conflicts: st.conflicts,
              ms: Date.now() - startedAt,
              model: parsed.model,
            });
          }

          // 语法通过 → 用压缩后的代码送审，降低输入体积
          if (st.compressed && st.compressed.code) {
            codeToReview = st.compressed.code;
          }
        } finally {
          releaseStaticSlot();
        }
      }
    }

    const { content, usage } = await callReview({
      apiBase: parsed.apiBase,
      apiKey: parsed.apiKey,
      model: parsed.model,
      provider: parsed.provider,
      systemPrompt: REVIEW_SYSTEM_PROMPT,
      userPrompt: buildReviewUserPrompt({
        language: parsed.language,
        symbolTable: parsed.symbolTable,
        boundaryContext: parsed.boundaryContext,
        code: codeToReview,
      }),
      temperature: parsed.temperature,
      maxTokens: parsed.maxTokens,
      timeoutMs: parsed.timeoutMs,
    });

    const ms = Date.now() - startedAt;
    const { issues, degraded, raw, parseError } = normalizeIssues(content);

    req.log.info(
      { ms, model: parsed.model, issues: issues.length, degraded, parseError },
      'review done'
    );

    return reply.send({
      ok: true,
      issues,
      degraded, // JSON 解析失败 → 降级（前端按「待批量复核」处理）
      blocking: hasBlockingIssue(issues), // 含 high → 暂停分支，交大模型复核
      parseError,
      raw,
      ms,
      usage,
      model: parsed.model,
      preCheck, // 零 token 前置过滤结果（语法 / 符号 / 压缩）
    });
  } catch (err) {
    const ms = Date.now() - startedAt;

    // 超时：按方案「超时则跳过本次审查，标记为待后续批量复核」，
    // 返回 200 而非错误，保证不阻塞下一段代码生成。
    if (err && err.code === ErrorCodes.TIMEOUT) {
      req.log.warn({ ms, timeoutMs: parsed.timeoutMs }, 'review timeout -> skip');
      return reply.send({
        ok: true,
        timedOut: true,
        pending: true,
        issues: [],
        blocking: false,
        degraded: true,
        ms,
        model: parsed.model,
      });
    }

    const body = toErrorBody(err);
    req.log.warn({ code: body.code, message: body.message, ms }, 'review failed');
    return reply.code(httpStatusOf(body.code)).send(body);
  }
});

// ---------- /api/spec-fill（AI 辅助填写需求表单，2026-10-28） ----------
// 定位：程序员档 workflow 表单的"自然语言起草"。只写表单，不参与生成链路。
// 与 /api/review 同构（非流式 + 强制 JSON + 独立超时），但输出是结构化表单而不是问题清单。
// 刻意复用 callReview：它就是个"非流式 + 强制 JSON + 超时 AbortController"的通路；
// 另抽一个通用 callModel 会动到审查主链路，收益不抵风险（要做另开一轮）。
app.post('/api/spec-fill', async (req, reply) => {
  let parsed;
  try {
    parsed = await validateSpecFillBody(req.body);
  } catch (err) {
    const body = toErrorBody(err);
    req.log.warn({ code: body.code, message: body.message }, 'spec-fill validate failed');
    return reply.code(httpStatusOf(body.code)).send(body);
  }

  const startedAt = Date.now();
  try {
    const { content, usage } = await callReview({
      apiBase: parsed.apiBase,
      apiKey: parsed.apiKey,
      model: parsed.model,
      provider: parsed.provider,
      systemPrompt: SPEC_FILL_SYSTEM_PROMPT,
      userPrompt: buildSpecFillUserPrompt({ description: parsed.description }),
      temperature: parsed.temperature,
      maxTokens: parsed.maxTokens,
      timeoutMs: parsed.timeoutMs,
    });

    const ms = Date.now() - startedAt;
    // 解析失败 → spec 为空 + degraded:true，前端据此【一个字段都不写】
    //（半截污染比不填更糟：用户会以为 AI 看懂了，实则一半是编的）
    const { spec, filledCount, degraded, parseError, raw } = normalizeSpecFill(content);

    req.log.info(
      { ms, model: parsed.model, filledCount, degraded, parseError, overwrite: parsed.overwrite },
      'spec-fill done'
    );

    return reply.send({
      ok: true,
      spec,
      filledCount,
      overwrite: parsed.overwrite,
      degraded,
      parseError,
      raw,
      ms,
      usage,
      model: parsed.model,
    });
  } catch (err) {
    const ms = Date.now() - startedAt;

    // 超时按 review 的取舍：返回 200 + 标记，不让一次起草失败变成错误弹窗
    if (err && err.code === ErrorCodes.TIMEOUT) {
      req.log.warn({ ms, timeoutMs: parsed.timeoutMs }, 'spec-fill timeout');
      return reply.send({
        ok: true,
        timedOut: true,
        spec: {},
        filledCount: 0,
        degraded: true,
        ms,
        model: parsed.model,
      });
    }

    const body = toErrorBody(err);
    req.log.warn({ code: body.code, message: body.message, ms }, 'spec-fill failed');
    return reply.code(httpStatusOf(body.code)).send(body);
  }
});

// ---------- /api/static-check（零 token：语法校验 + 符号提取 + 冲突初筛 + 压缩） ----------
// 纯本地 Tree-sitter 计算：不需要 apiKey，不消耗任何 token。
// 定位：生成后、送模型前的第一道闸门（方案第 2 步）。
app.post('/api/static-check', async (req, reply) => {
  let parsed;
  try {
    parsed = validateStaticCheckBody(req.body);
  } catch (err) {
    const body = toErrorBody(err);
    req.log.warn({ code: body.code, message: body.message }, 'static-check validate failed');
    return reply.code(httpStatusOf(body.code)).send(body);
  }

  // 滑动窗口配额 + 并发闸：挡「排队式刷量」与绕过 Nginx 直连 Node 的并发洪峰。
  // 逻辑已收进 lib/static-check.js，/api/review 的 preCheck 走同一套（见下）。
  const slot = acquireStaticSlot(parsed.code.length);
  if (!slot.ok) {
    if (slot.reason === 'chars') {
      req.log.warn({ incoming: parsed.code.length }, 'static-check window quota exceeded');
      return reply.code(429).send({
        code: ErrorCodes.RATE_LIMIT,
        message: '静态校验请求过密，请稍后重试',
      });
    }
    req.log.warn({ limit: MAX_STATIC_CONCURRENCY }, 'static-check concurrency limit');
    return reply.code(429).send({
      code: ErrorCodes.RATE_LIMIT,
      message: `静态校验正忙（并发上限 ${MAX_STATIC_CONCURRENCY}），请稍后重试`,
    });
  }
  try {
    const result = await staticCheck(parsed);
    req.log.info(
      {
        language: result.language,
        supported: result.supported,
        syntaxOk: result.syntax && result.syntax.ok,
        errors: result.syntax && result.syntax.errorCount,
        ms: result.ms,
      },
      'static-check done'
    );
    // 闸门统计落盘（一行一次调用；不记代码正文）
    logStaticCheck(result, parsed.code.length);
    // 注意：不能写 ok:true 覆盖——否则解析器加载失败会被静默吞掉，
    // 表现为「语法 0 错误」，而实际根本没解析。
    if (!result.ok) {
      return reply
        .code(500)
        .send({ code: ErrorCodes.UNKNOWN, message: result.reason || '静态校验失败' });
    }
    return reply.send({
      ...result,
      loadedLanguages: loadedLanguages(), // 便于观测 wasm 常驻情况
    });
  } catch (err) {
    req.log.error({ err }, 'static-check failed');
    const body = toErrorBody(err);
    return reply.code(httpStatusOf(body.code)).send(body);
  } finally {
    releaseStaticSlot();
  }
});

// ---------- /api/extract-api（契约驱动双端生成：零 token 接口提取） ----------
// 从代码里抽出前端的接口调用或后端的接口定义，供三方一致性比对使用。
// 纯本地正则计算：不需要 apiKey，不消耗 token，也不额外占用 wasm 内存。
app.post('/api/extract-api', async (req, reply) => {
  let parsed;
  try {
    parsed = validateExtractApiBody(req.body);
  } catch (err) {
    const body = toErrorBody(err);
    req.log.warn({ code: body.code, message: body.message }, 'extract-api validate failed');
    return reply.code(httpStatusOf(body.code)).send(body);
  }

  try {
    const started = Date.now();
    const result = extractApis(parsed);
    // 同一份代码顺带提取 DTO 定义（字段名 + 类型）：供 /api/consistency 做 DTO 级比对。
    // 之前只提接口，于是"契约说 ID 是 string(UUID)、代码改成 number"这类改动
    // 在一致性校验里完全看不见——路径和方法都对，只有类型被偷偷换掉。
    const dtos = extractDtos(parsed);
    req.log.info(
      { side: result.side, count: result.apis.length, dtos: dtos.length, ms: Date.now() - started },
      'extract-api done'
    );
    return reply.send({ ok: true, ...result, dtos, ms: Date.now() - started });
  } catch (err) {
    req.log.error({ err }, 'extract-api failed');
    const body = toErrorBody(err);
    return reply.code(httpStatusOf(body.code)).send(body);
  }
});

// ---------- /api/consistency（契约 / 前端 / 后端 三方比对，零 token） ----------
// 结构化比对：路径、方法、是否有对应实现。覆盖绝大多数不一致，
// 剩余语义层面的问题再交给小模型抽查（前端负责调度）。
app.post('/api/consistency', async (req, reply) => {
  let parsed;
  try {
    parsed = validateConsistencyBody(req.body);
  } catch (err) {
    const body = toErrorBody(err);
    req.log.warn({ code: body.code, message: body.message }, 'consistency validate failed');
    return reply.code(httpStatusOf(body.code)).send(body);
  }

  try {
    const started = Date.now();
    const result = checkConsistency(parsed);
    req.log.info(
      { ...result.summary, ms: Date.now() - started },
      'consistency done'
    );
    // 闸门统计落盘：chars 取三方输入总长（只记长度，不记内容）
    logConsistency(result, [parsed.contract, parsed.frontend, parsed.backend]
      .reduce((n, x) => n + (typeof x === 'string' ? x.length : (Array.isArray(x) ? x.join('').length : 0)), 0));
    return reply.send({ ok: true, ...result, ms: Date.now() - started });
  } catch (err) {
    req.log.error({ err }, 'consistency failed');
    const body = toErrorBody(err);
    return reply.code(httpStatusOf(body.code)).send(body);
  }
});

// ---------- /api/memories（记忆库：服务于下一次生成的可执行知识） ----------
// 存储与检索在后端（解决 localStorage 丢数据 / 5MB 上限 / 多设备），
// prompt 注入时机在前端（只有前端知道这次是什么 stack / 场景 / 契约）。
// 记忆库故障绝不拖垮生成：recall 失败由前端兜底为空，照常生成。
app.post('/api/memories/recall', async (req, reply) => {
  let parsed;
  try {
    parsed = validateRecallBody(req.body);
  } catch (err) {
    const body = toErrorBody(err);
    req.log.warn({ code: body.code, message: body.message }, 'memories recall validate failed');
    return reply.code(httpStatusOf(body.code)).send(body);
  }
  // 耗时观测（P4① 2026-10-27）：此前 ms 写的是 Date.now() 时间戳而非耗时，
  // 日志里的"recall 耗时"完全失真（其他端点都是 Date.now() - startedAt）。
  const startedAt = Date.now();
  try {
    const store = loadMemories();
    const r = recallMemories(store, parsed);
    req.log.info(
      { counts: r.counts, stack: parsed.stack || '', ms: Date.now() - startedAt },
      'memories recall done'
    );
    return reply.send({
      ok: true,
      items: r.items,
      counts: r.counts,
      prompt: formatMemoriesForPrompt(r),
      ms: Date.now() - startedAt,
    });
  } catch (err) {
    // 记忆库坏不影响主流程：返回空召回，让调用方照常生成
    req.log.error({ err }, 'memories recall failed');
    return reply.send({ ok: true, items: [], counts: {}, prompt: '', degraded: true });
  }
});

app.post('/api/memories/ingest', async (req, reply) => {
  let parsed;
  try {
    parsed = validateIngestBody(req.body);
  } catch (err) {
    const body = toErrorBody(err);
    req.log.warn({ code: body.code, message: body.message }, 'memories ingest validate failed');
    return reply.code(httpStatusOf(body.code)).send(body);
  }
  try {
    const store = loadMemories();
    const r = ingestMemory(store, parsed, { issueType: parsed.issueType });
    if (r.duplicate) {
      return reply.send({
        ok: true, duplicate: true,
        existing: r.existing,
        message: '已存在近似记忆，未重复入库',
      });
    }
    if (!r.ok) {
      return reply.code(400).send({ code: ErrorCodes.INVALID_REQUEST, message: r.error });
    }
    req.log.info({ id: r.memory.id, type: r.memory.type }, 'memories ingest done');
    return reply.send({ ok: true, memory: r.memory });
  } catch (err) {
    req.log.error({ err }, 'memories ingest failed');
    const body = toErrorBody(err);
    return reply.code(httpStatusOf(body.code)).send(body);
  }
});

app.get('/api/memories', async (req, reply) => {
  try {
    const store = loadMemories();
    const items = listMemories(store, {
      status: typeof req.query.status === 'string' ? req.query.status : '',
      type: typeof req.query.type === 'string' ? req.query.type : '',
    });
    return reply.send({ ok: true, items, total: store.items.length });
  } catch (err) {
    req.log.error({ err }, 'memories list failed');
    const body = toErrorBody(err);
    return reply.code(httpStatusOf(body.code)).send(body);
  }
});

app.patch('/api/memories/:id', async (req, reply) => {
  try {
    const store = loadMemories();
    const r = patchMemory(store, String(req.params.id || ''), req.body || {});
    if (!r.ok) {
      return reply.code(404).send({ code: ErrorCodes.NOT_FOUND, message: r.error });
    }
    req.log.info({ id: r.memory.id }, 'memories patch done');
    return reply.send({ ok: true, memory: r.memory });
  } catch (err) {
    req.log.error({ err }, 'memories patch failed');
    const body = toErrorBody(err);
    return reply.code(httpStatusOf(body.code)).send(body);
  }
});

// 导出 / 导入：记忆库的备份与迁移（JSON 文件虽可直接下载，API 方式更省事）
app.get('/api/memories/export', async (req, reply) => {
  try {
    const store = loadMemories();
    return reply.send({ ok: true, store });
  } catch (err) {
    req.log.error({ err }, 'memories export failed');
    const body = toErrorBody(err);
    return reply.code(httpStatusOf(body.code)).send(body);
  }
});

app.post('/api/memories/import', async (req, reply) => {
  let parsed;
  try {
    parsed = validateImportBody(req.body);
  } catch (err) {
    const body = toErrorBody(err);
    req.log.warn({ code: body.code, message: body.message }, 'memories import validate failed');
    return reply.code(httpStatusOf(body.code)).send(body);
  }
  try {
    const cur = loadMemories();
    const incoming = Array.isArray(parsed.store && parsed.store.items) ? parsed.store.items : [];
    let added = 0, skipped = 0;
    for (const item of incoming.slice(0, MAX_ITEMS)) {
      const r = ingestMemory(cur, item, {});
      if (r.ok) added++;
      else skipped++;   // 重复 / 非法都跳过，不中断整批
    }
    req.log.info({ added, skipped }, 'memories import done');
    return reply.send({ ok: true, added, skipped, total: cur.items.length });
  } catch (err) {
    req.log.error({ err }, 'memories import failed');
    const body = toErrorBody(err);
    return reply.code(httpStatusOf(body.code)).send(body);
  }
});

// ---------- 记忆反馈（recurrence check 落账，零 token） ----------
// 前端算好「注入的记忆在这次校验里被遵守还是被违反」，这里只累加。
// 违反会双倍降权（recall 打分），反复无效的规则被软挤出，无需硬删。
app.post('/api/memories/feedback', async (req, reply) => {
  let parsed;
  try {
    parsed = validateFeedbackBody(req.body);
  } catch (err) {
    const body = toErrorBody(err);
    req.log.warn({ code: body.code, message: body.message }, 'memories feedback validate failed');
    return reply.code(httpStatusOf(body.code)).send(body);
  }
  try {
    const store = loadMemories();
    const r = recordFeedback(store, parsed.entries);
    req.log.info({ updated: r.updated }, 'memories feedback done');
    return reply.send({ ok: true, updated: r.updated });
  } catch (err) {
    // 反馈失败不影响主流程
    req.log.error({ err }, 'memories feedback failed');
    return reply.send({ ok: true, updated: 0, degraded: true });
  }
});

// ---------- 批量淘汰待确认候选（用户主动清理） ----------
// 场景：一次生成沉淀了太多噪声候选（如 2026-10-19 线上 45 条，其中 36 条是
// 本就"需人工确认"的 dto_missing），逐条点淘汰不现实。这个接口一键清空。
app.post('/api/memories/discard-pending', async (req, reply) => {
  try {
    const store = loadMemories();
    let discarded = 0;
    const now = Date.now();
    for (const m of store.items) {
      if (m.status === 'pending') {
        m.status = 'retired';
        m.updatedAt = now;
        discarded++;
      }
    }
    if (discarded > 0) saveMemories(store);
    req.log.info({ discarded }, 'memories discard-pending done');
    return reply.send({ ok: true, discarded });
  } catch (err) {
    req.log.error({ err }, 'memories discard-pending failed');
    const body = toErrorBody(err);
    return reply.code(httpStatusOf(body.code)).send(body);
  }
});

// ---------- 全局错误处理 ----------
app.setErrorHandler((err, req, reply) => {
  // Fastify 内建：请求体超限
  if (err && err.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
    return reply
      .code(400)
      .send({ code: ErrorCodes.INVALID_REQUEST, message: '请求体过大' });
  }
  // Fastify 内建：非法 JSON
  if (err && err.code === 'FST_ERR_CTP_INVALID_JSON_BODY') {
    return reply
      .code(400)
      .send({ code: ErrorCodes.INVALID_REQUEST, message: '请求体不是合法 JSON' });
  }
  req.log.error({ err }, 'unhandled error');
  const body = toErrorBody(err);
  return reply.code(httpStatusOf(body.code)).send(body);
});

// ---------- 启动 ----------
// 种子灌入（仅首次：库为空时灌 L2 模式 + L3 场景规则，让记忆库开箱即用。
// 用户主动淘汰的种子不会复活——ensureSeeds 只认空库）
try {
  const seeded = ensureSeeds(loadMemories());
  if (seeded.seeded > 0) {
    app.log.info({ seeded: seeded.seeded }, 'memories seeds loaded');
  }
} catch (err) {
  app.log.warn({ err }, 'memories seed failed (non-fatal)');
}

app
  .listen({ port: PORT, host: HOST })
  .then((addr) => {
    app.log.info(
      { addr, defaultApiBase: API_BASE },
      'proxy started（请求自带 apiBase 时以其为准）'
    );
  })
  .catch((err) => {
    app.log.error({ err }, 'failed to start');
    process.exit(1);
  });
