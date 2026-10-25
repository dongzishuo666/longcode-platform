/**
 * 请求体校验。
 * 校验归属：后端为安全边界；前端另有前置友好校验，二者不冲突。
 *
 * 与《设计总方案》3.2 校验顺序、3.7 接口契约严格对齐：
 *   /api/chat 请求体：{ apiKey, model, messages, systemPrompt?, temperature?, stream }
 *   /api/test 请求体：{ apiKey, model }
 */

import { AppError, ErrorCodes } from './errors.js';
import { MAX_ITEMS } from './memories.js';
import { assertApiBase } from './ssrf.js';
import { normalizeProvider, defaultModelFor, effectiveProvider, MULTI_MODEL_ENABLED } from './providers.js';

/**
 * 【历史遗留，已不再强制】DeepSeek 系模型名。
 *
 * 2026-10-24 放开多模型：模型名改由用户在所选供应商下自己填，后端不再维护
 * 这张表（各家的命名随时在变，硬编码只会持续过期，且会挡住所有非 DeepSeek 模型）。
 * 保留此常量仅供前端做 DeepSeek 供应商的下拉建议与错误提示兜底。
 *
 * 2026-10-18 的历史背景（保留备查）：
 *   deepseek-flash              稳定名，官方已把背后的模型静默换成 V4.1-Flash-1017。
 *   deepseek-v4.1-flash-1017    同期出现过的快照名，非官方承诺的稳定名。
 *   deepseek-chat / reasoner    旧名，官方自动重定向到 deepseek-flash。
 *   deepseek-v4-pro             已淘汰。
 */
export const MODEL_WHITELIST = Object.freeze([
  'deepseek-chat',
  'deepseek-reasoner',
  'deepseek-flash',
  'deepseek-v4.1-flash-1017',
]);

const ROLE_SET = new Set(['system', 'user', 'assistant']);
const IMAGE_DATA_URL = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;

/** 模型名长度上限 */
const MAX_MODEL_LEN = 128;

/** 后端兜底：请求体总大小上限 10MB */
export const MAX_BODY_BYTES = 10 * 1024 * 1024;
/** 单条消息内图片数量上限 */
const MAX_IMAGES_PER_MESSAGE = 5;
/** systemPrompt 长度上限（字符） */
const MAX_SYSTEM_PROMPT_LEN = 4000;

/** sk- 前缀 + 最小长度 */
function assertApiKey(apiKey) {
  if (
    typeof apiKey !== 'string' ||
    !apiKey.startsWith('sk-') ||
    apiKey.length < 20
  ) {
    throw new AppError(ErrorCodes.AUTH_FAILED, 'API Key 缺失或格式非法');
  }
}

/**
 * 模型名校验（2026-10-24：由「硬白名单」改为「自由命名」）。
 *
 * 原来是 MODEL_SET.has(model)，不在表里直接 400 —— 那是「只兼容 DeepSeek」
 * 的总闸门。放开多模型后，模型名由用户在所选供应商下自己填，后端不该
 * （也没法）认识所有供应商的所有模型名。
 *
 * 后端仍然要守的是「这不能是个能污染上游请求的脏字符串」：
 *   · 非空、限长 —— 防超长串塞爆上游
 *   · 不含换行 / 制表符 —— 防伪造出额外的请求字段
 * 名字在该供应商下到底存不存在，由上游判定并返回 400，落到 INVALID_REQUEST，
 * 前端统一提示「模型名在当前供应商下不可用，请核对」。
 *
 * @returns {string} 归一化后的模型名（去首尾空白）
 */
function assertModel(model) {
  if (typeof model !== 'string' || !model.trim()) {
    throw new AppError(ErrorCodes.INVALID_MODEL, 'model 不能为空');
  }
  if (model.length > MAX_MODEL_LEN) {
    throw new AppError(
      ErrorCodes.INVALID_MODEL,
      `model 长度不得超过 ${MAX_MODEL_LEN} 字符`
    );
  }
  if (/[\r\n\t]/.test(model)) {
    throw new AppError(
      ErrorCodes.INVALID_MODEL,
      'model 不能包含换行或制表符'
    );
  }
  const name = model.trim();
  // 界线：多模型关闭时（自用部署），模型名回落到 DeepSeek 白名单。
  // 否则用户手填 gpt-4o → 请求发给 DeepSeek → 上游返回"模型不存在"，
  // 报错信息完全指不到真因。这里直接给一句能看懂的话。
  if (!MULTI_MODEL_ENABLED && !MODEL_WHITELIST.includes(name)) {
    throw new AppError(
      ErrorCodes.INVALID_MODEL,
      `当前部署仅启用 DeepSeek（LC_MULTI_MODEL=0），模型名须为：${MODEL_WHITELIST.join(' / ')}`
    );
  }
  return name;
}

/**
 * 统一解析「连哪个供应商 / 哪个地址」。
 * provider 决定发哪些私有字段（见 providers.js），apiBase 决定往哪发（带 SSRF 防护）。
 */
async function resolveUpstream(body) {
  return {
    // 界线收口：多模型关闭时（LC_MULTI_MODEL=0），provider 一律按 deepseek 处理
    provider: effectiveProvider(body.provider),
    apiBase: await assertApiBase(body.apiBase),
  };
}

/** 标题生成：需求文本长度上限（够判断业务领域，又不至于把整段对话塞进去） */
export const MAX_TITLE_TEXT_LEN = 2000;

/**
 * 校验 /api/title 请求体（AI 生成会话标题）。
 * @returns {Promise<{ apiKey:string, model:string, text:string, provider:string, apiBase:string }>}
 */
export async function validateTitleBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AppError(ErrorCodes.INVALID_REQUEST, '请求体必须为 JSON 对象');
  }
  assertApiKey(body.apiKey);
  const { provider, apiBase } = await resolveUpstream(body);

  let model = defaultModelFor(provider);
  if (body.model !== undefined && body.model !== null && body.model !== '') {
    model = assertModel(body.model);
  }

  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) {
    throw new AppError(
      ErrorCodes.INVALID_REQUEST,
      'text 不能为空（用于生成标题的需求文本）'
    );
  }
  if (text.length > MAX_TITLE_TEXT_LEN) {
    throw new AppError(
      ErrorCodes.INVALID_REQUEST,
      `text 长度不得超过 ${MAX_TITLE_TEXT_LEN} 字符`
    );
  }
  return { apiKey: body.apiKey, model, text, provider, apiBase };
}

/**
 * 校验 /api/chat 请求体。
 * @returns {Promise<{ apiKey:string, model:string, messages:Array, systemPrompt:string, temperature:number, provider:string, apiBase:string }>}
 */
export async function validateChatBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AppError(ErrorCodes.INVALID_REQUEST, '请求体必须为 JSON 对象');
  }

  assertApiKey(body.apiKey);
  const { provider, apiBase } = await resolveUpstream(body);
  const model = assertModel(body.model);

  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new AppError(ErrorCodes.INVALID_REQUEST, 'messages 不能为空');
  }
  const normalized = messages.map((m, i) => validateMessage(m, i));

  if (body.stream !== true) {
    throw new AppError(ErrorCodes.INVALID_REQUEST, 'stream 必须为 true');
  }

  let temperature = 0.7;
  if (body.temperature !== undefined) {
    const t = body.temperature;
    if (typeof t !== 'number' || Number.isNaN(t) || t < 0 || t > 2) {
      throw new AppError(
        ErrorCodes.INVALID_REQUEST,
        'temperature 必须为 0–2 之间的数字'
      );
    }
    temperature = t;
  }

  // systemPrompt：可选，后端唯一注入点（总方案 3.3）
  let systemPrompt = '';
  if (body.systemPrompt !== undefined && body.systemPrompt !== null) {
    if (typeof body.systemPrompt !== 'string') {
      throw new AppError(
        ErrorCodes.INVALID_REQUEST,
        'systemPrompt 必须为字符串'
      );
    }
    if (body.systemPrompt.length > MAX_SYSTEM_PROMPT_LEN) {
      throw new AppError(
        ErrorCodes.INVALID_REQUEST,
        `systemPrompt 长度不得超过 ${MAX_SYSTEM_PROMPT_LEN} 字符`
      );
    }
    systemPrompt = body.systemPrompt;
  }

  return {
    apiKey: body.apiKey,
    model,
    messages: normalized,
    systemPrompt,
    temperature,
    provider,
    apiBase,
  };
}

/**
 * 校验 /api/test 请求体。
 * @returns {Promise<{ apiKey:string, model:string, provider:string, apiBase:string }>}
 */
export async function validateTestBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AppError(ErrorCodes.INVALID_REQUEST, '请求体必须为 JSON 对象');
  }
  assertApiKey(body.apiKey);
  const { provider, apiBase } = await resolveUpstream(body);
  const model = assertModel(body.model);
  return { apiKey: body.apiKey, model, provider, apiBase };
}

/** 审查请求：单段代码片段长度上限（字符） */
const MAX_REVIEW_CODE_LEN = 200_000;
const MIN_REVIEW_TIMEOUT_MS = 100;
const MAX_REVIEW_TIMEOUT_MS = 10_000;

/**
 * 校验 /api/review 请求体（生成流水线的增量代码审查）。
 * 设计要点：严格增量——只收「新片段 + 边界上下文 + 精简符号表」，不收全量代码。
 */
export async function validateReviewBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AppError(ErrorCodes.INVALID_REQUEST, '请求体必须为 JSON 对象');
  }

  assertApiKey(body.apiKey);
  const { provider, apiBase } = await resolveUpstream(body);

  // model 可选；默认走该供应商的快模型
  let model = defaultModelFor(provider);
  if (body.model !== undefined && body.model !== null && body.model !== '') {
    model = assertModel(body.model);
  }

  // 核心审查对象：本次新生成的代码片段
  const code = body.code;
  if (typeof code !== 'string' || !code.trim()) {
    throw new AppError(
      ErrorCodes.INVALID_REQUEST,
      'code 不能为空（本次新生成的代码片段）'
    );
  }
  if (code.length > MAX_REVIEW_CODE_LEN) {
    throw new AppError(
      ErrorCodes.INVALID_REQUEST,
      `code 长度不得超过 ${MAX_REVIEW_CODE_LEN} 字符`
    );
  }

  const language =
    typeof body.language === 'string' && body.language.trim()
      ? body.language.trim()
      : 'unknown';

  // 精简符号表：对象或字符串均可，统一序列化
  let symbolTable = '';
  if (typeof body.symbolTable === 'string') {
    symbolTable = body.symbolTable;
  } else if (body.symbolTable && typeof body.symbolTable === 'object') {
    try {
      symbolTable = JSON.stringify(body.symbolTable);
    } catch {
      throw new AppError(ErrorCodes.INVALID_REQUEST, 'symbolTable 无法序列化');
    }
  }

  const boundaryContext =
    typeof body.boundaryContext === 'string' ? body.boundaryContext : '';

  let temperature = 0.1;
  if (body.temperature !== undefined) {
    const t = body.temperature;
    if (typeof t !== 'number' || Number.isNaN(t) || t < 0 || t > 2) {
      throw new AppError(
        ErrorCodes.INVALID_REQUEST,
        'temperature 必须为 0–2 之间的数字'
      );
    }
    temperature = t;
  }

  let maxTokens = 400;
  if (body.maxTokens !== undefined) {
    const m = body.maxTokens;
    if (!Number.isInteger(m) || m < 1 || m > 4000) {
      throw new AppError(
        ErrorCodes.INVALID_REQUEST,
        'maxTokens 必须为 1–4000 的整数'
      );
    }
    maxTokens = m;
  }

  // 审查是流水线上的「插队」动作：超时只降级、不报错、不阻塞生成。
  // 阈值依据（2026-10 实测，关闭思考链后）：
  //   极短片段（无问题）≈ 0.46s
  //   真实片段（618 prompt / 116 completion）≈ 1.0s
  // 故默认取 1500ms 留余量：既能拦住异常卡顿，又不会把正常审查误判为超时。
  let timeoutMs = 1500;
  if (body.timeoutMs !== undefined) {
    const t = body.timeoutMs;
    if (
      !Number.isInteger(t) ||
      t < MIN_REVIEW_TIMEOUT_MS ||
      t > MAX_REVIEW_TIMEOUT_MS
    ) {
      throw new AppError(
        ErrorCodes.INVALID_REQUEST,
        `timeoutMs 必须为 ${MIN_REVIEW_TIMEOUT_MS}–${MAX_REVIEW_TIMEOUT_MS} 的整数`
      );
    }
    timeoutMs = t;
  }

  return {
    apiKey: body.apiKey,
    model,
    provider,
    apiBase,
    code,
    language,
    symbolTable,
    boundaryContext,
    temperature,
    maxTokens,
    timeoutMs,
    // 审查请求的 preCheck 铁律（默认只能是 false）：
    // preCheck:true 会先把代码压缩再送模型 —— 压缩会删注释、压连续空行，
    // 行数随之改变，模型返回的行号是【压缩后】的坐标；而前端 applyFixes
    // 拿这些行号去切【原始】代码，等于把修改落到别处；
    // 更糟的是复核只看语法（语法合法 ≠ 修改位置正确），改错位置会被静默采纳。
    // 默认值必须取安全的一侧：漏传时宁可多花 token，也不能静默改坏代码。
    // 显式传 true 仍保留压缩能力（调用方需自行承担坐标不一致的后果）。
    preCheck: body.preCheck === true,
  };
}

/**
 * 校验 /api/static-check 请求体（零 token 静态校验）。
 * 注意：本接口为纯本地计算，不消耗 token，因此不要求 apiKey。
 */
export function validateStaticCheckBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AppError(ErrorCodes.INVALID_REQUEST, '请求体必须为 JSON 对象');
  }

  const code = body.code;
  if (typeof code !== 'string' || !code.trim()) {
    throw new AppError(ErrorCodes.INVALID_REQUEST, 'code 不能为空');
  }
  if (code.length > MAX_REVIEW_CODE_LEN) {
    throw new AppError(
      ErrorCodes.INVALID_REQUEST,
      `code 长度不得超过 ${MAX_REVIEW_CODE_LEN} 字符`
    );
  }

  const language =
    typeof body.language === 'string' && body.language.trim()
      ? body.language.trim()
      : 'unknown';

  let compress = true;
  if (body.compress !== undefined && typeof body.compress !== 'boolean') {
    throw new AppError(ErrorCodes.INVALID_REQUEST, 'compress 必须为布尔值');
  }
  if (typeof body.compress === 'boolean') compress = body.compress;

  // 全局符号表：数组或对象（可选）
  let globalSymbols = body.globalSymbols;
  if (globalSymbols !== undefined) {
    const okShape =
      Array.isArray(globalSymbols) ||
      (globalSymbols && typeof globalSymbols === 'object');
    if (!okShape) {
      throw new AppError(
        ErrorCodes.INVALID_REQUEST,
        'globalSymbols 必须为数组或对象'
      );
    }
  }

  return { code, language, globalSymbols, compress };
}

function validateMessage(m, idx) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) {
    throw new AppError(ErrorCodes.INVALID_REQUEST, `messages[${idx}] 非法`);
  }
  if (!ROLE_SET.has(m.role)) {
    throw new AppError(
      ErrorCodes.INVALID_REQUEST,
      `messages[${idx}].role 非法（仅允许 system / user / assistant）`
    );
  }

  const c = m.content;

  // 纯文本
  if (typeof c === 'string') {
    return { role: m.role, content: c };
  }

  // 多模态数组
  if (Array.isArray(c)) {
    if (c.length === 0) {
      throw new AppError(
        ErrorCodes.INVALID_REQUEST,
        `messages[${idx}].content 不能为空数组`
      );
    }
    let imageCount = 0;
    const parts = c.map((p, j) => {
      if (!p || typeof p !== 'object' || Array.isArray(p)) {
        throw new AppError(
          ErrorCodes.INVALID_REQUEST,
          `messages[${idx}].content[${j}] 非法`
        );
      }

      if (p.type === 'text') {
        if (typeof p.text !== 'string') {
          throw new AppError(
            ErrorCodes.INVALID_REQUEST,
            `messages[${idx}].content[${j}].text 必须为字符串`
          );
        }
        return { type: 'text', text: p.text };
      }

      if (p.type === 'image_url') {
        const url = p.image_url && p.image_url.url;
        if (typeof url !== 'string' || !IMAGE_DATA_URL.test(url)) {
          throw new AppError(
            ErrorCodes.INVALID_REQUEST,
            `messages[${idx}].content[${j}] 图片必须为 png/jpeg/webp 的 base64 data URL`
          );
        }
        imageCount += 1;
        if (imageCount > MAX_IMAGES_PER_MESSAGE) {
          throw new AppError(
            ErrorCodes.INVALID_REQUEST,
            `单条消息图片数量不得超过 ${MAX_IMAGES_PER_MESSAGE} 张`
          );
        }
        return { type: 'image_url', image_url: { url } };
      }

      throw new AppError(
        ErrorCodes.INVALID_REQUEST,
        `messages[${idx}].content[${j}].type 非法（仅允许 text / image_url）`
      );
    });
    return { role: m.role, content: parts };
  }

  throw new AppError(
    ErrorCodes.INVALID_REQUEST,
    `messages[${idx}].content 必须为字符串或数组`
  );
}

// ==================== 契约驱动双端生成 ====================
// 两个接口都是纯本地计算（零 token），不需要 apiKey。

/** 单段代码长度上限（字符）：与审查接口保持一致 */
const MAX_CONTRACT_CODE_LEN = 200_000;
/** 契约接口条目上限 */
const MAX_CONTRACT_APIS = 500;

/**
 * POST /api/extract-api
 * body: { code, language?, side: 'frontend'|'backend' }
 */
export function validateExtractApiBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AppError(ErrorCodes.INVALID_REQUEST, '请求体必须为 JSON 对象');
  }

  const code = body.code;
  if (typeof code !== 'string' || !code.trim()) {
    throw new AppError(ErrorCodes.INVALID_REQUEST, 'code 不能为空');
  }
  if (code.length > MAX_CONTRACT_CODE_LEN) {
    throw new AppError(
      ErrorCodes.INVALID_REQUEST,
      `code 长度不得超过 ${MAX_CONTRACT_CODE_LEN} 字符`
    );
  }

  const side = String(body.side || '').trim().toLowerCase();
  if (side !== 'frontend' && side !== 'backend') {
    throw new AppError(ErrorCodes.INVALID_REQUEST, "side 必须为 'frontend' 或 'backend'");
  }

  const language =
    typeof body.language === 'string' && body.language.trim()
      ? body.language.trim()
      : 'unknown';

  return { code, language, side };
}

/**
 * POST /api/consistency
 * body: { contract: {apis:[...]}, frontend: [...], backend: [...] }
 */
export function validateConsistencyBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AppError(ErrorCodes.INVALID_REQUEST, '请求体必须为 JSON 对象');
  }

  const contract = body.contract;
  if (contract !== undefined && contract !== null) {
    if (typeof contract !== 'object' || Array.isArray(contract)) {
      throw new AppError(ErrorCodes.INVALID_REQUEST, 'contract 必须为对象');
    }
    if (contract.apis !== undefined && !Array.isArray(contract.apis)) {
      throw new AppError(ErrorCodes.INVALID_REQUEST, 'contract.apis 必须为数组');
    }
    if (Array.isArray(contract.apis) && contract.apis.length > MAX_CONTRACT_APIS) {
      throw new AppError(
        ErrorCodes.INVALID_REQUEST,
        `contract.apis 条目不得超过 ${MAX_CONTRACT_APIS} 个`
      );
    }
  }

  const side = (v, name) => {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) {
      throw new AppError(ErrorCodes.INVALID_REQUEST, `${name} 必须为数组`);
    }
    return v.slice(0, MAX_CONTRACT_APIS);
  };

  // DTO 提取结果（extractDtos 的产物）。白名单式返回的函数最容易在这里栽跟头：
  // 漏放行一个字段，前端传了也会被静默丢掉，然后表现为"校验没生效"且毫无线索。
  const dtos = (v, name) => {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) {
      throw new AppError(ErrorCodes.INVALID_REQUEST, `${name} 必须为数组`);
    }
    return v.slice(0, MAX_CONTRACT_APIS);
  };

  return {
    contract: contract || {},
    frontend: side(body.frontend, 'frontend'),
    backend: side(body.backend, 'backend'),
    frontendDtos: dtos(body.frontendDtos, 'frontendDtos'),
    backendDtos: dtos(body.backendDtos, 'backendDtos'),
  };
}

// ---------- 记忆库 ----------

/** 字符串数组归一：超长截断、去非字符串、限个数 */
function strArray(v, name, max, maxLen) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) {
    throw new AppError(ErrorCodes.INVALID_REQUEST, `${name} 必须为数组`);
  }
  return v
    .filter((x) => typeof x === 'string')
    .map((x) => x.slice(0, maxLen))
    .slice(0, max);
}

/**
 * 召回参数：技术栈 + 场景标签 + 关键词。
 * 三者都可空（空 = 不过滤，但 recallMemories 内部对"完全没关联"的会挡掉）。
 */
export function validateRecallBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AppError(ErrorCodes.INVALID_REQUEST, '请求体必须为 JSON 对象');
  }
  if (body.stack !== undefined && typeof body.stack !== 'string') {
    throw new AppError(ErrorCodes.INVALID_REQUEST, 'stack 必须为字符串');
  }
  return {
    stack: (body.stack || '').slice(0, 200),
    sceneTags: strArray(body.sceneTags, 'sceneTags', 20, 30),
    keywords: strArray(body.keywords, 'keywords', 50, 50),
  };
}

/**
 * 入库候选：rule 必填（可执行规则，不许空话），其余可选。
 * issueType 不进库，只用于自动打标签（normalizeCandidate 用）。
 */
export function validateIngestBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AppError(ErrorCodes.INVALID_REQUEST, '请求体必须为 JSON 对象');
  }
  if (typeof body.rule !== 'string' || !body.rule.trim()) {
    throw new AppError(ErrorCodes.INVALID_REQUEST, 'rule 必填（写成可执行规则，禁止空话）');
  }
  if (body.type !== undefined && !['L1', 'L2', 'L3', 'L4'].includes(body.type)) {
    throw new AppError(ErrorCodes.INVALID_REQUEST, 'type 必须为 L1/L2/L3/L4');
  }
  return {
    type: body.type,
    rule: body.rule.slice(0, 500),
    sceneTags: strArray(body.sceneTags, 'sceneTags', 8, 20),
    stack: strArray(body.stack, 'stack', 8, 30),
    trigger: typeof body.trigger === 'string' ? body.trigger.slice(0, 200) : '',
    badCase: typeof body.badCase === 'string' ? body.badCase.slice(0, 1000) : '',
    goodCase: typeof body.goodCase === 'string' ? body.goodCase.slice(0, 1000) : '',
    severity: ['block', 'important', 'suggest'].includes(body.severity) ? body.severity : undefined,
    source: typeof body.source === 'string' ? body.source.slice(0, 300) : '',
    issueType: typeof body.issueType === 'string' ? body.issueType.slice(0, 50) : '',
    status: ['active', 'pending', 'retired'].includes(body.status) ? body.status : undefined,
  };
}

/**
 * 反馈批量入参：entries 为 [{id, outcome}]，outcome 仅 followed/violated。
 * 上限 50 条（一次召回最多 L1≤5+L2≤3+L3≤4+L4≤2=14，留足余量）。
 */
export function validateFeedbackBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AppError(ErrorCodes.INVALID_REQUEST, '请求体必须为 JSON 对象');
  }
  if (!Array.isArray(body.entries)) {
    throw new AppError(ErrorCodes.INVALID_REQUEST, 'entries 必须为数组');
  }
  const entries = body.entries.slice(0, 50).map((e) => {
    if (!e || typeof e.id !== 'string' || !e.id) {
      throw new AppError(ErrorCodes.INVALID_REQUEST, 'entries[].id 必须为非空字符串');
    }
    if (e.outcome !== 'followed' && e.outcome !== 'violated') {
      throw new AppError(ErrorCodes.INVALID_REQUEST, 'entries[].outcome 必须为 followed/violated');
    }
    return { id: e.id.slice(0, 60), outcome: e.outcome };
  });
  return { entries };
}

/** 导入：整库 JSON，条目逐个过 normalizeCandidate（坏条目跳过不中断） */
export function validateImportBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AppError(ErrorCodes.INVALID_REQUEST, '请求体必须为 JSON 对象');
  }
  if (body.store !== undefined && (typeof body.store !== 'object' || body.store === null || Array.isArray(body.store))) {
    throw new AppError(ErrorCodes.INVALID_REQUEST, 'store 必须为对象');
  }
  if (body.store && body.store.items !== undefined && !Array.isArray(body.store.items)) {
    throw new AppError(ErrorCodes.INVALID_REQUEST, 'store.items 必须为数组');
  }
  if (body.store && Array.isArray(body.store.items) && body.store.items.length > MAX_ITEMS) {
    throw new AppError(ErrorCodes.INVALID_REQUEST, `导入条目不得超过 ${MAX_ITEMS} 条`);
  }
  return { store: body.store || { items: [] } };
}

export { MAX_ITEMS };
