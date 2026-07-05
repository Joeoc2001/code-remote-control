import { readFileSync, writeFileSync } from "node:fs";

const [, , indexPath, fontPath, outPath, fontFamily] = process.argv;

if (!indexPath || !fontPath || !outPath || !fontFamily) {
  throw new Error(
    "usage: build-ttyd-index.mjs <index.html> <font> <out.html> <font-family>",
  );
}

const isWoff2 = fontPath.endsWith(".woff2");
const mime = isWoff2 ? "font/woff2" : "font/ttf";
const format = isWoff2 ? "woff2" : "truetype";

const index = readFileSync(indexPath, "utf8");
const fontBase64 = readFileSync(fontPath).toString("base64");

const marker = "</head>";
if (!index.includes(marker)) {
  throw new Error("ttyd index.html is missing a </head> tag");
}

const injection =
  `<style>@font-face{font-family:'${fontFamily}';` +
  `src:url(data:${mime};base64,${fontBase64}) format('${format}');` +
  `font-display:swap;}</style>` +
  `<script>document.fonts.load("16px '${fontFamily}'").then(function(){` +
  `window.dispatchEvent(new Event('resize'));});</script>`;

writeFileSync(outPath, index.replace(marker, `${injection}${marker}`));
