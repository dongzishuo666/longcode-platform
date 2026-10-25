/**
 * SSE 事件格式化 + DeepSeek 原生 delta → 标准化事件转换。
 *
 * 标准事件结构（后端 → 前端）：
 *   { type: "reasoning" | "content" | "done" | "error", data: ... }
 *
 * 与《裁决 3：SSE 输出格式》严格对齐。
 */

/** 将对象包装为一条 SSE data 行 */
export function sseLine(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

/** SSE 注释心跳行（前端解析时忽略） */
export function sseKeepalive() {
  return ': keepalive\n\n';
}

/**
 * DeepSeek 原生 delta / finish_reason → 标准事件数组。
 * 同一 chunk 可能同时含 reasoning_content 与 content（少见但允许）。
 *
 * @param {object|undefined} delta
 * @param {string|null|undefined} finishReason
 * @returns {Array<{type:string,data:any}>}
 */
export function toStandardEvents(delta, finishReason) {
  const events = [];
  if (delta && typeof delta === 'object') {
    if (
      typeof delta.reasoning_content === 'string' &&
      delta.reasoning_content.length > 0
    ) {
      events.push({ type: 'reasoning', data: delta.reasoning_content });
    }
    if (typeof delta.content === 'string' && delta.content.length > 0) {
      events.push({ type: 'content', data: delta.content });
    }
  }
  if (typeof finishReason === 'string' && finishReason) {
    events.push({ type: 'done', data: { finish_reason: finishReason } });
  }
  return events;
}

/** 构造 SSE error 事件 */
export function toErrorEvent(code, message) {
  return { type: 'error', data: { code, message } };
}

/**
 * 构造 SSE usage 事件。
 * 上游开启 stream_options.include_usage 后，流末尾会多出一个「只有 usage、choices 为空」的
 * chunk —— 这是唯一的真实 token 计量（前端估算的 0.7×字符数只能算个大概）。
 * 续写每轮重发全部历史，成本是 O(n²)，必须先把这条曲线量出来再谈优化。
 */
export function toUsageEvent(usage) {
  return {
    type: 'usage',
    data: {
      prompt_tokens: Number(usage?.prompt_tokens) || 0,
      completion_tokens: Number(usage?.completion_tokens) || 0,
      total_tokens: Number(usage?.total_tokens) || 0,
      // 上下文缓存命中量：续写每轮重发全部历史，而 messages 的前缀每轮只增不减
      // → 缓存命中率天然很高，DeepSeek 命中部分按 1/10 计价。
      // 也就是说「续写 O(n²)」的名义成本被缓存大幅缓解，但以前这里只透传
      // 三个字段，命中量被丢掉，界面上完全看不见到底省了多少。
      //
      // 多模型放开后（2026-10-24）：各家字段名不一样 ——
      //   DeepSeek / 部分兼容端点：usage.prompt_cache_hit_tokens
      //   OpenAI：                usage.prompt_tokens_details.cached_tokens
      // 这里两个都读，谁有值用谁；都没有就是 0（不显示缓存命中，不影响正确性）。
      prompt_cache_hit_tokens:
        Number(usage?.prompt_cache_hit_tokens) ||
        Number(usage?.prompt_tokens_details?.cached_tokens) ||
        0,
      prompt_cache_miss_tokens: Number(usage?.prompt_cache_miss_tokens) || 0,
    },
  };
}
