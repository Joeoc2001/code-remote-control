import { readFileSync, writeFileSync } from "node:fs";

const [, , indexPath, fontPath, outPath, fontFamily] = process.argv;

if (!indexPath || !fontPath || !outPath || !fontFamily) {
  throw new Error(
    "usage: build-ttyd-index.mjs <index.html> <font> <out.html> <font-family>",
  );
}

const index = readFileSync(indexPath, "utf8");
const fontBase64 = readFileSync(fontPath).toString("base64");

const marker = "</head>";
if (!index.includes(marker)) {
  throw new Error("ttyd index.html is missing a </head> tag");
}

const injection = `<script>
(function () {
  var bin = atob("${fontBase64}");
  var bytes = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  var face = new FontFace(${JSON.stringify(fontFamily)}, bytes.buffer);
  document.fonts.add(face);
  face.loaded.then(function () {
    window.dispatchEvent(new Event("resize"));
  });
})();
</script>`;

writeFileSync(outPath, index.replace(marker, `${injection}${marker}`));
