/**
 * 供应商能力表（多模型接入，2026-10-24）。
 *
 * 背景：放开「用户自选模型」后，请求里会带上 provider + 任意 model 名。
 * 各家对 OpenAI Chat Completions 的「方言」支持程度不同，这里集中声明
 * 能力开关，由 deepseek.js 决定是否发送某些私有 / 非标准字段：
 *
 *   supportsThinking     是否支持 DeepSeek 私有的 thinking:{type:'disabled'}。
 *                        审查接口必须关思考链：不关的话 deepseek-flash 会把
 *                        max_tokens 预算全部烧在 reasoning_content 上，
 *                        content 为空（实测：默认 400 全给 reasoning，2.2s 空转；
 *                        关掉后 0.46s 出 JSON）。但这是 DeepSeek 私有扩展，
 *                        发给别的供应商反而可能 400 —— 所以按供应商决定发不发。
 *   supportsStreamUsage  是否支持 stream_options:{include_usage:true}。
 *                        这是「流式也能拿到真实 token 计量」的关键，续写 O(n²)
 *                        的成本曲线全靠它量出来；不支持的供应商就别发，避免 400。
 *   supportsJson         是否支持 response_format:{type:'json_object'}。
 *                        审查接口靠它强制 JSON 输出。多数兼容端点都支持，
 *                        少数本地推理服务（部分 Ollama 模型）不支持，故做成开关。
 *
 * 不在此表中的 provider 一律按 custom 处理 —— 最保守：只发标准字段。
 */

export const PROVIDER_CAPS = Object.freeze({
  deepseek: {
    label: 'DeepSeek',
    supportsThinking: true, // 唯一需要（且能）关闭思考链的供应商
    supportsStreamUsage: true,
    supportsJson: true,
  },
  openai: {
    label: 'OpenAI',
    supportsThinking: false,
    supportsStreamUsage: true,
    supportsJson: true,
  },
  openrouter: {
    label: 'OpenRouter',
    supportsThinking: false,
    supportsStreamUsage: true,
    supportsJson: true,
  },
  qwen: {
    label: '通义千问',
    supportsThinking: false,
    supportsStreamUsage: true,
    supportsJson: true,
  },
  moonshot: {
    label: '月之暗面 Kimi',
    supportsThinking: false,
    supportsStreamUsage: true,
    supportsJson: true,
  },
  ollama: {
    label: 'Ollama（本地）',
    supportsThinking: false,
    supportsStreamUsage: true,
    supportsJson: true,
  },
  custom: {
    label: '自定义',
    supportsThinking: false,
    supportsStreamUsage: true,
    supportsJson: true,
  },
});

/** 已识别的 provider 键（前端预设下拉用同一套命名） */
const PROVIDER_KEYS = new Set(Object.keys(PROVIDER_CAPS));

/**
 * 多模型能力总开关（2026-10-24 · 界线明确化）。
 *
 * 这个平台要开源 → 开源用户希望能接的不止 DeepSeek，所以【仓库默认开多模型】。
 * 但自用/私有部署只想跑 DeepSeek → 设 `LC_MULTI_MODEL=0` 即完全关闭多模型：
 *   · provider 一律按 deepseek 处理（发 DeepSeek 私有字段 thinking 等）
 *   · 模型名回落到 DeepSeek 白名单校验（手填别家模型名会得到清晰报错，
 *     而不是"把 gpt-4o 发给 DeepSeek"这种看不懂的失败）
 *   · /api/health 暴露 multiModel=false → 前端自动隐藏「供应商」下拉，
 *     界面上就只剩一个 DeepSeek 模型框
 *
 * 目的：**一份代码、两种运行形态**，用显式配置区分，
 * 而不是"线上跑的文件和仓库不一样"那种隐性状态（那会导致前后端错版、
 * 改了一处另一边没改、问题无法复现）。
 */
export const MULTI_MODEL_ENABLED = process.env.LC_MULTI_MODEL !== '0';

/** 关闭多模型时，对外只暴露 deepseek 一个供应商 */
export function enabledProviderKeys() {
  return MULTI_MODEL_ENABLED ? [...PROVIDER_KEYS] : ['deepseek'];
}

/**
 * 界线收口：多模型关闭时，任何 provider 都按 deepseek 处理。
 * 缺省仍是 deepseek（老客户端兼容，见 normalizeProvider 的说明）。
 */
export function effectiveProvider(provider) {
  if (!MULTI_MODEL_ENABLED) return 'deepseek';
  return normalizeProvider(provider);
}

/**
 * 取供应商能力；未知 / 缺省一律走 custom（只发标准字段，最不容易 400）。
 */
export function getProviderCaps(provider) {
  const key = String(provider == null ? '' : provider).trim().toLowerCase();
  return PROVIDER_CAPS[key] || PROVIDER_CAPS.custom;
}

/**
 * provider 归一化。
 *
 * ⚠️ 缺省值刻意取 'deepseek' 而不是 'custom'：
 * 老客户端（不含 provider 字段）本来就只连 DeepSeek，且审查接口依赖
 * thinking:{type:'disabled'} 才不会空转。缺省回 deepseek 才能保持旧行为不变。
 * 而【显式传了】未知值（如 'gpt' / 'my-proxy'）则回 custom —— 那是新客户端
 * 在接第三方，最保守的标准字段组合才不会踩到私有扩展。
 */
export function normalizeProvider(provider) {
  if (provider === undefined || provider === null || provider === '') {
    return 'deepseek';
  }
  const key = String(provider).trim().toLowerCase();
  return PROVIDER_KEYS.has(key) ? key : 'custom';
}

/** provider 是否为我们已知的预设（用于日志与错误提示） */
export function isKnownProvider(provider) {
  return PROVIDER_KEYS.has(String(provider == null ? '' : provider).trim().toLowerCase());
}

/**
 * 各供应商的兜底模型名（仅当请求里没带 model 时才用）。
 * 正常路径前端总会带上用户选的模型，这里主要服务直接调 API 的调用方
 * 与「老客户端不传 provider/model」的兼容场景。
 */
export const DEFAULT_MODEL_BY_PROVIDER = Object.freeze({
  deepseek: 'deepseek-flash',
  openai: 'gpt-4o-mini',
  openrouter: 'openai/gpt-4o-mini',
  qwen: 'qwen-plus',
  moonshot: 'moonshot-v1-8k',
  ollama: 'llama3',
  custom: 'deepseek-flash',
});

/** 取该供应商的兜底模型名 */
export function defaultModelFor(provider) {
  return DEFAULT_MODEL_BY_PROVIDER[normalizeProvider(provider)] || 'deepseek-flash';
}
