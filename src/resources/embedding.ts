import type {
  EmbeddedResource,
  ReadResourceResult,
  ResourceLink,
} from "@modelcontextprotocol/sdk/types.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { OkhError } from "../errors.js";

export const MAX_EMBEDDED_RESOURCE_BYTES = 24 * 1024;
export const MAX_EMBEDDED_CONTEXT_BYTES = 64 * 1024;
export const MIN_READ_RESOURCE_CHUNK_BYTES = 256;
export const MAX_READ_RESOURCE_CHUNK_BYTES = 48 * 1024;

export interface EmbeddedResourceSelection {
  embeddedResources: EmbeddedResource[];
  embeddedUris: string[];
  deferredUris: string[];
}

export type BoundedResourceReader = (
  uri: string,
  maxBytes: number,
) => Promise<ReadResourceResult>;

export interface ResourceChunk {
  embeddedResource: EmbeddedResource;
  contentIndex: number;
  contentCount: number;
  offset: number;
  returnedBytes: number;
  totalBytes: number;
  nextOffset?: number;
  mimeType?: string;
}

function wireBytes(result: ReadResourceResult): number {
  return result.contents.reduce(
    (total, content) => total + Buffer.byteLength(
      "text" in content ? content.text : content.blob,
      "text" in content ? "utf8" : "ascii",
    ),
    0,
  );
}

export async function embedResourceLinks(
  links: readonly ResourceLink[],
  read: BoundedResourceReader,
  options: {
    maxResourceBytes?: number;
    maxTotalBytes?: number;
  } = {},
): Promise<EmbeddedResourceSelection> {
  const maxResourceBytes =
    options.maxResourceBytes ?? MAX_EMBEDDED_RESOURCE_BYTES;
  const maxTotalBytes =
    options.maxTotalBytes ?? MAX_EMBEDDED_CONTEXT_BYTES;
  const embeddedResources: EmbeddedResource[] = [];
  const embeddedUris: string[] = [];
  const deferredUris: string[] = [];
  let usedBytes = 0;

  for (const link of links) {
    const remaining = maxTotalBytes - usedBytes;
    const readLimit = Math.min(maxResourceBytes, remaining);
    if (
      readLimit <= 0
      || (link.size !== undefined && link.size > readLimit)
    ) {
      deferredUris.push(link.uri);
      continue;
    }

    let result: ReadResourceResult;
    try {
      result = await read(link.uri, readLimit);
    } catch (error) {
      if (error instanceof McpError && error.code === -32602) {
        deferredUris.push(link.uri);
        continue;
      }
      throw error;
    }

    const resultBytes = wireBytes(result);
    if (
      result.contents.length === 0
      || resultBytes > readLimit
    ) {
      deferredUris.push(link.uri);
      continue;
    }
    embeddedResources.push(...result.contents.map((resource) => ({
      type: "resource" as const,
      resource,
    })));
    embeddedUris.push(link.uri);
    usedBytes += resultBytes;
  }

  return { embeddedResources, embeddedUris, deferredUris };
}

function isUtf8Continuation(value: number): boolean {
  return (value & 0xc0) === 0x80;
}

export function chunkResourceResult(
  result: ReadResourceResult,
  options: {
    contentIndex?: number;
    offset?: number;
    maxBytes?: number;
  } = {},
): ResourceChunk {
  const contentIndex = options.contentIndex ?? 0;
  const offset = options.offset ?? 0;
  const maxBytes = options.maxBytes ?? MAX_READ_RESOURCE_CHUNK_BYTES;

  if (!Number.isInteger(contentIndex) || contentIndex < 0) {
    throw new OkhError("INVALID_ARGUMENT", "contentIndex must be a non-negative integer.");
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw new OkhError("INVALID_ARGUMENT", "offset must be a non-negative integer.");
  }
  if (
    !Number.isInteger(maxBytes)
    || maxBytes < MIN_READ_RESOURCE_CHUNK_BYTES
    || maxBytes > MAX_READ_RESOURCE_CHUNK_BYTES
  ) {
    throw new OkhError(
      "INVALID_ARGUMENT",
      `maxBytes must be between ${MIN_READ_RESOURCE_CHUNK_BYTES} and`
      + ` ${MAX_READ_RESOURCE_CHUNK_BYTES}.`,
    );
  }

  const content = result.contents[contentIndex];
  if (!content) {
    throw new OkhError(
      "NOT_FOUND",
      `Resource content ${contentIndex} does not exist;`
      + ` the resource returned ${result.contents.length} content item(s).`,
    );
  }

  const source = "text" in content
    ? Buffer.from(content.text, "utf8")
    : Buffer.from(content.blob, "base64");
  if (offset > source.length) {
    throw new OkhError(
      "INVALID_ARGUMENT",
      `offset ${offset} exceeds the resource size of ${source.length} bytes.`,
    );
  }
  if (
    "text" in content
    && offset < source.length
    && isUtf8Continuation(source[offset]!)
  ) {
    throw new OkhError(
      "INVALID_ARGUMENT",
      "offset must be a UTF-8 character boundary; use the previous result's nextOffset.",
    );
  }

  let end = Math.min(source.length, offset + maxBytes);
  if ("text" in content) {
    while (end < source.length && isUtf8Continuation(source[end]!)) end -= 1;
  }
  const chunk = source.subarray(offset, end);
  const resource = "text" in content
    ? { ...content, text: chunk.toString("utf8") }
    : { ...content, blob: chunk.toString("base64") };
  const nextOffset = end < source.length ? end : undefined;

  return {
    embeddedResource: { type: "resource", resource },
    contentIndex,
    contentCount: result.contents.length,
    offset,
    returnedBytes: chunk.length,
    totalBytes: source.length,
    ...(nextOffset !== undefined ? { nextOffset } : {}),
    ...(content.mimeType ? { mimeType: content.mimeType } : {}),
  };
}
