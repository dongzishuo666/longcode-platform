/**
 * 上游接口地址（apiBase）校验 + SSRF 防护。
 *
 * 为什么必须做：
 *   放开「用户自选模型」后，apiBase 从「部署者在 .env 里配一次」变成了
 *   「每个用户每次请求都能带」。后端是拿着这个地址去 fetch 的 —— 如果不校验，
 *   任何人都能让这台服务器去访问 http://169.254.169.254（云厂商元数据，可能
 *   直接拿临时凭证）、http://10.0.0.x（内网服务）或 http://127.0.0.1（本机
 *   未授权端口）。这是教科书级的 SSRF，且比单纯"打内网"更危险：
 *   请求体里还带着用户的 API Key，会被一并送到攻击者指定的地址。
 *
 * 策略（默认安全，需要时才开）：
 *   1. 只接受 http / https。
 *   2. 域名解析后取 IP，命中私有 / 回环 / 链路本地 / 保留段 → 拦截。
 *      （含 DNS 指向内网的情况，不只是字面 IP）
 *   3. 例外：设 ALLOW_LOCAL_TARGETS=1 才允许访问本地服务（典型场景：
 *      本机跑 Ollama，代理也在同一台机器上）。这是单人自托管的合理用法，
 *      但多用户实例下【不该开】—— 开了等于任何人都能探测宿主机端口。
 *   4. 公网地址一律要求 https：明文 http 会把 API Key 与代码明文外泄。
 *
 * 已知残留风险（记录在此，不掩饰）：
 *   DNS rebinding —— 解析时是公网 IP、真正连接时指向内网。彻底解决要在
 *   连接层做 IP 固定（pin），超出本代理的复杂度预算。单机自托管场景下
 *   风险可接受；若你把本服务暴露给不可信用户，建议只开预设供应商、不给自定义。
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { AppError, ErrorCodes } from './errors.js';

/**
 * 是否允许把请求发往本机 / 内网（默认否）。
 * 典型用途：本机 Ollama（http://localhost:11434/v1）。
 */
const ALLOW_LOCAL_TARGETS = process.env.ALLOW_LOCAL_TARGETS === '1';

/** 服务端默认上游地址（部署者配，可信；请求不传 apiBase 时回落到这里） */
export function defaultApiBase() {
  return (process.env.DEEPSEEK_API_BASE || 'https://api.deepseek.com').replace(
    /\/+$/,
    ''
  );
}

// ---------- IPv4 私有 / 保留段判定 ----------

/** 点分十进制 → 无符号 32 位整数（用乘法避免 JS 位运算的 int32 截断） */
function v4ToInt(ip) {
  const parts = String(ip).split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v < 0 || v > 255) return null;
    n = n * 256 + v;
  }
  return n >>> 0;
}

/**
 * 分两档，而不是一张表 —— 这是踩过一次才改对的：
 * 最初是「私有段一律拦，ALLOW_LOCAL_TARGETS=1 就一律放行」，结果开了本机模式后
 * 连 169.254.169.254（云厂商元数据，SSRF 的头号目标）也放行了。
 * 本机模式只想放行「我自己机器上跑的 Ollama」，不等于放行云元数据。
 */
function toCidrs(list) {
  return list.map(([base, bits]) => ({
    net: v4ToInt(base),
    mask: bits === 0 ? 0 : ((0xffffffff << (32 - bits)) >>> 0),
  }));
}

/** 【任何情况都不放行】链路本地（云元数据）/ 未指定 / CGNAT / 文档段 / 组播 / 保留 */
const V4_ALWAYS_BLOCK = toCidrs([
  ['0.0.0.0', 8], //           "this network"
  ['100.64.0.0', 10], //       CGNAT（运营商共享段，不是你的内网）
  ['169.254.0.0', 16], //      链路本地 —— 含云元数据 169.254.169.254
  ['192.0.0.0', 24], //        IETF 协议保留
  ['192.0.2.0', 24], //        TEST-NET-1
  ['198.18.0.0', 15], //       基准测试
  ['198.51.100.0', 24], //     TEST-NET-2
  ['203.0.113.0', 24], //      TEST-NET-3
  ['224.0.0.0', 4], //         组播
  ['240.0.0.0', 4], //         保留（含 255.255.255.255）
]);

/** 【开了 ALLOW_LOCAL_TARGETS 才放行】回环与 RFC1918 私有网段（本机 / 局域网服务） */
const V4_LOCAL_ONLY = toCidrs([
  ['10.0.0.0', 8],
  ['127.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
]);

function matchV4(int, cidrs) {
  for (const { net, mask } of cidrs) {
    if (((int & mask) >>> 0) === ((net & mask) >>> 0)) return true;
  }
  return false;
}

function isV4AlwaysBlocked(int) {
  return matchV4(int, V4_ALWAYS_BLOCK);
}
function isV4LocalOnly(int) {
  return matchV4(int, V4_LOCAL_ONLY);
}

// ---------- IPv6 ----------

function v6Norm(ip) {
  return String(ip).toLowerCase().split('%')[0]; // 去掉 zone id（fe80::1%eth0）
}

function isV6AlwaysBlocked(ip) {
  const s = v6Norm(ip);
  if (s === '::') return true; //        未指定
  if (s.startsWith('fe80')) return true; // 链路本地 fe80::/10
  return false;
}

function isV6LocalOnly(ip) {
  const s = v6Norm(ip);
  if (s === '::1') return true; //       回环
  if (/^f[cd]/.test(s)) return true; //  唯一本地地址 fc00::/7
  // IPv4-mapped（::ffff:192.168.1.1）：剥出来按 v4 的两档规则判
  const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) {
    const int = v4ToInt(mapped[1]);
    if (int === null) return true; // 解析不出就当本地，宁可拦
    return isV4AlwaysBlocked(int) || isV4LocalOnly(int);
  }
  return false;
}

/** 该 IP 是否【任何情况都不放行】 */
export function isAlwaysBlockedAddress(ip) {
  const v = isIP(ip);
  if (v === 4) {
    const int = v4ToInt(ip);
    return int === null ? true : isV4AlwaysBlocked(int);
  }
  if (v === 6) return isV6AlwaysBlocked(ip);
  return false;
}

/** 该 IP 是否属于「本机 / 局域网」（仅 ALLOW_LOCAL_TARGETS=1 时放行） */
export function isLocalOnlyAddress(ip) {
  const v = isIP(ip);
  if (v === 4) {
    const int = v4ToInt(ip);
    return int === null ? true : isV4LocalOnly(int);
  }
  if (v === 6) return isV6LocalOnly(ip);
  return false;
}

/**
 * 是否「非普通公网地址」（上面两档的并集）。
 * 供外部判断"这个地址是不是内网/本机/保留"用。
 */
export function isPrivateAddress(ip) {
  return isAlwaysBlockedAddress(ip) || isLocalOnlyAddress(ip);
}

function isLoopbackName(host) {
  return host === 'localhost' || host.endsWith('.localhost');
}

/**
 * 校验并归一化上游接口地址。
 *
 * @param {unknown} raw 请求体里的 apiBase（可空 → 回落服务端默认）
 * @returns {Promise<string>} 归一化后的 base（已去掉结尾斜杠）
 * @throws {AppError} INVALID_REQUEST —— URL 非法 / 协议不允许 / 命中 SSRF 规则
 */
export async function assertApiBase(raw) {
  const s = String(raw == null ? '' : raw).trim();

  // 未提供 → 用部署者配的默认地址（可信来源，不做 SSRF 检查）
  if (!s) return defaultApiBase();

  let u;
  try {
    u = new URL(s);
  } catch {
    throw new AppError(ErrorCodes.INVALID_REQUEST, '接口地址不是合法 URL');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new AppError(
      ErrorCodes.INVALID_REQUEST,
      '接口地址只支持 http / https'
    );
  }

  // URL.hostname 对 IPv6 带方括号，剥掉统一处理
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) {
    throw new AppError(ErrorCodes.INVALID_REQUEST, '接口地址缺少主机名');
  }

  let ip = host;
  if (!isIP(host)) {
    if (isLoopbackName(host)) {
      ip = '127.0.0.1'; // localhost 系列统一按回环处理
    } else {
      try {
        const resolved = await lookup(host);
        ip = resolved.address;
      } catch {
        throw new AppError(
          ErrorCodes.INVALID_REQUEST,
          `接口地址的域名无法解析：${host}`
        );
      }
    }
  }

  // 第一档：链路本地 / 云元数据 / 保留段 —— 任何时候都不放行，
  // 哪怕开了 ALLOW_LOCAL_TARGETS（本机模式只想放行自己机器上的 Ollama，
  // 不等于放行 169.254.169.254 这种能直接换临时凭证的地址）。
  if (isAlwaysBlockedAddress(ip)) {
    throw new AppError(
      ErrorCodes.INVALID_REQUEST,
      '接口地址不允许指向链路本地 / 云元数据 / 保留地址（防 SSRF，该地址任何时候都不放行）'
    );
  }

  // 第二档：本机 / 局域网 —— 仅 ALLOW_LOCAL_TARGETS=1 时放行
  if (isLoopbackName(host) || isLocalOnlyAddress(ip)) {
    if (!ALLOW_LOCAL_TARGETS) {
      throw new AppError(
        ErrorCodes.INVALID_REQUEST,
        '接口地址不允许指向内网 / 本机（防 SSRF）。' +
          '如需连接本机 Ollama 等本地服务，请设置 ALLOW_LOCAL_TARGETS=1 后重启后端；' +
          '注意多用户实例不要开启该项。'
      );
    }
    return s.replace(/\/+$/, '');
  }

  // 公网地址：明文 http 会把 API Key 与代码裸奔在链路上
  if (u.protocol === 'http:') {
    throw new AppError(
      ErrorCodes.INVALID_REQUEST,
      '访问公网接口必须使用 https（明文 http 会泄露 API Key 与代码）'
    );
  }

  return s.replace(/\/+$/, '');
}
