"use strict";
const puppeteer = require("puppeteer-core");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9226" });
  const pages = await browser.pages();
  const demo = pages.find((p) => p.url().includes("demo.html"));
  const ext = pages.find((p) => p.url().startsWith("chrome-extension"));
  await demo.bringToFront();
  await demo.setViewport({ width: 1300, height: 900 });
  await demo.evaluate(() => {
    document.getElementById("restoreTargetBtn").click();
    window.scrollTo(0, 0);
  });
  await sleep(500);

  // find bottomButton elementId via a fresh scan
  const setup = await ext.evaluate(async () => {
    const tabs = await chrome.tabs.query({ url: "http://127.0.0.1:8765/test/demo.html" });
    const r = await chrome.tabs.sendMessage(tabs[0].id, { action: PAGESENSE.ACTIONS.SCAN_PAGE });
    return { tabId: tabs[0].id, id: r.data.elements.find((e) => e.id === "bottomButton").elementId };
  });

  await ext.evaluate(async (tid, id) => {
    await chrome.tabs.sendMessage(tid, { action: PAGESENSE.ACTIONS.LOCATE_ELEMENT, elementId: id });
  }, setup.tabId, setup.id);

  for (let i = 0; i < 10; i++) {
    const s = await demo.evaluate(() => {
      const r = document.getElementById("bottomButton").getBoundingClientRect();
      return { y: Math.round(window.scrollY), top: Math.round(r.top), h: window.innerHeight };
    });
    console.log(`t=${i * 400}ms scrollY=${s.y} rect.top=${s.top} innerH=${s.h} center=${s.h / 2}`);
    await sleep(400);
  }
  await browser.disconnect();
})();
