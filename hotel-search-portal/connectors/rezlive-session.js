const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const SESSION_DIR = path.join(__dirname, '..', '.rezlive-session');
const STORAGE_PATH = path.join(SESSION_DIR, 'storage-state.json');
const STATUS_PATH = path.join(SESSION_DIR, 'status.json');
const REZLIVE_HOME = 'https://www.rezlive.com/common/index';
const CHROME_USER_DATA = process.env.REZLIVE_CHROME_USER_DATA || path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data');
const CHROME_PROFILE = process.env.REZLIVE_CHROME_PROFILE || '';
const CHROME_DISPLAY_NAME = process.env.REZLIVE_CHROME_PROFILE_NAME || 'Chaseflight';
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

function resolveChromeProfile() {
  if (CHROME_PROFILE) return CHROME_PROFILE;
  const localState = path.join(CHROME_USER_DATA, 'Local State');
  if (!fs.existsSync(localState)) return 'Default';
  try {
    const data = JSON.parse(fs.readFileSync(localState, 'utf8'));
    const info = data?.profile?.info_cache || {};
    const match = Object.entries(info).find(([, value]) => String(value?.name || '').trim().toLowerCase() === CHROME_DISPLAY_NAME.toLowerCase());
    return match?.[0] || data?.profile?.last_used || 'Default';
  } catch {
    return 'Default';
  }
}

async function connectRezLive() {
  if (activeLogin) return { ok: true, status: 'already_connecting' };
  ensureDir();
  writeStatus('connecting');
  activeLogin = (async () => {
    let context = null;
    try {
      if (!fs.existsSync(CHROME_USER_DATA)) throw new Error(`Chrome user-data directory not found: ${CHROME_USER_DATA}`);
      const profile = resolveChromeProfile();
      console.log(`Using Chrome profile '${CHROME_DISPLAY_NAME}' (${profile}).`);
      console.log('IMPORTANT: close ALL normal Chrome windows before continuing.');

      context = await chromium.launchPersistentContext(CHROME_USER_DATA, {
        channel: 'chrome',
        headless: false,
        viewport: { width: 1440, height: 1000 },
        args: [`--profile-directory=${profile}`]
      });
      let page = context.pages()[0] || await context.newPage();
      await page.goto(REZLIVE_HOME, { waitUntil: 'domcontentloaded', timeout: 30000 });
      console.log(`RezLive opened with Chrome profile '${profile}'.`);
      console.log('If your existing Chaseflight session is valid, the RezLive hotel search should open without a new authenticator challenge.');
      console.log('If RezLive asks for a new authenticator code, stop here and tell me; do not enter or share the code.');

      const deadline = Date.now() + 3 * 60 * 1000;
      while (Date.now() < deadline) {
        if (page.isClosed()) throw new Error('RezLive browser was closed before the session could be saved.');
        const url = page.url();
        if (!url.includes('/login')) {
          await context.storageState({ path: STORAGE_PATH });
          writeStatus('connected');
          await context.close().catch(() => {});
          return { ok: true, status: 'connected' };
        }
        await page.waitForTimeout(1000);
      }
      writeStatus('error', 'RezLive session was not authenticated within 3 minutes.');
      await context.close().catch(() => {});
      return { ok: false, status: 'error', error: 'RezLive session was not authenticated within 3 minutes.' };
    } catch (e) {
      writeStatus('error', e.message);
      if (context) await context.close().catch(() => {});
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
