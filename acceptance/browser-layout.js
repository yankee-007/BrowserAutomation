/* Real-browser layout E2E (acceptance spec sections 10, 11, 23).
 * Launches real Edge with puppeteer-core, loads the REAL scanner into the
 * REAL demo page, and verifies viewport logic, coordinate systems and
 * repeated scans against an actual layout engine. */
"use strict";
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer-core");

const ROOT = path.resolve(__dirname, "..", "pagesense");
const constantsSrc = fs.readFileSync(path.join(ROOT, "shared", "constants.js"), "utf8");
const elementMapSrc = fs.readFileSync(path.join(ROOT, "content", "element-map.js"), "utf8");
const scannerSrc = fs.readFileSync(path.join(ROOT, "content", "scanner.js"), "utf8");
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

let failures = 0;
function check(id, name, cond, detail) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${id} ${name}` + (cond ? "" : `  -> ${detail || ""}`));
  if (!cond) failures++;
}
function eq(id, name, actual, expected) {
  check(id, name, actual === expected, `expected ${expected} got ${actual}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: false,
    args: ["--no-first-run", "--no-default-browser-check", "--window-size=1300,900"]
  });
  const page = (await browser.pages())[0];
  await page.setViewport({ width: 1300, height: 900 });
  await page.goto("http://127.0.0.1:8765/test/demo.html", { waitUntil: "networkidle0" });
  await page.evaluate(constantsSrc);
  await page.evaluate(elementMapSrc);
  await page.evaluate(scannerSrc);

  /* Section 10: visible vs inViewport at top of page */
  let scan = await page.evaluate(() => PageSenseScanner.scanPage());
  const bottom = scan.elements.find((e) => e.id === "bottomButton");
  check("B01a", "底部按钮 visible=true", bottom.visible === true);
  check("B01b", "底部按钮 inViewport=false（不在视口≠不可见）", bottom.inViewport === false,
    JSON.stringify(bottom.position));
  const topBtn = scan.elements.find((e) => e.text === "立即沟通");
  check("B02", "顶部按钮 inViewport=true", topBtn.inViewport === true);

  /* Section 9 in real engine */
  eq("B03", "真实浏览器过滤 6 个隐藏元素", scan.stats.hidden, 6);
  check("B03b", "display:none 等元素不在列表",
    !scan.elements.some((e) => /隐藏按钮|零尺寸/.test(e.text)));

  /* Section 11: coordinate relations before scroll */
  check("B04a", "pageX = left + scrollX (scroll=0)",
    bottom.position.pageX === bottom.position.left);
  check("B04b", "pageY = top + scrollY (scroll=0)",
    bottom.position.pageY === bottom.position.top);
  check("B04c", "坐标字段完整",
    ["x", "y", "pageX", "pageY", "width", "height", "top", "right", "bottom", "left"]
      .every((k) => typeof bottom.position[k] === "number"));

  /* Scroll to bottom and re-scan */
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await sleep(600);
  scan = await page.evaluate(() => PageSenseScanner.scanPage());
  const bottom2 = scan.elements.find((e) => e.id === "bottomButton");
  check("B05a", "滚动后底部按钮 inViewport=true", bottom2.inViewport === true,
    JSON.stringify(bottom2.position));
  check("B05b", "滚动后 x/y 为视口坐标（y 较小）",
    bottom2.position.y < 900 && bottom2.position.y >= 0, "y=" + bottom2.position.y);
  check("B05c", "pageY 为页面绝对坐标（保持大值）",
    bottom2.position.pageY > 1000, "pageY=" + bottom2.position.pageY);
  check("B05d", "关系 pageY = top + scrollY 成立",
    bottom2.position.pageY === bottom2.position.top + scan.page.scroll.y,
    `pageY=${bottom2.position.pageY} top=${bottom2.position.top} scrollY=${scan.page.scroll.y}`);
  check("B05e", "关系 pageX = left + scrollX 成立",
    bottom2.position.pageX === bottom2.position.left + scan.page.scroll.x);
  const top2 = scan.elements.find((e) => e.text === "立即沟通");
  check("B06", "滚动后顶部按钮 visible=true 且 inViewport=false",
    top2.visible === true && top2.inViewport === false);

  /* stats consistency in real browser after scroll */
  check("B07a", "stats.total === elements.length",
    scan.stats.total === scan.elements.length);
  check("B07b", "stats.inViewport 与数据一致",
    scan.stats.inViewport === scan.elements.filter((e) => e.inViewport).length);

  /* Section 23: 20 repeated scans */
  let allOk = true;
  let idSig = null;
  for (let i = 0; i < 20; i++) {
    const s = await page.evaluate(() => PageSenseScanner.scanPage());
    const ids = s.elements.map((e) => e.elementId);
    const sig = ids.join(",");
    if (idSig === null) idSig = sig;
    if (sig !== idSig || new Set(ids).size !== ids.length || s.elements.length !== s.stats.total) {
      allOk = false;
    }
  }
  check("B08", "连续 20 次扫描：结构合法、id 唯一、结果稳定", allOk);

  await page.screenshot({ path: path.join(__dirname, "evidence-bottom.png") });

  await browser.close();
  console.log(`\nBROWSER LAYOUT SUMMARY: ${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error("HARNESS ERROR:", e);
  process.exit(1);
});
