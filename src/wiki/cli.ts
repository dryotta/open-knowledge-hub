import { buildAndPublishWiki } from "./publish.js";

export async function runWikiCli(argv: string[]): Promise<number> {
  // argv[0] === "wiki"
  const sub = argv[1];
  if (sub !== "publish") {
    process.stderr.write(`Usage: open-knowledge-hub wiki publish [--dry-run] [--repo <path>]\n`);
    return 2;
  }
  let dryRun = false;
  let repo = process.cwd();
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--repo") {
      repo = argv[i + 1] ?? repo;
      i += 1;
    } else {
      process.stderr.write(`Unknown argument: ${arg}\n`);
      return 2;
    }
  }
  const token = process.env.GITHUB_TOKEN || process.env.WIKI_TOKEN || undefined;
  try {
    const res = await buildAndPublishWiki(repo, { dryRun, token });
    process.stdout.write(
      `wiki ${res.outcome}: ${res.pages} pages, ${res.assets} assets` +
        (res.warnings.length ? `, ${res.warnings.length} warnings` : "") +
        (res.wikiUrl ? ` -> ${res.wikiUrl}` : "") +
        "\n",
    );
    for (const w of res.warnings) process.stdout.write(`  warning[${w.kind}]: ${w.message}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`wiki publish failed: ${(err as Error).message}\n`);
    return 1;
  }
}
