/* U25: real-Chrome contenteditable isContentEditable + category. */
"use strict";
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer-core");

const ROOT = path.resolve(__dirname, "..", "pagesense");

(async () => {
  const browser = await puppeteer.launch({
    executablePath: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    headless: false,
    args: ["--no-first-run", "--no-default-browser-check"]
  });
  const page = (await browser.pages())[0];
  await page.setViewport({ width: 1300, height: 1800 });
  await page.goto("http://127.0.0.1:8765/test/demo.html", { waitUntil: "networkidle0" });
  await page.evaluate(fs.readFileSync(path.join(ROOT, "shared", "constants.js"), "utf8"));
  await page.evaluate(fs.readFileSync(path.join(ROOT, "content", "element-map.js"), "utf8"));
  await page.evaluate(fs.readFileSync(path.join(ROOT, "content", "scanner.js"), "utf8"));
  const r = await page.evaluate(() => {
    const s = PageSenseScanner.scanPage();
    const ce = s.elements.find((e) => e.role === "textbox");
    return { contentEditable: ce.contentEditable, category: PAGESENSE.categorizeElement(ce) };
  });
  console.log(JSON.stringify(r));
  const pass = r.contentEditable === true && r.category === "input";
  console.log(pass ? "PASS  U25 contenteditable 真实浏览器 contentEditable + 分类" : "FAIL  U25");
  await browser.close();
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
