// Telegram 存储模式端到端测试（配合 preview_local.mjs FCB_TG_MODE=1 的 Telegram mock）
// 流程：上传文件到 Telegram(mock) -> 创建文件分享 -> 取件 -> 下载字节比对 -> 校验 Content-Type/filename
const BASE = process.env.BASE || 'http://127.0.0.1:8088';

function randBytes(n) {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 31 + 7) % 256; // 确定性伪随机，便于比对
  return b;
}

async function main() {
  const fileName = '测试文件.bin';
  const fileType = 'application/octet-stream';
  const payload = randBytes(2048);

  // 1) 上传到 Telegram（/api/imgbed/upload 在 TG 模式下直传 Telegram）
  const fd = new FormData();
  fd.append('file', new Blob([payload], { type: fileType }), fileName);
  const up = await fetch(`${BASE}/api/imgbed/upload`, { method: 'POST', body: fd });
  const upJson = await up.json();
  console.log('[upload] status', up.status, 'body', JSON.stringify(upJson));
  if (!up.ok || !upJson.id) throw new Error('上传失败：' + JSON.stringify(upJson));
  const fileKey = upJson.id;

  // 2) 创建文件分享
  const sf = new FormData();
  sf.append('type', 'file');
  sf.append('file_key', fileKey);
  sf.append('file_name', fileName);
  sf.append('file_type', fileType);
  sf.append('file_size', String(payload.length));
  const create = await fetch(`${BASE}/api/share`, { method: 'POST', body: sf });
  const createJson = await create.json();
  console.log('[create] status', create.status, 'body', JSON.stringify(createJson));
  if (!create.ok || !createJson.code) throw new Error('创建分享失败：' + JSON.stringify(createJson));
  const code = createJson.code;

  // 3) 取件（签名防直链 token）
  const claim = await fetch(`${BASE}/api/share/${code}/claim`, { method: 'POST' });
  const claimJson = await claim.json();
  console.log('[claim] status', claim.status, 'body', JSON.stringify(claimJson));
  if (!claim.ok || !claimJson.url) throw new Error('取件失败：' + JSON.stringify(claimJson));
  const fileUrl = claimJson.url; // /file/<key>?t=<token>

  // 4) 下载字节
  const dl = await fetch(`${BASE}${fileUrl}`);
  if (!dl.ok) throw new Error('下载失败：' + dl.status + ' ' + (await dl.text()).slice(0, 100));
  const got = new Uint8Array(await dl.arrayBuffer());
  console.log('[download] status', dl.status, 'Content-Type', dl.headers.get('Content-Type'), 'len', got.length);
  console.log('[download] Content-Disposition', dl.headers.get('Content-Disposition'));

  // 5) 比对
  let ok = got.length === payload.length;
  if (ok) for (let i = 0; i < payload.length; i++) if (got[i] !== payload[i]) { ok = false; break; }
  if (!ok) throw new Error(`字节不一致：期望 ${payload.length}，实际 ${got.length}`);

  // 6) 校验 Content-Type / Content-Disposition（中文文件名遵循 RFC 5987 放在 filename* 百分号编码中）
  const ctOk = (dl.headers.get('Content-Type') || '').includes(fileType);
  const cd = dl.headers.get('Content-Disposition') || '';
  const star = cd.match(/filename\*=UTF-8''([^;]+)/);
  const decodedName = star ? decodeURIComponent(star[1]) : '';
  const cdOk = cd.startsWith('inline;') && decodedName === fileName;
  if (!ctOk) throw new Error('Content-Type 不正确：' + dl.headers.get('Content-Type'));
  if (!cdOk) throw new Error('Content-Disposition 不正确：' + cd);

  // 7) 校验无 token 应被拒（403）
  const noTok = await fetch(`${BASE}/file/${fileKey}`);
  if (noTok.status !== 403) throw new Error('缺少 token 未被拒，status=' + noTok.status);

  // 8) 校验 /api/config 显示 Telegram 存储
  const cfg = await (await fetch(`${BASE}/api/config`)).json();
  if (cfg.storage !== 'Telegram (Bot API)') throw new Error('storage 标签错误：' + cfg.storage);

  console.log('\n✅ Telegram 存储端到端测试全部通过');
  console.log('   - 上传/取件/下载字节 2048=2048 完全一致');
  console.log('   - Content-Type / Content-Disposition 正确：' + dl.headers.get('Content-Type') + ' / ' + dl.headers.get('Content-Disposition'));
  console.log('   - 无 token 取件被拒(403)，防直链生效');
  console.log('   - /api/config 显示：' + cfg.storage);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('\n❌ 测试失败：', e.message);
  process.exit(1);
});
