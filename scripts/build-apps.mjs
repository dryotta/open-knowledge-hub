import { mkdir, copyFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

await import("./build-todo-app.mjs");

const entryPath = fileURLToPath(new URL("../app/web/main.ts", import.meta.url));
const outputDir = new URL("../dist/web-app/", import.meta.url);
const assetsDir = new URL("assets/", outputDir);

await Promise.all([
  rm(outputDir, { recursive: true, force: true }),
  rm(new URL("../dist/web/assets/", import.meta.url), { recursive: true, force: true }),
  rm(new URL("../dist/web/index.html", import.meta.url), { force: true }),
]);
await mkdir(assetsDir, { recursive: true });
await build({
  entryPoints: [entryPath],
  outfile: fileURLToPath(new URL("app.js", assetsDir)),
  platform: "browser",
  format: "esm",
  target: "es2022",
  bundle: true,
  minify: true,
});
await Promise.all([
  copyFile(new URL("../app/web/index.html", import.meta.url), new URL("index.html", outputDir)),
  copyFile(new URL("../app/web/styles.css", import.meta.url), new URL("styles.css", assetsDir)),
]);
