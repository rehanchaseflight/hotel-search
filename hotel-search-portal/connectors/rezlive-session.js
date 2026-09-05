const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const SESSION_DIR = path.join(__dirname, '..', '.rezlive-session');
const STORAGE_PATH = path.join(SESSION_DIR, 'storage-state.json');
const STATUS_PATH = path.join(SESSION_DIR, 'status.json');
const REZLIVE_HOME = 'https://www.rezlive.com/common/index';
const CHROME_USER_DATA = process.env.REZLIVE_CHROME_USER_DATA || path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data');
const CHROME_PROFILE = process.env.REZLIVE_CHROME_PROFILE || 'Profile 2';
const CHROME_DISPLAY_NAME = 'Chaseflight';
const CLONE_DIR = path.join(SESSION_DIR, 'chrome-user-data');
const CLONE_PROFILE = CHROME_PROFILE;
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

function cloneChromeSession() {
  if (!fs.existsSync(CHROME_USER_DATA)) throw new Error(`Chrome user-data directory not found: ${CHROME_USER_DATA}`);
  const sourceProfile = path.join(CHROME_USER_DATA, CHROME_PROFILE);
  if (!fs.existsSync(sourceProfile)) throw new Error(`Chrome profile not found: ${sourceProfile}`);

  fs.mkdirSync(CLONE_DIR, { recursive: true });
  const localStateSrc = path.join(CHROME_USER_DATA, 'Local State');
  const localStateDst = path.join(CLONE_DIR, 'Local State');
  if (fs.existsSync(localStateSrc)) fs.copyFileSync(localStateSrc, localStateDst);

  const destProfile = path.join(CLONE_DIR, CLONE_PROFILE);
  if (fs.existsSync(destProfile)) fs.rmSync(destProfile, { recursive: true, force: true });

  fs.cpSync(sourceProfile, destProfile, {
    recursive: true,
    filter: source => !/\\(Cache|Code Cache|GPUCache|GrShaderCache|DawnCache|Service Worker\\CacheStorage)$/.test(source)
  });
}

async function connectRezLive() {
  if (activeLogin) return { ok: true, status: 'already_connecting' };
  ensureDir();
  writeStatus('connecting');
  activeLogin = (async () => {
    let context = null;
    try {
      console.log(`Using Chrome profile '${CHROME_DISPLAY_NAME}' (${CHROME_PROFILE}).`);
      console.log('Close ALL normal Chrome windows before continuing.');
      console.log('Creating a private automation copy of the Chaseflight profile...');
      cloneChromeSession();

      context = await chromium.launchPersistentContext(CLONE_DIR, {
        channel: 'chrome',
        headless: false,
        viewport: { width: 1440, height: 1000 },
        args: [`--profile-directory=${CLONE_PROFILE}`, '--no-first-run', '--no-default-browser-check']
      });

      const pages = context.pages();
      for (const p of pages) await p.close().catch(() => {});
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      console.log('Opening RezLive Agent Login...');
      await page.goto(REZLIVE_HOME, { waitUntil: 'domcontentloaded', timeout: 30000 });
      console.log(`RezLive URL: ${page.url()}`);
      console.log('The copied Chaseflight session will be tested here.');
      console.log('Do not enter or share a new authenticator code.');

      const deadline = Date.now() + 3 * 60 * 1000;
      while (Date.now() < deadline) {
        if (page.isClosed()) throw new Error('RezLive browser was closed before the session could be saved.');
        if (!page.url().includes('/login')) {
          await context.storageState({ path: STORAGE_PATH });
          writeStatus('connected');
          await context.close().catch(() => {});
          return { ok: true, status: 'connected' };
        }
        await page.waitForTimeout(1000);
      }
      writeStatus('error', 'The copied Chaseflight session is not authenticated with RezLive.');
      await context.close().catch(() => {});
      return { ok: false, status: 'error', error: 'The copied Chaseflight session is not authenticated with RezLive.' };
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
