/**
 * 零 token 静态校验层（方案第 2 步：生成后前置过滤）。
 *
 * 职责（全部本地完成，不消耗任何 token）：
 *   1. Tree-sitter 语法校验：语法错误直接打回重生成，不进入模型
 *   2. 符号提取：函数/类/变量签名（供符号表更新 + 模型审查用）
 *   3. 符号冲突初筛：重定义、声明未引用
 *   4. 输入压缩：剥离注释/空行/行尾空白，压缩送审体积
 *
 * 选型说明：
 *   用 web-tree-sitter（wasm）而非 native tree-sitter —— 本机总内存仅 1.7GB，
 *   native 版需 node-gyp 编译且常驻较大；wasm 版可按需懒加载 + LRU 淘汰。
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * 静态校验的入口配额（并发闸 + 滑动窗口字符配额）。
 *
 * 原来这两套计数器长在 server.js 里，而 /api/review 的 preCheck 分支是裸调
 * staticCheck() 的 —— 等于给静态校验开了个不限流的旁门：双端并行时几个 review
 * 同时打进来就能把 CPU 吃满，而 /api/static-check 那边反倒在被限流。
 * 现在统一收到这里，两个入口走同一套 acquire/release。
 *
 * 两处调用方的取舍不同（刻意不一致）：
 *   /api/static-check      拿不到名额 → 429 让前端退避重试（前端有指数退避逻辑）
 *   /api/review 的 preCheck  拿不到名额 → 跳过静态前置、照常送审
 *                            （preCheck 只是省 token 的优化，它失败不该让审查失败）
 */
const MAX_STATIC_CONCURRENCY = Number(process.env.MAX_STATIC_CONCURRENCY || 3);
const STATIC_WINDOW_MS = Number(process.env.STATIC_WINDOW_MS || 10_000);
const STATIC_MAX_CHARS_PER_WINDOW = Number(
  process.env.STATIC_MAX_CHARS_PER_WINDOW || 2_000_000
);
let staticRunning = 0;
let staticWindowStart = Date.now();
let staticCharsInWindow = 0;

/**
 * 申请一次静态校验名额。
 *
 * 顺序刻意保持「先扣字符、再查并发」：与搬来之前 server.js 的行为一致
 * （被并发闸拒绝的请求也占字符配额）。改动顺序会改变限流形状，不做无谓调整。
 *
 * @param {number} chars 本次代码字符数
 * @returns {{ok: true} | {ok: false, reason: 'chars' | 'busy'}}
 */
export function acquireStaticSlot(chars) {
  const n = typeof chars === 'number' && Number.isFinite(chars) ? Math.max(0, chars) : 0;
  const now = Date.now();
  if (now - staticWindowStart > STATIC_WINDOW_MS) {
    staticWindowStart = now;
    staticCharsInWindow = 0;
  }
  if (staticCharsInWindow + n > STATIC_MAX_CHARS_PER_WINDOW) {
    return { ok: false, reason: 'chars' };
  }
  staticCharsInWindow += n;
  if (staticRunning >= MAX_STATIC_CONCURRENCY) {
    return { ok: false, reason: 'busy' };
  }
  staticRunning++;
  return { ok: true };
}

/** 释放并发名额（字符配额按窗口自然滑过，不在此处返还） */
export function releaseStaticSlot() {
  staticRunning = Math.max(0, staticRunning - 1);
}

export { MAX_STATIC_CONCURRENCY, STATIC_WINDOW_MS, STATIC_MAX_CHARS_PER_WINDOW };

/**
 * 常驻语言数量上限（控制 RSS）。
 * 实测：每个语言 wasm 加载后约 10~30MB（cpp 这类大语法更明显），
 * 本机总内存仅 1.7GB，曾出现一次加载 6 个语言导致 RSS +89MB、free 掉到 69MB。
 * 故收紧为 3：常用语言够用，且内存可控。
 */
const MAX_LOADED_LANGS = 3;

/**
 * ⚠️ 内存硬约束（本机总内存仅 1.7GB，实测教训）：
 *   wasm 的 WebAssembly.Memory 只增不减 —— 即使 LRU 淘汰了 parser，
 *   该语言占用的内存也不会释放（实测：加载 10 种语言后 RSS 从 70MB 涨到 425MB，
 *   静置 30s 完全不回落，free 掉到 84MB）。36 种语言若被用遍，会直接 OOM。
 * 因此设三道闸：
 *   1) 语言白名单：只放行常用且体积正常的语法
 *   2) 单文件体积上限：超过阈值的大语法直接不加载
 *   3) RSS 水位：进程内存过高时拒绝加载【新】语言（已加载的仍可用）
 * 触发时一律降级为 unsupported，绝不阻塞生成流水线。
 */
// 注：yaml 的 wasm 与当前运行时不兼容（parse 时抛 resolved is not a function），已移出。
const ALLOWED_WASM_LANGS = new Set([
  'javascript', 'typescript', 'tsx', 'python', 'java', 'go', 'c', 'cpp',
  'rust', 'php', 'ruby', 'html', 'css', 'json', 'bash', 'vue',
  'lua', 'dart', 'zig', 'scala', 'kotlin',
]);

/** 单个 wasm 体积上限（字节）：objc/ocaml/tlaplus 等 4~8MB 的直接不放行 */
const MAX_WASM_BYTES = 3 * 1024 * 1024;

/** RSS 水位上限（MB）：超过则不再加载新语言 */
const MAX_RSS_MB = 320;

function rssMb() {
  try {
    return process.memoryUsage().rss / 1024 / 1024;
  } catch {
    return 0;
  }
}

/** 语言别名 → tree-sitter-wasms 文件名（不含前缀与后缀） */
const LANG_ALIASES = Object.freeze({
  js: 'javascript',
  jsx: 'javascript',
  javascript: 'javascript',
  mjs: 'javascript',
  node: 'javascript',
  ts: 'typescript',
  typescript: 'typescript',
  tsx: 'tsx',
  py: 'python',
  python: 'python',
  java: 'java',
  go: 'go',
  golang: 'go',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  'c++': 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  'c#': 'c_sharp',
  csharp: 'c_sharp',
  cs: 'c_sharp',
  rust: 'rust',
  rs: 'rust',
  ruby: 'ruby',
  rb: 'ruby',
  php: 'php',
  kotlin: 'kotlin',
  kt: 'kotlin',
  swift: 'swift',
  scala: 'scala',
  lua: 'lua',
  dart: 'dart',
  zig: 'zig',
  html: 'html',
  css: 'css',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  bash: 'bash',
  sh: 'bash',
  shell: 'bash',
  vue: 'vue',
});

/** 规范化语言名；无法识别时返回 null */
export function normalizeLanguage(lang) {
  if (typeof lang !== 'string') return null;
  const key = lang.trim().toLowerCase();
  return LANG_ALIASES[key] ?? null;
}

/**
 * 符号提取：按「节点类型」提取（不用 Query）。
 *
 * 为什么不用 tree-sitter Query：
 *   实测 web-tree-sitter 0.25.10 + tree-sitter-wasms 下，Query 能正常编译
 *   （5 条 pattern 全部编译成功），但对有效 tree 调用 matches() 恒返回 0，
 *   导致符号提取静默为空。改为直接遍历 AST 按节点类型提取，
 *   既避开该版本坑，也不依赖各 grammar 的 query 语法细节。
 */
const SYMBOL_NODE_TYPES = {
  javascript: {
    function: ['function_declaration', 'generator_function_declaration', 'method_definition'],
    class: ['class_declaration'],
    variable: ['variable_declarator'],
  },
  typescript: {
    function: ['function_declaration', 'function_signature', 'method_definition', 'method_signature'],
    class: ['class_declaration', 'interface_declaration'],
    variable: ['variable_declarator'],
  },
  tsx: {
    function: ['function_declaration', 'method_definition'],
    class: ['class_declaration'],
    variable: ['variable_declarator'],
  },
  python: {
    function: ['function_definition'],
    class: ['class_definition'],
    variable: ['assignment'],
  },
  java: {
    function: ['method_declaration', 'constructor_declaration'],
    class: ['class_declaration', 'interface_declaration'],
    variable: ['variable_declarator'],
  },
  go: {
    function: ['function_declaration', 'method_declaration'],
    class: ['type_spec'],
    variable: ['var_spec', 'const_spec'],
  },
  c: {
    function: ['function_definition'],
    class: ['struct_specifier', 'enum_specifier'],
    variable: ['declaration'],
  },
  cpp: {
    function: ['function_definition', 'field_declaration'],
    class: ['class_specifier', 'struct_specifier'],
    variable: ['declaration'],
  },
  c_sharp: {
    function: ['method_declaration', 'constructor_declaration'],
    class: ['class_declaration', 'interface_declaration'],
    variable: ['variable_declarator'],
  },
  rust: {
    function: ['function_item'],
    class: ['struct_item', 'enum_item'],
    variable: ['let_declaration'],
  },
  php: {
    function: ['function_definition', 'method_declaration'],
    class: ['class_declaration'],
    variable: ['assignment_expression'],
  },
};

/** 名字节点类型（用于无 name 字段的 grammar，如 C 的函数声明） */
const NAME_NODE_TYPES = new Set([
  'identifier',
  'type_identifier',
  'property_identifier',
  'field_identifier',
  'name',
  'variable_name',
  'constant',
]);

/** 取节点的名字节点：优先 name 字段，否则向下找标识符（限深度） */
function nameNodeOf(node, maxDepth = 3) {
  const walk = (n, depth) => {
    if (!n || depth > maxDepth) return null;
    if (typeof n.childForFieldName === 'function') {
      const named = n.childForFieldName('name');
      if (named) return named;
    }
    for (const c of n.children || []) {
      if (NAME_NODE_TYPES.has(c.type)) return c;
    }
    for (const c of n.children || []) {
      const r = walk(c, depth + 1);
      if (r) return r;
    }
    return null;
  };
  return walk(node, 0);
}

// 注：早期 tree-sitter Query 方案（SYMBOL_PATTERNS_LEGACY / CAPTURE_KIND / queryCache）
// 已被 AST 遍历（extractSymbols）完全取代，相关代码已全部移除。

let TS = null; // { Parser, Language }
let initPromise = null;

/**
 * 加载 web-tree-sitter。
 *
 * ⚠️ 0.27 的 CJS require() 返回的是「命名空间对象」，导出位置很反直觉：
 *      mod.init            → undefined（不存在）
 *      mod.default.init    → undefined（也不存在）
 *      mod.Parser.init     → ✅ 真正的 init
 *      mod.Language        → ✅ 挂在命名空间上（不在 Parser 上）
 *      mod.Query           → ✅ 同上
 *    即 init 在 Parser 类上，而 Language / Query 在命名空间上，三处分散。
 */
async function getTS() {
  if (TS) return TS;
  if (!initPromise) {
    initPromise = (async () => {
      const mod = require('web-tree-sitter');
      // 0.20~0.27 导出形状不一致，逐个候选找带 init() 的那个
      const Parser = [
        mod,
        mod.default,
        mod.Parser,
        mod.default && mod.default.Parser,
      ].find((c) => c && typeof c.init === 'function');
      if (!Parser) {
        throw new Error('web-tree-sitter 导出异常：找不到带 init() 的 Parser');
      }
      await Parser.init();
      const resolved = {
        Parser,
        Language: mod.Language || Parser.Language,
        Query: mod.Query || Parser.Query,
      };
      if (!resolved.Language || !resolved.Query) {
        throw new Error('web-tree-sitter 导出异常：Language/Query 缺失');
      }
      TS = resolved;
      return TS;
    })();
  }
  return initPromise;
}

/** 已加载语言缓存（简易 LRU：命中时移到末尾，超限时淘汰最久未用） */
const langCache = new Map();
const parserCache = new Map();

function wasmPathOf(lang) {
  return path.join(
    require.resolve('tree-sitter-wasms/package.json'),
    '..',
    'out',
    `tree-sitter-${lang}.wasm`
  );
}

async function getParser(lang) {
  if (parserCache.has(lang)) {
    // LRU：命中后移到最新
    const p = parserCache.get(lang);
    parserCache.delete(lang);
    parserCache.set(lang, p);
    return p;
  }

  const { Parser, Language } = await getTS();

  // 闸门 1：语言白名单
  if (!ALLOWED_WASM_LANGS.has(lang)) return null;

  const wasmPath = wasmPathOf(lang);
  if (!fs.existsSync(wasmPath)) return null;

  // 闸门 2：单文件体积上限
  let size = 0;
  try {
    size = fs.statSync(wasmPath).size;
  } catch {
    return null;
  }
  if (size > MAX_WASM_BYTES) return null;

  // 闸门 3：RSS 水位（只拦「新语言加载」，已加载的照常服务）
  if (!parserCache.has(lang) && rssMb() > MAX_RSS_MB) return null;

  const language = await Language.load(wasmPath);
  const parser = new Parser();
  parser.setLanguage(language);

  parserCache.set(lang, parser);
  langCache.set(lang, Language);

  // 超限：淘汰最久未使用的
  while (parserCache.size > MAX_LOADED_LANGS) {
    const oldest = parserCache.keys().next().value;
    parserCache.delete(oldest);
    langCache.delete(oldest);
  }
  return parser;
}

/**
 * 版本兼容：hasError / isMissing 在 0.25 是【布尔属性】，在 0.27 是【方法】。
 * 统一取值，避免 "xxx is not a function"。
 */
function flagOf(node, key) {
  const v = node[key];
  return typeof v === 'function' ? !!v.call(node) : !!v;
}

const isMissingNode = (n) => flagOf(n, 'isMissing');
const hasErrorNode = (n) => flagOf(n, 'hasError');

/**
 * 收集语法错误（精确到行列）。
 * 只报告最内层错误节点，避免外层父节点重复上报。
 */
function findErrorNodes(root, limit = 10) {
  const out = [];
  const walk = (node) => {
    if (out.length >= limit) return;

    if (isMissingNode(node)) {
      out.push({
        line: node.startPosition.row + 1,
        col: node.startPosition.column + 1,
        kind: 'missing',
        message: `缺少语法成分（${node.type}）`,
      });
      return;
    }

    if (node.type === 'ERROR') {
      const hasChildError = node.children.some(
        (c) => c.type === 'ERROR' || isMissingNode(c)
      );
      if (hasChildError) {
        for (const c of node.children) walk(c);
      } else {
        const text = node.text.slice(0, 40);
        out.push({
          line: node.startPosition.row + 1,
          col: node.startPosition.column + 1,
          kind: 'error',
          message: text ? `语法错误：${text}` : '语法错误',
        });
      }
      return;
    }

    if (hasErrorNode(node)) {
      for (const c of node.children) walk(c);
    }
  };
  walk(root);
  return out;
}

/**
 * 语言补充规则。
 * tree-sitter 的错误恢复会放过一部分真实错误（例如 Python 缩进错误会被
 * 解析成合法但函数体为空的结构），这里针对常用语言补一道。
 */
const EXTRA_CHECKS = {
  python(root, push) {
    const walk = (n) => {
      if (n.type === 'function_definition' || n.type === 'class_definition') {
        const body =
          typeof n.childForFieldName === 'function'
            ? n.childForFieldName('body')
            : null;
        if (!body || (body.type === 'block' && body.namedChildCount === 0)) {
          push({
            line: (n.startPosition ? n.startPosition.row : 0) + 1,
            col: (n.startPosition ? n.startPosition.column : 0) + 1,
            kind: 'error',
            message: '函数/类定义体为空，疑似缩进错误',
          });
        }
      }
      for (const c of n.children || []) walk(c);
    };
    walk(root);
  },
};

/** 统计标识符出现次数（用于判断"声明后是否被引用"） */
function countIdentifiers(root) {
  const counts = new Map();
  const walk = (node) => {
    if (node.type === 'identifier' || node.type === 'type_identifier') {
      const t = node.text;
      counts.set(t, (counts.get(t) || 0) + 1);
    }
    for (const c of node.children) walk(c);
  };
  walk(root);
  return counts;
}

/** 取声明首行作为签名（截断，避免把整个函数体塞进符号表） */
function signatureOf(node) {
  const text = node.text || '';
  const nl = text.indexOf('\n');
  const first = nl === -1 ? text : text.slice(0, nl);
  return first.trim().slice(0, 160);
}

/**
 * 方法类声明：挂在类 / 对象里，不同类完全可以有同名方法（两个组件各写一个 render）。
 * 这类名字不能参与「重定义」判定，否则同文件多类必误报。
 */
const METHOD_NODE_TYPES = new Set([
  'method_definition', 'method_declaration', 'constructor_declaration', 'method_signature',
]);

/** export 语句里可能出现的声明节点类型（用于收集显式导出符号） */
const EXPORT_DECL_NODE_TYPES = new Set([
  'function_declaration', 'generator_function_declaration', 'function_signature',
  'class_declaration', 'abstract_class_declaration', 'interface_declaration',
  'type_alias_declaration', 'enum_declaration', 'variable_declarator',
]);

/** export 语句首行兜底正则（处理 export declare ... 等 AST 拿不到名字的写法） */
const EXPORT_FALLBACK_RES = [
  /\bfunction\s+([A-Za-z_$][\w$]*)/,
  /\bclass\s+([A-Za-z_$][\w$]*)/,
  /\binterface\s+([A-Za-z_$][\w$]*)/,
  /\btype\s+([A-Za-z_$][\w$]*)/,
  /\benum\s+([A-Za-z_$][\w$]*)/,
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/,
];

/**
 * 收集「显式导出」的符号名（export 语句）。
 * 只有 JS/TS/TSX 有 export 语句；Python / Go / Java 是隐式导出，返回空数组 ——
 * 这里宁可漏报（不判跨文件冲突），也不能错报：把各模块各自的私有 helper
 * 判成冲突，正是本次按文件维度改造要消除的误报。
 */
function collectExportNames(root) {
  const names = new Set();

  const walkExport = (node) => {
    if (EXPORT_DECL_NODE_TYPES.has(node.type)) {
      const nn = nameNodeOf(node, node.type === 'variable_declarator' ? 1 : 3);
      if (nn && nn.text) names.add(nn.text);
    }
    if (node.type === 'export_specifier') {
      // export { a as b }：本文件的符号是 a，b 只是对外别名
      const nm = typeof node.childForFieldName === 'function'
        ? node.childForFieldName('name')
        : null;
      const t = (nm && nm.text)
        || (node.children.find((c) => c.type === 'identifier') || {}).text;
      if (t) names.add(t);
    }
    for (const c of node.children || []) walkExport(c);
  };

  const walk = (node) => {
    if (node.type === 'export_statement') {
      const before = names.size;
      walkExport(node);
      if (names.size === before) {
        // AST 没拿到名字：只看首行，避免把函数体里的 const/let 当成导出符号
        const first = String(node.text || '').split('\n')[0];
        for (const re of EXPORT_FALLBACK_RES) {
          const m = first.match(re);
          if (m) names.add(m[1]);
        }
      }
      return;
    }
    for (const c of node.children || []) walk(c);
  };
  walk(root);
  return [...names];
}

/**
 * 提取符号（函数 / 类 / 变量）
 * @returns {{functions:Array, classes:Array, variables:Array, exports:Array<string>, supported:boolean}}
 */
function extractSymbols(tree, lang) {
  const empty = { functions: [], classes: [], variables: [], exports: [], supported: false };
  const spec = SYMBOL_NODE_TYPES[lang];
  if (!spec) return empty;

  // 节点类型 → 符号类别
  const kindOfType = new Map();
  for (const kind of ['function', 'class', 'variable']) {
    for (const t of spec[kind] || []) kindOfType.set(t, kind);
  }

  const buckets = { function: [], class: [], variable: [] };
  const seen = new Set();

  try {
    const walk = (node) => {
      const kind = kindOfType.get(node.type);
      if (kind) {
        // 变量取浅一些，避免把函数声明里的名字误判成变量名
        const nameNode = nameNodeOf(node, kind === 'variable' ? 1 : 3);
        if (nameNode && nameNode.text) {
          const line = (nameNode.startPosition ? nameNode.startPosition.row : 0) + 1;
          const key = `${kind}:${nameNode.text}:${line}`;
          if (!seen.has(key)) {
            seen.add(key);
            buckets[kind].push({
              name: nameNode.text,
              line,
              signature: signatureOf(node),
              method: METHOD_NODE_TYPES.has(node.type),
            });
          }
        }
      }
      for (const c of node.children || []) walk(c);
    };
    walk(tree.rootNode);
    return {
      functions: buckets.function,
      classes: buckets.class,
      variables: buckets.variable,
      exports: collectExportNames(tree.rootNode),
      supported: true,
    };
  } catch {
    // 执行期异常（grammar 差异等）降级：不影响语法校验结果
    return empty;
  }
}

/** 收集所有注释节点区间（AST 精准识别，不会误删字符串里的 // ） */
function collectCommentRanges(root) {
  const ranges = [];
  const walk = (node) => {
    if (node.type === 'comment') {
      ranges.push([node.startIndex, node.endIndex]);
    }
    for (const c of node.children) walk(c);
  };
  walk(root);
  return ranges;
}

/**
 * 压缩输入体积：剥离注释 → 去行尾空白 → 压缩连续空行 → 去首尾空行。
 * 基于 AST 删注释，因此不会破坏字符串字面量中的 // 或 /* 。
 */
function compressCode(tree, code) {
  const original = code;
  const ranges = collectCommentRanges(tree.rootNode);
  let out = code;
  // 从后往前替换，避免索引位移
  for (let i = ranges.length - 1; i >= 0; i -= 1) {
    const [s, e] = ranges[i];
    out = out.slice(0, s) + out.slice(e);
  }
  out = out
    .split('\n')
    .map((l) => l.replace(/[\t ]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '');

  const originalBytes = Buffer.byteLength(original, 'utf8');
  const compressedBytes = Buffer.byteLength(out, 'utf8');
  return {
    code: out,
    originalBytes,
    compressedBytes,
    savedBytes: originalBytes - compressedBytes,
    savedPct:
      originalBytes > 0
        ? Number(
            (((originalBytes - compressedBytes) / originalBytes) * 100).toFixed(1)
          )
        : 0,
    commentsRemoved: ranges.length,
  };
}

/**
 * 把外部传入的符号表拍平成「名字」集合。
 * 注意：比对用的是名字（formatDate），不是签名（function formatDate(d) {...}）——
 * 调用方若把签名塞进来，重定义判定会静默失效（名字永远匹配不上）。
 *
 * 接受四种形态：
 *   ① 数组：['formatDate', {name:'ApiClient'}, ...]
 *   ② 对象：{functions:[...], classes:[...], variables:[...], names:[...]}
 *      names 桶用于承载「跨文件导出符号」这类不分类别的名字
 *   ③ 对象的 JSON 字符串：上面两种被 JSON.stringify 之后的产物
 *   ④ 行文本：symbolTableText() 给模型看的那份上下文，
 *      形如 "[文件]\nfn formatDate(d)\nclass ApiClient\nvar counter\n\nexport formatDate"
 *
 * ④ 是 2026-10-15 补的：此前 /api/review 的 preCheck 分支一直传的是 ④，
 * 而这里只认 ①②，字符串会一路走到函数末尾【静默返回空集】——
 * 表现为「符号冲突检测失效」却没有任何报错，正是最坑的那种形态。
 * 现在四种形态都能用；解析不了的输入仍然返回空集（与旧行为一致）。
 *
 * @param {unknown} gs
 * @returns {Set<string>}
 */
export function flattenGlobalSymbols(gs) {
  const set = new Set();
  if (!gs) return set;
  const push = (item) => {
    if (typeof item === 'string' && item.trim()) set.add(item.trim());
    else if (item && typeof item === 'object' && typeof item.name === 'string') {
      set.add(item.name.trim());
    }
  };

  // ③ JSON 字符串先还原成对象，走下面的对象分支
  let src = gs;
  if (typeof src === 'string') {
    const t = src.trim();
    if (t.startsWith('{') || t.startsWith('[')) {
      try {
        src = JSON.parse(t);
      } catch {
        /* 不是合法 JSON，按 ④ 行文本处理 */
      }
    }
  }

  if (Array.isArray(src)) {
    src.forEach(push);
    return set;
  }
  if (src && typeof src === 'object') {
    for (const key of [
      'functions',
      'classes',
      'variables',
      'methods',
      'types',
      'names',
    ]) {
      const arr = src[key];
      if (Array.isArray(arr)) arr.forEach(push);
    }
    return set;
  }

  // ④ 行文本：按行取「前缀 + 标识符」，只取名字不取签名
  //    （fn formatDate(d) → formatDate；与上面「比对用名字」的约定一致）
  if (typeof gs === 'string') {
    for (const line of gs.split('\n')) {
      const m = /^\s*(?:fn|function|def|class|var|let|const|export)\s+([A-Za-z_$][\w$]*)/.exec(
        line
      );
      if (m) set.add(m[1]);
    }
  }
  return set;
}

/**
 * 符号冲突初筛：重定义 + 声明未引用。
 * 说明：仅作"初步匹配"，未定义引用交给模型（模型有符号表上下文，判断更准）。
 *
 * 判重范围由调用方通过 globalSymbols 决定（前端按文件维度组装）：
 *   - 同一文件里已声明的函数 / 类 → 真重定义
 *   - 其它文件显式导出的符号 → 跨文件冲突（各模块私有 helper 不在此列）
 * 因此这里的 globalNames 已经是「筛选后」的集合，本函数只负责按名字比对。
 */function checkConflicts(symbols, globalNames, identifierCounts) {
  const redefinitions = [];
  const unused = [];

  for (const kind of ['functions', 'classes', 'variables']) {
    for (const s of symbols[kind] || []) {
      // 方法类声明不判重：不同类 / 对象可以有同名方法
      if (!s.method && globalNames.has(s.name)) {
        redefinitions.push({
          name: s.name,
          kind: kind === 'variables' ? 'variable' : kind === 'classes' ? 'class' : 'function',
          line: s.line,
          reason: '与已有符号同名（同文件重定义或跨文件导出冲突），可能覆盖已有实现',
        });
      }
      // 「未引用」只对变量判断：增量生成时，函数 / 类往往在【后续片段】才被调用，
      // 在本片段内统计必然为 0 引用，会大量误伤（constructor、导出函数等）。
      if (kind === 'variables') {
        const cnt = identifierCounts.get(s.name) || 0;
        if (cnt <= 1) {
          unused.push({
            name: s.name,
            kind: 'variable',
            line: s.line,
            reason: '声明后在片段内未被引用',
          });
        }
      }
    }
  }
  return { redefinitions, unused };
}

/**
 * 安全基线静态检测（零 token）。
 *
 * 设计原则——【宁可漏报，不可错报】：
 *   1. 只收模式明确、几乎无歧义的几类。拿不准的（比如"该不该转义"）交给
 *      小模型审查，它看得懂上下文；
 *   2. 只报告，【不接自动修复回路】。自动修是把双刃剑（applyFixes 有过改坏
 *      代码的前科），安全类误改的代价比漏报高得多；
 *   3. 与语言无关：纯文本模式匹配，任何栈都能扫。
 *
 * @param {string} code 待检测代码
 * @returns {Array<{rule:string,severity:string,line:number,message:string,suggestion:string,snippet:string}>}
 */
const SECURITY_RULES = [
  {
    id: 'js_pseudo_protocol',
    severity: 'high',
    re: /(?:href|src|action|formaction)\s*=\s*["']?\s*javascript\s*:/i,
    message: '使用了 javascript: 伪协议，可被利用做 XSS',
    suggestion: '改为真实 URL，或对协议做白名单校验',
  },
  {
    id: 'eval_usage',
    severity: 'high',
    re: /\b(?:eval|new\s+Function)\s*\(/,
    message: '使用了 eval / new Function，可执行任意字符串',
    suggestion: '改用 JSON.parse 或显式分派逻辑',
  },
  {
    id: 'sql_string_concat',
    severity: 'high',
    // SQL 关键字后面出现模板变量插值（${...}）——字符串拼 SQL 的典型形态
    re: /\b(?:SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b[^'"`\n]*\$\{/i,
    message: 'SQL 语句中拼接了模板变量，存在注入风险',
    suggestion: '改用参数化查询 / 预编译语句',
  },
  {
    id: 'hardcoded_secret',
    severity: 'high',
    re: /(?:api[_-]?key|secret|token|passwd|password|pwd|access[_-]?key|private[_-]?key)\s*[:=]\s*['"][A-Za-z0-9_\-/+=.]{16,}['"]/i,
    message: '疑似硬编码密钥 / 口令',
    suggestion: '改为从环境变量或配置中心读取，并及时轮换已泄露的凭据',
  },
  {
    id: 'dangerous_inner_html',
    severity: 'medium',
    re: /dangerouslySetInnerHTML|\.innerHTML\s*=|\.outerHTML\s*=/,
    message: '直接写入 innerHTML / dangerouslySetInnerHTML，未消毒会 XSS',
    suggestion: '改用 textContent / 框架的 {} 绑定；确需 HTML 先消毒',
  },
  {
    id: 'cors_wildcard',
    severity: 'medium',
    re: /origin\s*:\s*['"][*]['"]|Access-Control-Allow-Origin['"]?\s*[,:]\s*['"][*]['"]/i,
    message: 'CORS 配置为通配 *，对任意来源放行',
    suggestion: '显式列出允许的来源；同源部署时不要开启跨域',
  },
  {
    id: 'path_traversal',
    severity: 'medium',
    re: /(?:readFile|writeFile|appendFile|createReadStream|createWriteStream|unlink|rm|rmSync|open|sendFile)\s*\([^)\n]*\.\.\//,
    message: '文件操作路径中出现 ../，存在目录穿越风险',
    suggestion: '拼接后校验规范化路径，拒绝越界访问',
  },
];

const BLANK_TARGET_RE = /target\s*=\s*['"]_blank['"]/i;
const REL_OK_RE = /rel\s*=\s*['"][^'"]*\bnoopener\b/i;

function checkSecurity(code) {
  const src = String(code || '');
  if (!src) return [];
  const lines = src.split('\n');
  const out = [];

  const push = (rule, idx) => {
    out.push({
      rule: rule.id,
      severity: rule.severity,
      line: idx + 1,
      message: rule.message,
      suggestion: rule.suggestion,
      snippet: (lines[idx] || '').trim().slice(0, 120),
    });
  };

  for (const rule of SECURITY_RULES) {
    for (let i = 0; i < lines.length; i++) {
      if (rule.re.test(lines[i])) push(rule, i);
    }
  }

  // target="_blank" 但附近没有 rel="noopener"（属性可能换行写，看前后 3 行）
  for (let i = 0; i < lines.length; i++) {
    if (!BLANK_TARGET_RE.test(lines[i])) continue;
    const ctx = lines.slice(Math.max(0, i - 3), i + 4).join('\n');
    if (!REL_OK_RE.test(ctx)) {
      push({
        id: 'blank_target_no_rel',
        severity: 'low',
        message: 'target="_blank" 未加 rel="noopener noreferrer"',
        suggestion: '补上 rel，防止反向标签钓鱼（window.opener 篡改）',
      }, i);
    }
  }

  return out;
}

/**
 * 执行静态校验（零 token）。
 * @param {{code:string, language:string, globalSymbols?:unknown, compress?:boolean}} p
 */
export async function staticCheck({ code, language, globalSymbols, compress = true }) {
  const startedAt = Date.now();
  const lang = normalizeLanguage(language);

  // 语言不支持：不报错（避免打断生成流水线），仅返回 unsupported。
  // 但安全检测是纯文本模式匹配、不依赖 AST，所以这里【照样要跑】——
  // 早先漏了这一步，等于不支持的语言完全不做安全扫描。
  if (!lang) {
    return {
      ok: true,
      supported: false,
      language: language || 'unknown',
      reason: '语言不在 Tree-sitter 支持列表，已跳过语法与符号校验',
      syntax: { ok: true, skipped: true, errorCount: 0, errors: [] },
      symbols: { functions: [], classes: [], variables: [], supported: false },
      conflicts: { redefinitions: [], unused: [] },
      security: checkSecurity(code),
      compressed: null,
      ms: Date.now() - startedAt,
    };
  }

  let parser;
  try {
    parser = await getParser(lang);
  } catch (err) {
    return {
      ok: false,
      supported: true,
      language: lang,
      reason: `语法解析器加载失败：${err && err.message ? err.message : err}`,
      ms: Date.now() - startedAt,
    };
  }
  if (!parser) {
    // 区分降级原因，便于运维判断是「不支持」还是「内存保护」
    let reason = '该语言未启用静态校验';
    if (!ALLOWED_WASM_LANGS.has(lang)) {
      reason = `语言 ${lang} 不在静态校验白名单（体积/使用频率考量）`;
    } else if (rssMb() > MAX_RSS_MB) {
      reason = `进程内存水位 ${Math.round(rssMb())}MB 超过 ${MAX_RSS_MB}MB，暂不加载新语言`;
    }
    return {
      ok: true,
      supported: false,
      language: lang,
      reason,
      syntax: { ok: true, skipped: true, errorCount: 0, errors: [] },
      symbols: { functions: [], classes: [], variables: [], supported: false },
      conflicts: { redefinitions: [], unused: [] },
      compressed: null,
      ms: Date.now() - startedAt,
    };
  }

  let tree;
  try {
    tree = parser.parse(code);
  } catch (err) {
    // 解析失败（个别 wasm 与运行时版本不兼容等）：降级为「跳过静态校验」，
    // 绝不让流水线因为校验层自身问题而中断。
    return {
      ok: true,
      supported: false,
      language: lang,
      reason: `解析失败，已跳过静态校验：${
        err && err.message ? err.message : String(err)
      }`,
      syntax: { ok: true, skipped: true, errorCount: 0, errors: [] },
      symbols: { functions: [], classes: [], variables: [], supported: false },
      conflicts: { redefinitions: [], unused: [] },
      compressed: null,
      ms: Date.now() - startedAt,
    };
  }

  const errors = findErrorNodes(tree.rootNode);

  // 语言补充检查（按行去重，避免与 AST 错误节点重复上报）
  const extraCheck = EXTRA_CHECKS[lang];
  if (extraCheck) {
    const found = [];
    try {
      extraCheck(tree.rootNode, (e) => found.push(e));
    } catch {
      /* 补充规则失败不影响主流程 */
    }
    for (const e of found) {
      if (!errors.some((x) => x.line === e.line)) errors.push(e);
    }
  }

  const symbols = extractSymbols(tree, lang);
  const identifierCounts = countIdentifiers(tree.rootNode);
  const globalNames = flattenGlobalSymbols(globalSymbols);
  const conflicts = checkConflicts(symbols, globalNames, identifierCounts);
  // 安全基线检测：不依赖 AST，纯文本模式匹配（unsupported 语言也要能扫）
  const security = checkSecurity(code);

  return {
    ok: true,
    supported: true,
    language: lang,
    syntax: {
      ok: errors.length === 0,
      errorCount: errors.length,
      errors,
    },
    symbols: {
      functions: symbols.functions,
      classes: symbols.classes,
      variables: symbols.variables,
      exports: symbols.exports,
      supported: symbols.supported,
    },
    conflicts,
    security,
    compressed: compress ? compressCode(tree, code) : null,
    ms: Date.now() - startedAt,
  };
}

/** 供运维观测：当前已加载的语言（含 wasm 常驻情况） */
export function loadedLanguages() {
  return [...parserCache.keys()];
}
