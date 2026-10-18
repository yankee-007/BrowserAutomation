/* Minimal static file server for the PageSense demo page.
 * Usage: node serve.js [port] [rootDir]
 * Default port 8765, default root ../pagesense
 * The port matters: acceptance scripts query tabs by URL, so demo and
 * harness must agree (DEMO_PORT env var, see v2-*.js).
 */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.argv[2] || process.env.DEMO_PORT || 8765);
const ROOT = path.resolve(process.argv[3] || path.join(__dirname, "..", "pagesense"));

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split("?")[0]);
  let filePath = path.join(ROOT, urlPath);
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  fs.stat(filePath, (err, stat) => {
    if (!err && stat.isDirectory()) {
      filePath = path.join(filePath, "index.html");
    }
    fs.readFile(filePath, (err2, data) => {
      if (err2) {
        res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
        return;
      }
      res.writeHead(200, {
        "Content-Type": TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream",
        "Cache-Control": "no-store"
      });
      res.end(data);
    });
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`demo server: http://127.0.0.1:${PORT}/  root=${ROOT}`);
});
