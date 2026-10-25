/**
 * 契约驱动双端生成：接口提取 + 三方一致性比对。
 *
 * 两个模块都是纯本地计算，不消耗任何 token：
 *   1. extractApis  —— 从代码里抽出「前端接口调用」或「后端接口定义」
 *   2. checkConsistency —— 契约 / 前端 / 后端三方结构化比对
 *
 * 为什么用正则而不是 Tree-sitter：
 *   本机总内存仅 1.7GB，而 web-tree-sitter 的 wasm 内存只增不减，
 *   static-check 已把常驻语言上限压到 3 个。双端生成天然要同时处理
 *   「前端语言 + 后端语言」，再引入 parser 有 OOM 风险；
 *   而接口提取只需识别若干固定框架写法，正则足够覆盖且零内存、毫秒级。
 *   这里是「提示性校验」而非编译器，允许少量误报，不允许阻塞生成。
 */

/** 行注释 / 块注释剥离：避免把注释里写的示例路径当成真实接口 */
function stripComments(code, language) {
  const lang = String(language || '').toLowerCase();
  let out = String(code || '');

  // 块注释 /* */（含 JSDoc）
  out = out.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  // Python 三引号字符串不作为注释处理（里面可能是 docstring 里的路径，量极少，忽略）
  if (lang === 'python' || lang === 'py') {
    out = out.replace(/(^|\n)\s*#[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));
  } else {
    out = out.replace(/(^|\n)\s*\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));
  }
  return out;
}

/**
 * 路径归一化：把各种占位写法统一成 {param}，才能跨端比对。
 *   /api/users/{id}   （契约 / Spring）
 *   /api/users/:id    （Express）
 *   /api/users/${id}  （前端模板字符串）
 *   /api/users/       （末尾斜杠）
 */
export function normalizePath(raw) {
  let p = String(raw == null ? '' : raw).trim();
  if (!p) return '';
  // 去引号
  p = p.replace(/^['"`]|['"`]$/g, '');
  // 查询串与 hash 不影响接口身份
  p = p.split('?')[0].split('#')[0];
  if (!p) return '';
  // 模板字符串拼接：只保留前缀常量部分（`${API}/users` 这类整体变量路径会被丢弃）
  p = p.replace(/\$\{[^}]*\}/g, '{param}');
  p = p.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, '{param}');
  p = p.replace(/\{[A-Za-z_][A-Za-z0-9_]*\}/g, '{param}');
  // 多个连续参数名不同的占位符统一（/a/{x}/b/{y} → /a/{param}/b/{param}）
  if (!p.startsWith('/')) p = '/' + p;
  p = p.replace(/\/{2,}/g, '/');
  p = p.replace(/\/+$/, '');
  return p || '/';
}

function lineOf(code, index) {
  let line = 1;
  for (let i = 0; i < index && i < code.length; i++) {
    if (code.charCodeAt(i) === 10) line++;
  }
  return line;
}

function normMethod(m) {
  const u = String(m || '').toUpperCase();
  if (u === 'DEL' || u === 'DESTROY') return 'DELETE';
  if (u === 'ALL' || u === 'USE' || u === 'ANY') return 'ANY';
  return u || 'GET';
}

/**
 * 收集「挂载前缀」（后端）。
 * 真实路径 = 全局前缀(/api) + 模块前缀(/tasks) + 路由内路径(/:id)。
 * 只读路由文件里的 /:id 就认为后端实现的是 /:id，会和契约的 /api/tasks/{param} 对不上，
 * 这是此前最典型的一类误报。
 */
function collectMountPrefixes(src) {
  const out = new Set();
  const add = (v) => {
    const p = normalizePath(v);
    if (p && p !== '/') out.add(p);
  };
  let m;
  // Express / Koa：app.use('/api', router)、router.use('/tasks', sub)
  const useRe = /\b(?:app|server|api|r|router)\s*\.\s*use\s*\(\s*(['"`])([^'"`]+)\1/gi;
  while ((m = useRe.exec(src)) !== null) add(m[2]);
  // FastAPI：APIRouter(prefix='/api')
  const fastRe = /APIRouter\s*\([^)]*prefix\s*=\s*(['"`])([^'"`]+)\1/g;
  while ((m = fastRe.exec(src)) !== null) add(m[2]);
  // Flask：Blueprint(..., url_prefix='/api')
  const flaskRe = /Blueprint\s*\([^)]*url_prefix\s*=\s*(['"`])([^'"`]+)\1/g;
  while ((m = flaskRe.exec(src)) !== null) add(m[2]);
  // Go gin / echo：r.Group('/api')
  const goRe = /\.\s*Group\s*\(\s*(['"`])([^'"`]+)\1/g;
  while ((m = goRe.exec(src)) !== null) add(m[2]);
  return [...out];
}

/**
 * 收集「请求基址」（前端）。
 * 前端 task.api.js 里写的是相对路径 /tasks，运行时与 BASE_URL: '/api' 拼成 /api/tasks，
 * 只看相对路径会误判成「未调用契约接口」。
 */
function collectBaseUrls(src) {
  const out = new Set();
  const add = (v) => {
    const p = normalizePath(v);
    if (p && p !== '/') out.add(p);
  };
  let m;
  // axios.create({ baseURL: '/api' })
  const re1 = /baseUrl\s*:\s*(['"`])([^'"`]*)\1/gi;
  while ((m = re1.exec(src)) !== null) add(m[2]);
  // const BASE_URL = import.meta.env.VITE_API_BASE || '/api'
  const re2 = /(?:BASE_URL|API_BASE|API_PREFIX|basePath|VITE_API_BASE)\s*[:=]\s*(['"`])([^'"`]*)\1/g;
  while ((m = re2.exec(src)) !== null) add(m[2]);
  return [...out];
}

/** 从 fetch 调用的第二个参数里找 method（可能跨行，向后看一段即可） */
function methodNear(code, idx) {
  const seg = code.slice(idx, idx + 220);
  const m = /method\s*:\s*['"`]([A-Za-z]+)['"`]/.exec(seg);
  return m ? normMethod(m[1]) : '';
}

// ---------- 前端：接口调用 ----------
// 覆盖 fetch / axios / request|api|http|client 的链式写法与 axios(config) 对象写法
const FE_PATTERNS = [
  // axios.get('/path')、axios.post('/path', data)
  { re: /\baxios\s*\.\s*(get|post|put|delete|del|patch|head)\s*\(\s*(['"`])([^'"`]*)\2/g, g: (m) => ({ path: m[3], method: normMethod(m[1]) }) },
  // request.get('/path')、api.post('/path')、http.put、client.delete
  { re: /\b(?:request|api|http|client|fetcher)\s*\.\s*(get|post|put|delete|del|patch)\s*\(\s*(['"`])([^'"`]*)\2/gi, g: (m) => ({ path: m[3], method: normMethod(m[1]) }) },
  // fetch('/path')、fetch(`/path`, {...})
  { re: /\bfetch\s*\(\s*(['"`])([^'"`]*)\1/g, g: (m) => ({ path: m[2], method: '' }) },
];

// ---------- 后端：接口定义 ----------
const BE_PATTERNS = [
  // Express / Koa：app.get('/path')、router.post('/path')
  // 注意：不含 use —— app.use('/api', router) 是「挂载前缀」而不是接口定义，
  // 之前把它当成 ANY /api 接口，会凭空多出一条「契约外接口」。
  { re: /\b(?:app|router|server|api|r)\s*\.\s*(get|post|put|delete|del|patch|all)\s*\(\s*(['"`])([^'"`]*)\2/gi, g: (m) => ({ path: m[3], method: normMethod(m[1]) }) },
  // Flask：@app.route('/path', methods=['POST'])、@bp.route('/path')
  { re: /@[A-Za-z_]\w*\s*\.\s*route\s*\(\s*(['"`])([^'"`]*)\1([^)]*)\)/g, g: (m) => {
      const mm = /methods\s*=\s*\[\s*['"`]([A-Za-z]+)['"`]/.exec(m[3] || '');
      return { path: m[2], method: mm ? normMethod(mm[1]) : 'GET' };
    } },
  // FastAPI / Flask：@app.get('/path')、@router.post('/path')
  { re: /@(?:app|router|blueprint|api)\s*\.\s*(get|post|put|delete|patch)\s*\(\s*(['"`])([^'"`]*)\2/gi, g: (m) => ({ path: m[3], method: normMethod(m[1]) }) },
  // Spring：@GetMapping('/path')、@RequestMapping(value='/path', method=RequestMethod.POST)
  { re: /@(Get|Post|Put|Delete|Patch|Request)Mapping\s*\(([^)]*)\)/g, g: (m) => {
      let method = m[1].toUpperCase();
      const args = m[2] || '';
      const pm = /method\s*=\s*RequestMethod\.([A-Za-z]+)/.exec(args);
      if (pm) method = normMethod(pm[1]);
      // value / path 可取数组：@RequestMapping({"a","b"})，这里只取第一个
      const vm = /(?:value|path)\s*=\s*(?:\{\s*)?['"`]([^'"`]*)['"`]/.exec(args)
        || /^\s*['"`]([^'"`]*)['"`]/.exec(args);
      return { path: vm ? vm[1] : '', method };
    } },
  // Spring 无参映射（@GetMapping 直接挂在方法上，路径来自类上的 @RequestMapping）——路径留空，仅记录方法
  { re: /@(Get|Post|Put|Delete|Patch)Mapping\s*(?=\s|(?:public|private|protected|[A-Za-z_<>\[\]]))/g, g: (m) => ({ path: '', method: m[1].toUpperCase() }) },
  // Go gin / echo：r.GET('/path')
  { re: /\b[A-Za-z_]\w*\s*\.\s*(GET|POST|PUT|DELETE|PATCH)\s*\(\s*(['"`])([^'"`]*)\2/g, g: (m) => ({ path: m[3], method: normMethod(m[1]) }) },
  // Go net/http：http.HandleFunc('/path', h)
  { re: /\bhttp\s*\.\s*HandleFunc\s*\(\s*(['"`])([^'"`]*)\1/g, g: () => ({ path: '', method: 'ANY' }) },
];

/**
 * 提取接口。
 * @param {object} p
 * @param {string} p.code      代码文本
 * @param {string} p.language  语言（仅用于注释剥离）
 * @param {string} p.side      'frontend' | 'backend'
 * @returns {{side:string, apis:Array<{path:string,method:string,raw:string,line:number}>}}
 */
export function extractApis({ code, language, side }) {
  const src = stripComments(code, language);
  const isFe = String(side || '').toLowerCase() === 'frontend';
  const patterns = isFe ? FE_PATTERNS : BE_PATTERNS;

  const seen = new Map(); // key = method + ' ' + path
  const apis = [];

  for (const { re, g } of patterns) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src)) !== null) {
      // 防御：零宽匹配会死循环
      if (m[0] === '') { re.lastIndex++; continue; }

      let hit;
      try { hit = g(m, src, m.index); } catch { hit = null; }
      if (!hit) continue;

      let method = hit.method || '';
      // fetch / axios 对象写法：method 在参数里，需要二次抽取
      if (!method) {
        if (/^\s*fetch\s*\(/.test(m[0])) method = methodNear(src, m.index) || 'GET';
        else method = 'GET';
      }

      const path = normalizePath(hit.path);
      // 后端允许空路径：Spring 无参 @PostMapping 的路径来自类级注解，后处理阶段补
      if (!path && isFe) continue;

      const key = method + ' ' + path;
      if (seen.has(key)) continue;
      seen.set(key, true);
      apis.push({ path, method, raw: hit.path, line: lineOf(src, m.index) });
    }
  }

  // Spring 类级 @RequestMapping 是前缀，方法级 @GetMapping("/{id}") 只有后半段，
  // 不拼接会被判成「后端实现与契约不一致」的误报。
  if (!isFe) {
    const classRe = /@RequestMapping\s*\(\s*(?:value\s*=\s*)?(['"`])([^'"`]+)\1[^)]*\)\s*(?:[\s\S]{0,200}?)\b(?:class|interface)\b/g;
    const cm = classRe.exec(src);
    if (cm) {
      const base = normalizePath(cm[2]);
      if (base && base !== '/') {
        for (const a of apis) {
          // 相对片段（/{id}、/list）拼上前缀；已是完整路径（/api/...）的不动
          if (!a.path || a.path === '/') a.path = base;
          else if (!a.path.startsWith(base) && !a.path.startsWith('/api')) a.path = base + a.path;
        }
        // 类级注解本身不是接口，剔除
        for (let i = apis.length - 1; i >= 0; i--) {
          if (apis[i].path === base && apis[i].method === 'REQUEST') apis.splice(i, 1);
        }
      }
    }
  }

  // axios({url, method}) 这类对象写法：上面正则覆盖不到，单独扫一遍
  if (isFe) {
    const objRe = /\baxios\s*\(\s*\{/g;
    let om;
    while ((om = objRe.exec(src)) !== null) {
      // 取到匹配的右花括号（不处理嵌套对象，够用即可）
      const end = src.indexOf('}', om.index + om[0].length);
      if (end < 0) continue;
      const obj = src.slice(om.index, end + 1);
      const um = /(?:url|path)\s*:\s*['"`]([^'"`]*)['"`]/.exec(obj);
      if (!um) continue;
      const mm = /method\s*:\s*['"`]([A-Za-z]+)['"`]/.exec(obj);
      const path = normalizePath(um[1]);
      if (!path) continue;
      const method = mm ? normMethod(mm[1]) : 'GET';
      const key = method + ' ' + path;
      if (seen.has(key)) continue;
      seen.set(key, true);
      apis.push({ path, method, raw: um[1], line: lineOf(src, om.index) });
    }
  }

  // 挂载前缀 / 请求基址：把相对路径补成完整路径。
  // 只有「前缀唯一」时才自动拼接——同时存在 /api、/admin 等多个前缀说明无法判断归属，
  // 这时保持原样，交给比对阶段的后缀容错去降级提示，避免乱拼造成新的误报。
  const prefixes = isFe ? collectBaseUrls(src) : collectMountPrefixes(src);
  if (prefixes.length === 1) {
    const base = prefixes[0];
    for (const a of apis) {
      if (!a.path || a.path === '/') a.path = base;
      else if (!a.path.startsWith(base)) a.path = base + a.path;
    }
  }

  const valid = apis.filter((a) => a.path);
  valid.sort((a, b) =>
    a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path)
  );
  return { side: isFe ? 'frontend' : 'backend', apis: valid };
}

/**
 * 响应类型是否标注为「集合」。
 * 契约约定用 Xxx[] / List<Xxx> 标注（提示词里明确要求了），
 * 另外兼容 desc 里写「列表 / 数组 / 多条」的自然语言写法。
 */
function isCollectionResponse(a) {
  const t = String((a.response || {}).type || '').trim();
  if (/\[\s*\]$/.test(t)) return true;                                  // User[] / User []
  if (/^(list|array|set|iterable|ienumerable|collection)\s*</i.test(t)) return true;  // List<User>
  if (/^(列表|数组|集合)/.test(t)) return true;
  return /列表|数组|集合|一批|多条/.test(String((a.response || {}).desc || ''));
}

/** 分页参数名（大小写不敏感）：覆盖 page/pageSize 与常见等价写法 */
const PAGINATION_PARAM_RE =
  /^(page|pagenum|pageno|pageindex|current|offset|limit|pagesize|size|perpage|per_page|cursor)$/i;

/** request.query 里是否已声明分页参数 */
function hasPaginationParam(a) {
  const q = (a.request || {}).query;
  if (!Array.isArray(q)) return false;
  return q.some((p) => p && PAGINATION_PARAM_RE.test(String(p.name || '').trim()));
}

// ==================== DTO 维度：字段名 / 类型 / 契约外字段 / 枚举越界 ====================
// 背景（2026-10-16 实测）：契约把 ID 定义成 string (UUID)，前后端都私下改成 number；
// sortBy 擅自加了契约外的枚举值；status 初始值直接传 done。prompt 里明明写了
// 「字段名、类型必须和共用 DTO 完全一致」「禁止私自修改」，但模型照改不误 ——
// 而原有 consistency 只校验路径和方法，看不到 DTO 层，这类改动全无痕迹。
// 这里补 DTO 级静态比对：认不出的写法返回空（那是"没检查到"，不是"没问题"）。

/** 基础类型归一化：跨语言同义类型必须归到同一桶，否则全是误报 */
const TYPE_BUCKETS = [
  [/^(string|str|text|uuid|guid|char|varchar|nvarchar|character|clob|ntext)$/i, 'string'],
  [/^(int|integer|long|bigint|smallint|tinyint|short|number|numeric|float|double|decimal|real|serial|bigserial|money)$/i, 'number'],
  [/^(bool|boolean|bit)$/i, 'boolean'],
  [/^(date|datetime|timestamp|timestamptz|time)$/i, 'date'],
  [/^(object|json|map|dict|record)$/i, 'object'],
];

/**
 * 归一化字段类型：'string (UUID)'→string；'int'→number；'List<User>'/'User[]'→array；
 * 'Optional[str]'→string；'varchar(255)'→string。无法识别时返回小写原文（按名字比）。
 */
export function normFieldType(raw) {
  let t = String(raw == null ? '' : raw).trim();
  if (!t) return '';
  const isArray = /\[\s*\]$/.test(t) ||
    /^(list|array|set|slice|collection|ienumerable|iterable)\s*[<\[(]/i.test(t);
  t = t.replace(/\([^)]*\)/g, ' ');              // 去括号说明
  // Optional/Nullable 包装要在删泛型【之前】剥：'Optional[str]' → 'str'
  // （连带闭合括号一起取内容，只删左半边会留下孤儿 ] ）
  const optM = /^(?:optional|nullable)\s*[<\[(]([^>\]\)]*)[>\]\)]/i.exec(t);
  if (optM) t = optM[1];
  t = t.replace(/\s*\|\s*none\s*$/i, '');        // Python 的 'str | None'
  t = t.split(/[\/\/#,;]|--/)[0];                // 去行内说明（'int, 自增' → 'int'）
  t = t.replace(/[<\[][\s\S]*$/, '').trim();     // 'List<User>' → 'List'
  t = t.replace(/\[]$/, '').trim();              // 'string[]' → 'string'
  t = t.replace(/\?$/, '').trim();
  if (!t) return isArray ? 'array' : '';
  const low = t.toLowerCase();
  for (const [re, v] of TYPE_BUCKETS) if (re.test(low)) return isArray ? 'array' : v;
  if (/^(list|array|set|slice|collection|ienumerable|iterable)$/i.test(low)) return 'array';
  return isArray ? 'array' : low;                // 自定义类型（如 Status）按小写名字比
}

/** 字段名 / DTO 名比对：大小写不敏感（Go 的 ID vs 契约的 id 不该判不一致） */
function sameName(a, b) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}

/**
 * 从生成的代码里提取 DTO / 类型定义（与 extractApis 同样用正则，不引 parser）。
 * 只认各语言最常见的定义写法，认不出就返回空。
 *
 * @param {object} p
 * @param {string} p.code
 * @param {string} p.language
 * @returns {Array<{name:string, fields:Array<{name:string, type:string}>}>}
 */
export function extractDtos({ code, language }) {
  const src = stripComments(code, language);
  const lang = String(language || '').toLowerCase();
  const out = new Map();   // key = 小写名 → { name, fields: Map<小写字段名, {name, type}> }
  const add = (name, field, type) => {
    if (!name || !field) return;
    const key = String(name).toLowerCase();
    if (!out.has(key)) out.set(key, { name: String(name), fields: new Map() });
    const f = out.get(key).fields;
    const fk = String(field).toLowerCase();
    // 保留原始大小写：驼峰字段名（createdAt）被压成小写会让消费方按原名取不到
    if (!f.has(fk)) f.set(fk, { name: String(field), type: String(type || '') });
  };

  // TS / JS：interface X { ... } 与 type X = { ... }
  // 闭括号用 \} 而非 \n}：单行写法（interface TaskList { items: Task[]; total: number; }）
  // 同样很常见；interface 体内一般不会有单独的 }，非贪婪到第一个闭括号两种情况都对。
  // 字段按 ; 分割而不是按行：单行写法下第二个字段不在行首，按行会漏（漏字段=漏报）。
  if (/typescript|javascript|tsx|jsx/.test(lang)) {
    const re = /\b(?:export\s+)?(?:interface|type)\s+([A-Za-z_$][\w$]*)\s*(?:=\s*)?\{([\s\S]*?)\}/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      for (const part of m[2].split(';')) {
        const pm = /^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*\??\s*:\s*([^;\n]+)/.exec(part);
        if (pm) add(m[1], pm[1], pm[2].trim());
      }
    }
  }

  // Python：@dataclass class X: / class X(BaseModel):
  if (/python/.test(lang)) {
    const re = /\bclass\s+([A-Za-z_]\w*)\s*(?:\([^)]*\))?\s*:\s*\n((?:[ \t]+[^\n]*\n?)+)/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const lineRe = /^[ \t]+([A-Za-z_]\w*)\s*:\s*([^\n=#]+)/gm;
      let lm;
      while ((lm = lineRe.exec(m[2])) !== null) add(m[1], lm[1], lm[2].trim());
    }
  }

  // Java：class X { private T f; } 与 record X(T f, ...)
  if (/java/.test(lang)) {
    const re = /\b(?:public|private|protected)?\s*(?:final\s+)?class\s+([A-Za-z_]\w*)[^{]*\{([\s\S]*?)\n\}/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const lineRe = /(?:private|public|protected)\s+(?:final\s+)?([A-Za-z_][\w.<>\[\],\s]*?)\s+([A-Za-z_]\w*)\s*[;=]/g;
      let lm;
      while ((lm = lineRe.exec(m[2])) !== null) add(m[1], lm[2], lm[1].trim());
    }
    const rec = /\brecord\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/g;
    while ((m = rec.exec(src)) !== null) {
      for (const part of m[2].split(',')) {
        const pm = /^\s*(?:final\s+)?([A-Za-z_][\w.<>\[\],\s]*?)\s+([A-Za-z_]\w*)\s*$/.exec(part);
        if (pm) add(m[1], pm[2], pm[1].trim());
      }
    }
  }

  // Go：type X struct { F T `json:"f"` }
  if (/^go$|golang/.test(lang)) {
    const re = /\btype\s+([A-Za-z_]\w*)\s+struct\s*\{([\s\S]*?)\n\}/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const lineRe = /^\s*([A-Za-z_]\w*)\s+([\w\[\]\*\.]+)/gm;
      let lm;
      while ((lm = lineRe.exec(m[2])) !== null) add(m[1], lm[1], lm[2].trim());
    }
  }

  // SQL：CREATE TABLE x ( f TYPE, ... )，跳过约束行
  if (/sql/.test(lang)) {
    const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)["`]?\s*\(([\s\S]*?)\)\s*;/gi;
    let m;
    while ((m = re.exec(src)) !== null) {
      for (const part of m[2].split(',')) {
        const pm = /^\s*["`]?(\w+)["`]?\s+([A-Za-z_]\w*(?:\s*\([^)]*\))?)/.exec(part);
        if (!pm) continue;
        if (/^(primary|foreign|unique|constraint|key|check|index)$/i.test(pm[1])) continue;
        add(m[1], pm[1], pm[2].trim());
      }
    }
  }

  return [...out.values()].map((d) => ({
    name: d.name,
    fields: [...d.fields.values()]
  }));
}

/**
 * 从契约字段的 desc 里提取枚举值（"取值: a/b/c"、"枚举: x,y"）。
 * 提取不到返回 null —— 调用方据此跳过枚举检查，不猜。
 */
export function enumValuesOf(desc) {
  const m = /(?:取值|枚举|enum|values?)\s*[:：]\s*([^\n,，;；]+)/i.exec(String(desc || ''));
  if (!m) return null;
  const vals = m[1]
    .split(/[\/、,，;；|\s]+/)
    .map((s) => s.trim().replace(/^['"`]|['"`]$/g, ''))
    .filter(Boolean);
  return vals.length >= 2 ? vals : null;
}
/**
 * 契约 / 前端 / 后端三方比对。
 *
 * @param {object} p
 * @param {object} p.contract  契约对象 { apis, common_dto }
 * @param {Array}  p.frontend  前端接口提取结果
 * @param {Array}  p.backend   后端接口提取结果
 * @param {Array}  [p.frontendDtos] 前端 DTO 提取结果（extractDtos）
 * @param {Array}  [p.backendDtos]  后端 DTO 提取结果
 */
export function checkConsistency({ contract, frontend = [], backend = [], frontendDtos = [], backendDtos = [] }) {
  const cApis = Array.isArray(contract && contract.apis) ? contract.apis : [];
  const norm = (arr, defaultMethod) =>
    (Array.isArray(arr) ? arr : []).map((a) => ({
      path: normalizePath(a.path),
      method: normMethod(a.method || defaultMethod || 'GET'),
    })).filter((a) => a.path);

  const C = norm(cApis, 'GET');
  const F = norm(frontend, 'GET');
  const B = norm(backend, 'GET');

  const key = (a) => a.method + ' ' + a.path;
  const pathKey = (a) => a.path;

  const cMap = new Map(C.map((a) => [key(a), a]));
  const cByPath = new Map();
  C.forEach((a) => {
    const arr = cByPath.get(pathKey(a)) || [];
    arr.push(a.method);
    cByPath.set(pathKey(a), arr);
  });
  const fByPath = new Map();
  F.forEach((a) => {
    const arr = fByPath.get(pathKey(a)) || [];
    arr.push(a.method);
    fByPath.set(pathKey(a), arr);
  });
  const bByPath = new Map();
  B.forEach((a) => {
    const arr = bByPath.get(pathKey(a)) || [];
    arr.push(a.method);
    bByPath.set(pathKey(a), arr);
  });

  const issues = [];
  const push = (severity, type, position, path, message) =>
    issues.push({ severity, type, position, path, message });

  /**
   * 路径后缀容错：把「相对路径」视为完整路径的可能实现。
   * 例：路由文件里的 /tasks/:id 与契约的 /api/tasks/{param} 后缀一致 → 认为已实现，
   *     只是前缀由挂载点（app.use / baseURL）在运行时补全，不再判成严重不一致。
   */
  const isPathSuffix = (full, rel) => {
    if (!full || !rel) return false;
    if (full === rel) return true;
    const f = full.split('/').filter(Boolean);
    const r = rel.split('/').filter(Boolean);
    if (!r.length || r.length > f.length) return false;
    for (let i = 0; i < r.length; i++) {
      if (f[f.length - r.length + i] !== r[i]) return false;
    }
    return true;
  };

  /**
   * 「保序子序列」匹配：/api/{param} 的段按顺序出现在 /api/tasks/{param} 里。
   * 用于兜住「两级前缀」——全局 /api 在 app.js、模块 /tasks 在别处，
   * 校验器只拿到 /api/{param}，此时不判严重不一致，而是降级提示人工确认。
   */
  const isSubsequence = (sub, full) => {
    const s = sub.split('/').filter(Boolean);
    const f = full.split('/').filter(Boolean);
    if (!s.length || s.length > f.length) return false;
    let i = 0;
    for (const seg of f) {
      if (seg === s[i]) i++;
      if (i === s.length) return true;
    }
    return false;
  };

  /**
   * 找候选：exact（严格相等）> suffix（后缀一致，前缀由挂载点补全）> weak（分段疑似缺失）。
   * weak 只用于「降级为提示」，绝不用来判定一致，避免掩盖真实问题。
   */
  const findCandidates = (path, map) => {
    if (map.has(path)) return { keys: [path], level: 'exact' };
    const suffix = [];
    const weak = [];
    for (const k of map.keys()) {
      if (isPathSuffix(k, path) || isPathSuffix(path, k)) suffix.push(k);
      else if (isSubsequence(path, k) || isSubsequence(k, path)) weak.push(k);
    }
    if (suffix.length) return { keys: suffix, level: 'suffix' };
    if (weak.length) return { keys: weak, level: 'weak' };
    return { keys: [], level: 'none' };
  };

  const methodsOf = (map, keys) => keys.reduce((acc, k) => acc.concat(map.get(k) || []), []);

  // 1) 契约有、后端未实现 —— 前端调了会 404
  for (const a of C) {
    const { keys, level } = findCandidates(a.path, bByPath);
    if (level === 'none') {
      push('high', 'missing_backend', 'backend', a.path,
        `契约定义了 ${a.method} ${a.path}，后端未找到对应实现`);
      continue;
    }
    const methods = methodsOf(bByPath, keys);
    if (keys.length > 1) {
      push('medium', 'ambiguous_backend', 'backend', a.path,
        `后端有多个接口（${keys.join('、')}）可能是 ${a.path} 的实现，请确认挂载前缀`);
      continue;
    }
    if (!methods.includes(a.method)) {
      push(level === 'exact' ? 'high' : 'medium', 'method_mismatch', 'backend', a.path,
        `契约方法为 ${a.method}，后端实现为 ${methods.join('/')}`);
      continue;
    }
    if (level === 'suffix') {
      push('low', 'prefix_inferred_backend', 'backend', a.path,
        `后端以相对路径 ${keys[0]} 实现，推测完整路径为 ${a.path}（前缀由挂载点补全），请确认一致`);
    } else if (level === 'weak') {
      push('medium', 'prefix_inferred_backend', 'backend', a.path,
        `后端路径 ${keys[0]} 疑似缺少分段（契约为 ${a.path}），请确认挂载前缀是否拼齐`);
    }
  }

  // 2) 契约有、前端未调用 —— 可能是尚未生成到，提示级
  for (const a of C) {
    const { keys, level } = findCandidates(a.path, fByPath);
    if (level === 'none') {
      push('low', 'missing_frontend', 'frontend', a.path,
        `契约定义了 ${a.method} ${a.path}，前端未找到调用（可能尚未生成到该模块）`);
      continue;
    }
    const methods = methodsOf(fByPath, keys);
    if (keys.length > 1) {
      push('low', 'ambiguous_frontend', 'frontend', a.path,
        `前端有多个调用（${keys.join('、')}）可能对应 ${a.path}，请确认请求基址`);
      continue;
    }
    if (!methods.includes(a.method)) {
      push('medium', 'method_mismatch', 'frontend', a.path,
        `契约方法为 ${a.method}，前端调用为 ${methods.join('/')}`);
      continue;
    }
    if (level === 'suffix') {
      push('low', 'prefix_inferred_frontend', 'frontend', a.path,
        `前端以相对路径 ${keys[0]} 调用，运行时与 baseURL 拼接后应为 ${a.path}`);
    } else if (level === 'weak') {
      push('low', 'prefix_inferred_frontend', 'frontend', a.path,
        `前端调用 ${keys[0]} 疑似缺少分段（契约为 ${a.path}），请确认请求基址`);
    }
  }

  // 3) 后端实现了契约外的接口 —— 私增接口
  for (const a of B) {
    const { keys, level } = findCandidates(a.path, cByPath);
    if (level === 'none') {
      push('medium', 'unknown_backend', 'backend', a.path,
        `后端实现了契约外的接口 ${a.method} ${a.path}`);
      continue;
    }
    if (keys.length > 1 || level === 'weak') {
      push('low', 'ambiguous_backend', 'backend', a.path,
        `后端接口 ${a.path} 可能对应契约中的 ${keys.join('、')}，请确认前缀`);
    }
  }

  // 4) 前端调用了契约外的接口 —— 会打到一个不存在的地址
  for (const a of F) {
    const { keys, level } = findCandidates(a.path, cByPath);
    if (level === 'none') {
      push('high', 'unknown_frontend', 'frontend', a.path,
        `前端调用了契约外的接口 ${a.method} ${a.path}`);
      continue;
    }
    if (keys.length > 1 || level === 'weak') {
      push('medium', 'ambiguous_frontend', 'frontend', a.path,
        `前端调用 ${a.path} 可能对应契约中的 ${keys.join('、')}，请确认请求基址`);
    }
  }

  // 5) 前端调了、后端没实现（不经过契约的直接比对，兜住契约漏定义的场景）
  for (const a of F) {
    const { keys, level } = findCandidates(a.path, bByPath);
    if (level === 'none') {
      push('high', 'frontend_no_backend', 'backend', a.path,
        `前端调用了 ${a.method} ${a.path}，但后端没有对应实现`);
      continue;
    }
    if (keys.length > 1 || level === 'weak') {
      push('medium', 'ambiguous_pair', 'backend', a.path,
        `前端调用 ${a.path} 在后端有多个可能实现（${keys.join('、')}），请确认挂载前缀`);
    }
  }

  // 6) 列表接口未分页（契约层面的设计建议，提示级）
  //
  // 为什么是 low 而不是 high/medium：
  //   只有 high 会触发前端的自动修复回路，而「补分页参数」需要改契约本身并
  //   重新生成两端，靠定向修复某一端根本修不好——判成 high 只会让修复回路
  //   空转几轮、白烧 token。提示级足够：报告表格里会列出来，用户能看到。
  //
  // 判据全部来自契约自身（平台拿不到运行时的查询量，只能做静态推导）：
  //   - GET 且响应类型标注为集合（Xxx[] / List<Xxx> / desc 含"列表、数组"）
  //   - request.query 里没有 page / pageSize 一类的分页参数
  // 有界集合（枚举项、固定配置）由契约在 summary 里说明理由后豁免。
  for (const a of cApis) {
    if (normMethod(a.method) !== 'GET') continue;
    if (!isCollectionResponse(a)) continue;
    if (hasPaginationParam(a)) continue;
    const note = String(a.summary || '') + String((a.response || {}).desc || '');
    if (/有界|全量返回|枚举|固定|配置项|不超过/.test(note)) continue;
    push('low', 'unpaginated_list', 'contract', normalizePath(a.path),
      `列表接口 ${a.method} ${a.path} 未声明分页参数：建议在 request.query 增加 page 与 pageSize，`
      + '避免数据量增长后变成全表查询（如确有界请在 summary 中说明理由）');
  }

  // ---------- DTO 维度：字段名 / 类型 / 契约外字段 / 枚举越界 ----------
  // 这是 2026-10-16 补的第二层校验。第一层（上面的接口维度）只保证"路径和方法对得上"，
  // 保证不了"字段类型没被偷偷改掉"——而后者才是联调炸雷的直接原因
  // （契约 ID 是 string(UUID)，代码改成 number；契约没定义的枚举值被擅自传入）。
  const cDtos = Array.isArray(contract.common_dto) ? contract.common_dto : [];

  /**
   * 在某一端提取结果里找契约 DTO 的实现（大小写不敏感）。
   * 同时容忍常见的命名变体：UserDto ↔ UserDTO ↔ User 已在 sameName 内统一大小写，
   * 再额外容忍 "XxxDto/XxxDTO/XxxEntity" 与契约名 "Xxx" 的互配。
   */
  const findImpl = (dtos, name) => {
    const base = String(name || '').toLowerCase();
    return (dtos || []).find((d) => {
      const n = String(d.name || '').toLowerCase();
      return n === base
        || n === base + 'dto' || n === base + 'entity' || n === base + 'model'
        || n.replace(/(dto|entity|model)$/, '') === base;
    }) || null;
  };

  /** 在实现的字段表里按名字取（大小写不敏感），取不到返回 undefined */
  const pickField = (fields, name) => {
    const f = (fields || []).find((x) => sameName(x.name, name));
    return f ? f : undefined;
  };

  const checkSideDtos = (dtos, side) => {
    const label = side === 'frontend' ? '前端' : '后端';
    for (const cd of cDtos) {
      const impl = findImpl(dtos, cd.name);
      // 契约 DTO 在该侧找不到：不判 high——它可能本就是另一侧的概念（如纯后端实体），
      // 判成 high 会让自动修复回路空转。提示级即可。
      if (!impl) {
        push('medium', 'dto_missing', side, cd.name,
          `契约 DTO ${cd.name} 在${label}代码中未找到对应定义（该侧可能不使用，需人工确认）`);
        continue;
      }
      for (const f of cd.fields || []) {
        const got = pickField(impl.fields, f.name);
        if (!got) {
          const optional = /可选|optional|非必填|nullable|选填/i.test(String(f.desc || ''));
          push(optional ? 'low' : 'high', 'dto_field_missing', side, `${cd.name}.${f.name}`,
            optional
              ? `可选字段 ${cd.name}.${f.name} 未实现（契约类型 ${f.type}）`
              : `必填字段 ${cd.name}.${f.name} 缺失：契约要求 ${f.type}，${label}代码里没有这个字段`);
          continue;
        }
        // 类型比对：归一化后不同才算不一致（string(UUID) vs number 在这一步现形）
        const want = normFieldType(f.type);
        const have = normFieldType(got.type);
        if (want && have && want !== have) {
          push('high', 'dto_type_mismatch', side, `${cd.name}.${f.name}`,
            `字段类型与契约不一致：契约 ${cd.name}.${f.name} 为 ${f.type}（${want}），`
            + `${label}代码实现为 ${got.type}（have=${have}）——按语言或数据库习惯替换类型会直接导致联调失败`);
        }
      }
      // 契约外字段：代码里有、契约没定义（擅自加字段同样破坏联调）
      for (const gf of impl.fields || []) {
        const inContract = (cd.fields || []).some((f) => sameName(f.name, gf.name));
        if (!inContract) {
          push('medium', 'dto_field_extra', side, `${cd.name}.${gf.name}`,
            `${label}代码给 ${cd.name} 增加了契约外字段 ${gf.name}: ${gf.type}——契约未定义，需人工确认`);
        }
      }
    }
  };
  checkSideDtos(frontendDtos, 'frontend');
  checkSideDtos(backendDtos, 'backend');

  // ---------- 枚举越界检查不在这里做 ----------
  // 它需要源码里的「字段字面量赋值」（status: 'done'），而 checkConsistency 只收到
  // 提取结果、拿不到 code；把整份代码再传给后端又是浪费。改在前端做：
  // quality-text.mjs 的 findEnumViolations(contract, blocks)，纯函数、可单测、
  // 零网络开销，结果由前端合并成同构 issue 进一致性报告。

  const count = (s) => issues.filter((i) => i.severity === s).length;
  return {
    ok: issues.filter((i) => i.severity === 'high').length === 0,
    summary: {
      contract: C.length,
      frontend: F.length,
      backend: B.length,
      high: count('high'),
      medium: count('medium'),
      low: count('low'),
    },
    issues,
  };
}
