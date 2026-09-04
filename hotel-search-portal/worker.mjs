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
      const handleRequest = await loadApp(env);
      return handleRequest(request);
    }
    return env.ASSETS.fetch(request);
  },
};
