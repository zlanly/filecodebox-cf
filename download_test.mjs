// 复现「下载得到 0 字节文件」问题：真实浏览器上传 + 取件 + 下载，读取下载内容
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const EXE = '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const BASE = 'http://localhost:8000';
const testFile = '/tmp/fcb_up_src.bin';
// 造一个带二进制内容的文件（非纯文本，测试 multipart 解析）
fs.writeFileSync(testFile, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03, 0xff, 0xfe, 0xfd, 0x41, 0x42, 0x43]));

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage();
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
page.on('requestfailed', (r) => logs.push(`[reqfail] ${r.url()} ${r.failure()?.errorText}`));

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.click('.seg-btn[data-type="file"]');
await page.setInputFiles('#fileInput', testFile);
await page.click('#sendBtn');
await page.waitForSelector('#sendResult:not(.hidden)', { timeout: 8000 });
const code = await page.$eval('#resultCode', (el) => el.textContent.replace(/-/g, ''));
console.log('取件码 =', code);

// 取件
await page.click('.tab[data-view="receive"]');
await page.fill('#codeInput', code);
await page.click('#receiveBtn');
await page.waitForTimeout(800);
const href = await page.$eval('#receiveOut a.primary-btn', (el) => el.getAttribute('href')).catch(() => null);
console.log('下载链接 =', href);

// 监听下载
let dlInfo = null;
try {
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 8000 }),
    page.click('#receiveOut a.primary-btn'),
  ]);
  const suggested = download.suggestedFilename();
  const path = await download.path();
  const buf = fs.readFileSync(path);
  dlInfo = { suggested, size: buf.length, head: Array.from(buf.slice(0, 8)) };
} catch (e) {
  dlInfo = { error: String(e).slice(0, 200) };
}
console.log('下载结果 =', JSON.stringify(dlInfo));

// 直接请求该链接，看响应字节
if (href) {
  const direct = await page.evaluate(async (url) => {
    try {
      const r = await fetch(url, { redirect: 'follow' });
      const buf = await r.arrayBuffer();
      return { status: r.status, bytes: buf.byteLength, head: Array.from(new Uint8Array(buf.slice(0, 8))) };
    } catch (e) { return { error: String(e) }; }
  }, href);
  console.log('直接 fetch 链接 =', JSON.stringify(direct));
}

console.log('--- 日志 ---');
console.log(logs.join('\n') || '(无)');
await browser.close();
