# 前端：nginx 静态托管 + 反向代理 /api 到后端（智能代码生成平台）
# 仓库只提交了 vendor/jszip.min.js，其余第三方库在构建时拉取（与 deploy/setup.sh 一致）。
FROM nginx:1.27-alpine

# alpine 默认无 curl
RUN apk add --no-cache curl

# 复制前端静态资源
COPY . /usr/share/nginx/html

# 补齐前端第三方库（marked / DOMPurify / highlight.js + 语言包 + 主题）
# jszip.min.js 已在仓库内，无需下载。
WORKDIR /usr/share/nginx/html/vendor
RUN JSDELIVR=https://cdn.jsdelivr.net/npm \
 && UNPKG=https://unpkg.com \
 && HLS="$JSDELIVR/@highlightjs/cdn-assets@11.9.0" \
 && fetch() { \
      if ! curl -fsSL --max-time 30 -o "$1" "$2"; then \
        echo "  主源失败，改用备用源: $3"; \
        curl -fsSL --max-time 30 -o "$1" "$3"; \
      fi; \
    } \
 && fetch marked.min.js         "$JSDELIVR/marked@12.0.0/marked.min.js"          "$UNPKG/marked@12.0.0/marked.min.js" \
 && fetch purify.min.js         "$JSDELIVR/dompurify@3.0.8/dist/purify.min.js"   "$UNPKG/dompurify@3.0.8/dist/purify.min.js" \
 && mkdir -p highlight/languages \
 && fetch highlight/highlight.min.js      "$HLS/highlight.min.js"             "$HLS/highlight.min.js" \
 && fetch highlight/atom-one-dark.min.css "$HLS/styles/atom-one-dark.min.css" "$HLS/styles/atom-one-dark.min.css" \
 && for l in javascript typescript python java cpp go rust css xml json bash; do \
      fetch "highlight/languages/$l.min.js" "$HLS/languages/$l.min.js" "$HLS/languages/$l.min.js"; \
    done \
 && echo "vendor 补齐完成：" && ls -R /usr/share/nginx/html/vendor

# 用自定义 nginx 配置（静态 + /api 反代）
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
