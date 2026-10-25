#!/bin/bash
# 智能代码生成平台 —— 服务端部署脚本
# 用法：bash /tmp/setup.sh [域名]
set -e

DOMAIN="${1:-}"
NODE_HOME=/usr/local/lighthouse/softwares/nodejs/node
NODE_BIN=$NODE_HOME/bin/node
NPM_BIN=$NODE_HOME/bin/npm
export PATH="$NODE_HOME/bin:$PATH"

# 建立全局软链，避免 /usr/bin/env node 找不到解释器
ln -sf "$NODE_BIN" /usr/local/bin/node
ln -sf "$NPM_BIN" /usr/local/bin/npm
ln -sf "$NODE_HOME/bin/npx" /usr/local/bin/npx
APP_DIR=/opt/deepseek-proxy
WEB_DIR=/var/www/longcode
CONF_SRC=/tmp/deploy/longcode.conf
CONF_DST=/etc/nginx/conf.d/longcode.conf
SERVICE_SRC=/tmp/deploy/deepseek-proxy.service
SERVICE_DST=/etc/systemd/system/deepseek-proxy.service

echo "===== 1. 环境自检 ====="
"$NODE_BIN" -v
"$NPM_BIN" -v

echo "===== 2. 安装后端依赖 ====="
cd "$APP_DIR"
"$NPM_BIN" install --omit=dev --registry=https://registry.npmmirror.com --no-fund --no-audit
echo "已安装依赖："
ls node_modules | head -5
echo "依赖体积：$(du -sh node_modules | cut -f1)"

echo "===== 3. 下载前端第三方库（本地自托管，避免 CDN 不可达）====="
V="$WEB_DIR/vendor"
mkdir -p "$V/highlight/languages"
JSDELIVR=https://cdn.jsdelivr.net/npm
UNPKG=https://unpkg.com
# highlight.js 的 CDN 资源包（highlight.js 主包不含可直接引用的 min 构建）
HLS=$JSDELIVR/@highlightjs/cdn-assets@11.9.0
HLS_FALLBACK=$UNPKG/@highlightjs/cdn-assets@11.9.0

fetch() { # fetch <目标文件> <主 URL> <备用 URL>
  if ! curl -fsSL --max-time 20 -o "$1" "$2"; then
    echo "  主源失败，改用备用源: $3"
    curl -fsSL --max-time 20 -o "$1" "$3"
  fi
}

fetch "$V/marked.min.js"  "$JSDELIVR/marked@12.0.0/marked.min.js"        "$UNPKG/marked@12.0.0/marked.min.js"
fetch "$V/purify.min.js"  "$JSDELIVR/dompurify@3.0.8/dist/purify.min.js" "$UNPKG/dompurify@3.0.8/dist/purify.min.js"
# JSZip：ZIP 打包导出用。版本固定 3.10.1 —— 与 2026-10-10 手工放到线上 vendor 的那份一致，
# 不要顺手升到最新版，否则线上会出现两个不同版本（一个手工、一个脚本拉）。
# 它曾经不在这个列表里：线上那份是人工补的，按旧 setup.sh 重新部署就会缺文件，
# /vendor/jszip.min.js 404，ZIP 导出功能静默死亡（前端只提示"JSZip 未加载"不崩）。
fetch "$V/jszip.min.js"   "$JSDELIVR/jszip@3.10.1/dist/jszip.min.js"     "$UNPKG/jszip@3.10.1/dist/jszip.min.js"
fetch "$V/highlight/highlight.min.js"      "$HLS/highlight.min.js"            "$HLS_FALLBACK/highlight.min.js"
fetch "$V/highlight/atom-one-dark.min.css" "$HLS/styles/atom-one-dark.min.css" "$HLS_FALLBACK/styles/atom-one-dark.min.css"
for l in javascript typescript python java cpp go rust css xml json bash; do
  fetch "$V/highlight/languages/$l.min.js" "$HLS/languages/$l.min.js" "$HLS_FALLBACK/languages/$l.min.js"
done

# 部署自检：每个 vendor 文件都必须存在且体积正常。
# fetch 的兜底只覆盖"下载失败"，覆盖不了"历史上压根没拉这个文件"（jszip 就中过）。
# 缺任何一个都当场失败，不留"看起来部署成功、某个功能其实死了"的状态。
verify() { # verify <文件> <最小字节>
  [ -s "$1" ] || { echo "  !! 缺失或为空: $1"; exit 1; }
  local sz; sz=$(stat -c%s "$1")
  [ "$sz" -ge "$2" ] || { echo "  !! 体积异常(${sz}B < $2B): $1"; exit 1; }
  echo "  ok $(basename "$1") (${sz}B)"
}
echo "vendor 自检："
# 阈值按 2026-10-16 线上实测体积的约 1/3 取（留足余量又不误报）：
#   marked 35159 / purify 21074 / jszip 97630 / highlight 121727
#   atom-one-dark.min.css 856 / 语言包最小 json 496
# 曾经把 CSS 阈值拍成 2000、json 拍成 500，两个都误报 —— 自检阈值必须用实测值校准，
# 否则下次部署会有人以为"部署失败"，甚至索性跳过自检。
verify "$V/marked.min.js" 10000
verify "$V/purify.min.js" 6000
verify "$V/jszip.min.js" 30000
verify "$V/highlight/highlight.min.js" 40000
verify "$V/highlight/atom-one-dark.min.css" 300
for l in javascript typescript python java cpp go rust css xml json bash; do
  verify "$V/highlight/languages/$l.min.js" 200
done
echo "vendor 目录："
find "$V" -type f | sed "s|$WEB_DIR||"

echo "===== 4. 权限与 SELinux ====="
chmod -R a+rX "$WEB_DIR"
chown -R root:root "$WEB_DIR"
if command -v getenforce >/dev/null 2>&1 && [ "$(getenforce)" = "Enforcing" ]; then
  echo "SELinux Enforcing：配置上下文与网络连通"
  chcon -R -t httpd_sys_content_t "$WEB_DIR" 2>/dev/null || true
  setsebool -P httpd_can_network_connect 1 2>/dev/null || true
fi

echo "===== 5. 安装 systemd 服务 ====="
cp "$SERVICE_SRC" "$SERVICE_DST"
systemctl daemon-reload
systemctl enable deepseek-proxy
systemctl restart deepseek-proxy
sleep 2
systemctl is-active deepseek-proxy

echo "===== 6. 安装 Nginx 站点 ====="
if [ -n "$DOMAIN" ]; then
  sed "s/__DOMAIN__/$DOMAIN/g" "$CONF_SRC" > "$CONF_DST"
  echo "已写入 server_name: $DOMAIN"
else
  cp "$CONF_SRC" "$CONF_DST"
  echo "未指定域名，server_name 保持 __DOMAIN__ 占位，请稍后替换"
fi
nginx -t
systemctl reload nginx

echo "===== 7. 部署验证 ====="
echo "--- 后端 health ---"
curl -s --max-time 5 http://127.0.0.1:8787/api/health || echo "health 失败"
echo
echo "--- 静态首页 ---"
curl -s -o /dev/null -w "index.html -> HTTP %{http_code}\n" --max-time 5 http://127.0.0.1/ --resolve "$DOMAIN:80:127.0.0.1" 2>/dev/null || true
echo "--- 服务监听 ---"
ss -lntp | grep -E ':8787|:80' || true

echo "===== 部署完成 ====="
