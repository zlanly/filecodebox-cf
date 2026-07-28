// FileCodeBox-CF · 分享记录数据库（FileCodeBox 自有 D1: fcb_db）
// 仅负责分享元数据（取件码、类型、过期、次数、密码哈希等）。
// 文件二进制本体存放在 ImgBed 的 R2 桶（img_r2），不在此处。

// 表结构见 migrations/0001_init.sql

export async function createShare(db, row) {
  await db
    .prepare(
      `INSERT INTO shares
       (code, type, text_content, file_key, file_name, file_type, file_size,
        password, expire_at, download_limit, downloads, created_at, upload_ip)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
    )
    .bind(
      row.code,
      row.type,
      row.text_content ?? null,
      row.file_key ?? null,
      row.file_name ?? null,
      row.file_type ?? null,
      row.file_size ?? null,
      row.password ?? null,
      row.expire_at ?? null,
      row.download_limit ?? 0,
      row.created_at,
      row.upload_ip ?? ''
    )
    .run();
}

export async function getShare(db, code) {
  const row = await db
    .prepare(`SELECT * FROM shares WHERE code = ?`)
    .bind(code)
    .first();
  return row || null;
}

// 取件时 +1 下载计数
export async function incrementDownloads(db, code) {
  await db
    .prepare(`UPDATE shares SET downloads = downloads + 1 WHERE code = ?`)
    .bind(code)
    .run();
}

export async function deleteShare(db, code) {
  await db.prepare(`DELETE FROM shares WHERE code = ?`).bind(code).run();
}

export async function listShares(db, limit = 100, offset = 0) {
  const rows = await db
    .prepare(
      `SELECT code, type, file_name, file_type, file_size, expire_at,
              download_limit, downloads, created_at, password IS NOT NULL AS has_password
       FROM shares ORDER BY created_at DESC LIMIT ? OFFSET ?`
    )
    .bind(limit, offset)
    .all();
  return rows.results || [];
}

export async function countShares(db) {
  const r = await db.prepare(`SELECT COUNT(*) AS c FROM shares`).first();
  return r ? r.c : 0;
}

export async function countActive(db) {
  const now = Date.now();
  const r = await db
    .prepare(
      `SELECT COUNT(*) AS c FROM shares
       WHERE (expire_at IS NULL OR expire_at = 0 OR expire_at > ?)`
    )
    .bind(now)
    .first();
  return r ? r.c : 0;
}

// 清理过期 / 超额分享：返回被删除的 file_key 列表，供调用方清理 R2
export async function sweepExpired(db, now = Date.now()) {
  const expired = await db
    .prepare(
      `SELECT code, file_key FROM shares
       WHERE (expire_at IS NOT NULL AND expire_at != 0 AND expire_at <= ?)
          OR (download_limit > 0 AND downloads >= download_limit)`
    )
    .bind(now)
    .all();
  const rows = expired.results || [];
  if (rows.length) {
    const codes = rows.map((r) => r.code);
    const placeholders = codes.map(() => '?').join(',');
    await db
      .prepare(`DELETE FROM shares WHERE code IN (${placeholders})`)
      .bind(...codes)
      .run();
  }
  return rows.map((r) => r.file_key).filter(Boolean);
}
