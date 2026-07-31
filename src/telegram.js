import { fileToken } from './auth.js';

// FileCodeBox-CF · Telegram 存储后端（移植自 CloudFlare-ImgBed 的 telegramAPI.js）
//
// 把文件直接存到 Telegram（通过 Bot API），从而无需额外部署 / 对接一个 ImgBed 实例。
// 凭据（在 Cloudflare 控制台配置为 Variables / Secrets）：
//   TG_BOT_TOKEN : BotFather 申请的 Bot Token（形如 123456:ABC-DEF...）
//   TG_CHAT_ID   : 文件要发往的频道 / 群组 ID（机器人需为该会话管理员；私聊可用自己的 id）
//   TG_API       : 可选，自定义反代域名（用于 api.telegram.org 被墙的环境），留空则用官方 API
//
// 安全说明：取件时本 Worker 在服务端用 bot token 调 getFile 取回字节并流式返回给浏览器，
// bot token 始终留在服务端，不会下发给客户端（与 ImgBed 的 302 不同，这里不暴露 token）。

export class TelegramAPI {
  constructor(botToken, proxyUrl = '') {
    this.botToken = botToken;
    const domain = proxyUrl ? `https://${proxyUrl}` : 'https://api.telegram.org';
    this.baseURL = `${domain}/bot${botToken}`;
    this.fileDomain = domain;
    this.defaultHeaders = {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36 Edg/121.0.0.0',
    };
  }

  // 发送文件到 Telegram（统一用 sendDocument，支持任意类型、最大 50MB）
  async sendFile(file, chatId, functionName, functionType, caption = '', fileName = '') {
    const formData = new FormData();
    formData.append('chat_id', chatId);
    if (fileName) formData.append(functionType, file, fileName);
    else formData.append(functionType, file);
    if (caption) formData.append('caption', caption);

    const response = await fetch(`${this.baseURL}/${functionName}`, {
      method: 'POST',
      headers: this.defaultHeaders,
      body: formData,
    });
    if (!response.ok) {
      throw new Error(`Telegram API error: ${response.status} ${response.statusText}`);
    }
    return response.json();
  }

  // 从 Bot API 响应里提取 file_id / file_name / file_size
  getFileInfo(responseData) {
    const getDetails = (file) => ({
      file_id: file.file_id,
      file_name: file.file_name || file.file_unique_id,
      file_size: file.file_size,
    });
    try {
      if (!responseData.ok) return null;
      if (responseData.result.photo) {
        const largest = responseData.result.photo.reduce((p, c) =>
          p.file_size > c.file_size ? p : c
        );
        return getDetails(largest);
      }
      if (responseData.result.video) return getDetails(responseData.result.video);
      if (responseData.result.audio) return getDetails(responseData.result.audio);
      if (responseData.result.document) return getDetails(responseData.result.document);
      return null;
    } catch (e) {
      return null;
    }
  }

  async getFilePath(fileId) {
    try {
      const url = `${this.baseURL}/getFile?file_id=${encodeURIComponent(fileId)}`;
      const response = await fetch(url, { method: 'GET', headers: this.defaultHeaders });
      const data = await response.json();
      return data.ok ? data.result.file_path : null;
    } catch (e) {
      return null;
    }
  }

  // 取回文件内容（服务端 fetch，token 不出服务端）
  async getFileContent(fileId) {
    const filePath = await this.getFilePath(fileId);
    if (!filePath) throw new Error(`File path not found for fileId: ${fileId}`);
    const fullURL = `${this.fileDomain}/file/bot${this.botToken}/${filePath}`;
    return fetch(fullURL, { headers: this.defaultHeaders });
  }
}

// 上传：把请求里的文件发给 Telegram，返回 { id: file_id, src }
export async function uploadToTelegram(env, request) {
  if (!env.TG_BOT_TOKEN) throw new Error('未配置 TG_BOT_TOKEN（Telegram Bot Token）');
  if (!env.TG_CHAT_ID) throw new Error('未配置 TG_CHAT_ID（文件要发往的频道/群组 ID）');
  const form = await request.formData();
  const file = form.get('file');
  if (!file) throw new Error('未找到上传文件');

  const tg = new TelegramAPI(env.TG_BOT_TOKEN, env.TG_API || '');
  const resp = await tg.sendFile(file, env.TG_CHAT_ID, 'sendDocument', 'document', '', file.name || 'file');
  const info = tg.getFileInfo(resp);
  if (!info || !info.file_id) {
    throw new Error('Telegram 未返回 file_id: ' + JSON.stringify(resp).slice(0, 200));
  }
  return { id: info.file_id, src: `tg://${info.file_id}` };
}

// 取件：先校验 HMAC 防直链 token，再在服务端用 bot token 取回文件内容并流式返回。
// meta（file_name / file_type）用于设置正确的 Content-Type 与下载文件名。
export async function serveFromTelegram(env, request, key, meta) {
  const token = new URL(request.url).searchParams.get('t');
  const expected = await fileToken(env, key);
  if (!token || token !== expected) {
    return new Response('无效或缺失的访问凭证', { status: 403 });
  }
  const tg = new TelegramAPI(env.TG_BOT_TOKEN, env.TG_API || '');
  let resp;
  try {
    resp = await tg.getFileContent(key);
  } catch (e) {
    return new Response('Telegram 取文件失败: ' + e.message, { status: 502 });
  }
  if (!resp.ok) return new Response('Telegram 取文件失败', { status: 502 });
  const headers = new Headers();
  headers.set(
    'Content-Type',
    (meta && meta.file_type) || resp.headers.get('Content-Type') || 'application/octet-stream'
  );
  const name = meta && meta.file_name;
  if (name) {
    // 文件名可能含中文等非 ASCII：标准 Headers 要求值是 Latin1 ByteString，直接塞会抛错。
    // 按 RFC 5987 用 filename* 做 UTF-8 百分号编码；filename 退化为 ASCII 兜底（浏览器优先用 filename*）。
    const asciiName = String(name).replace(/[^\x20-\x7E]/g, '_');
    const encoded = encodeURIComponent(name);
    headers.set('Content-Disposition', `inline; filename="${asciiName}"; filename*=UTF-8''${encoded}`);
  } else {
    headers.set('Content-Disposition', 'inline');
  }
  const len = resp.headers.get('Content-Length');
  if (len) headers.set('Content-Length', len);
  return new Response(resp.body, { status: 200, headers });
}
