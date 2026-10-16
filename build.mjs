import { build } from "esbuild";
import { mkdir, copyFile } from "node:fs/promises";
await mkdir("dist", { recursive: true });
await build({
  entryPoints: ["src/app.js"],
  bundle: true,
  format: "esm",
  minify: true,
  outfile: "dist/app.js",
  target: "chrome120",
  legalComments: "eof",
});
await Promise.all(
  ["index.html", "style.css"].map((file) =>
    copyFile(`src/${file}`, `dist/${file}`),
  ),
);
console.log("Browser bundle built.");
