import { fileURLToPath } from "node:url";
import { isAbsolute, relative } from "node:path";
import type { ResourceLink } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  ContainerService,
  ResolvedContainer,
  ResolvedModule,
} from "../container/service.js";
import { OkhError } from "../errors.js";
import { skillResourcePaths, type Skill } from "../modules/skills.js";
import { FileTreeResourceProvider, type FileTreeResourceEntry } from "./fileTree.js";
import { HubResourceProvider } from "./hub.js";
import { mimeTypeForPath } from "./moduleFiles.js";
import type { ResourceProvider } from "./types.js";
import {
  DOCS_URI_PREFIX,
  INSTRUCTIONS_URI_PREFIX,
  moduleFileUri,
} from "./uris.js";

const DOCS_ROOT = new URL("../../resources/docs/", import.meta.url);
const INSTRUCTIONS_ROOT = new URL("../../resources/instructions/", import.meta.url);

export class OkhResourceRegistry {
  readonly providers: readonly ResourceProvider[];

  constructor(
    readonly documentation: FileTreeResourceProvider,
    readonly instructions: FileTreeResourceProvider,
    readonly hub: HubResourceProvider,
  ) {
    this.providers = [hub, documentation, instructions];
  }

  async register(server: McpServer): Promise<void> {
    for (const provider of this.providers) await provider.register(server);
  }

  helpLinks(question?: string): ResourceLink[] {
    const docs = this.documentation.search(question)
      .map((entry) => this.documentation.link(entry));
    const common = question?.trim()
      ? this.instructions.search(question, 2, false)
        .map((entry) => this.instructions.link(entry))
      : this.instructions.search(undefined)
        .map((entry) => this.instructions.link(entry));
    return [...new Map([...docs, ...common].map((link) => [link.uri, link])).values()];
  }

  private bundledEntry(uri: string): {
    provider: FileTreeResourceProvider;
    entry: FileTreeResourceEntry;
  } | undefined {
    const docs = this.documentation.get(uri);
    if (docs) return { provider: this.documentation, entry: docs };
    const instructions = this.instructions.get(uri);
    if (instructions) return { provider: this.instructions, entry: instructions };
    return undefined;
  }

  async skillLinks(
    skill: Skill,
    target: ResolvedContainer,
    module: ResolvedModule,
  ): Promise<ResourceLink[]> {
    const links: ResourceLink[] = [];
    for (const uri of skill.resourceUris ?? []) {
      const bundled = this.bundledEntry(uri);
      if (!bundled) {
        if (uri.startsWith("okh://")) {
          throw new OkhError(
            "INVALID_MANIFEST",
            `Skill "${skill.name}" references unknown resource "${uri}".`,
          );
        }
        links.push({
          type: "resource_link",
          uri,
          name: uri,
          description: `Resource required by the "${skill.name}" skill.`,
        });
        continue;
      }
      links.push(bundled.provider.link(bundled.entry));
    }

    for (const absolutePath of await skillResourcePaths(skill)) {
      const relativePath = relative(module.absPath, absolutePath).replace(/\\/gu, "/");
      if (!relativePath || isAbsolute(relativePath) || relativePath.startsWith("../")) {
        throw new OkhError(
          "INVALID_MANIFEST",
          `Bundled skill "${skill.name}" must reference shared guidance through frontmatter resources.`,
        );
      }
      links.push({
        type: "resource_link",
        uri: moduleFileUri(target.name, module.path, relativePath),
        name: relativePath,
        description: `Bundled file for the "${skill.name}" skill.`,
        mimeType: mimeTypeForPath(relativePath),
        annotations: { audience: ["assistant"], priority: 0.7 },
      });
    }

    return [...new Map(links.map((link) => [link.uri, link])).values()];
  }
}

export async function registerResources(
  server: McpServer,
  service: ContainerService,
): Promise<OkhResourceRegistry> {
  const [documentation, instructions] = await Promise.all([
    FileTreeResourceProvider.load({
      id: "docs",
      root: fileURLToPath(DOCS_ROOT),
      uriPrefix: DOCS_URI_PREFIX,
      audience: ["user", "assistant"],
      priority: 0.8,
    }),
    FileTreeResourceProvider.load({
      id: "instructions",
      root: fileURLToPath(INSTRUCTIONS_ROOT),
      uriPrefix: INSTRUCTIONS_URI_PREFIX,
      audience: ["assistant"],
      priority: 0.9,
    }),
  ]);
  const registry = new OkhResourceRegistry(
    documentation,
    instructions,
    new HubResourceProvider(service),
  );
  await registry.register(server);
  return registry;
}
