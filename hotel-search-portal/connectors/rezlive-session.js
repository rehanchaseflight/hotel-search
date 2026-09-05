const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const SESSION_DIR = path.join(__dirname, '..', '.rezlive-session');
const STORAGE_PATH = path.join(SESSION_DIR, 'storage-state.json');
const STATUS_PATH = path.join(SESSION_DIR, 'status.json');
const REZLIVE_HOME = 'https://www.rezlive.com/common/index';
const CHROME_USER_DATA = process.env.REZLIVE_CHROME_USER_DATA || path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data');
const CHROME_PROFILE_NAME = process.env.REZLIVE_CHROME_PROFILE || 'Chaseflight';
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

function resolveChromeProfileDirectory() {
  const localStatePath = path.join(CHROME_USER_DATA, 'Local State');
  if (!fs.existsSync(localStatePath)) throw new Error(`Chrome Local State not found: ${localStatePath}`);

  let localState;
  try {
    localState = JSON.parse(fs.readFileSync(localStatePath, 'utf8'));
  } catch (e) {
    throw new Error(`Could not read Chrome Local State: ${e.message}`);
  }

  const profiles = localState?.profile?.info_cache || {};
  const wanted = CHROME_PROFILE_NAME.toLowerCase();
  const match = Object.entries(profiles).find(([directory, info]) => {
    return directory.toLowerCase() === wanted || String(info?.name || '').toLowerCase() === wanted;
  });

  if (!match) {
    const available = Object.entries(profiles)
      .map(([directory, info]) => `${info?.name || '(unnamed)'}=${directory}`)
      .join(', ');
    throw new Error(`Chrome profile '${CHROME_PROFILE_NAME}' was not found. Available profiles: ${available || '(none)'}`);
  }
  return match[0];
}

async function connectRezLive() {
  if (activeLogin) return { ok: true, status: 'already_connecting' };
  ensureDir();
  writeStatus('connecting');
  activeLogin = (async () => {
    let context = null;
    try {
      if (!fs.existsSync(CHROME_USER_DATA)) {
        throw new Error(`Chrome user-data directory not found: ${CHROME_USER_DATA}`);
      }

      const profileDirectory = resolveChromeProfileDirectory();
      console.log(`Using Chrome profile '${CHROME_PROFILE_NAME}' (${profileDirectory}) so RezLive can reuse its existing login session.`);
      console.log('IMPORTANT: close ALL normal Chrome windows before continuing.');

      context = await chromium.launchPersistentContext(CHROME_USER_DATA, {
        channel: 'chrome',
        headless: false,
        viewport: { width: 1440, height: 1000 },
        args: [`--profile-directory=${profileDirectory}`]
      });
      const page = context.pages()[0] || await context.newPage();
      await page.goto(REZLIVE_HOME, { waitUntil: 'domcontentloaded', timeout: 30000 });
      console.log('RezLive opened. If the Chaseflight profile already has the RezLive session, it should go directly to the hotel search.');
      console.log('If RezLive asks for a new authenticator code, stop here and tell me; do not enter or share the code.');

      const deadline = Date.now() + 3 * 60 * 1000;
      while (Date.now() < deadline) {
        if (page.isClosed()) throw new Error('RezLive browser was closed before the session could be saved.');
        const url = page.url();
        if (url.includes('/agency/hotels/') || (!url.includes('/login') && url.includes('rezlive.com'))) {
          await context.storageState({ path: STORAGE_PATH });
          writeStatus('connected');
          await context.close().catch(() => {});
          return { ok: true, status: 'connected', profileDirectory };
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
