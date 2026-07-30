// FileCodeBox-CF · Worker 入口（零依赖，纯 Web 标准 API）
//
// 路由说明：
//   /api/share            POST  创建分享（文本 / 文件）
//   /api/share/:code      GET   查看分享元信息（不消耗）
//   /api/share/:code/claim POST 取件（消耗一次，文本直接返回 / 文件返回防直链 URL）
//   /api/imgbed/upload    POST  把文件流式代理到 ImgBed 的 /upload（原生支持大文件）
//   /file/:key?t=TOKEN    GET   校验防直链 token 后 302 跳转到 ImgBed 原地址
//   /api/admin/login      POST  管理员登录，返回 token
//   /api/admin/stats      GET   统计
//   /api/admin/shares     GET   分享列表
//   /api/admin/share/:code DELETE 删除某分享（同步清理 ImgBed 侧对象）
//   /api/admin/sweep      POST  清理过期 / 超额分享
//   /api/install         GET/POST  首次部署初始化 D1 表结构（幂等，也可由首次访问自动建表）
//   /api/config           GET   前端公共配置
//   /api/health           GET   健康检查

import * as api from './api.js';
import * as storage from './storage.js';
import * as db from './db.js';

// 编译 "/api/share/:code/claim" -> 正则 + 参数名
function compile(pattern) {
  const names = [];
  const rx = pattern.replace(/:[^/]+/g, (m) => {
    names.push(m.slice(1));
    return '([^/]+)';
  });
  return { regex: new RegExp('^' + rx + '/?$'), names };
}

const ROUTES = [
  { method: 'GET', pattern: '/api/install', handler: api.install },
  { method: 'POST', pattern: '/api/install', handler: api.install },
  { method: 'GET', pattern: '/api/health', handler: api.health },
  { method: 'GET', pattern: '/api/config', handler: api.publicConfig },
  { method: 'POST', pattern: '/api/share', handler: api.createShare },
  { method: 'POST', pattern: '/api/imgbed/upload', handler: async (ctx) => {
    const r = await storage.uploadToImgBed(ctx.env, ctx.request);
    return new Response(JSON.stringify(r), {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  } },
  { method: 'GET', pattern: '/api/share/:code', handler: api.getShareMeta },
  { method: 'POST', pattern: '/api/share/:code/claim', handler: api.claimShare },
  { method: 'GET', pattern: '/file/:key', handler: (ctx) => storage.serveFromImgBed(ctx.env, ctx.request, ctx.params.key) },
  { method: 'POST', pattern: '/api/admin/login', handler: api.adminLogin },
  { method: 'GET', pattern: '/api/admin/stats', handler: api.adminStats },
  { method: 'GET', pattern: '/api/admin/shares', handler: api.adminList },
  { method: 'DELETE', pattern: '/api/admin/share/:code', handler: api.adminDelete },
  { method: 'POST', pattern: '/api/admin/sweep', handler: api.adminSweep },
].map((r) => ({ ...r, ...compile(r.pattern) }));

function match(method, pathname) {
  for (const r of ROUTES) {
    if (r.method !== method) continue;
    const m = pathname.match(r.regex);
    if (m) {
      const params = {};
      r.names.forEach((n, i) => (params[n] = decodeURIComponent(m[i + 1])));
      return { handler: r.handler, params };
    }
  }
  return null;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;
    let method = request.method.toUpperCase();

    // HEAD 复用 GET 路由（文件服务支持 HEAD）
    const lookupMethod = method === 'HEAD' ? 'GET' : method;
    const found = match(lookupMethod, pathname);

    if (found) {
      const context = { request, env, ctx, params: found.params };
      try {
        const res = await found.handler(context);
        // 统一附加 CORS（按需，默认开放）
        const headers = new Headers(res.headers);
        headers.set('Access-Control-Allow-Origin', '*');
        if (method === 'HEAD') {
          return new Response(null, { status: res.status, headers });
        }
        return new Response(res.body, { status: res.status, headers });
      } catch (e) {
        return new Response(JSON.stringify({ error: '服务器错误：' + e.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
        });
      }
    }

    // 预检
    if (method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        },
      });
    }

    // 其余交给静态资源（SPA）
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    return new Response('Not Found', { status: 404 });
  },

  // Cron Trigger：定期清理过期 / 超额分享
  async scheduled(event, env, ctx) {
    const keys = await db.sweepExpired(env.fcb_db, Date.now());
    for (const k of keys) {
      ctx.waitUntil(storage.deleteFromImgBed(env, k));
    }
  },
};
