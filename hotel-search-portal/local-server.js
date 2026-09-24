const http = require('http');
const { handleRequest, initPromise } = require('./server');

const PORT = Number(process.env.PORT || 3001);

const server = http.createServer(async (req, res) => {
  try {
    const chunks = [];

    for await (const chunk of req) chunks.push(chunk);

    const body = Buffer.concat(chunks);

    const url = `http://127.0.0.1:${PORT}${req.url}`;

    const headers = new Headers();

    for (const [key, value] of Object.entries(req.headers)) {
      if (Array.isArray(value)) headers.set(key, value.join(', '));
      else if (value != null) headers.set(key, value);
    }

    const request = new Request(url, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : body
    });

    const response = await handleRequest(request);

    res.statusCode = response.status;

    response.headers.forEach((value, key) => {
      res.setHeader(key, value);
    });

    const responseBody = Buffer.from(await response.arrayBuffer());
    res.end(responseBody);
  } catch (err) {
    console.error('LOCAL BACKEND ERROR:', err);
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'Backend request failed' }));
  }
});

initPromise
  .then(() => {
    server.listen(PORT, '127.0.0.1', () => {
      console.log(`LOCAL BACKEND READY: http://127.0.0.1:${PORT}`);
    });
  })
  .catch(err => {
    console.error('DATABASE INIT FAILED:', err);
    process.exit(1);
  });
