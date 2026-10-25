/**
 * 会话标题生成（2026-10-23）。
 *
 * 背景：标题原先取用户首条消息前 20 字，侧栏里全是半句话
 * （"做一个电商下单，要防止超卖…"），看起来乱；而且中英文切换无法跟随。
 * 改为让模型给出"项目名"的中英两版（zh 2-8 汉字 / en 2-4 词），
 * 前端按当前语言选一条显示，切语言时标题跟着切。
 *
 * 本文件只放【纯函数】与提示词，便于 Node 单测（server.js 不好直接 import）。
 */

export const TITLE_SYSTEM_PROMPT = `你是项目命名助手。根据用户的需求描述，给出一个简短的“项目名称”（不是句子，不是功能清单）。
只输出 JSON，格式：{"zh":"中文名","en":"English Name"}
要求：
- zh：2-8 个汉字，像产品名（如「周报汇总工具」「库存管理系统」），不含标点、引号、emoji
- en：2-4 个英文单词，Title Case（如 "Weekly Report Hub"）
- 体现业务领域，不要堆技术栈（不出现 React / Node / MySQL 之类）
- 不要空泛的「项目」「系统」二字单独作名，尽量具体到业务`;

/** 标题调用超时：标题是锦上添花，超时就放弃（前端保留兜底标题） */
export const TITLE_TIMEOUT_MS = 5000;

/** 标题最大长度：zh 16 字符 / en 40 字符（够长，又能防止模型啰嗦） */
export const TITLE_MAX = { zh: 16, en: 40 };

function cleanName(s, max) {
  // 顺序很关键：先删 emoji，再【循环】剥引号与句末标点。
  // 单次剥离会漏：`"E-commerce Checkout" 🛒` 先去掉尾部 emoji，
  // 引号才露出来成为新的尾字符（早期版本就这么漏了一个引号）。
  let out = String(s == null ? '' : s)
    .replace(/[\u{1F300}-\u{1FAFF}\u{2700}-\u{27BF}]/gu, '') // emoji
    .replace(/\s+/g, ' ')
    .trim();
  for (let i = 0; i < 3; i++) {
    const before = out;
    out = out
      .replace(/^["'「『\s]+|["'」』\s]+$/g, '')   // 首尾引号/空白
      .replace(/[。．.!！?？,，;；:：]+$/g, '')     // 句末标点
      .trim();
    if (out === before) break;                    // 收敛就停
  }
  return out.slice(0, max);
}

/**
 * 从模型输出里抠出标题并清洗。
 * 容错：```json 围栏、JSON 前后有解释文字、字段缺失、字段名大小写。
 *
 * @param {string} raw 模型原始输出
 * @returns {{zh:string, en:string}} 解析失败时两项均为空串（前端保留兜底标题）
 */
export function normalizeTitle(raw) {
  const empty = { zh: '', en: '' };
  let text = String(raw == null ? '' : raw).trim();
  if (!text) return empty;

  text = text.replace(/^```[a-zA-Z]*\s*/, '').replace(/```$/, '').trim();

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return empty;

  let obj = null;
  try {
    obj = JSON.parse(text.slice(start, end + 1));
  } catch {
    return empty;
  }
  if (!obj || typeof obj !== 'object') return empty;

  const rawZh = obj.zh ?? obj.ZH ?? obj.cn ?? obj.title_zh;
  const rawEn = obj.en ?? obj.EN ?? obj.english ?? obj.title_en;
  const zh = cleanName(rawZh, TITLE_MAX.zh);
  const en = cleanName(rawEn, TITLE_MAX.en);

  // 中英都空视为失败（避免返回 {"zh":"","en":""} 让前端以为成功）
  if (!zh && !en) return empty;
  return { zh, en };
}
