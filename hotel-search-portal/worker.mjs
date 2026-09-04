process.env.CLOUDFLARE = "true";

const { handleRequest, initPromise } = await import("./server.js");
await initPromise;

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/") || url.pathname === "/health") {
      return handleRequest(request);
    }
    return new Response("Not found", { status: 404 });
  },
};
