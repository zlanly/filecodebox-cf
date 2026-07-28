// FileCodeBox-CF · 加密与鉴权工具
// 全部基于 Web Crypto（Cloudflare Workers 运行时原生提供）

const enc = new TextEncoder();

function toBase64Url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function toHex(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// HMAC-SHA256，返回 base64url 字符串
export async function hmac(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return toBase64Url(new Uint8Array(sig));
}

// SHA-256，返回 hex（用于密码哈希存储）
export async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(str));
  return toHex(new Uint8Array(buf));
}

// 生成随机取件码，形如 XXXX-XXXX
export function genCode(length = 8, group = 4) {
  let raw = '';
  const alphabet = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  const buf = new Uint8Array(length);
  crypto.getRandomValues(buf);
  for (let i = 0; i < length; i++) raw += alphabet[buf[i] % alphabet.length];
  if (!group || group <= 0) return raw;
  const parts = [];
  for (let i = 0; i < raw.length; i += group) parts.push(raw.slice(i, i + group));
  return parts.join('-');
}

// 生成随机 slug（用于 R2 对象 key）
export function genKey() {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  return toHex(buf);
}

// ---------- 管理员鉴权 ----------

// 静态管理员 token：HMAC(ADMIN_KEY, 'fcb-admin')，无状态、可验证不可反推
export async function expectedAdminToken(env) {
  const secret = env.ADMIN_KEY || 'change-me-please';
  return hmac(secret, 'fcb-admin');
}

export async function verifyAdmin(env, request) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return false;
  const expected = await expectedAdminToken(env);
  // 定长比较，避免计时攻击
  if (token.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= token.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

// 文件直链 token：HMAC(FILE_SECRET, key)，轻量防直链
export async function fileToken(env, key) {
  const secret = env.FILE_SECRET || env.ADMIN_KEY || 'change-me-please';
  return hmac(secret, key);
}
