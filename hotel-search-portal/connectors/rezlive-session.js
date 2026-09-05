const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const SESSION_DIR = path.join(__dirname, '..', '.rezlive-session');
const STORAGE_PATH = path.join(SESSION_DIR, 'storage-state.json');
const STATUS_PATH = path.join(SESSION_DIR, 'status.json');
const REZLIVE_HOME = 'https://www.rezlive.com/common/index';
const CHROME_USER_DATA = process.env.REZLIVE_CHROME_USER_DATA || path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data');
const CHROME_PROFILE = process.env.REZLIVE_CHROME_PROFILE || 'Profile 2';
const CHROME_EXE = process.env.REZLIVE_CHROME_EXE || path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe');
const DEBUG_PORT = Number(process.env.REZLIVE_CHROME_DEBUG_PORT || 9222);
let activeLogin = null;

function ensureDir() { fs.mkdirSync(SESSION_DIR, { recursive: true }); }
function writeStatus(status, error = null) { ensureDir(); fs.writeFileSync(STATUS_PATH, JSON.stringify({ status, error, updatedAt: new Date().toISOString() })); }
function readStatus() {
  if (!fs.existsSync(STATUS_PATH)) return { status: 'not_connected', error: null };
  try { return JSON.parse(fs.readFileSync(STATUS_PATH, 'utf8')); } catch { return { status: 'not_connected', error: null }; }
}

async function connectRezLive() {
  if (activeLogin) return { ok: true, status: 'already_connecting' };
  ensureDir();
  writeStatus('connecting');
  activeLogin = (async () => {
    let browser = null;
    let chromeProcess = null;
    try {
      if (!fs.existsSync(CHROME_USER_DATA)) throw new Error(`Chrome user-data directory not found: ${CHROME_USER_DATA}`);
      if (!fs.existsSync(CHROME_EXE)) throw new Error(`Chrome executable not found: ${CHROME_EXE}`);

      console.log(`Using existing Chrome profile '${CHROME_PROFILE}' for RezLive.`);
      console.log(`Starting Chrome with remote debugging on port ${DEBUG_PORT}...`);
      chromeProcess = spawn(CHROME_EXE, [
        `--remote-debugging-port=${DEBUG_PORT}`,
        `--user-data-dir=${CHROME_USER_DATA}`,
        `--profile-directory=${CHROME_PROFILE}`,
        '--no-first-run',
        '--no-default-browser-check',
        REZLIVE_HOME
      ], { detached: true, stdio: 'ignore', windowsHide: false });
      chromeProcess.unref();

      await new Promise((resolve, reject) => {
        const deadline = Date.now() + 20000;
        const timer = setInterval(async () => {
          if (Date.now() > deadline) { clearInterval(timer); reject(new Error('Chrome remote debugging did not become available within 20 seconds.')); return; }
          try {
            const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
            if (res.ok) { clearInterval(timer); resolve(); }
          } catch {}
        }, 500);
      });

      browser = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`);
      let page = browser.contexts().flatMap(c => c.pages())[0];
      if (!page) {
        const context = browser.contexts()[0] || await browser.newContext();
        page = await context.newPage();
      }
      await page.goto(REZLIVE_HOME, { waitUntil: 'domcontentloaded', timeout: 30000 });
      console.log(`RezLive URL: ${page.url()}`);
      console.log('Using the actual Chaseflight Chrome profile and its existing browser session.');
      console.log('Do not enter or share a new authenticator code.');

      const deadline = Date.now() + 3 * 60 * 1000;
      while (Date.now() < deadline) {
        if (page.isClosed()) throw new Error('RezLive Chrome page was closed before the session could be saved.');
        if (!page.url().includes('/login')) {
          const ctx = page.context();
          await ctx.storageState({ path: STORAGE_PATH });
          writeStatus('connected');
          console.log('RezLive authenticated session saved.');
          await browser.close().catch(() => {});
          return { ok: true, status: 'connected' };
        }
        await page.waitForTimeout(1000);
      }

      writeStatus('error', 'The Chaseflight Chrome session is not authenticated with RezLive.');
      await browser.close().catch(() => {});
      return { ok: false, status: 'error', error: 'The Chaseflight Chrome session is not authenticated with RezLive.' };
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

function hasRezLiveSession() { return fs.existsSync(STORAGE_PATH); }
function getRezLiveSessionStatus() {
  if (hasRezLiveSession()) { const status = readStatus(); if (status.status !== 'error') return { status: 'connected', error: null }; }
  return readStatus();
}
async function withRezLiveSession(fn) {
  if (!hasRezLiveSession()) throw new Error('RezLive session is not connected.');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState: STORAGE_PATH, viewport: { width: 1440, height: 1000 } });
  try { return await fn({ browser, context, page: await context.newPage() }); }
  finally { await context.close().catch(() => {}); await browser.close().catch(() => {}); }
}
module.exports = { connectRezLive, hasRezLiveSession, getRezLiveSessionStatus, withRezLiveSession, STORAGE_PATH };