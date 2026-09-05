const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const SESSION_DIR = path.join(__dirname, '..', '.rezlive-session');
const STORAGE_PATH = path.join(SESSION_DIR, 'storage-state.json');
const STATUS_PATH = path.join(SESSION_DIR, 'status.json');
const REZLIVE_HOME = 'https://www.rezlive.com/common/index';
const CHROME_USER_DATA = process.env.REZLIVE_CHROME_USER_DATA || path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data');
const CHROME_PROFILE = process.env.REZLIVE_CHROME_PROFILE || 'Profile 2';
const DEVTOOLS_ACTIVE_PORT = path.join(CHROME_USER_DATA, 'DevToolsActivePort');
let activeLogin = null;

function ensureDir() { fs.mkdirSync(SESSION_DIR, { recursive: true }); }
function writeStatus(status, error = null) { ensureDir(); fs.writeFileSync(STATUS_PATH, JSON.stringify({ status, error, updatedAt: new Date().toISOString() })); }
function readStatus() {
  if (!fs.existsSync(STATUS_PATH)) return { status: 'not_connected', error: null };
  try { return JSON.parse(fs.readFileSync(STATUS_PATH, 'utf8')); } catch { return { status: 'not_connected', error: null }; }
}

function readDevToolsEndpoint() {
  if (!fs.existsSync(DEVTOOLS_ACTIVE_PORT)) throw new Error(`DevToolsActivePort not found: ${DEVTOOLS_ACTIVE_PORT}`);
  const lines = fs.readFileSync(DEVTOOLS_ACTIVE_PORT, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const port = Number(lines[0]);
  const wsPath = lines[1];
  if (!port || !wsPath) throw new Error('Invalid DevToolsActivePort contents.');
  return `ws://127.0.0.1:${port}${wsPath}`;
}

async function connectRezLive() {
  if (activeLogin) return { ok: true, status: 'already_connecting' };
  ensureDir();
  writeStatus('connecting');
  activeLogin = (async () => {
    let browser = null;
    try {
      const endpoint = readDevToolsEndpoint();
      console.log(`Connecting to Chrome ${CHROME_PROFILE} with Puppeteer.`);
      browser = await puppeteer.connect({
        browserWSEndpoint: endpoint,
        handleDevToolsAsPage: true,
        defaultViewport: null,
        protocolTimeout: 120000
      });

      const pages = await browser.pages();
      let page = pages.find(p => /(^|\.)rezlive\.com$/i.test(new URL(p.url()).hostname));
      if (!page) page = pages.find(p => p.url() && p.url() !== 'about:blank') || pages[0];
      if (!page) page = await browser.newPage();

      console.log(`Current Chrome page: ${page.url()}`);
      if (!/rezlive\.com/i.test(page.url())) {
        await page.goto(REZLIVE_HOME, { waitUntil: 'domcontentloaded', timeout: 30000 });
      }
      console.log(`RezLive URL: ${page.url()}`);

      if (/\/login/i.test(page.url())) {
        writeStatus('error', 'The existing Chaseflight Chrome session is not authenticated with RezLive.');
        browser.disconnect();
        return { ok: false, status: 'error', error: 'The existing Chaseflight Chrome session is not authenticated with RezLive.' };
      }

      const cookies = await page.cookies();
      const localStorage = await page.evaluate(() => {
        const out = {};
        for (let i = 0; i < window.localStorage.length; i++) {
          const key = window.localStorage.key(i);
          out[key] = window.localStorage.getItem(key);
        }
        return out;
      });
      fs.writeFileSync(STORAGE_PATH, JSON.stringify({
        cookies,
        origins: [{ origin: new URL(page.url()).origin, localStorage: Object.entries(localStorage).map(([name, value]) => ({ name, value })) }]
      }));
      writeStatus('connected');
      console.log('RezLive authenticated session saved.');
      browser.disconnect();
      return { ok: true, status: 'connected' };
    } catch (e) {
      writeStatus('error', e.message);
      if (browser) browser.disconnect();
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
  if (hasRezLiveSession()) {
    const status = readStatus();
    if (status.status !== 'error') return { status: 'connected', error: null };
  }
  return readStatus();
}

async function withRezLiveSession(fn) {
  const endpoint = readDevToolsEndpoint();
  const browser = await puppeteer.connect({ browserWSEndpoint: endpoint, handleDevToolsAsPage: true, defaultViewport: null, protocolTimeout: 120000 });
  try {
    const pages = await browser.pages();
    let page = pages.find(p => /rezlive\.com/i.test(p.url())) || pages[0];
    if (!page) page = await browser.newPage();
    return await fn({ browser, page });
  } finally {
    browser.disconnect();
  }
}

module.exports = { connectRezLive, hasRezLiveSession, getRezLiveSessionStatus, withRezLiveSession, STORAGE_PATH };
