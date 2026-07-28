// 浏览器端到端测试：复现「文件上传取件码无法取件 + 取件页布局」问题
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const EXE = '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const BASE = 'http://localhost:8000';

// 造一个测试文件
const testFile = '/tmp/fcb_test_file.txt';
fs.writeFileSync(testFile, 'FileCodeBox-CF 浏览器上传测试内容 ' + Date.now());

const logs = [];
const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 420, height: 900 } });

page.on('console', (m) => logs.push(`[console.${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
page.on('requestfailed', (r) => logs.push(`[requestfailed] ${r.url()} ${r.failure()?.errorText}`));

console.log('== 1. 打开首页 ==');
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(300);

console.log('== 2. 切到「文件」分段 ==');
await page.click('.seg-btn[data-type="file"]');
await page.waitForTimeout(150);

console.log('== 3. 选择文件 ==');
await page.setInputFiles('#fileInput', testFile);
await page.waitForTimeout(200);

console.log('== 4. 点击「生成取件码」 ==');
await page.click('#sendBtn');
await page.waitForSelector('#sendResult:not(.hidden)', { timeout: 8000 }).catch(() => {});
await page.waitForTimeout(400);

const code = await page.$eval('#resultCode', (el) => el.textContent).catch(() => '(无)');
const link = await page.$eval('#resultLink', (el) => el.value).catch(() => '(无)');
console.log('   取件码 =', code);
console.log('   分享链 =', link);
await page.screenshot({ path: '/tmp/fcb_send.png' });

console.log('== 5. 切到「取件」tab ==');
await page.click('.tab[data-view="receive"]');
await page.waitForTimeout(150);

console.log('== 6. 输入取件码并点击「取件」 ==');
await page.fill('#codeInput', code);
await page.click('#receiveBtn');
await page.waitForTimeout(800);

const receiveHTML = await page.$eval('#receiveOut', (el) => el.innerHTML).catch(() => '(无)');
console.log('   #receiveOut 内容 (HTML) =');
console.log('   ' + receiveHTML.replace(/\n/g, '\n   '));

// 是否存在下载链接 / 文本结果？
const hasFileLink = await page.$('#receiveOut a.primary-btn') ? true : false;
const hasErr = await page.$('#receiveOut .msg.err') ? true : false;
console.log('   含下载按钮:', hasFileLink, ' 含错误提示:', hasErr);
await page.screenshot({ path: '/tmp/fcb_receive.png' });

console.log('== 7. 若有下载链接，尝试点击并捕获结果 ==');
if (hasFileLink) {
  const href = await page.$eval('#receiveOut a.primary-btn', (el) => el.getAttribute('href'));
  console.log('   下载链接 href =', href);
  // 跟踪请求结果
  const resp = await page.evaluate(async (url) => {
    try {
      const r = await fetch(url, { redirect: 'manual' });
      const body = await r.text().catch(() => '');
      return { status: r.status, location: r.headers.get('location'), bodyLen: body.length, bodyHead: body.slice(0, 120) };
    } catch (e) {
      return { error: String(e) };
    }
  }, href);
  console.log('   点击下载响应 =', JSON.stringify(resp));
}

console.log('== 8. 分享链接直达 (#r/CODE) 自动取件 ==');
await page.goto(`${BASE}/#r/${code}`, { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
const autoReceiveHTML = await page.$eval('#receiveOut', (el) => el.innerHTML).catch(() => '(无)');
const receiveActive = await page.$eval('.tab[data-view="receive"]', (el) => el.classList.contains('active'));
console.log('   取件 tab active:', receiveActive);
console.log('   #receiveOut 内容:', autoReceiveHTML.slice(0, 200).replace(/\n/g, ' '));
await page.screenshot({ path: '/tmp/fcb_deep_link.png' });

console.log('\n== CONSOLE / 错误日志 ==');
console.log(logs.length ? logs.join('\n') : '(无)');

await browser.close();
