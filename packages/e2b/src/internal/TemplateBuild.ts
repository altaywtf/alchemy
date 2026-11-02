/**
 * Plans and runs an E2B template build. Shared by the `E2B.Template`
 * resource and the runtime `E2B.CreateTemplate` binding, so a template
 * built at deploy time and one built at runtime from the same props are the
 * same build.
 *
 * E2B builds remotely only: there is no local Docker step. The flow is
 *
 *   1. `createTemplate` — the template (by name) and a new build id
 *   2. `getTemplateFileUploadLink` per `COPY` hash, uploading what E2B lacks
 *   3. `startTemplateBuild` — base image or template, steps, start/ready command
 *   4. `getTemplateBuildStatus` until the build is `ready` or `error`
 */
import * as crypto from "node:crypto";
import * as templates from "@distilled.cloud/e2b/templates";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { E2BUnexpectedResponse, TemplateBuildFailed } from "../Errors.ts";
import {
  type ContextFile,
  filesHash,
  type InlineFile,
  inlineFiles,
  requireFiles,
  resolveSource,
  tarGzip,
} from "./BuildContext.ts";
import { type LoweredStep, lowerDockerfile } from "./Dockerfile.ts";

/** Inline Dockerfile content (`Dockerfile.inline` from `@alchemy.run/docker`, or `{ content }`). */
export interface InlineDockerfile {
  readonly content: string;
}

/** Credentials for a private base image. Passed to E2B's builder for the pull only. */
export type TemplateRegistry =
  | {
      /** Any registry with username/password auth (Docker Hub, GHCR, …). */
      readonly username: string;
      readonly password: Redacted.Redacted<string>;
    }
  | {
      /** Amazon ECR. */
      readonly awsAccessKeyId: string;
      readonly awsSecretAccessKey: Redacted.Redacted<string>;
      readonly awsRegion: string;
    }
  | {
      /** Google Artifact Registry / GCR. */
      readonly serviceAccountJson: Redacted.Redacted<string>;
    };

/** What a template is built from. Exactly one of `image`, `dockerfile`, `fromTemplate`. */
export interface TemplateSource {
  /** A registry image to build on, e.g. `"node:22-bookworm"`. */
  readonly image?: string;
  /**
   * A Dockerfile: a path (relative to the working directory) or inline
   * content. Lowered to E2B build steps; see the resource docs for what E2B
   * supports.
   */
  readonly dockerfile?: string | InlineDockerfile;
  /**
   * The directory `COPY` / `ADD` sources are relative to.
   * @default the Dockerfile's directory, or the working directory for inline Dockerfiles
   */
  readonly context?: string;
  /** Another E2B template (name or id) to build on, reusing its cached layers. */
  readonly fromTemplate?: string;
  /** Shell commands run after the base, as extra `RUN` steps. */
  readonly run?: ReadonlyArray<string>;
  /**
   * An in-memory build context: `COPY` sources in the Dockerfile resolve
   * against these paths before the `context` directory, so a template can be
   * built where there is no filesystem (at runtime, in a Worker). A file with
   * a `dest` is also copied there on its own, after the Dockerfile's steps.
   */
  readonly files?: ReadonlyArray<InlineFile & { readonly dest?: string }>;
  /** Environment variables set in the image (`ENV`). */
  readonly env?: Readonly<Record<string, string>>;
  /** `ARG` values for the Dockerfile. */
  readonly args?: Readonly<Record<string, string>>;
  /** Credentials for a private base image. */
  readonly registry?: TemplateRegistry;
  /**
   * Command started when the template is built and captured running in its
   * snapshot, so every sandbox starts with it already up. Defaults to the
   * Dockerfile's `ENTRYPOINT` / `CMD`.
   */
  readonly startCmd?: string;
  /** Command that exits 0 once `startCmd` is ready; the snapshot is taken then. */
  readonly readyCmd?: string;
}

export interface TemplateBuildSpec extends TemplateSource {
  /** Template name (and alias). */
  readonly name: string;
  /** Tags assigned to this build (e.g. `"v1"`). */
  readonly tags?: ReadonlyArray<string>;
  readonly cpuCount?: number;
  readonly memoryMB?: number;
  readonly minFreeDiskMb?: number;
  /** Rebuild every layer, ignoring E2B's cache. */
  readonly force?: boolean;
}

interface PlannedStep {
  readonly type: string;
  readonly args: string[];
  readonly filesHash?: string;
  readonly force?: boolean;
}

export interface TemplateBuildPlan {
  readonly fromImage?: string;
  readonly fromTemplate?: string;
  readonly steps: ReadonlyArray<PlannedStep>;
  readonly startCmd?: string;
  readonly readyCmd?: string;
  /** Files per `COPY` hash, uploaded when E2B does not have them. */
  readonly uploads: ReadonlyMap<string, ReadonlyArray<ContextFile>>;
  /** Content hash of everything that determines the build. A different hash means rebuild. */
  readonly hash: string;
}

export interface TemplateBuildResult {
  readonly templateId: string;
  readonly buildId: string;
  readonly names: ReadonlyArray<string>;
  readonly aliases: ReadonlyArray<string>;
  readonly tags: ReadonlyArray<string>;
  readonly public: boolean;
}

/** A context-relative path without `./` or leading/trailing slashes. */
const normalize = (path: string) => path.replace(/^(\.\/|\/)+/, "").replace(/\/+$/, "") || ".";

const sourceCount = (source: TemplateSource) =>
  [source.image, source.dockerfile, source.fromTemplate].filter((x) => x !== undefined).length;

/** Plans a build: lowers the source to steps, resolves and hashes `COPY` contexts. */
export const planTemplateBuild = Effect.fn(function* (spec: TemplateBuildSpec) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (sourceCount(spec) > 1) {
    return yield* new E2BUnexpectedResponse({
      message: `template ${spec.name}: set one of image, dockerfile or fromTemplate`,
    });
  }

  let fromImage = spec.image;
  let lowered: ReadonlyArray<LoweredStep> = [];
  let startCmd = spec.startCmd;
  let context = spec.context !== undefined ? path.resolve(spec.context) : path.resolve(".");

  if (spec.dockerfile !== undefined) {
    const text =
      typeof spec.dockerfile === "string"
        ? yield* fs.readFileString(path.resolve(spec.dockerfile))
        : spec.dockerfile.content;
    if (typeof spec.dockerfile === "string" && spec.context === undefined) {
      context = path.dirname(path.resolve(spec.dockerfile));
    }
    const dockerfile = yield* lowerDockerfile(text, spec.args);
    fromImage = dockerfile.fromImage;
    lowered = dockerfile.steps;
    startCmd = startCmd ?? dockerfile.startCmd;
  }
  if (fromImage === undefined && spec.fromTemplate === undefined) {
    // No base: E2B's default base image.
    fromImage = "e2bdev/base";
  }

  const extra: LoweredStep[] = [
    ...(spec.env && Object.keys(spec.env).length > 0
      ? [{ type: "ENV" as const, args: Object.entries(spec.env).flat() }]
      : []),
    ...(spec.files ?? []).flatMap((file) =>
      file.dest === undefined
        ? []
        : [{ type: "COPY" as const, args: [normalize(file.path), file.dest, "", ""] }],
    ),
    ...(spec.run ?? []).map((command) => ({ type: "RUN" as const, args: [command] })),
  ];

  const inline = new Map(inlineFiles(spec.files ?? []).map((file) => [file.path, file]));
  /** In-memory files under a COPY source: the file itself, or everything below a directory. */
  const inlineUnder = (src: string) => {
    const root = normalize(src);
    return [...inline.values()].filter(
      (file) => root === "." || file.path === root || file.path.startsWith(`${root}/`),
    );
  };

  const uploads = new Map<string, ReadonlyArray<ContextFile>>();
  const steps: PlannedStep[] = [];
  for (const step of [...lowered, ...extra]) {
    if (step.type !== "COPY") {
      steps.push({ type: step.type, args: [...step.args] });
      continue;
    }
    const [src, dest] = step.args as [string, string];
    const fromMemory = inlineUnder(src);
    const fromContext = fromMemory.length > 0 ? [] : yield* resolveSource(context, src);
    const files = fromMemory.length > 0 ? fromMemory : yield* requireFiles(src, fromContext);
    const hash = filesHash(src, dest, files);
    uploads.set(hash, files);
    steps.push({ type: "COPY", args: [...step.args], filesHash: hash });
  }

  const hash = crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        fromImage,
        fromTemplate: spec.fromTemplate,
        steps,
        startCmd,
        readyCmd: spec.readyCmd,
        cpuCount: spec.cpuCount,
        memoryMB: spec.memoryMB,
        minFreeDiskMb: spec.minFreeDiskMb,
        registry: spec.registry === undefined ? undefined : Object.keys(spec.registry).sort(),
      }),
    )
    .digest("hex");

  return {
    fromImage: spec.fromTemplate === undefined ? fromImage : undefined,
    fromTemplate: spec.fromTemplate,
    steps,
    startCmd,
    readyCmd: spec.readyCmd,
    uploads,
    hash,
  } satisfies TemplateBuildPlan;
});

const registryOf = (registry: TemplateRegistry): templates.FromImageRegistry =>
  // The registry union is opaque on the wire: secrets are unwrapped here, at
  // the point of use, and never logged.
  "awsAccessKeyId" in registry
    ? {
        type: "aws",
        awsAccessKeyId: registry.awsAccessKeyId,
        awsSecretAccessKey: Redacted.value(registry.awsSecretAccessKey),
        awsRegion: registry.awsRegion,
      }
    : "serviceAccountJson" in registry
      ? { type: "gcp", serviceAccountJson: Redacted.value(registry.serviceAccountJson) }
      : {
          type: "registry",
          username: registry.username,
          password: Redacted.value(registry.password),
        };

/** Uploads one `COPY` context unless E2B already has it. */
const uploadContext = Effect.fn(function* (
  templateId: string,
  hash: string,
  files: ReadonlyArray<ContextFile>,
) {
  const link = yield* templates.getTemplateFileUploadLink({ templateID: templateId, hash });
  if (link.present) return;
  if (link.url === undefined) {
    return yield* new E2BUnexpectedResponse({
      message: `E2B returned no upload URL for context ${hash} of template ${templateId}`,
    });
  }
  const archive = yield* tarGzip(files);
  const client = yield* HttpClient.HttpClient;
  const headers = Object.fromEntries(
    Object.entries(link.headers ?? {}).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  // Raw HTTP: a presigned upload URL the API handed back, used as-is. The
  // body is sized (presigned PUTs reject chunked transfer encoding).
  const response = yield* client
    .execute(
      HttpClientRequest.put(link.url).pipe(
        HttpClientRequest.setHeaders(headers),
        HttpClientRequest.bodyUint8Array(archive, "application/gzip"),
      ),
    )
    .pipe(Effect.retry({ times: 4, schedule: Schedule.exponential("500 millis") }));
  if (response.status < 200 || response.status >= 300) {
    return yield* new E2BUnexpectedResponse({
      message: `uploading build context ${hash} for template ${templateId} failed with HTTP ${response.status}`,
    });
  }
});

/** Polls a build until it is ready; fails with its reason and the tail of its logs. */
export const waitForBuild = Effect.fn(function* (templateId: string, buildId: string) {
  const status = yield* templates
    .getTemplateBuildStatus({ templateID: templateId, buildID: buildId })
    .pipe(
      Effect.repeat({
        // Image pulls and dependency installs take minutes; bounded at ~20 min.
        schedule: Schedule.spaced(Duration.seconds(3)),
        until: (info) => info.status === "ready" || info.status === "error",
        times: 400,
      }),
    );
  if (status.status !== "ready") {
    return yield* new TemplateBuildFailed({
      message: `E2B template build ${buildId} failed: ${status.reason?.message ?? status.status}`,
      templateId,
      buildId,
      reason: status.reason?.message,
      logs: status.logs.slice(-40),
    });
  }
  return status;
});

/** Runs a planned build to completion. */
export const runTemplateBuild = Effect.fn(function* (
  spec: TemplateBuildSpec,
  plan: TemplateBuildPlan,
) {
  const created = yield* templates.createTemplate({
    name: spec.name,
    tags: spec.tags === undefined ? undefined : [...spec.tags],
    cpuCount: spec.cpuCount,
    memoryMB: spec.memoryMB,
    minFreeDiskMb: spec.minFreeDiskMb,
  });
  yield* Effect.forEach(
    [...plan.uploads],
    ([hash, files]) => uploadContext(created.templateID, hash, files),
    { concurrency: 4, discard: true },
  );
  yield* templates.startTemplateBuild({
    templateID: created.templateID,
    buildID: created.buildID,
    fromImage: plan.fromImage,
    fromTemplate: plan.fromTemplate,
    fromImageRegistry: spec.registry === undefined ? undefined : registryOf(spec.registry),
    steps: plan.steps.map((step) => ({
      type: step.type,
      args: step.args,
      filesHash: step.filesHash,
      force: step.force ?? spec.force,
    })),
    startCmd: plan.startCmd,
    readyCmd: plan.readyCmd,
    force: spec.force,
  });
  yield* waitForBuild(created.templateID, created.buildID);
  return {
    templateId: created.templateID,
    buildId: created.buildID,
    names: created.names,
    aliases: created.aliases,
    tags: created.tags,
    public: created.public,
  } satisfies TemplateBuildResult;
});
