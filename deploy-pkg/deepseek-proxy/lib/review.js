/**
 * 增量代码审查：Prompt 组装 + 输出归一化。
 *
 * 设计对齐《代码审查小模型方案》：
 *   - 系统 Prompt 固定（便于上游前缀缓存）
 *   - 用户 Prompt 只装 3 类信息：新片段 / 边界上下文 / 精简符号表（严格增量）
 *   - 模型输出必须归一化到固定 schema，否则前端拿不到 fix_code 就没法自动修
 */

export const SEVERITIES = Object.freeze(['high', 'medium', 'low']);

export const ISSUE_TYPES = Object.freeze([
  'logic_error',
  'interface_mismatch',
  'undefined_symbol',
  'context_break',
  'safety',
  'error_handling',
  'standard',
  'optimization',
]);

/** 单条审查结果允许的最大条数（防止模型失控） */
const MAX_ISSUES = 20;

/** 锚点原文的长度上限：超过就不当锚点（一段修复不该替换整块代码） */
const MAX_ANCHOR_CHARS = 4000;
/** 锚点最小有效长度（去掉空白后）：太短（如单个 `}`）无法唯一定位，宁可丢弃 */
const MIN_ANCHOR_CHARS = 6;

/** 系统 Prompt：固定不变，走前缀缓存 */
export const REVIEW_SYSTEM_PROMPT = `你是代码生成流水线的专属审查员，仅审查平台本次新生成的代码片段，严格基于给定的上下文和符号表校验，禁止脑补不存在的内容。

核心审查目标：
拦截生成代码的常见错误，保证局部逻辑正确、与已有上下文衔接一致、接口调用符合约定。

审查边界：
1. 只审查「本次新生成代码」范围内的内容，不评价全局架构设计
2. 校验依据：给定的「边界上下文」（衔接正确性）、「精简符号表」（接口存在性与参数匹配）
3. 不要求业务合理性判断，只查代码逻辑与语法层面的问题

输出铁则（违反则输出无效）：
1. 仅输出纯JSON，无任何解释、注释、markdown标记、多余话术
2. 顶层结构固定为 {"issues": []}，无问题直接输出 {"issues": []}
3. 每个问题必须包含：line_start、line_end、severity、issue_type、description、fix_code、original
4. line_start / line_end 为本次新生成代码片段内的相对行号，从1开始计数
5. fix_code只输出修改后的对应代码行/片段，禁止输出完整上下文、禁止重复无问题代码
6. 无法完全确定的问题，必须增加字段 "uncertain": true
7. original【必填】：被 fix_code 替换掉的那几行**原始代码**，必须从给定代码里**逐字复制**，
   不要带行号、不要带代码围栏、不要改写空格与缩进、不要包含未改动的行。
   它的用途是让平台按「内容」定位替换位置，而不是只信行号 ——
   行号写错时平台靠 original 仍能改对地方，写不出 original 时这条修复会被跳过。
   若被替换区域跨多行，按原样多行输出；若只有一行，就输出那一行。

严重程度：
- high：逻辑错误、空指针/越界、接口不匹配、变量未定义、上下文衔接断裂
- medium：错误处理缺失、代码规范不符、可读性问题
- low：性能优化建议、写法优化建议

问题类型：
logic_error、interface_mismatch、undefined_symbol、context_break、safety、error_handling、standard、optimization`;

/**
 * 组装用户 Prompt（严格增量，无全量代码）
 * @param {{language:string, symbolTable:string, boundaryContext:string, code:string}} p
 */
export function buildReviewUserPrompt({ language, symbolTable, boundaryContext, code }) {
  return `=== 编程语言 ===
${language}

=== 当前文件精简符号表（仅签名） ===
${symbolTable || '(未提供)'}

=== 上一段已生成代码（边界上下文） ===
\`\`\`
${boundaryContext || '(首段，无上文)'}
\`\`\`

=== 本次平台新生成代码片段（审查对象） ===
\`\`\`
${code}
\`\`\`

=== 审查重点 ===
1. 变量/函数/类是否存在未定义、重定义问题
2. 调用符号表中的函数/方法时，参数数量、类型是否匹配
3. 代码自身是否存在逻辑错误、条件判断漏洞、数组越界、空指针风险
4. 与上一段边界上下文的逻辑衔接是否正确，是否存在变量断层、作用域错误
5. 异步操作是否缺少错误处理，边界输入是否缺少合法性校验
6. 安全基线（命中即报告；只有能给出确定 fix_code 的才标 high，拿不准的标 medium 并设 uncertain）：
   - SQL / shell 命令用字符串拼接，未参数化
   - 使用 eval / new Function
   - 未消毒的 innerHTML / dangerouslySetInnerHTML 渲染用户输入
   - CORS 配置为 origin:"*" 或 Access-Control-Allow-Origin: *
   - 密钥 / 令牌 / 密码硬编码在代码里
   - 错误处理把堆栈、SQL、内部路径返回给客户端
   - 外链缺少 rel="noopener noreferrer"
   - 用 URL 参数跳转时未校验协议（javascript: 等伪协议）
   - 文件路径拼接未校验，存在目录穿越（../）风险
   - 请求体大小 / 超时未做限制
   说明：安全项按「确定性」分级——明确违反上述某条才报；技术栈未提供对应能力
   （如原生 JS 项目没有 CORS 概念）时不报，避免噪声。

严格按照要求输出JSON。`;
}

/** 剥离可能的 markdown 代码围栏 */
function stripFences(text) {
  if (!text) return '';
  let s = String(text).trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  return s.trim();
}

/** 取首个 JSON 对象（模型偶尔在 JSON 前后加话术） */
function extractJsonObject(text) {
  const s = stripFences(text);
  try {
    return JSON.parse(s);
  } catch {
    /* 继续尝试截取 */
  }
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(s.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  return null;
}

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * 归一化单条 issue。
 * 模型常输出 type/severity/message/line 等别名，这里统一到方案约定 schema。
 */
function normalizeIssue(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const lineStart = Math.max(
    1,
    Math.trunc(num(raw.line_start ?? raw.lineStart ?? raw.line ?? raw.start_line, 1))
  );
  const lineEnd = Math.max(
    lineStart,
    Math.trunc(num(raw.line_end ?? raw.lineEnd ?? raw.end_line ?? raw.line, lineStart))
  );

  // severity：未知一律降为 medium 并标记不确定（high 会暂停生成，必须保守）
  let severity = String(raw.severity ?? '').toLowerCase().trim();
  let uncertain = raw.uncertain === true;
  if (!SEVERITIES.includes(severity)) {
    severity = 'medium';
    uncertain = true;
  }

  const issueType = String(
    raw.issue_type ?? raw.issueType ?? raw.type ?? ''
  ).toLowerCase().trim();

  const description = String(
    raw.description ?? raw.desc ?? raw.message ?? ''
  ).trim();

  const fixCode = String(raw.fix_code ?? raw.fixCode ?? raw.fix ?? '').trim();

  // 既无描述又无修复代码 → 无效条目，丢弃
  if (!description && !fixCode) return null;

  // 锚点原文（2026-10-25）：被 fix_code 替换掉的原始行，逐字复制。
  // 前端靠它在±N 行窗口内按【内容】定位，行号写错也能改对地方。
  // 太长/太短都不适合当锚点 —— 直接丢弃，让前端退化为行号模式并标注。
  let original = String(
    raw.original ?? raw.original_code ?? raw.before ?? raw.source_text ?? ''
  );
  // 剥围栏：注意只吃行内的空格/制表符，绝不能用 \s*
  // —— \s* 会贪婪吞掉换行后的缩进，让锚点与原文错位（实测踩过）。
  original = original
    .replace(/^(`{3,}|~{3,})[ \t]*[\w+#.-]*[ \t]*\r?\n?/, '')
    .replace(/\r?\n?[ \t]*(`{3,}|~{3,})[ \t]*$/, '');
  // 只去掉首尾的空行 —— 不能用 trim()：那会把首行缩进也削掉，
  // 而锚点与原文的缩进不一致时，人眼对照起来会误判"这段没找到"。
  // （前端匹配时按行归一化空白，缩进差异本身能容忍，但保留原文更利于排查。）
  original = original
    .replace(/^(?:[ \t]*\r?\n)+/, '')
    .replace(/(?:\r?\n[ \t]*)+$/, '')
    .replace(/\r\n/g, '\n');
  const originalLines = original ? original.split('\n') : [];
  const anchorUsable =
    original &&
    original.length <= MAX_ANCHOR_CHARS &&
    originalLines.filter((l) => l.trim()).length >= 1 &&
    original.replace(/\s/g, '').length >= MIN_ANCHOR_CHARS;

  const issue = {
    line_start: lineStart,
    line_end: lineEnd,
    severity,
    issue_type: issueType || 'standard',
    description,
    fix_code: fixCode,
  };
  if (anchorUsable) issue.original = original;
  if (uncertain) issue.uncertain = true;
  return issue;
}

/**
 * 解析模型输出 → 归一化 issues
 * @returns {{issues:Array, degraded:boolean, raw:string, parseError:string|null}}
 */
export function normalizeIssues(rawContent) {
  const raw = rawContent == null ? '' : String(rawContent);

  // 空输出：视为无问题（模型认为没问题时常直接给 {"issues":[]}）
  if (!raw.trim()) {
    return { issues: [], degraded: true, raw, parseError: 'empty_output' };
  }

  const parsed = extractJsonObject(raw);
  if (!parsed) {
    return { issues: [], degraded: true, raw, parseError: 'json_parse_failed' };
  }

  const list = Array.isArray(parsed) ? parsed : parsed.issues;
  if (!Array.isArray(list)) {
    // 没有 issues 字段 → 视为无问题，但标记降级便于观测
    return { issues: [], degraded: true, raw, parseError: 'no_issues_field' };
  }

  const issues = [];
  for (const item of list) {
    const n = normalizeIssue(item);
    if (n) issues.push(n);
    if (issues.length >= MAX_ISSUES) break;
  }

  return { issues, degraded: false, raw, parseError: null };
}

/** 是否含有需要暂停生成的 high 级问题（含未确定的 high） */
export function hasBlockingIssue(issues) {
  return Array.isArray(issues) && issues.some((i) => i.severity === 'high');
}
