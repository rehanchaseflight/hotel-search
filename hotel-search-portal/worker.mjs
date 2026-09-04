let appPromise;

async function loadApp(env) {
  globalThis.__WORKER_ENV = env;
  process.env.CLOUDFLARE = "true";
  if (env.JWT_SECRET) process.env.JWT_SECRET = env.JWT_SECRET;
  if (env.DATABASE_URL) process.env.DATABASE_URL = env.DATABASE_URL;
  if (!appPromise) {
    appPromise = import("./server.js").then(async ({ handleRequest, initPromise }) => {
      await initPromise;
      return handleRequest;
    });
  }
  return appPromise;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/") || url.pathname === "/health") {
      try {
        const handleRequest = await loadApp(env);
        return await handleRequest(request);
      } catch (error) {
        console.error("Worker application error:", error);
        if (url.pathname === "/health") {
          return new Response(JSON.stringify({ ok: false, error: error?.message || "Worker application error" }), {
            status: 503,
            headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
          });
        }
        return new Response(JSON.stringify({ error: "Request failed" }), {
          status: 500,
          headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
        });
      }
    }
    return env.ASSETS.fetch(request);
  },
};
