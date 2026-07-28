# FileCodeBox-CF

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?repository=https://github.com/zlanly/filecodebox-cf)

**FileCodeBox 的 Cloudflare 移植版**，文件存储后端直接复用已部署的 [CloudFlare-ImgBed](https://github.com/MarSeventh/CloudFlare-ImgBed) —— 通过它的 HTTP API 委托上传 / 取件 / 清理，而非自己绑定 R2/D1。

- 后端：**零依赖 Cloudflare Worker**（纯 Web 标准 API，自研轻量路由，无需 `npm install` 即可部署）
- 存储：**委托 CloudFlare-ImgBed 的 `/upload` API**。ImgBed 本就跑在 Cloudflare 上，原生支持大文件 / 分片上传 / R2 存储与图床后台，文件自然出现在 ImgBed 图床里
- 元数据：分享记录（取件码 / 过期 / 取件次数 / 密码）存于 FileCodeBox 自有 D1（`fcb_db`）
- 前端：温暖清新风格的单页应用（SPlayer 风），原生 JS，无构建步骤

> 设计要点：FileCodeBox 只做「取件码层」。文件二进制**不**经由本 Worker 落盘，而是流式代理给 ImgBed 的 `/upload`（不缓冲，大文件直穿），取件时返回带 HMAC 防直链 token 的 `/file/:key` 直链，由 Worker 302 跳转到 ImgBed 原地址。因此本项目**不再需要直接绑定** ImgBed 的 R2 / D1。

---

## 架构

```
┌──────────────────────────────────────────────────────────────┐
│                  Cloudflare Worker（取件码薄层）                │
│                                                                │
│  寄件 POST /api/share ──┐                                      │
│  取件 GET/POST /api/share/:code ─┐                             │
│  上传 POST /api/imgbed/upload ──┐ 流式代理 ──► ImgBed /upload  │
│  文件 GET /file/:key  ◄──── 校验 token 后 302 跳转到 ImgBed    │
│  管理 /api/admin/*                                               │
└───────────────┬────────────────────────────┬───────────────────┘
                │                            │
         ┌──────▼──────┐              ┌───────▼──────────────┐
         │  D1 fcb_db  │              │  CloudFlare-ImgBed    │
         │ 分享元数据   │              │  （R2 + 图床后台）      │
         └─────────────┘              │  文件二进制 / 大文件    │
                                      └────────────────────────┘
```

文件本体完全由 ImgBed 负责：上传走 `/upload`（原生支持大文件与分片），取件走 `/file/<key>`（由 ImgBed 处理 Range / 流式传输）。删除分享时本 Worker 可选同步调用 ImgBed 的 `/api/manage/delete/<id>` 清理对象。

---

## 快速部署

### 0. 前置
- 一个已部署（或将要部署）的 [CloudFlare-ImgBed](https://github.com/MarSeventh/CloudFlare-ImgBed) 实例，记下它的**访问地址**（如 `https://img.example.com`）。
- 安装 `wrangler`：`npm i -g wrangler` 并 `wrangler login`。

### 1. 创建 D1（仅分享元数据）
```bash
wrangler d1 create filecodebox
# 把输出的 database_id 填进 wrangler.toml 的 fcb_db
wrangler d1 migrations apply filecodebox --config wrangler.toml
```

### 2. 配置 wrangler.toml
- `fcb_db.database_id` → 上一步生成的 id
- `IMG_BED_URL` → ImgBed 实例地址（**核心：这就是「用 ImgBed 当存储」**）
- 可选：
  - `IMG_BED_UPLOAD_TOKEN` + `IMG_BED_UPLOAD_TOKEN_PARAM` → ImgBed 上传所需 token（参数名默认 `token`）
  - `IMG_BED_UPLOAD_CHANNEL` → 指定上传通道（如 `cfr2`）
  - `IMG_BED_ADMIN_TOKEN` → 删除分享时同步清理 ImgBed 对象所需的管理 token
- `ADMIN_KEY` → 管理后台密码（生产建议改用 `wrangler secret put ADMIN_KEY`）
- 本项目**不需要**绑定 ImgBed 的 `img_r2` / `img_d1`，只需配置 `IMG_BED_URL` 即可

### 3. 部署
```bash
wrangler deploy --config wrangler.toml
```

### 4.（可选）本地开发
```bash
cp .dev.vars.example .dev.vars   # 填入本地环境变量（见下）
wrangler dev --config wrangler.toml
```
`.dev.vars` 示例：
```
ADMIN_KEY=local-key
FILE_SECRET=local-file-secret
IMG_BED_URL=https://imgbed.test
```

---

## 功能对照（与原版 FileCodeBox）

| 能力 | 原版 FileCodeBox | 本移植版 |
|------|------------------|----------|
| 文本分享 | ✅ | ✅ |
| 文件分享 | ✅ | ✅（委托 ImgBed `/upload`） |
| 取件码 | 服务端生成 | 服务端生成（形如 `A1B2-C3D4`） |
| 过期时间 | 时/分/天 | 1h / 1d / 7d / 30d / 永久 |
| 取件次数 | 次数上限 | 1 / 10 / 100 / 不限 |
| 访问密码 | 部分版本 | ✅（SHA-256 存储） |
| 防直链 | download key | HMAC 签名的 `/file/:key?t=` |
| 管理后台 | ✅ | ✅ 统计 / 列表 / 删除 / 清理 |
| 大文件 | 需客户端分片 | ✅（委托 ImgBed，**原生支持大文件 / 分片，无大小限制**） |

---

## API 速查

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/share` | 创建分享。`multipart`：`type=text\|file`、`text`、`file_key`+`file_name`+`file_type`+`file_size`（文件先经 `/api/imgbed/upload` 上传）、`expire_ms`、`download_limit`、`password` |
| `POST` | `/api/imgbed/upload` | 把文件流式代理到 ImgBed 的 `/upload`，返回 `{ id, src }`（`id` 即 ImgBed 文件 key） |
| `GET` | `/api/share/:code` | 分享元信息（不消耗） |
| `POST` | `/api/share/:code/claim` | 取件（消耗一次）。文本直接返回；文件返回 `/file/:key?t=TOKEN` |
| `GET` | `/file/:key?t=TOKEN` | 校验防直链 token 后 302 跳转到 ImgBed 原地址（Range / 大文件由 ImgBed 负责） |
| `POST` | `/api/admin/login` | 登录，返回 `token` |
| `GET` | `/api/admin/stats` | 统计（需 `Authorization: Bearer <token>`） |
| `GET` | `/api/admin/shares` | 分享列表 |
| `DELETE` | `/api/admin/share/:code` | 删除分享（可选同步清理 ImgBed 对象） |
| `POST` | `/api/admin/sweep` | 清理过期 / 超额分享 |
| `GET` | `/api/config`、`/api/health` | 公共配置 / 健康检查 |

---

## 说明与边界

- **存储即 ImgBed**：文件二进制只存在于 ImgBed 的 R2，并通过 ImgBed 的 `/upload` 接口写入，因此这些文件也能被 ImgBed 自身的 `/file/<key>` 路由直接访问与管理。删除分享会（在配置了 `IMG_BED_ADMIN_TOKEN` 时）同步删除 ImgBed 侧对象。
- **大文件 / 分片**：文件上传由本 Worker 把请求体**流式转发**给 ImgBed 的 `/upload`，由 ImgBed 完成存储，完全不受 Worker 请求体大小限制；分片上传同样由 ImgBed 处理。
- **Cron 清理**：Worker 的 `scheduled` 触发器每天 04:00 清理失效分享，并在配置了管理 token 时回收 ImgBed 对象，也可在后台手动「清理过期」。
- **无需 R2 CORS**：浏览器不再跨域直传 R2（那套预签名方案已移除），因此也无需在 R2 桶配置 CORS。跨域访问统一经本 Worker 的 302 跳转完成。
- **安全**：密码以 SHA-256 存储；文件直链带 HMAC 防直链 token；后台接口需 Bearer token。生产环境请通过 `wrangler secret put` 设置 `ADMIN_KEY` / `FILE_SECRET` / `IMG_BED_URL` 等，**不要**把密钥写进 `wrangler.toml` 提交到仓库。
