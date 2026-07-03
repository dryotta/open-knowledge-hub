import "tsx/cjs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const mod = require("./copilotProvider.ts");

export default mod.default;
