import { createHash } from "node:crypto";
import type { InlineDockerfile } from "@alchemy.run/docker/Dockerfile";
import * as image from "@distilled.cloud/modal/image";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/**
 * A Dockerfile instruction Modal's image builder doesn't run. Modal builds
 * images with its own builder (not Docker): it ignores `USER` (containers run
 * as root) and doesn't implement `EXPOSE`, `HEALTHCHECK`, `LABEL`, `ONBUILD`,
 * `STOPSIGNAL` or `VOLUME`. Reported at plan, before anything is uploaded.
 */
export class ImageDockerfileUnsupported extends Data.TaggedError(
  "Modal.ImageDockerfileUnsupported",
)<{
  readonly instruction: string;
  readonly line: number;
  readonly message: string;
}> {}

/** Modal's builder finished the image build with a failure. */
export class ImageBuildFailed extends Data.TaggedError("Modal.ImageBuildFailed")<{
  readonly imageId: string;
  readonly status: string;
  readonly message: string;
  /** The last lines the build printed. */
  readonly logs: string;
}> {}

/** The build didn't finish within its time budget. */
export class ImageBuildTimeout extends Data.TaggedError("Modal.ImageBuildTimeout")<{
  readonly imageId: string;
  readonly message: string;
}> {}

/** Instructions Modal's builder rejects or silently ignores. */
const UNSUPPORTED: Record<string, string> = {
  USER: "Modal ignores USER: containers run as root. Remove it.",
  EXPOSE: "Modal doesn't implement EXPOSE. Open ports when creating a sandbox instead.",
  HEALTHCHECK: "Modal doesn't implement HEALTHCHECK. Use a sandbox readiness probe instead.",
  LABEL: "Modal doesn't implement LABEL. Remove it.",
  ONBUILD: "Modal doesn't implement ONBUILD. Remove it.",
  STOPSIGNAL: "Modal doesn't implement STOPSIGNAL. Remove it.",
  VOLUME: "Modal doesn't implement VOLUME. Mount a Modal.Volume instead.",
};

/** One Dockerfile instruction, with continuation lines joined. */
export interface DockerfileInstruction {
  readonly keyword: string;
  readonly args: string;
  readonly line: number;
  readonly text: string;
}

/** Split Dockerfile text into instructions (comments dropped, continuations joined). */
export const parseDockerfile = (text: string): DockerfileInstruction[] => {
  const out: DockerfileInstruction[] = [];
  const lines = text.split(/\r?\n/);
  let buffer = "";
  let start = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const trimmed = raw.trim();
    if (buffer === "" && (trimmed === "" || trimmed.startsWith("#"))) continue;
    if (buffer === "") start = i + 1;
    if (trimmed.endsWith("\\")) {
      buffer += `${trimmed.slice(0, -1)} `;
      continue;
    }
    buffer += trimmed;
    const match = /^(\S+)\s*(.*)$/s.exec(buffer);
    if (match) {
      out.push({
        keyword: match[1]!.toUpperCase(),
        args: match[2]!.trim(),
        line: start,
        text: buffer,
      });
    }
    buffer = "";
  }
  return out;
};

/** Fail with {@link ImageDockerfileUnsupported} on the first instruction Modal can't run. */
export const validateDockerfile = (instructions: ReadonlyArray<DockerfileInstruction>) => {
  for (const instruction of instructions) {
    const reason = UNSUPPORTED[instruction.keyword];
    if (reason !== undefined) {
      return Effect.fail(
        new ImageDockerfileUnsupported({
          instruction: instruction.keyword,
          line: instruction.line,
          message: `Line ${instruction.line} (${instruction.text}): ${reason}`,
        }),
      );
    }
  }
  return Effect.void;
};

/** Local paths a COPY/ADD instruction reads from the build context. */
const copySources = (instruction: DockerfileInstruction): string[] => {
  if (instruction.keyword !== "COPY" && instruction.keyword !== "ADD") return [];
  let args = instruction.args;
  const flags: string[] = [];
  while (args.startsWith("--")) {
    const match = /^(--\S+)\s*(.*)$/s.exec(args);
    if (!match) break;
    flags.push(match[1]!);
    args = match[2]!;
  }
  // `COPY --from=stage` copies from another stage, not the context.
  if (flags.some((flag) => flag.startsWith("--from"))) return [];
  let parts: string[];
  if (args.startsWith("[")) {
    try {
      parts = JSON.parse(args) as string[];
    } catch {
      parts = [];
    }
  } else {
    parts = args.split(/\s+/).filter(Boolean);
  }
  return parts.slice(0, -1).filter((source) => !/^[a-z]+:\/\//i.test(source));
};

/** A file sent to Modal's builder as part of the build context. */
export interface ContextFile {
  readonly filename: string;
  readonly data: Uint8Array;
}

/**
 * The files the Dockerfile's COPY/ADD instructions read from `context`:
 * each source path (a file, or a directory walked recursively), keyed by
 * its path relative to the context.
 */
export const collectContextFiles = Effect.fn(function* (
  instructions: ReadonlyArray<DockerfileInstruction>,
  context: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.resolve(context);
  const files = new Map<string, Uint8Array>();
  const add = Effect.fn(function* (absolute: string): Effect.fn.Return<void, any> {
    const info = yield* fs.stat(absolute);
    if (info.type === "Directory") {
      for (const entry of yield* fs.readDirectory(absolute)) {
        yield* add(path.join(absolute, entry));
      }
      return;
    }
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    if (!files.has(relative)) files.set(relative, yield* fs.readFile(absolute));
  });
  for (const instruction of instructions) {
    for (const source of copySources(instruction)) {
      if (/[*?[]/.test(source)) {
        // A glob: send the directory it lives in.
        const dir = path.join(root, path.dirname(source));
        if (yield* fs.exists(dir)) yield* add(dir);
        continue;
      }
      const absolute = path.join(root, source);
      if (yield* fs.exists(absolute)) yield* add(absolute);
    }
  }
  return [...files].map(([filename, data]) => ({ filename, data }) satisfies ContextFile);
});

/** What an image is built from, after Dockerfile lowering. */
export interface ImageBuildSpec {
  /** A registry image to start from (`FROM <ref>`). */
  readonly dockerTag?: string;
  /** A Modal image to start from. */
  readonly baseImageId?: string;
  /**
   * Dockerfile commands. With `dockerTag`/`baseImageId` they follow the
   * generated `FROM`; otherwise they are a whole Dockerfile.
   */
  readonly commands: ReadonlyArray<string>;
  readonly contextFiles?: ReadonlyArray<ContextFile>;
  /** Secrets (ids) the build steps see as environment variables. */
  readonly secretIds?: ReadonlyArray<string>;
  /** Credentials to pull a private base image. */
  readonly registry?: {
    readonly authType: "aws" | "gcp" | "static";
    readonly secretId: string;
  };
  /** Run the build on a GPU (`"A10G"`, `"H100"`, ...). */
  readonly gpu?: string;
  readonly builderVersion?: string;
  readonly forceBuild?: boolean;
}

const AUTH_TYPE = {
  aws: "REGISTRY_AUTH_TYPE_AWS",
  gcp: "REGISTRY_AUTH_TYPE_GCP",
  static: "REGISTRY_AUTH_TYPE_STATIC_CREDS",
} as const;

/** A `"A100-80GB:2"`-style GPU spec as Modal's `GPUConfig`. */
export const gpuConfig = (gpu: string | undefined): image.GPUConfig | undefined => {
  if (gpu === undefined) return undefined;
  const [type, count] = gpu.split(":");
  return { gpuType: type!.toUpperCase(), count: count ? Number(count) : 1 };
};

const FINISHED = (status: string | undefined) =>
  status !== undefined && status !== "GENERIC_STATUS_UNSPECIFIED";

/**
 * Build (or reuse) an image with Modal's builder and wait until it is ready.
 * Modal content-addresses images, so the same spec returns the same image
 * without rebuilding. Fails with {@link ImageBuildFailed} on a failed build.
 */
export const buildImage = Effect.fn(function* (
  appId: string,
  spec: ImageBuildSpec,
  options: { readonly note?: (message: string) => Effect.Effect<void> } = {},
) {
  const from = spec.baseImageId
    ? { baseImages: [{ imageId: spec.baseImageId, dockerTag: "base" }], first: ["FROM base"] }
    : spec.dockerTag
      ? { baseImages: [], first: [`FROM ${spec.dockerTag}`] }
      : { baseImages: [], first: [] as string[] };
  const contextFiles = yield* Effect.sync(() =>
    (spec.contextFiles ?? []).map((file) => ({
      filename: file.filename,
      data: Buffer.from(file.data).toString("base64"),
    })),
  );
  const created = yield* image.imageGetOrCreate({
    appId,
    image: {
      baseImages: from.baseImages,
      dockerfileCommands: [...from.first, ...spec.commands],
      contextFiles,
      secretIds: spec.secretIds ? [...spec.secretIds] : undefined,
      imageRegistryConfig: spec.registry
        ? { registryAuthType: AUTH_TYPE[spec.registry.authType], secretId: spec.registry.secretId }
        : undefined,
      gpuConfig: gpuConfig(spec.gpu),
    },
    builderVersion: spec.builderVersion,
    forceBuild: spec.forceBuild,
  });
  const imageId = created.imageId;
  if (!imageId) {
    return yield* new ImageBuildFailed({
      imageId: "",
      status: "GENERIC_STATUS_UNSPECIFIED",
      message: "Modal returned no image id",
      logs: "",
    });
  }
  let result = created.result;
  let lastEntryId: string | undefined;
  const logs: string[] = [];
  // Each join call streams build logs for up to ~55 s; a build may take many.
  for (let attempt = 0; !FINISHED(result?.status) && attempt < 60; attempt++) {
    if (attempt === 0 && options.note) yield* options.note(`Building image ${imageId}...`);
    const { items } = yield* image.imageJoinStreaming({
      imageId,
      timeout: 55,
      lastEntryId,
      includeLogsForFinished: true,
    });
    for (const item of items) {
      if (item.entryId) lastEntryId = item.entryId;
      for (const log of item.taskLogs ?? []) {
        if (log.data) logs.push(log.data);
      }
      if (FINISHED(item.result?.status)) result = item.result;
    }
  }
  if (!FINISHED(result?.status)) {
    return yield* new ImageBuildTimeout({
      imageId,
      message: `Modal image ${imageId} was still building after 55 minutes`,
    });
  }
  if (result?.status !== "GENERIC_STATUS_SUCCESS") {
    return yield* new ImageBuildFailed({
      imageId,
      status: result?.status ?? "GENERIC_STATUS_UNSPECIFIED",
      message: result?.exception || `Modal image build ${imageId} ended with ${result?.status}`,
      logs: logs.join("").split("\n").slice(-40).join("\n"),
    });
  }
  return imageId;
});

/** An environment for an image: a registry ref, or Dockerfile text plus context files. */
export interface ImageEnvironment {
  /** A registry image (`node:22-slim`, `ghcr.io/org/base:1`). */
  readonly image?: string;
  /**
   * A Dockerfile: a path (read from {@link context}) or inline content
   * (`Dockerfile.inline\`…\``).
   */
  readonly dockerfile?: string | InlineDockerfile;
  /**
   * Build context for a Dockerfile's COPY/ADD sources.
   * @default the Dockerfile's directory (a path), or the working directory (inline)
   */
  readonly context?: string;
  /** Dockerfile lines appended after the environment (`"RUN pip install pandas"`). */
  readonly commands?: ReadonlyArray<string>;
}

/**
 * Lower an {@link ImageEnvironment} to an {@link ImageBuildSpec}: validate the
 * Dockerfile against what Modal's builder runs, and collect the context
 * files its COPY/ADD instructions read.
 */
export const lowerImageEnvironment = Effect.fn(function* (env: ImageEnvironment) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const extra = [...(env.commands ?? [])];
  yield* validateDockerfile(parseDockerfile(extra.join("\n")));
  if (env.dockerfile === undefined) {
    return {
      dockerTag: env.image ?? "debian:bookworm-slim",
      commands: extra,
    } satisfies ImageBuildSpec;
  }
  const text =
    typeof env.dockerfile === "string"
      ? yield* fs.readFileString(path.resolve(env.dockerfile))
      : String(env.dockerfile.content);
  const context =
    env.context ?? (typeof env.dockerfile === "string" ? path.dirname(env.dockerfile) : ".");
  const instructions = parseDockerfile(text);
  yield* validateDockerfile(instructions);
  const contextFiles = yield* collectContextFiles(instructions, context);
  return {
    commands: [...instructions.map((instruction) => instruction.text), ...extra],
    contextFiles,
  } satisfies ImageBuildSpec;
});

/** A stable hash of a build spec, to detect a changed environment at plan. */
export const hashImageSpec = (spec: ImageBuildSpec) =>
  Effect.sync(() => {
    const hasher = createHash("sha256");
    hasher.update(
      JSON.stringify({
        tag: spec.dockerTag,
        base: spec.baseImageId,
        commands: spec.commands,
        secrets: spec.secretIds,
        registry: spec.registry,
        gpu: spec.gpu,
        builder: spec.builderVersion,
      }),
    );
    for (const file of spec.contextFiles ?? []) {
      hasher.update(file.filename);
      hasher.update(file.data);
    }
    return hasher.digest("hex");
  });
