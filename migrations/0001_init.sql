-- FileCodeBox-CF · 分享记录库（绑定名 fcb_db）初始化
-- 仅存放分享元数据（取件码 / 类型 / 过期 / 次数 / 密码哈希）。
-- 文件二进制本体存放在 ImgBed 的 R2 桶（img_r2）。

CREATE TABLE IF NOT EXISTS shares (
    code           TEXT PRIMARY KEY,            -- 取件码
    type           TEXT NOT NULL,               -- text | file
    text_content   TEXT,                        -- 文本分享内容
    file_key       TEXT,                        -- R2 对象 key（ImgBed 桶）
    file_name      TEXT,                        -- 原始文件名
    file_type      TEXT,                        -- MIME
    file_size      INTEGER,                     -- 字节
    password       TEXT,                        -- SHA-256 哈希（可空）
    expire_at      INTEGER,                     -- 过期时间戳(ms)，NULL/0=永久
    download_limit INTEGER NOT NULL DEFAULT 0,  -- 取件次数上限，0=不限
    downloads      INTEGER NOT NULL DEFAULT 0,  -- 已取件次数
    created_at     INTEGER NOT NULL,            -- 创建时间戳(ms)
    upload_ip      TEXT                         -- 上传者 IP
);

CREATE INDEX IF NOT EXISTS idx_shares_created_at ON shares(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_shares_expire_at ON shares(expire_at);
