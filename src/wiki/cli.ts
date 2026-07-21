import { buildAndPublishWiki } from "./publish.js";
import { reverseSyncWiki } from "./reverse.js";

const USAGE = `Usage: open-knowledge-hub wiki <publish|reverse> [--dry-run] [--repo <path>]\n`;

type ParsedArgs = { dryRun: boolean; repo: string } | { error: string };

function parseArgs(argv: string[]): ParsedArgs {
  let dryRun = false;
  let repo = process.cwd();
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--repo") {
      repo = argv[i + 1] ?? repo;
      i += 1;
    } else {
      return { error: `Unknown argument: ${arg}` };
    }
  }
  return { dryRun, repo };
}

function token(): string | undefined {
  return process.env.GITHUB_TOKEN || process.env.WIKI_TOKEN || undefined;
}

export async function runWikiCli(argv: string[]): Promise<number> {
  // argv[0] === "wiki"
  const sub = argv[1];
  if (sub !== "publish" && sub !== "reverse") {
    process.stderr.write(USAGE);
    return 2;
  }
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    process.stderr.write(`${parsed.error}\n`);
    return 2;
  }

  if (sub === "publish") return runPublish(parsed.repo, parsed.dryRun);
  return runReverse(parsed.repo, parsed.dryRun);
}

async function runPublish(repo: string, dryRun: boolean): Promise<number> {
  try {
    const res = await buildAndPublishWiki(repo, { dryRun, token: token() });
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

async function runReverse(repo: string, dryRun: boolean): Promise<number> {
  try {
    const res = await reverseSyncWiki(repo, { dryRun, token: token(), runId: process.env.GITHUB_RUN_ID });
    const { added, modified, deleted, renamed } = res.counts;
    let line = `wiki reverse ${res.outcome}: ${res.changed} changed (A${added} M${modified} D${deleted} R${renamed})`;
    if (res.prUrl) line += ` -> ${res.prUrl}`;
    else if (res.commit) line += ` -> ${res.commit.slice(0, 7)}`;
    process.stdout.write(line + "\n");
    return 0;
  } catch (err) {
    process.stderr.write(`wiki reverse failed: ${(err as Error).message}\n`);
    return 1;
  }
}
