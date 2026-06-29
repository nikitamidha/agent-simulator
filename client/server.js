// ============================================================================
//  CLIENT SERVER  (port 3000)
// ============================================================================
//  A tiny static file server for the HTML/CSS/JS frontend in ./public.
//  Kept separate from the API server so the project literally "spawns both
//  the server and the client server" (see ../start.js). Dependency-free.
// ============================================================================

import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "public");
const PORT = process.env.AGENT_SIM_CLIENT_PORT || process.env.PORT || 3000;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
};

const server = http.createServer(async (req, res) => {
  // Resolve the request path safely inside PUBLIC_DIR (no path traversal).
  let pathname = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (pathname === "/") pathname = "/index.html";
  const filePath = normalize(join(PUBLIC_DIR, pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  try {
    const data = await readFile(filePath);
    const ext = filePath.slice(filePath.lastIndexOf("."));
    res.writeHead(200, {
      "content-type": TYPES[ext] || "application/octet-stream",
      "cache-control": "no-store", // always serve fresh UI during development
    });
    res.end(data);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
  }
});

server.listen(PORT, () => {
  console.log(`Client server listening on http://localhost:${PORT}`);
});
