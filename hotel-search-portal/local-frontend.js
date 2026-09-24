const http = require('http');
const fs = require('fs');
const path = require('path');

const FRONTEND_PORT = 3000;
const BACKEND_HOST = '127.0.0.1';
const BACKEND_PORT = 3001;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

function serveStatic(req, res) {
  let requestPath = decodeURIComponent(new URL(req.url, `http://${req.headers.host}`).pathname);

  if (requestPath === '/') {
    requestPath = '/index.html';
  }

  const filePath = path.resolve(PUBLIC_DIR, '.' + requestPath);

  if (!filePath.startsWith(path.resolve(PUBLIC_DIR) + path.sep)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();

    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });

    fs.createReadStream(filePath).pipe(res);
  });
}

function proxyApi(req, res) {
  const options = {
    hostname: BACKEND_HOST,
    port: BACKEND_PORT,
    path: req.url,
    method: req.method,
    headers: {
      ...req.headers,
      host: `${BACKEND_HOST}:${BACKEND_PORT}`
    }
  };

  const proxy = http.request(options, backendRes => {
    const headers = { ...backendRes.headers };

    // Explicitly preserve Set-Cookie from the backend.
    if (backendRes.headers['set-cookie']) {
      headers['set-cookie'] = backendRes.headers['set-cookie'];
    }

    res.writeHead(backendRes.statusCode || 502, headers);
    backendRes.pipe(res);
  });

  proxy.on('error', err => {
    console.error('API PROXY ERROR:', err.message);

    if (!res.headersSent) {
      res.writeHead(502, {
        'Content-Type': 'application/json; charset=utf-8'
      });
    }

    res.end(JSON.stringify({
      error: 'Backend unavailable',
      details: err.message
    }));
  });

  req.pipe(proxy);
}

const server = http.createServer((req, res) => {
  console.log(`${req.method} ${req.url}`);

  if (req.url.startsWith('/api/')) {
    return proxyApi(req, res);
  }

  serveStatic(req, res);
});

server.listen(FRONTEND_PORT, '127.0.0.1', () => {
  console.log('');
  console.log('========================================');
  console.log('FRONTEND READY');
  console.log('========================================');
  console.log(`Frontend: http://127.0.0.1:${FRONTEND_PORT}`);
  console.log(`Backend:  http://${BACKEND_HOST}:${BACKEND_PORT}`);
  console.log('API proxy: /api/* -> backend:3001');
  console.log('========================================');
  console.log('');
});

