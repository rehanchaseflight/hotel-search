const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const SESSION_DIR = path.join(__dirname, '..', '.rezlive-session');
const STORAGE_PATH = path.join(SESSION_DIR, 'storage-state.json');
const STATUS_PATH = path.join(SESSION_DIR, 'status.json');
const REZLIVE_HOME = 'https://www.rezlive.com/common/index';
const CHROME_USER_DATA = process.env.REZLIVE_CHROME_USER_DATA || path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data');
const DEBUG_PORT = Number(process.env.REZLIVE_CHROME_DEBUG_PORT || 9222);
const DEVTOOLS_ACTIVE_PORT = path.join(CHROME_USER_DATA, 'DevToolsActivePort');
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

function readDevToolsEndpoint() {
  if (!fs.existsSync(DEVTOOLS_ACTIVE_PORT)) {
    throw new Error(`Chrome remote-debugging endpoint file not found: ${DEVTOOLS_ACTIVE_PORT}. Make sure Remote debugging is enabled in chrome://inspect/#remote-debugging.`);
  }
  const lines = fs.readFileSync(DEVTOOLS_ACTIVE_PORT, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const port = Number(lines[0] || DEBUG_PORT);
  const browserPath = lines[1] || '';
  if (!browserPath.startsWith('/devtools/browser/')) {
    throw new Error('Chrome DevToolsActivePort file does not contain a browser WebSocket path.');
  }
  return `ws://127.0.0.1:${port}${browserPath}`;
}

async function connectRezLive() {
  if (activeLogin) return { ok: true, status: 'already_connecting' };
  ensureDir();
  writeStatus('connecting');
  activeLogin = (async () => {
    let browser = null;
    try {
      if (!fs.existsSync(CHROME_USER_DATA)) {
        throw new Error(`Chrome user-data directory not found: ${CHROME_USER_DATA}`);
      }

      const wsEndpoint = readDevToolsEndpoint();
      console.log('Connecting to the existing Chrome browser through Chrome Remote Debugging.');
      console.log('Your existing Chaseflight Chrome session will be used; no new login or authenticator should be required.');

      browser = await chromium.connectOverCDP(wsEndpoint);
      const contexts = browser.contexts();
      const pages = contexts.flatMap(context => context.pages());
      let page = pages.find(p => p.url().includes('rezlive.com')) || pages[0];

      if (!page) {
        const context = contexts[0] || await browser.newContext();
        page = await context.newPage();
      }

      await page.goto(REZLIVE_HOME, { waitUntil: 'domcontentloaded', timeout: 30000 });
      console.log(`RezLive URL: ${page.url()}`);

      if (page.url().includes('/login')) {
        writeStatus('error', 'The existing Chaseflight Chrome session is not authenticated with RezLive.');
        await browser.close().catch(() => {});
        return { ok: false, status: 'error', error: 'The existing Chaseflight Chrome session is not authenticated with RezLive.' };
      }

      const context = page.context();
      await context.storageState({ path: STORAGE_PATH });
      writeStatus('connected');
      console.log('RezLive authenticated session saved.');
      await browser.close().catch(() => {});
      return { ok: true, status: 'connected' };
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