import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const htmlPath = new URL("../app/todos/index.html", import.meta.url);
const entryPath = fileURLToPath(new URL("../app/todos/main.ts", import.meta.url));
const outputPath = new URL("../dist/apps/todos.html", import.meta.url);
const placeholder = "<!-- APP_SCRIPT -->";

const result = await build({
  entryPoints: [entryPath],
  platform: "browser",
  format: "esm",
  target: "es2022",
  bundle: true,
  minify: true,
  write: false,
});

const javascript = result.outputFiles?.find((file) => file.path.endsWith(".js") || file.path === "<stdout>")?.text;
if (!javascript) {
  throw new Error("Todo app build produced no JavaScript output.");
}

const html = await readFile(htmlPath, "utf8");
const placeholderCount = html.split(placeholder).length - 1;
if (placeholderCount !== 1) {
  throw new Error(`Todo app HTML must contain exactly one ${placeholder}; found ${placeholderCount}.`);
}

const safeJavascript = javascript.replace(/<\/script/gi, "<\\/script");
const bundledHtml = html.replace(placeholder, () => `<script type="module">${safeJavascript}</script>`);

await mkdir(new URL("./", outputPath), { recursive: true });
await writeFile(outputPath, bundledHtml, "utf8");
