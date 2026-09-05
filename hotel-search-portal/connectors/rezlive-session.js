const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const SESSION_DIR = path.join(__dirname, '..', '.rezlive-session');
const STORAGE_PATH = path.join(SESSION_DIR, 'storage-state.json');
const STATUS_PATH = path.join(SESSION_DIR, 'status.json');
let activeLogin = null;

function ensureDir() {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
}

function writeStatus(status, error = null) {
  ensureDir();
  fs.writeFileSync(STATUS_PATH, JSON.stringify({ status, error, updatedAt: new Date().toISOString() }));
}

function readStatus() {
  if (!fs.existsSync(STATUS_PATH)) return { status: 'not_connected', error: null };
  try { return JSON.parse(fs.readFileSync(STATUS_PATH, 'utf8')); }
  catch { return { status: 'not_connected', error: null }; }
}

async function connectRezLive() {
  if (activeLogin) return { ok: true, status: 'already_connecting' };
  ensureDir();
  writeStatus('connecting');
  activeLogin = (async () => {
    let browser = null;
    try {
      browser = await chromium.launch({ headless: false });
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      const page = await context.newPage();
      await page.goto('https://extranet.rezlive.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
      console.log('RezLive browser opened. Complete the login and security CAPTCHA manually.');

      const deadline = Date.now() + 5 * 60 * 1000;
      while (Date.now() < deadline) {
        if (page.isClosed()) throw new Error('RezLive login browser was closed before authentication completed.');
        if (!page.url().includes('/login')) {
          await context.storageState({ path: STORAGE_PATH });
          writeStatus('connected');
          await context.close().catch(() => {});
          await browser.close().catch(() => {});
          return { ok: true, status: 'connected' };
        }
        await page.waitForTimeout(1000);
      }
      writeStatus('error', 'RezLive login timed out.');
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
      return { ok: false, status: 'error', error: 'RezLive login timed out.' };
    } catch (e) {
      writeStatus('error', e.message);
      if (browser) await browser.close().catch(() => {});
      return { ok: false, status: 'error', error: e.message };
    } finally {
      activeLogin = null;
    }
  })();
  activeLogin.catch(() => {});
  return { ok: true, status: 'connecting' };
}

function hasRezLiveSession() {
  return fs.existsSync(STORAGE_PATH);
}

function getRezLiveSessionStatus() {
  if (hasRezLiveSession()) {
    const status = readStatus();
    if (status.status !== 'error') return { status: 'connected', error: null };
  }
  return readStatus();
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

module.exports = { connectRezLive, hasRezLiveSession, getRezLiveSessionStatus, withRezLiveSession, STORAGE_PATH };
