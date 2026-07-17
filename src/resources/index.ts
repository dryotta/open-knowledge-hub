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
import { FileTreeResourceProvider } from "./fileTree.js";
import { ContainerResourceProvider } from "./hub.js";
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
    readonly containers: ContainerResourceProvider,
  ) {
    this.providers = [containers, documentation, instructions];
  }

  async register(server: McpServer): Promise<void> {
    for (const provider of this.providers) await provider.register(server);
  }

  helpLinks(question?: string): ResourceLink[] {
    const docs = this.documentation.search(question)
      .map((entry) => this.documentation.link(entry));
    const common = question?.trim()
      ? this.instructions.search(question, {
        limit: 2,
        fallback: false,
        fields: "keywords",
      })
        .map((entry) => this.instructions.link(entry))
      : this.instructions.search(undefined)
        .map((entry) => this.instructions.link(entry));
    return [...new Map([...docs, ...common].map((link) => [link.uri, link])).values()];
  }

  private async resolveLink(uri: string): Promise<ResourceLink | undefined> {
    for (const provider of this.providers) {
      const link = await provider.resolveLink?.(uri);
      if (link) return link;
    }
    return undefined;
  }

  async skillLinks(
    skill: Skill,
    target: ResolvedContainer,
    module: ResolvedModule,
  ): Promise<ResourceLink[]> {
    const links: ResourceLink[] = [];
    for (const uri of skill.resourceUris ?? []) {
      const link = await this.resolveLink(uri);
      if (!link) {
        throw new OkhError(
          "INVALID_MANIFEST",
          `Skill "${skill.name}" references a resource that this server cannot read: "${uri}".`,
        );
      }
      links.push(link);
    }

    for (const absolutePath of await skillResourcePaths(skill)) {
      const relativePath = relative(module.absPath, absolutePath).replace(/\\/gu, "/");
      if (!relativePath || isAbsolute(relativePath) || relativePath.startsWith("../")) {
        throw new OkhError(
          "INVALID_MANIFEST",
          `Bundled skill "${skill.name}" must reference shared guidance through frontmatter resources.`,
        );
      }
      const uri = moduleFileUri(target.name, module.path, relativePath);
      const link = await this.resolveLink(uri);
      if (!link) {
        throw new OkhError(
          "INVALID_MANIFEST",
          `Bundled file "${relativePath}" for skill "${skill.name}" cannot be read as an MCP resource.`,
        );
      }
      links.push({
        ...link,
        name: relativePath,
        description: `Bundled file for the "${skill.name}" skill.`,
        mimeType: mimeTypeForPath(relativePath),
        annotations: {
          ...link.annotations,
          audience: ["assistant"],
          priority: 0.7,
        },
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
    new ContainerResourceProvider(service),
  );
  await registry.register(server);
  return registry;
}
