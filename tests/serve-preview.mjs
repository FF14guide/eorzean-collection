#!/usr/bin/env node
/**
 * Minimal local preview server for public/ assets.
 * Usage: node tests/serve-preview.mjs
 */
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const publicRoot = resolve(projectRoot, "public");
const port = Number(process.env.PORT || 4173);
const types = {
  ".html": "text/html; charset=utf-8",
  ".png": "image/png",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const server = http.createServer(async (request, response) => {
  const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
  const requested = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
  const file = resolve(publicRoot, requested);
  if (file !== publicRoot && !file.startsWith(`${publicRoot}${sep}`)) {
    response.writeHead(403).end("Forbidden");
    return;
  }
  try {
    const content = await readFile(file);
    response.writeHead(200, {
      "Content-Type": types[extname(file)] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    response.end(content);
  } catch {
    response.writeHead(404).end("Not found");
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Preview available at http://0.0.0.0:${port}`);
});
