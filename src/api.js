// FileCodeBox-CF · API 处理函数
import * as db from './db.js';
import * as storage from './storage.js';
import {
  genCode,
  sha256,
  verifyAdmin,
  expectedAdminToken,
  fileToken,
} from './auth.js';
import { EXPIRE_PRESETS, DOWNLOAD_PRESETS, appName, appSubtitle } from './config.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function clientIp(request) {
  const fwd = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For');
  return fwd ? fwd.split(',')[0].trim() : 'unknown';
}

// 过期判定：永久 = expire_at 为 null 或 0
function isExpired(row, now = Date.now()) {
  return row.expire_at && row.expire_at !== 0 && row.expire_at <= now;
}
function isDepleted(row) {
  return row.download_limit > 0 && row.downloads >= row.download_limit;
}

// POST /api/share  —— 创建分享（文本或文件）
export async function createShare({ request, env }) {
  let form;
  const ct = request.headers.get('Content-Type') || '';
  if (ct.includes('application/json')) {
    const body = await request.json().catch(() => ({}));
    // 把 JSON 包成伪 form，便于复用同一套逻辑
    form = {
      get(k) {
        return body[k] ?? null;
      },
      async formData() {
        return form;
      },
    };
    form._isJson = true;
  } else {
    form = await request.formData();
  }

  const type = form.get('type');
  const text = form.get('text');
  const file = form.get('file');
  const password = form.get('password');

  let shareType = type;
  if (!shareType) shareType = file ? 'file' : 'text';
  if (shareType !== 'text' && shareType !== 'file') {
    return json({ error: 'type 必须是 text 或 file' }, 400);
  }

  let row = {
    code: genCode(),
    type: shareType,
    created_at: Date.now(),
    upload_ip: clientIp(request),
    expire_at: null,
    download_limit: 0,
    password: null,
  };

  if (shareType === 'text') {
    if (!text || !text.trim()) return json({ error: '文本内容不能为空' }, 400);
    if (text.length > 222 * 1024) return json({ error: '文本过长（上限 222KB）' }, 413);
    row.text_content = text;
  } else {
    // 文件模式：file_key 由 /api/imgbed/upload 代理上传到 ImgBed 后返回，
    // 这里只接收并记录（file 本体不经过本接口，避免请求体大小限制）
    const fileKey = form.get('file_key');
    if (!fileKey) {
      return json({ error: '请先通过 /api/imgbed/upload 上传文件，再提交 file_key' }, 400);
    }
    row.file_key = String(fileKey);
    row.file_name = form.get('file_name') || 'file';
    row.file_type = form.get('file_type') || 'application/octet-stream';
    row.file_size = parseInt(form.get('file_size') || '0', 10) || 0;
  }

  // 过期时间（毫秒，0/缺省=永久）
  const expireMs = parseInt(form.get('expire_ms') || '0', 10);
  if (expireMs > 0) row.expire_at = row.created_at + expireMs;

  // 下载次数上限
  const dl = parseInt(form.get('download_limit') || '0', 10);
  row.download_limit = Number.isFinite(dl) && dl > 0 ? dl : 0;

  // 访问密码
  if (password && String(password).length) {
    row.password = await sha256(String(password));
  }

  await db.createShare(env.fcb_db, row);
  return json({
    code: row.code,
    type: row.type,
    expire_at: row.expire_at,
    download_limit: row.download_limit,
  });
}

// GET /api/share/:code  —— 查看分享元信息（不消耗次数）
export async function getShareMeta({ params, env }) {
  const row = await db.getShare(env.fcb_db, params.code);
  if (!row) return json({ error: '取件码不存在' }, 404);
  if (isExpired(row)) return json({ error: '该分享已过期', code: params.code, expired: true }, 410);
  if (isDepleted(row)) return json({ error: '该分享已达取件上限', code: params.code, depleted: true }, 410);

  const base = {
    code: row.code,
    type: row.type,
    expire_at: row.expire_at,
    download_limit: row.download_limit,
    downloads: row.downloads,
    has_password: !!row.password,
    remaining: row.download_limit > 0 ? Math.max(0, row.download_limit - row.downloads) : null,
  };
  if (row.type === 'file') {
    base.file_name = row.file_name;
    base.file_type = row.file_type;
    base.file_size = row.file_size;
  }
  return json(base);
}

// POST /api/share/:code/claim  —— 取件（消耗一次）
export async function claimShare({ request, params, env }) {
  const row = await db.getShare(env.fcb_db, params.code);
  if (!row) return json({ error: '取件码不存在' }, 404);
  if (isExpired(row)) return json({ error: '该分享已过期' }, 410);
  if (isDepleted(row)) return json({ error: '该分享已达取件上限' }, 410);

  // 密码校验
  if (row.password) {
    let provided = '';
    const ct = request.headers.get('Content-Type') || '';
    if (ct.includes('application/json')) {
      const b = await request.json().catch(() => ({}));
      provided = b.password || '';
    } else {
      const f = await request.formData().catch(() => null);
      provided = f ? f.get('password') || '' : '';
    }
    const ok = (await sha256(String(provided))) === row.password;
    if (!ok) return json({ error: '密码错误', requiresPassword: true }, 401);
  }

  await db.incrementDownloads(env.fcb_db, params.code);

  if (row.type === 'text') {
    return json({ type: 'text', text: row.text_content });
  }

  // 文件：签发轻量防直链 token，返回可直接访问的 URL
  const token = await fileToken(env, row.file_key);
  return json({
    type: 'file',
    file_name: row.file_name,
    file_type: row.file_type,
    file_size: row.file_size,
    url: `/file/${row.file_key}?t=${token}`,
  });
}

// ---------- 管理员 ----------

export async function adminLogin({ request, env }) {
  let password = '';
  const ct = request.headers.get('Content-Type') || '';
  if (ct.includes('application/json')) {
    const b = await request.json().catch(() => ({}));
    password = b.password || '';
  } else {
    const f = await request.formData().catch(() => null);
    password = f ? f.get('password') || '' : '';
  }
  if (!env.ADMIN_KEY || String(password) !== String(env.ADMIN_KEY)) {
    return json({ error: '管理员密码错误' }, 401);
  }
  const token = await expectedAdminToken(env);
  return json({ token });
}

async function requireAdmin(env, request) {
  if (!(await verifyAdmin(env, request))) {
    return json({ error: '未授权' }, 401);
  }
  return null;
}

export async function adminStats(ctx) {
  const denied = await requireAdmin(ctx.env, ctx.request);
  if (denied) return denied;
  const total = await db.countShares(ctx.env.fcb_db);
  const active = await db.countActive(ctx.env.fcb_db);
  const now = Date.now();
  const expired = await ctx.env.fcb_db
    .prepare(`SELECT COUNT(*) AS c FROM shares WHERE (expire_at IS NOT NULL AND expire_at != 0 AND expire_at <= ?) OR (download_limit > 0 AND downloads >= download_limit)`)
    .bind(now)
    .first();
  return json({ total, active, expired: expired ? expired.c : 0 });
}

export async function adminList(ctx) {
  const denied = await requireAdmin(ctx.env, ctx.request);
  if (denied) return denied;
  const rows = await db.listShares(ctx.env.fcb_db, 200, 0);
  return json({ shares: rows });
}

export async function adminDelete(ctx) {
  const denied = await requireAdmin(ctx.env, ctx.request);
  if (denied) return denied;
  const code = ctx.params.code;
  const row = await db.getShare(ctx.env.fcb_db, code);
  if (!row) return json({ error: '不存在' }, 404);
  await db.deleteShare(ctx.env.fcb_db, code);
  await storage.deleteFromImgBed(ctx.env, row.file_key);
  return json({ ok: true });
}

export async function adminSweep(ctx) {
  const denied = await requireAdmin(ctx.env, ctx.request);
  if (denied) return denied;
  const keys = await db.sweepExpired(ctx.env.fcb_db, Date.now());
  for (const k of keys) await storage.deleteFromImgBed(ctx.env, k);
  return json({ cleaned: keys.length });
}

// GET /api/config  —— 前端公共配置
export async function publicConfig({ env }) {
  return json({
    name: appName(env),
    subtitle: appSubtitle(env),
    expirePresets: EXPIRE_PRESETS,
    downloadPresets: DOWNLOAD_PRESETS,
    storage: 'CloudFlare-ImgBed (API)',
  });
}

export async function health() {
  return json({ ok: true, service: 'filecodebox-cf', time: Date.now() });
}
