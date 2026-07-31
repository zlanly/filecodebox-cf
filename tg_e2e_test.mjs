// Telegram 存储模式端到端测试（配合 preview_local.mjs FCB_TG_MODE=1 的 Telegram mock）
// 覆盖：小文件（单发）、大文件（16MB 自动分片）、Range 取件、无 token 拒 403、config 标签
const BASE = process.env.BASE || 'http://127.0.0.1:8088';
const CHUNK = 16 * 1024 * 1024; // 与 src/telegram.js 一致

// 确定性伪随机字节（便于比对，跨分片边界也连续）
function randBytes(n, seed = 0) {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 31 + 7 + seed) % 256;
  return b;
}

async function uploadAndShare(payload, fileName, fileType) {
  const fd = new FormData();
  fd.append('file', new Blob([payload], { type: fileType }), fileName);
  const up = await fetch(`${BASE}/api/imgbed/upload`, { method: 'POST', body: fd });
  const upJson = await up.json();
  if (!up.ok || !upJson.id) throw new Error('上传失败：' + JSON.stringify(upJson));
  const sf = new FormData();
  sf.append('type', 'file');
  sf.append('file_key', upJson.id);
  sf.append('file_name', fileName);
  sf.append('file_type', fileType);
  sf.append('file_size', String(payload.length));
  const create = await fetch(`${BASE}/api/share`, { method: 'POST', body: sf });
  const createJson = await create.json();
  if (!create.ok || !createJson.code) throw new Error('创建分享失败：' + JSON.stringify(createJson));
  const claim = await (await fetch(`${BASE}/api/share/${createJson.code}/claim`, { method: 'POST' })).json();
  if (!claim.ok && !claim.url) throw new Error('取件失败：' + JSON.stringify(claim));
  return { upJson, claimUrl: claim.url };
}

function assert(cond, msg) { if (!cond) throw new Error('断言失败：' + msg); }

async function main() {
  // ---------- 1) 小文件（<16MB，单发，file_key=纯 file_id）----------
  {
    const fileName = '小文件.bin';
    const payload = randBytes(2048);
    const { upJson, claimUrl } = await uploadAndShare(payload, fileName, 'application/octet-stream');
    assert(!upJson.id.startsWith('c:'), '小文件不应分片（file_key 不应以 c: 开头）');
    const dl = await fetch(`${BASE}${claimUrl}`);
    assert(dl.status === 200, '小文件下载 200');
    const got = new Uint8Array(await dl.arrayBuffer());
    assert(got.length === payload.length, `小文件字节数 ${got.length} != ${payload.length}`);
    for (let i = 0; i < payload.length; i++) assert(got[i] === payload[i], '小文件字节不一致 @' + i);
    console.log('[1] 小文件单发：上传/取件/下载字节一致（2048）✅');
  }

  // ---------- 2) 大文件（>16MB，自动分片）----------
  let chunkedId;
  let chunkedClaimUrl;
  {
    const fileName = '大文件.bin';
    const payload = randBytes(CHUNK + 1024 * 1024, 11); // 17MB → 2 片
    const { upJson, claimUrl } = await uploadAndShare(payload, fileName, 'application/octet-stream');
    assert(upJson.id.startsWith('c:'), '大文件应分片（file_key 以 c: 开头）');
    chunkedId = upJson.id;
    chunkedClaimUrl = claimUrl;
    const dl = await fetch(`${BASE}${claimUrl}`);
    assert(dl.status === 200, '大文件下载 200，实际 ' + dl.status);
    const len = parseInt(dl.headers.get('Content-Length') || '0', 10);
    assert(len === payload.length, `Content-Length ${len} != ${payload.length}`);
    const got = new Uint8Array(await dl.arrayBuffer());
    assert(got.length === payload.length, `大文件字节数 ${got.length} != ${payload.length}`);
    for (let i = 0; i < payload.length; i++) assert(got[i] === payload[i], '大文件字节不一致 @' + i);
    console.log(`[2] 大文件分片（17MB→2片）：上传/取件/下载全量字节一致（${payload.length}）✅`);
  }

  // ---------- 3) Range 取件（跨分片边界）----------
  {
    // 造一个 3 片的大文件（~33MB），验证 Range 跨片
    const fileName = 'range.bin';
    const payload = randBytes(CHUNK * 2 + 1024 * 1024, 22); // ~33MB → 3 片
    const { upJson, claimUrl } = await uploadAndShare(payload, fileName, 'application/octet-stream');
    assert(upJson.id.startsWith('c:'), 'range 场景应分片');
    // 头部 16 字节
    let r = await fetch(`${BASE}${claimUrl}`, { headers: { Range: 'bytes=0-15' } });
    assert(r.status === 206, 'Range 头部应 206，实际 ' + r.status);
    let buf = new Uint8Array(await r.arrayBuffer());
    assert(buf.length === 16, 'Range 头部长度 16，实际 ' + buf.length);
    for (let i = 0; i < 16; i++) assert(buf[i] === payload[i], 'Range 头部不一致 @' + i);
    // 跨分片边界：从 16MB 处取 16 字节（第 1 片末 → 第 2 片首）
    const start = CHUNK;
    r = await fetch(`${BASE}${claimUrl}`, { headers: { Range: `bytes=${start}-${start + 15}` } });
    assert(r.status === 206, 'Range 跨片应 206，实际 ' + r.status);
    buf = new Uint8Array(await r.arrayBuffer());
    assert(buf.length === 16, 'Range 跨片长度 16，实际 ' + buf.length);
    for (let i = 0; i < 16; i++) assert(buf[i] === payload[start + i], 'Range 跨片不一致 @' + (start + i));
    // 尾部 16 字节
    const end = payload.length - 16;
    r = await fetch(`${BASE}${claimUrl}`, { headers: { Range: `bytes=${end}-${payload.length - 1}` } });
    assert(r.status === 206, 'Range 尾部应 206，实际 ' + r.status);
    buf = new Uint8Array(await r.arrayBuffer());
    assert(buf.length === 16, 'Range 尾部长度 16，实际 ' + buf.length);
    for (let i = 0; i < 16; i++) assert(buf[i] === payload[end + i], 'Range 尾部不一致 @' + (end + i));
    console.log('[3] Range 取件（头部/跨16MB边界/尾部）206 且字节一致 ✅');
  }

  // ---------- 4) HEAD 不应返回 body，但带 Content-Length ----------
  {
    const r = await fetch(`${BASE}${chunkedClaimUrl}`, { method: 'HEAD' });
    assert(r.status === 200, 'HEAD 200，实际 ' + r.status);
    assert(r.headers.get('Content-Length') === String(CHUNK + 1024 * 1024), 'HEAD Content-Length 正确');
    const body = await r.arrayBuffer();
    assert(body.byteLength === 0, 'HEAD 不应有 body');
    console.log('[4] HEAD 返回正确 Content-Length 且无 body ✅');
  }

  // ---------- 5) 无 token 取件被拒 ----------
  {
    const r = await fetch(`${BASE}/file/${chunkedId}`);
    assert(r.status === 403, '缺 token 应 403，实际 ' + r.status);
    console.log('[5] 无 token 取件被拒(403) ✅');
  }

  // ---------- 6) config 显示 Telegram ----------
  {
    const cfg = await (await fetch(`${BASE}/api/config`)).json();
    assert(cfg.storage === 'Telegram (Bot API)', 'storage 标签错误：' + cfg.storage);
    console.log('[6] /api/config 显示：' + cfg.storage + ' ✅');
  }

  console.log('\n✅ Telegram 存储端到端测试全部通过（含大文件分片 + Range）');
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('\n❌ 测试失败：', e.message);
  process.exit(1);
});
