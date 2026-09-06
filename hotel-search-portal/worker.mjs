export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/') || url.pathname === '/health') {
      const backend = String(env.BACKEND_URL || '').replace(/\/$/, '');
      if (!backend) {
        return new Response(JSON.stringify({ error: 'BACKEND_URL is not configured' }), {
          status: 503,
          headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
        });
      }
      const target = new URL(url.pathname + url.search, backend + '/');
      const headers = new Headers(request.headers);
      const proxyRequest = new Request(target.toString(), { method: request.method, headers, body: ['GET','HEAD'].includes(request.method) ? undefined : request.body, redirect: 'manual' });
      const response = await fetch(proxyRequest);
      const out = new Response(response.body, response);
      out.headers.set('cache-control', 'no-store');
      return out;
    }
    return env.ASSETS.fetch(request);
  }
};
