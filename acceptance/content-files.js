/* Single source of truth for the acceptance harness: the Content Script file
 * list is read straight out of the extension source instead of being copied
 * into every test. A hardcoded copy silently goes stale whenever a module is
 * added (exactly what happened when V2.0 introduced element-search.js), and a
 * partial injection then fails deep inside the Content Script.
 */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "pagesense");

/** Extract the CONTENT_FILES array literal from a source file. */
function extractFrom(relativePath) {
  const src = fs.readFileSync(path.join(ROOT, relativePath), "utf8");
  const match = src.match(/CONTENT_FILES\s*=\s*\[([\s\S]*?)\]/);
  if (!match) {
    throw new Error(`CONTENT_FILES not found in ${relativePath}`);
  }
  return Array.from(match[1].matchAll(/"([^"]+)"/g)).map((m) => m[1]);
}

/**
 * The injection list used by every harness. Taken from the Popup (the path a
 * user takes) and cross-checked against the Controller Bridge (the path
 * Python takes), so a divergence between the two is a hard error here too.
 */
function contentFiles() {
  const fromPopup = extractFrom("popup/popup.js");
  const fromBridge = extractFrom("bridge/controller-bridge.js");
  if (JSON.stringify(fromPopup) !== JSON.stringify(fromBridge)) {
    throw new Error(
      "CONTENT_FILES differ between popup.js and controller-bridge.js:\n" +
      `  popup:  ${fromPopup.join(", ")}\n  bridge: ${fromBridge.join(", ")}`
    );
  }
  return fromPopup;
}

module.exports = { contentFiles, extractFrom, ROOT };
