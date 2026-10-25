/**
 * DeepSeek 官方 Chat Completions API 调用封装。
 * 职责：
 *   - 连接阶段重试（最多 2 次，退避 1s→2s）
 *   - 连接超时（默认 30s，探活 10s）
 *   - 流式空闲超时（60s）
 *   - 上游错误分类 → 7 码之一
 *   - 原生 SSE 解析 → 标准事件
 *
 * 严格对齐《裁决 2：重试归属》《裁决 3：SSE 输出格式》
 * 《最终错误码表（确认版）》《重试策略映射（最终）》。
 */

import { AppError, ErrorCodes, isRetryable } from './errors.js';
import { toStandardEvents, toUsageEvent } from './sse.js';
import { getProviderCaps } from './providers.js';

const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const IDLE_TIMEOUT_MS = 60_000;
const MAX_RETRIES = 2; // 最多 2 次重试 → 最坏 3 次官方调用
const BACKOFFS = [1000, 2000];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 上游 HTTP 状态 → 内部错误码 */
function classifyHttpStatus(status) {
  if (status === 401 || status === 403) return ErrorCodes.AUTH_FAILED;
  if (status === 429) return ErrorCodes.RATE_LIMIT;
  if (status === 400) return ErrorCodes.INVALID_REQUEST;
  if (status >= 500) return ErrorCodes.UPSTREAM_ERROR;
  return ErrorCodes.UNKNOWN;
}

/**
 * 单次连接上游，不重试。
 * @returns {Promise<Response>} 200 响应；否则抛 AppError
 */
async function fetchOnce({
  apiBase,
  apiKey,
  model,
  messages,
  temperature,
  maxTokens,
  stream,
  connectTimeoutMs,
  externalSignal,
  provider,
}) {
  // 供应商能力：决定哪些「非标准字段」能发（详见 providers.js）
  const caps = getProviderCaps(provider);
  const url = `${apiBase}/chat/completions`;
  const body = { model, messages, stream: !!stream };
  if (typeof temperature === 'number') body.temperature = temperature;
  if (typeof maxTokens === 'number') body.max_tokens = maxTokens;
  // 流式也要 usage：否则拿不到真实 token 消耗，续写每轮重发历史的 O(n²) 成本只能靠猜。
  // 但 stream_options 是 OpenAI 系扩展，不是所有兼容端点都认（认不出的会 400），
  // 故按供应商能力决定发不发；不发就退回前端按字符数估算（0.7×），不致命。
  if (stream && caps.supportsStreamUsage) {
    body.stream_options = { include_usage: true };
  }

  const connectController = new AbortController();
  const connectTimer = setTimeout(() => {
    connectController.abort(new Error('connect timeout'));
  }, connectTimeoutMs);

  const signals = [connectController.signal];
  if (externalSignal) signals.push(externalSignal);
  const combined =
    signals.length > 1 ? AbortSignal.any(signals) : signals[0];

  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        Accept: stream ? 'text/event-stream' : 'application/json',
      },
      body: JSON.stringify(body),
      signal: combined,
    });
  } catch (err) {
    if (externalSignal?.aborted) {
      const e = new Error('client aborted');
      e.name = 'ClientAborted';
      throw e;
    }
    if (connectController.signal.aborted) {
      throw new AppError(ErrorCodes.TIMEOUT, `连接上游模型服务超时（${apiBase}）`, err);
    }
    throw new AppError(ErrorCodes.UPSTREAM_ERROR, `连接上游模型服务失败（${apiBase}）`, err);
  } finally {
    clearTimeout(connectTimer);
  }

  if (resp.status === 200) return resp;

  // 非 200：读一部分响应体用于日志，不外泄给前端
  let detail = '';
  try {
    detail = (await resp.text()).slice(0, 500);
  } catch {
    /* ignore */
  }
  const code = classifyHttpStatus(resp.status);
  throw new AppError(code, `上游返回 ${resp.status}`, detail);
}

/**
 * 带重试的上游调用。仅 UPSTREAM_ERROR / TIMEOUT 重试。
 * 注意：仅用于「流式开始前」的连接阶段；一旦已向前端发出 chunk，禁止重试。
 * @returns {Promise<Response>} 200 响应
 */
export async function callWithRetry(opts) {
  const { connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS } = opts;

  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fetchOnce({ ...opts, connectTimeoutMs });
    } catch (err) {
      if (err && err.name === 'ClientAborted') throw err;

      const appErr =
        err instanceof AppError
          ? err
          : new AppError(ErrorCodes.UPSTREAM_ERROR, '上游请求失败', err);

      if (!isRetryable(appErr.code) || attempt === MAX_RETRIES) {
        throw appErr;
      }
      lastErr = appErr;
    }
    await sleep(BACKOFFS[attempt] ?? BACKOFFS[BACKOFFS.length - 1]);
  }
  throw lastErr ?? new AppError(ErrorCodes.UNKNOWN, '未知错误');
}

/**
 * 审查专用调用：非流式 + 强制 JSON + 关闭思考链 + 独立超时。
 *
 * ⚠️ 关键（2026-10 实测，DeepSeek 专属）：必须传 thinking:{type:'disabled'}。
 *    否则 deepseek-flash 会把 max_tokens 预算**全部**消耗在 reasoning_content 上：
 *      - 默认（思考开）max=400：reasoning 占满 400 token，content 为【空】→ 拿不到 JSON，耗时 2.2s
 *      - 关闭思考后：                                    content 正常输出，耗时 0.46s，completion 仅 5 token
 *    即：不关思考链，审查接口既超时又烧钱。
 *
 *    但 thinking 是 DeepSeek 私有扩展 —— 别的供应商收到不认识的字段可能直接 400。
 *    所以这里按供应商能力决定发不发（见 providers.js 的 supportsThinking）：
 *    只有 deepseek 发，其余一律只发标准字段。
 *
 * @returns {Promise<{content:string, usage:object|null}>}
 */
export async function callReview({
  apiBase,
  apiKey,
  model,
  provider,
  systemPrompt,
  userPrompt,
  temperature = 0.1,
  maxTokens = 400,
  timeoutMs = 800,
}) {
  const caps = getProviderCaps(provider);
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error('review timeout'));
  }, timeoutMs);

  const payload = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    stream: false,
    temperature,
    max_tokens: maxTokens,
  };
  // 强制 JSON：多数 OpenAI 兼容端点支持；少数本地推理服务不支持，做成开关。
  if (caps.supportsJson) payload.response_format = { type: 'json_object' };
  // 关闭思考链：DeepSeek 私有字段，只对该供应商发（别的供应商发了可能 400）。
  if (caps.supportsThinking) payload.thinking = { type: 'disabled' };

  try {
    const resp = await fetch(`${apiBase}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!resp.ok) {
      let detail = '';
      try {
        detail = (await resp.text()).slice(0, 300);
      } catch {
        /* ignore */
      }
      throw new AppError(classifyHttpStatus(resp.status), `上游返回 ${resp.status}`, detail);
    }

    const json = await resp.json();
    return {
      content: json?.choices?.[0]?.message?.content ?? '',
      usage: json?.usage ?? null,
    };
  } catch (err) {
    // 上游已分类的错误（401/429/5xx…）保持原错误码
    if (err instanceof AppError) throw err;
    // 自身超时触发的 abort
    if (controller.signal.aborted) {
      throw new AppError(ErrorCodes.TIMEOUT, `审查超时（${timeoutMs}ms）`, err);
    }
    throw new AppError(ErrorCodes.UPSTREAM_ERROR, '审查请求失败', err);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 转发流式响应。调用方需在调用前完成 SSE 头写入。
 *
 * @param {Response} resp                已确认 200 的流式响应
 * @param {(event:object)=>void} onEvent  标准事件回调
 * @param {AbortSignal} [externalSignal]  客户端断开信号
 */
export async function pipeStream(resp, onEvent, externalSignal) {
  if (!resp.body) {
    throw new AppError(ErrorCodes.UPSTREAM_ERROR, '上游无响应体');
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let idleTimer = null;
  let idleFired = false;
  let doneEventSent = false;

  const clearIdle = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };

  const armIdle = () => {
    clearIdle();
    idleTimer = setTimeout(async () => {
      idleFired = true;
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
    }, IDLE_TIMEOUT_MS);
  };

  const onAbort = () => {
    reader.cancel().catch(() => {});
  };

  if (externalSignal) {
    if (externalSignal.aborted) {
      reader.cancel().catch(() => {});
    } else {
      externalSignal.addEventListener('abort', onAbort, { once: true });
    }
  }

  try {
    while (true) {
      armIdle();

      let chunk;
      try {
        chunk = await reader.read();
      } catch (err) {
        if (externalSignal?.aborted) {
          const e = new Error('client aborted');
          e.name = 'ClientAborted';
          throw e;
        }
        throw new AppError(ErrorCodes.UPSTREAM_ERROR, '读取上游流失败', err);
      }

      clearIdle();

      if (idleFired) {
        throw new AppError(ErrorCodes.TIMEOUT, '流式空闲超时');
      }
      if (chunk.done) break;

      buffer += decoder.decode(chunk.value, { stream: true });

      // 按行解析 SSE
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const rawLine = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        const line = rawLine.replace(/\r$/, '');

        if (!line || line.startsWith(':')) continue; // 空行 / 注释
        if (!line.startsWith('data:')) continue;

        const payload = line.slice(5).trimStart();

        // 官方 [DONE] 结束标记
        if (payload === '[DONE]') {
          if (!doneEventSent) {
            onEvent({ type: 'done', data: { finish_reason: 'stop' } });
            doneEventSent = true;
          }
          return;
        }

        let json;
        try {
          json = JSON.parse(payload);
        } catch {
          continue; // 忽略不可解析行
        }

        // 上游在流中传错误
        if (json.error) {
          const message =
            (json.error && (json.error.message || json.error.type)) ||
            '上游流式错误';
          onEvent({
            type: 'error',
            data: {
              code: ErrorCodes.UPSTREAM_ERROR,
              message: String(message),
            },
          });
          return;
        }

        // usage chunk：choices 是空数组，只有 usage。必须先于下面的 choices 判断处理，
        // 否则这个「唯一真实计量」的 chunk 会被静默丢掉。
        if (json.usage && typeof json.usage === 'object') {
          onEvent(toUsageEvent(json.usage));
        }

        const choice = Array.isArray(json.choices) ? json.choices[0] : null;
        if (!choice) continue;

        const events = toStandardEvents(choice.delta, choice.finish_reason);
        for (const ev of events) {
          if (ev.type === 'done') doneEventSent = true;
          onEvent(ev);
        }
      }
    }

    // 流自然结束但未收到 finish_reason，补 done
    if (!doneEventSent) {
      onEvent({ type: 'done', data: { finish_reason: 'stop' } });
    }
  } finally {
    clearIdle();
    if (externalSignal) externalSignal.removeEventListener('abort', onAbort);
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
  }
}
