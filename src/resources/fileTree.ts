import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type {
  Annotations,
  ResourceLink,
} from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { parseFrontmatter, stringField } from "../util/frontmatter.js";
import type { ResourceProvider } from "./types.js";
import { fileTreeUri } from "./uris.js";

export interface FileTreeResourceConfig {
  id: string;
  root: string;
  uriPrefix: string;
  audience: Array<"user" | "assistant">;
  priority: number;
}

export interface FileTreeResourceEntry {
  path: string;
  uri: string;
  name: string;
  title: string;
  description: string;
  keywords: readonly string[];
  text: string;
  size: number;
  annotations: Annotations;
}

export interface FileTreeSearchOptions {
  limit?: number;
  fallback?: boolean;
  fields?: "all" | "keywords";
}

function titleFromBody(body: string, path: string): string {
  return /^#\s+(.+)$/mu.exec(body)?.[1]?.trim() ?? basename(path, ".md");
}

function descriptionFromBody(body: string): string {
  const paragraph = body
    .split(/\r?\n\r?\n/u)
    .map((part) => part.trim())
    .find((part) => part.length > 0 && !part.startsWith("#") && !part.startsWith("```"));
  if (!paragraph) return "";
  const singleLine = paragraph.replace(/\s+/gu, " ");
  return singleLine.length > 240 ? `${singleLine.slice(0, 237)}...` : singleLine;
}

const SEARCH_STOPWORDS = new Set([
  "about",
  "and",
  "are",
  "can",
  "could",
  "does",
  "explain",
  "for",
  "from",
  "have",
  "help",
  "how",
  "into",
  "please",
  "should",
  "show",
  "that",
  "the",
  "their",
  "there",
  "this",
  "use",
  "using",
  "was",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "with",
  "would",
  "you",
  "your",
]);

async function markdownPaths(root: string): Promise<string[]> {
  const paths: string[] = [];
  async function walk(dir: string, relativeDir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      const absolutePath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath, relativePath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        paths.push(relativePath);
      }
    }
  }
  await walk(root, "");
  return paths;
}

function searchTokens(query: string): string[] {
  return [...new Set(
    query
      .toLowerCase()
      .split(/[^a-z0-9]+/u)
      .filter((token) => token.length >= 3 && !SEARCH_STOPWORDS.has(token)),
  )];
}

export class FileTreeResourceProvider implements ResourceProvider {
  readonly id: string;
  readonly entries: readonly FileTreeResourceEntry[];
  private readonly byUri: Map<string, FileTreeResourceEntry>;

  private constructor(
    config: FileTreeResourceConfig,
    entries: FileTreeResourceEntry[],
  ) {
    this.id = config.id;
    this.entries = entries;
    this.byUri = new Map(entries.map((entry) => [entry.uri, entry]));
  }

  static async load(config: FileTreeResourceConfig): Promise<FileTreeResourceProvider> {
    const paths = await markdownPaths(config.root);
    if (paths.length === 0) {
      throw new Error(`Resource provider "${config.id}" has no Markdown files at ${config.root}.`);
    }
    const entries = await Promise.all(paths.map(async (path): Promise<FileTreeResourceEntry> => {
      const absolutePath = join(config.root, ...path.split("/"));
      const [raw, info] = await Promise.all([readFile(absolutePath, "utf8"), stat(absolutePath)]);
      const { data, body } = parseFrontmatter(raw);
      const text = `${body.trimEnd()}\n`;
      const title = stringField(data, "title")?.trim() || titleFromBody(text, path);
      const description =
        stringField(data, "description")?.trim() || descriptionFromBody(text);
      const rawKeywords = data["keywords"];
      if (
        rawKeywords !== undefined
        && (
          !Array.isArray(rawKeywords)
          || rawKeywords.some((keyword) => typeof keyword !== "string" || keyword.trim().length === 0)
        )
      ) {
        throw new Error(`Resource "${path}" frontmatter keywords must be non-empty strings.`);
      }
      const keywords = (rawKeywords as string[] | undefined)?.map((keyword) =>
        keyword.trim().toLowerCase()) ?? [];
      return {
        path,
        uri: fileTreeUri(config.uriPrefix, path),
        name: `${config.id}/${path}`,
        title,
        description,
        keywords,
        text,
        size: Buffer.byteLength(text),
        annotations: {
          audience: config.audience,
          priority: config.priority,
          lastModified: info.mtime.toISOString(),
        },
      };
    }));
    return new FileTreeResourceProvider(config, entries);
  }

  async register(server: McpServer): Promise<void> {
    for (const entry of this.entries) {
      server.registerResource(
        entry.name,
        entry.uri,
        {
          title: entry.title,
          description: entry.description,
          mimeType: "text/markdown",
          size: entry.size,
          annotations: entry.annotations,
        },
        async (uri) => ({
          contents: [{
            uri: uri.toString(),
            mimeType: "text/markdown",
            text: entry.text,
            annotations: entry.annotations,
          }],
        }),
      );
    }
  }

  get(uri: string): FileTreeResourceEntry | undefined {
    return this.byUri.get(uri);
  }

  link(entry: FileTreeResourceEntry): ResourceLink {
    return {
      type: "resource_link",
      uri: entry.uri,
      name: entry.name,
      title: entry.title,
      description: entry.description,
      mimeType: "text/markdown",
      annotations: entry.annotations,
    };
  }

  async resolveLink(uri: string): Promise<ResourceLink | undefined> {
    const entry = this.get(uri);
    return entry ? this.link(entry) : undefined;
  }

  search(
    query: string | undefined,
    options: FileTreeSearchOptions = {},
  ): FileTreeResourceEntry[] {
    const {
      limit = 4,
      fallback = true,
      fields = "all",
    } = options;
    if (!query?.trim()) {
      const index = this.entries.find((entry) => entry.path === "index.md");
      return fallback ? (index ? [index] : this.entries.slice(0, 1)) : [];
    }
    const normalizedQuery = query.toLowerCase();
    const tokens = searchTokens(query);
    const ranked = this.entries
      .map((entry) => {
        if (fields === "keywords") {
          const score = entry.keywords.reduce(
            (total, keyword) => total + (normalizedQuery.includes(keyword) ? 10 : 0),
            0,
          );
          return { entry, score };
        }
        const path = entry.path.toLowerCase();
        const title = entry.title.toLowerCase();
        const description = entry.description.toLowerCase();
        const body = entry.text.toLowerCase();
        const score = tokens.reduce((total, token) => (
          total
          + (title.includes(token) ? 8 : 0)
          + (path.includes(token) ? 5 : 0)
          + (description.includes(token) ? 3 : 0)
          + (body.includes(token) ? 1 : 0)
        ), 0);
        return { entry, score };
      })
      .filter(({ score }) => score > 0)
      .sort((left, right) => right.score - left.score || left.entry.path.localeCompare(right.entry.path))
      .slice(0, limit)
      .map(({ entry }) => entry);
    if (ranked.length > 0) return ranked;
    if (!fallback) return [];
    const index = this.entries.find((entry) => entry.path === "index.md");
    return index ? [index] : this.entries.slice(0, 1);
  }
}
