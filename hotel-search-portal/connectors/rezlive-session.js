const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const SESSION_DIR = path.join(__dirname, '..', '.rezlive-session');
const STORAGE_PATH = path.join(SESSION_DIR, 'storage-state.json');

function ensureDir() {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
}

async function connectRezLive() {
  ensureDir();
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  await page.goto('https://extranet.rezlive.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 });

  console.log('RezLive browser opened. Complete login and security CAPTCHA manually.');
  console.log('After you reach the authenticated RezLive dashboard, return to the terminal and press Enter.');

  await new Promise(resolve => {
    process.stdin.resume();
    process.stdin.once('data', resolve);
  });

  const stillLogin = page.url().includes('/login');
  if (stillLogin) {
    await browser.close();
    throw new Error('RezLive login was not completed. Finish the login/CAPTCHA before pressing Enter.');
  }

  await context.storageState({ path: STORAGE_PATH });
  await browser.close();
  return { ok: true, sessionPath: STORAGE_PATH };
}

function hasRezLiveSession() {
  return fs.existsSync(STORAGE_PATH);
}

async function withRezLiveSession(fn) {
  if (!hasRezLiveSession()) throw new Error('RezLive session is not connected.');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState: STORAGE_PATH, viewport: { width: 1440, height: 1000 } });
  try {
    return await fn({ browser, context, page: await context.newPage() });
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

module.exports = { connectRezLive, hasRezLiveSession, withRezLiveSession, STORAGE_PATH };
