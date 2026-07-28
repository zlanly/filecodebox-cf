// FileCodeBox-CF 前端逻辑（零依赖原生 JS�?
(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  let state = {
    type: 'text',
    file: null,
    adminToken: localStorage.getItem('fcb_admin_token') || '',
  };

  // ---------- 工具 ----------
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.add('hidden'), 1800);
  }

  async function api(path, opts = {}) {
    const res = await fetch(path, opts);
    let data = null;
    try { data = await res.json(); } catch (e) { /* no body */ }
    if (!res.ok) {
      const err = (data && data.error) || `请求失败 (${res.status})`;
      throw new Error(err);
    }
    return data;
  }

  function fmtSize(b) {
    if (b == null) return '';
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
    return (b / 1024 / 1024).toFixed(2) + ' MB';
  }

  function fmtExpire(ts) {
    if (!ts) return '永久';
    const d = new Date(ts);
    return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  function normalizeCode(s) {
    return (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  function formatCode(code, group = 4) {
    const s = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!group || group <= 0) return s;
    const parts = [];
    for (let i = 0; i < s.length; i += group) parts.push(s.slice(i, i + group));
    return parts.join('-');
  }

  // ---------- 配置加载 ----------
  async function loadConfig() {
    try {
      const cfg = await api('/api/config');
      if (cfg.name) $('#appName').textContent = cfg.name;
      if (cfg.subtitle) $('#appSubtitle').textContent = cfg.subtitle;
    } catch (e) { /* 忽略 */ }
  }

  // ---------- Tabs / 分段 ----------
  $$('.tab').forEach((t) =>
    t.addEventListener('click', () => switchView(t.dataset.view))
  );
  $$('.seg-btn').forEach((b) =>
    b.addEventListener('click', () => {
      state.type = b.dataset.type;
      $$('.seg-btn').forEach((x) => x.classList.toggle('active', x === b));
      $('#pane-text').classList.toggle('hidden', state.type !== 'text');
      $('#pane-file').classList.toggle('hidden', state.type !== 'file');
    })
  );

  function switchView(v) {
    $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === v));
    $('#view-send').classList.toggle('hidden', v !== 'send');
    $('#view-receive').classList.toggle('hidden', v !== 'receive');
  }

  // ---------- 文件选择 ----------
  const dz = $('#dropzone');
  const fileInput = $('#fileInput');
  dz.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => setFile(fileInput.files[0]));
  ['dragover', 'dragenter'].forEach((ev) =>
    dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('drag'); })
  );
  ['dragleave', 'drop'].forEach((ev) =>
    dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('drag'); })
  );
  dz.addEventListener('drop', (e) => {
    const f = e.dataTransfer.files[0];
    if (f) setFile(f);
  });
  $('#fileClear').addEventListener('click', () => setFile(null));

  function setFile(f) {
    state.file = f || null;
    if (f) {
      $('#fcName').textContent = f.name;
      $('#fcSize').textContent = fmtSize(f.size);
      $('#fileChip').classList.remove('hidden');
    } else {
      $('#fileChip').classList.add('hidden');
      fileInput.value = '';
    }
  }

  // ---------- 寄件 ----------
  $('#sendBtn').addEventListener('click', async () => {
    const btn = $('#sendBtn');
    btn.disabled = true; btn.textContent = '生成中�?';
    try {
      const fd = new FormData();
      fd.set('type', state.type);
      fd.set('expire_ms', $('#expireSel').value);
      fd.set('download_limit', $('#dlSel').value);
      const pwd = $('#pwdInput').value.trim();
      if (pwd) fd.set('password', pwd);

      if (state.type === 'text') {
        const text = $('#textInput').value;
        if (!text.trim()) throw new Error('文本内容不能为空');
        fd.set('text', text);
      } else {
        if (!state.file) throw new Error('请先选择文件');
        // 文件交给 ImgBed：把请求体流式代理到 ImgBed �? /upload（大文件亦支持）
        const upForm = new FormData();
        upForm.set('file', state.file);
        const up = await api('/api/imgbed/upload', { method: 'POST', body: upForm });
        if (!up.id) throw new Error('ImgBed 未返回文�? id');
        fd.set('file_key', up.id);
        fd.set('file_name', state.file.name);
        fd.set('file_type', state.file.type || 'application/octet-stream');
        fd.set('file_size', String(state.file.size));
      }

      const data = await api('/api/share', { method: 'POST', body: fd });
      showSendResult(data);
    } catch (e) {
      toast(e.message);
    } finally {
      btn.disabled = false; btn.textContent = '生成取件�?';
    }
  });

  function showSendResult(data) {
    $('#resultCode').textContent = formatCode(data.code);
    const link = `${location.origin}/#r/${data.code}`;
    $('#resultLink').value = link;
    const tips = [];
    tips.push(data.expire_at ? `过期�?${fmtExpire(data.expire_at)}` : '永久有效');
    tips.push(data.download_limit > 0 ? `可取 ${data.download_limit} 次` : '取件次数不限');
    if (data.type === 'file') tips.push('文件已存�? ImgBed');
    $('#resultTip').textContent = tips.join(' · ');
    $('#sendResult').classList.remove('hidden');
  }

  $('#copyCode').addEventListener('click', () => copy($('#resultCode').textContent, '已复制取件码'));
  $('#copyLink').addEventListener('click', () => copy($('#resultLink').value, '已复制链�?'));
  function copy(text, ok) {
    navigator.clipboard.writeText(text).then(() => toast(ok)).catch(() => toast('复制失败'));
  }

  // ---------- 取件 ----------
  $('#receiveBtn').addEventListener('click', () => doReceive(false));
  $('#pwdSubmit').addEventListener('click', () => doReceive(true));
  let pendingCode = '';

  async function doReceive(withPwd) {
    const out = $('#receiveOut');
    const raw = $('#codeInput').value;
    const code = normalizeCode(raw);
    if (!code) { toast('请输入取件码'); return; }
    pendingCode = code;
    out.innerHTML = '<div class="spinner">取件中�?</div>';
    $('#pwdRow').classList.add('hidden');

    try {
      // 先取元信�?
      const meta = await api('/api/share/' + code);
      if (meta.has_password && !withPwd) {
        out.innerHTML = '';
        $('#pwdRow').classList.remove('hidden');
        $('#receivePwd').focus();
        return;
      }
      // 取件（消耗）
      const fd = new FormData();
      if (withPwd) fd.set('password', $('#receivePwd').value);
      const claim = await api('/api/share/' + code + '/claim', { method: 'POST', body: fd });

      if (claim.type === 'text') {
        out.innerHTML = `<div class="text-result">${escapeHtml(claim.text)}</div>
          <button class="mini-btn" id="copyText" style="margin-top:12px">复制文本</button>`;
        $('#copyText').addEventListener('click', () => copy(claim.text, '已复�?'));
      } else {
        out.innerHTML = `<div class="file-result">
          <div class="fr-icon">📄</div>
          <div class="fr-name">${escapeHtml(claim.file_name)}</div>
          <div class="fr-size">${fmtSize(claim.file_size)}</div>
          <a class="primary-btn" href="${claim.url}" download="${escapeHtml(claim.file_name)}">下载文件</a>
        </div>`;
      }
    } catch (e) {
      out.innerHTML = `<div class="msg err">${escapeHtml(e.message)}</div>`;
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
  }

  // ---------- 管理后台 ----------
  const modal = $('#adminModal');
  $('#adminBtn').addEventListener('click', openAdmin);
  $('#adminClose').addEventListener('click', () => modal.classList.add('hidden'));
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.add('hidden'); });

  function openAdmin() {
    modal.classList.remove('hidden');
    if (state.adminToken) {
      $('#adminLogin').classList.add('hidden');
      $('#adminDash').classList.remove('hidden');
      loadAdmin();
    } else {
      $('#adminLogin').classList.remove('hidden');
      $('#adminDash').classList.add('hidden');
      $('#adminErr').textContent = '';
      $('#adminPwd').focus();
    }
  }

  $('#adminLoginBtn').addEventListener('click', async () => {
    try {
      const data = await api('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: $('#adminPwd').value }),
      });
      state.adminToken = data.token;
      localStorage.setItem('fcb_admin_token', data.token);
      $('#adminLogin').classList.add('hidden');
      $('#adminDash').classList.remove('hidden');
      loadAdmin();
    } catch (e) {
      $('#adminErr').textContent = e.message;
    }
  });

  $('#adminLogout').addEventListener('click', () => {
    state.adminToken = '';
    localStorage.removeItem('fcb_admin_token');
    modal.classList.add('hidden');
  });

  $('#sweepBtn').addEventListener('click', async () => {
    try {
      await api('/api/admin/sweep', { method: 'POST', headers: authHeader() });
      toast('已清�?');
      loadAdmin();
    } catch (e) { toast(e.message); }
  });

  function authHeader() {
    return { Authorization: 'Bearer ' + state.adminToken };
  }

  async function loadAdmin() {
    try {
      const s = await api('/api/admin/stats', { headers: authHeader() });
      $('#adminStats').innerHTML = `
        <div class="stat"><div class="num">${s.total}</div><div class="lbl">总分�?</div></div>
        <div class="stat"><div class="num">${s.active}</div><div class="lbl">有效</div></div>
        <div class="stat"><div class="num">${s.expired}</div><div class="lbl">已失�?</div></div>`;
      const list = await api('/api/admin/shares', { headers: authHeader() });
      const rows = list.shares.map((r) => `
        <tr>
          <td class="code-cell">${formatCode(r.code)}</td>
          <td>${r.type === 'file' ? '📄 文件' : '✏️ 文本'}</td>
          <td>${escapeHtml(r.file_name || '�?')}</td>
          <td>${r.download_limit > 0 ? (r.download_limit - r.downloads) : '�?'}</td>
          <td>${fmtExpire(r.expire_at)}</td>
          <td><button class="del" data-code="${r.code}">删除</button></td>
        </tr>`).join('') || '<tr><td colspan="6" class="muted">暂无分享</td></tr>';
      $('#shareRows').innerHTML = rows;
      $$('#shareRows .del').forEach((b) =>
        b.addEventListener('click', () => delShare(b.dataset.code))
      );
    } catch (e) {
      if (/401|未授�?/.test(e.message)) {
        state.adminToken = '';
        localStorage.removeItem('fcb_admin_token');
        openAdmin();
      } else toast(e.message);
    }
  }

  async function delShare(code) {
    if (!confirm('确认删除取件�? ' + code + '�?')) return;
    try {
      await api('/api/admin/share/' + code, { method: 'DELETE', headers: authHeader() });
      toast('已删�?');
      loadAdmin();
    } catch (e) { toast(e.message); }
  }

  // ---------- 分享链接直达�?#r/CODE�? ----------
  function handleHash() {
    const m = location.hash.match(/^#r\/(.+)$/);
    if (m) {
      switchView('receive');
      $('#codeInput').value = m[1];
      doReceive(false);
    }
  }
  window.addEventListener('hashchange', handleHash);

  // ---------- 启动 ----------
  loadConfig();
  handleHash();
})();
