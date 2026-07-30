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

## 快速部署（全程网页面板，无需改代码 / 无需 CLI）

> 整个流程只在 Cloudflare 控制台点几下即可，仓库里的 `wrangler.toml` **不写任何密钥或占位符**，部署后直接到面板绑定。

### 第 0 步：准备 ImgBed 地址
- 准备一个已部署的 [CloudFlare-ImgBed](https://github.com/MarSeventh/CloudFlare-ImgBed) 实例，记下它的**访问地址**（如 `https://img.example.com`）。本项目所有文件都存到它那里。

### 第 1 步：一键部署（自动 Fork + 部署）
- 点击仓库顶部的 **Deploy to Cloudflare Workers** 按钮（或直接打开 `https://deploy.workers.cloudflare.com/?repository=https://github.com/zlanly/filecodebox-cf`）。
- 按提示登录 Cloudflare、授权 GitHub、为 Fork 命名，然后点 **Deploy**。
- 等待构建完成，页面会提示 `Your Worker is available at https://filecodebox-cf.<你的子域>.workers.dev`，并自动跳到该 Worker 的控制台页面。

### 第 2 步：绑定 D1 数据库（存分享元数据）
- 在 Worker 控制台进入 **Settings → Bindings → Add → D1 Database**。
- **Variable name** 填 `fcb_db`；**Database** 选 **Create new**，名称填 `filecodebox`，点 Create。
- 进入刚创建的 D1 数据库控制台（左侧 **Workers & Pages → D1 → filecodebox → Console**），把仓库里 `migrations/0001_init.sql` 的全部内容粘贴进去执行，完成建表。
  - 也可在本地用 CLI 执行：`wrangler d1 migrations apply filecodebox --config wrangler.toml`（任选其一）。

### 第 3 步：设置变量与密钥
- 回到 Worker 控制台 → **Settings → Variables and Secrets → Add**。
- **必填：**
  - `IMG_BED_URL`：ImgBed 实例地址，如 `https://img.example.com`（核心，决定文件存到哪）
  - `ADMIN_KEY`：管理后台密码（建议选 **Secret** 类型）
- **可选：**
  - `IMG_BED_UPLOAD_TOKEN` / `IMG_BED_UPLOAD_TOKEN_PARAM`：ImgBed 上传所需 token（参数名默认 `token`）
  - `IMG_BED_UPLOAD_CHANNEL`：上传通道（如 `cfr2`）
  - `IMG_BED_ADMIN_TOKEN`：删除分享时同步清理 ImgBed 对象所需的管理 token
  - `APP_NAME` / `APP_SUBTITLE`：界面展示文案（不填则用内置默认值）
- 改完变量后，Cloudflare 会提示重新部署，点 **Deploy** 让配置生效。

### 第 4 步：完成
- 访问你的 Worker 地址即可使用。寄件 / 取件 / 管理均在前端页面完成，**全程无需再碰 `wrangler.toml`**。

### （可选）本地开发
- 仅本地调试用，不影响线上部署：
  ```bash
  cp .dev.vars.example .dev.vars   # 填入本地环境变量
  wrangler dev --config wrangler.toml
  ```
  `.dev.vars.example` 示例：
  ```
  ADMIN_KEY=your-local-admin-key
  FILE_SECRET=your-local-file-secret
  APP_NAME=文件快递柜
  IMG_BED_URL=https://imgbed.test   # 本地调试时改用你的 ImgBed 地址
  ```
  > 注意：Git 仓库里不会提交真实密钥，`wrangler.toml` 也不含任何占位符，所有配置都在面板填写，避免误泄露。

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
- **安全**：密码以 SHA-256 存储；文件直链带 HMAC 防直链 token；后台接口需 Bearer token。所有密钥均通过 Cloudflare 控制台的 Variables and Secrets 设置（建议 `ADMIN_KEY` 用 Secret 类型），**不**写进 `wrangler.toml` 或提交到仓库。
