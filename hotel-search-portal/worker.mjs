import { httpServerHandler } from "cloudflare:node";

// Mark this process so server.js does not start a traditional TCP listener
// or serve assets from the Node filesystem.
process.env.CLOUDFLARE = "true";

const { app, initPromise } = await import("./server.js");
await initPromise;
app.listen(3000);

const apiHandler = httpServerHandler({ port: 3000 });

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/") || url.pathname === "/health") {
      return apiHandler(request, env, ctx);
    }
    return env.ASSETS.fetch(request);
  },
};
