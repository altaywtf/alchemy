import * as container from "@distilled.cloud/modal/container";
import { withTaskCommandRouter } from "@distilled.cloud/modal/Credentials";
import type { ModalOpContext } from "@distilled.cloud/modal/Protocol";
import * as sandbox from "@distilled.cloud/modal/sandbox";
import * as router from "@distilled.cloud/modal/task_command_router";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { buildImage, gpuConfig, type ImageBuildSpec } from "./ImageBuild.ts";
import { environmentOf, seconds } from "./internal.ts";

/** A sandbox ended (or never became ready) before the call could finish. */
export class SandboxNotRunning extends Data.TaggedError("Modal.SandboxNotRunning")<{
  readonly sandboxId: string;
  readonly message: string;
}> {}

/** A Modal call returned without the field the client needs. */
export class SandboxUnexpectedResponse extends Data.TaggedError("Modal.SandboxUnexpectedResponse")<{
  readonly message: string;
}> {}

/** A filesystem operation inside the sandbox failed (missing path, permissions). */
export class SandboxFilesystemError extends Data.TaggedError("Modal.SandboxFilesystemError")<{
  readonly path: string;
  readonly message: string;
}> {}

/** A Modal duration: seconds, or a string like `"10 minutes"`. */
export type DurationInput = number | string;

/** An image a sandbox boots from: a registry ref, or a `Modal.Image` (resolved). */
export type SandboxImage = string | { readonly imageId: string };

/** A volume a sandbox mounts, by itself or with mount options. */
export type SandboxVolumeMount =
  | { readonly volumeId: string }
  | {
      readonly volume: { readonly volumeId: string };
      /** Mount read-only. */
      readonly readOnly?: boolean;
      /** Mount this directory of the volume instead of its root. */
      readonly subPath?: string;
    };

/** An S3, R2 or GCS bucket a sandbox mounts with Modal's cloud bucket mounts. */
export interface CloudBucketMountOptions {
  readonly bucketName: string;
  readonly type?: "s3" | "r2" | "gcp";
  /** S3-compatible endpoint, e.g. an R2 account endpoint. */
  readonly endpointUrl?: string;
  /** A Modal secret holding `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` (or GCS HMAC keys). */
  readonly secret?: { readonly secretId: string };
  /** Mount only keys under this prefix. */
  readonly keyPrefix?: string;
  readonly readOnly?: boolean;
  /** Assume this AWS role with Modal's OIDC identity instead of a secret. */
  readonly oidcAuthRoleArn?: string;
}

/** Inject a secret's variables as headers into matching outbound HTTPS requests. */
export interface HeaderReplacement {
  /** Host the replacement applies to (`api.openai.com`). */
  readonly domain: string;
  /** The secret whose variables the header values reference. */
  readonly secret: { readonly secretId: string };
  /** Headers to set; `{VAR}` is replaced with the secret's `VAR`. */
  readonly headers: Record<string, string>;
}

/** Options for creating a sandbox: Modal's own sandbox parameters. */
export interface SandboxCreateOptions {
  /** Image to boot. Defaults to the binding's image, else `debian:bookworm-slim`. */
  readonly image?: SandboxImage;
  /**
   * The sandbox's main process. Without one the sandbox idles (`sleep`) and
   * you drive it with {@link SandboxHandle.exec}.
   */
  readonly command?: ReadonlyArray<string>;
  /** Working directory of the main process and of exec'd commands. */
  readonly workdir?: string;
  /** Environment variables for the main process. */
  readonly env?: Record<string, string>;
  /** Secrets whose variables the sandbox sees as environment variables. */
  readonly secrets?: ReadonlyArray<{ readonly secretId: string }>;
  /** Volumes by mount path. */
  readonly volumes?: Record<string, SandboxVolumeMount>;
  /** Cloud buckets by mount path. */
  readonly cloudBucketMounts?: Record<string, CloudBucketMountOptions>;
  /** Mounts (local files uploaded with `Modal.Mount`). */
  readonly mounts?: ReadonlyArray<{ readonly mountId: string }>;
  /** CPU cores (fractional allowed). */
  readonly cpu?: number;
  /** Memory in MiB. */
  readonly memory?: number;
  /** GPU: `"T4"`, `"A10G"`, `"A100-80GB"`, `"H100"`, with an optional `":<count>"`. */
  readonly gpu?: string;
  /** Ephemeral disk in MiB. */
  readonly ephemeralDisk?: number;
  /** Most time the sandbox lives. @default 5 minutes (Modal's default); at most 24 hours */
  readonly timeout?: DurationInput;
  /** Terminate after this long without exec'd commands or connections. */
  readonly idleTimeout?: DurationInput;
  /** Name, unique among the app's running sandboxes; find it again with `fromName`. */
  readonly name?: string;
  /** Tags, for `list({ tags })`. */
  readonly tags?: Record<string, string>;
  /** Regions to run in (`"us-east"`, `"eu"`, ...). */
  readonly regions?: ReadonlyArray<string>;
  /** Block all network access. */
  readonly blockNetwork?: boolean;
  /** Allow outbound traffic only to these CIDR ranges (and {@link allowedDomains}). */
  readonly cidrAllowlist?: ReadonlyArray<string>;
  /** Allow outbound traffic only to these domains (and {@link cidrAllowlist}). */
  readonly allowedDomains?: ReadonlyArray<string>;
  /** Allow inbound connections (tunnels) only from these CIDR ranges. */
  readonly inboundCidrAllowlist?: ReadonlyArray<string>;
  /** Outbound header injection: secrets the sandbox never sees. */
  readonly outboundPolicy?: { readonly headerReplacements: ReadonlyArray<HeaderReplacement> };
  /** Route outbound traffic through a `Modal.Proxy`'s static IPs. */
  readonly proxy?: { readonly proxyId: string };
  /** Ports reachable through TLS tunnels (`sandbox.tunnels()`). */
  readonly encryptedPorts?: ReadonlyArray<number>;
  /** Ports reachable through plain TCP tunnels. */
  readonly unencryptedPorts?: ReadonlyArray<number>;
  /** Ports reachable through HTTP/2 tunnels. */
  readonly h2Ports?: ReadonlyArray<number>;
  /** Allow memory snapshots of this sandbox (`snapshotMemory`). */
  readonly enableSnapshot?: boolean;
  /** Serve tunnels on a custom domain registered with Modal. */
  readonly customDomain?: string;
}

/** What a finished command printed, and its exit code. */
export interface ExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Options for {@link SandboxHandle.exec}. */
export interface ExecOptions {
  readonly workdir?: string;
  /** Extra environment variables for this command. */
  readonly env?: Record<string, string>;
  /** Secrets whose variables this command sees. */
  readonly secrets?: ReadonlyArray<{ readonly secretId: string }>;
  /** Kill the command after this long. */
  readonly timeout?: DurationInput;
  /** Bytes (or text) written to the command's stdin, then closed. */
  readonly stdin?: string | Uint8Array;
}

/** One entry of {@link SandboxHandle.listFiles}. */
export interface SandboxFileEntry {
  readonly path: string;
  readonly type: string;
  readonly size?: number;
}

/** A tunnel to a port inside the sandbox. */
export interface SandboxTunnel {
  /** `https://…` (or `tcp://…` for unencrypted tunnels). */
  readonly url: string;
  readonly host: string;
  readonly port: number;
}

/** A running (or finished) Modal sandbox. Every method calls Modal's API. */
export interface SandboxHandleOf<R> {
  readonly sandboxId: string;
  /** Run a command (an argument vector, no shell) and wait for it. */
  exec(command: ReadonlyArray<string>, options?: ExecOptions): Effect.Effect<ExecResult, any, R>;
  /** Read a file. */
  readFile(path: string): Effect.Effect<Uint8Array, any, R>;
  /** Read a UTF-8 file. */
  readFileString(path: string): Effect.Effect<string, any, R>;
  /** Write (create or truncate) a file. */
  writeFile(path: string, data: string | Uint8Array): Effect.Effect<void, any, R>;
  /** List a directory. */
  listFiles(path: string): Effect.Effect<ReadonlyArray<SandboxFileEntry>, any, R>;
  /** Create a directory (and its parents). */
  mkdir(path: string): Effect.Effect<void, any, R>;
  /** Remove a file or directory. */
  remove(path: string, options?: { readonly recursive?: boolean }): Effect.Effect<void, any, R>;
  /** Tunnels to the sandbox's open ports, by container port. */
  tunnels(timeout?: DurationInput): Effect.Effect<Record<number, SandboxTunnel>, any, R>;
  /**
   * A token-authenticated URL for one port, for a browser or client that
   * shouldn't hold Modal credentials.
   */
  connectToken(options?: {
    readonly port?: number;
    readonly userMetadata?: string;
  }): Effect.Effect<{ readonly url: string; readonly token: string }, any, R>;
  /** Capture the filesystem as a new image (usable as `image` later). */
  snapshotFilesystem(timeout?: DurationInput): Effect.Effect<{ readonly imageId: string }, any, R>;
  /** Capture memory and filesystem (needs `enableSnapshot`); restore with `restore`. */
  snapshotMemory(): Effect.Effect<{ readonly snapshotId: string }, any, R>;
  /** Capture one directory as an image (mount it into another sandbox with `mountDirectory`). */
  snapshotDirectory(path: string): Effect.Effect<{ readonly imageId: string }, any, R>;
  /** Mount a directory snapshot at `path`. */
  mountDirectory(path: string, snapshot: { readonly imageId: string }): Effect.Effect<void, any, R>;
  /** Replace the sandbox's outbound network policy while it runs. */
  setNetworkAccess(access: {
    readonly blockNetwork?: boolean;
    readonly cidrAllowlist?: ReadonlyArray<string>;
    readonly allowedDomains?: ReadonlyArray<string>;
  }): Effect.Effect<void, any, R>;
  /** Replace the outbound header injection rules while it runs. */
  setOutboundPolicy(policy: {
    readonly headerReplacements: ReadonlyArray<HeaderReplacement>;
  }): Effect.Effect<void, any, R>;
  /** Replace the sandbox's tags. */
  setTags(tags: Record<string, string>): Effect.Effect<void, any, R>;
  /** The main process's output so far. */
  logs(options?: { readonly timeout?: DurationInput }): Effect.Effect<string, any, R>;
  /** Wait for the sandbox to finish; `undefined` exit code while still running. */
  wait(
    timeout?: DurationInput,
  ): Effect.Effect<{ readonly exitCode?: number; readonly status: string }, any, R>;
  /** Terminate the sandbox (no-op when it already finished). */
  terminate(): Effect.Effect<void, any, R>;
}

/** A sandbox handle as bindings return it: calls run inside a deployed runtime. */
export type SandboxHandle = SandboxHandleOf<RuntimeContext>;

/** A sandbox handle whose calls need Modal credentials and an HTTP client. */
export type RawSandboxHandle = SandboxHandleOf<ModalOpContext>;

/** Where a sandbox client creates sandboxes. */
export interface SandboxTarget {
  readonly appId: string;
  /** Environment of the app (for name lookups and tag updates). */
  readonly environment?: string;
  /** Name of the app (for name lookups). */
  readonly appName?: string;
  /** Image used when `create` names none. */
  readonly imageId?: string;
}

const outputText = (batches: ReadonlyArray<container.RuntimeOutputBatch>, fd: string) => {
  const chunks: string[] = [];
  for (const batch of batches) {
    for (const message of [
      ...(batch.items ?? []),
      ...(fd === "FILE_DESCRIPTOR_STDOUT" ? (batch.stdout ?? []) : (batch.stderr ?? [])),
    ]) {
      if (message.fileDescriptor !== undefined && message.fileDescriptor !== fd) continue;
      if (message.messageBytes)
        chunks.push(Buffer.from(message.messageBytes, "base64").toString("utf8"));
      else if (message.message) chunks.push(message.message);
    }
  }
  return chunks.join("");
};

const decodeBase64 = (data: string) =>
  Effect.sync(() => new Uint8Array(Buffer.from(data, "base64")));
const encodeBase64 = (data: string | Uint8Array) =>
  Effect.sync(() =>
    typeof data === "string"
      ? Buffer.from(data, "utf8").toString("base64")
      : Buffer.from(data).toString("base64"),
  );

const tunnelTypeOf = (h2: boolean): sandbox.TunnelType | undefined =>
  h2 ? "TUNNEL_TYPE_H2" : undefined;

const BUCKET_TYPE = { s3: "S3", r2: "R2", gcp: "GCP" } as const;

/** Modal's `Sandbox` definition for {@link SandboxCreateOptions}. */
const definitionOf = (imageId: string, options: SandboxCreateOptions): sandbox.Sandbox => ({
  imageId,
  entrypointArgs: options.command ? [...options.command] : ["sleep", "infinity"],
  workdir: options.workdir,
  environmentVariables: options.env,
  secretIds: options.secrets?.map((s) => s.secretId),
  mountIds: options.mounts?.map((m) => m.mountId),
  volumeMounts: Object.entries(options.volumes ?? {}).map(([mountPath, mount]) =>
    "volume" in mount
      ? {
          mountPath,
          volumeId: mount.volume.volumeId,
          readOnly: mount.readOnly,
          subPath: mount.subPath,
          allowBackgroundCommits: true,
        }
      : { mountPath, volumeId: mount.volumeId, allowBackgroundCommits: true },
  ),
  cloudBucketMounts: Object.entries(options.cloudBucketMounts ?? {}).map(([mountPath, mount]) => ({
    mountPath,
    bucketName: mount.bucketName,
    bucketType: mount.type ? BUCKET_TYPE[mount.type] : undefined,
    bucketEndpointUrl: mount.endpointUrl,
    credentialsSecretId: mount.secret?.secretId,
    keyPrefix: mount.keyPrefix,
    readOnly: mount.readOnly,
    oidcAuthRoleArn: mount.oidcAuthRoleArn,
  })),
  resources: {
    milliCpu: options.cpu !== undefined ? Math.round(options.cpu * 1000) : undefined,
    memoryMb: options.memory,
    gpuConfig: gpuConfig(options.gpu),
    ephemeralDiskMb: options.ephemeralDisk,
  },
  timeoutSecs: seconds(options.timeout),
  idleTimeoutSecs: seconds(options.idleTimeout),
  name: options.name,
  schedulerPlacement: options.regions ? { regions: [...options.regions] } : undefined,
  blockNetwork: options.blockNetwork,
  networkAccess: networkAccessOf(options),
  inboundCidrAllowlist: options.inboundCidrAllowlist
    ? [...options.inboundCidrAllowlist]
    : undefined,
  outboundPolicy: options.outboundPolicy ? outboundPolicyOf(options.outboundPolicy) : undefined,
  proxyId: options.proxy?.proxyId,
  openPorts: {
    ports: [
      ...(options.encryptedPorts ?? []).map((port) => ({ port })),
      ...(options.unencryptedPorts ?? []).map((port) => ({ port, unencrypted: true })),
      ...(options.h2Ports ?? []).map((port) => ({ port, tunnelType: tunnelTypeOf(true) })),
    ],
  },
  enableSnapshot: options.enableSnapshot,
  customDomain: options.customDomain,
});

const networkAccessOf = (options: {
  readonly blockNetwork?: boolean;
  readonly cidrAllowlist?: ReadonlyArray<string>;
  readonly allowedDomains?: ReadonlyArray<string>;
}): sandbox.NetworkAccess | undefined =>
  options.blockNetwork
    ? { networkAccessType: "BLOCKED" }
    : options.cidrAllowlist !== undefined || options.allowedDomains !== undefined
      ? {
          networkAccessType: "ALLOWLIST",
          allowedCidrs: options.cidrAllowlist ? [...options.cidrAllowlist] : [],
          allowedDomains: options.allowedDomains ? [...options.allowedDomains] : [],
        }
      : undefined;

const outboundPolicyOf = (policy: {
  readonly headerReplacements: ReadonlyArray<HeaderReplacement>;
}): sandbox.OutboundPolicy => ({
  headerReplacements: policy.headerReplacements.map((r) => ({
    domain: r.domain,
    secretId: r.secret.secretId,
    headers: r.headers,
  })),
});

/**
 * The image to boot: a `Modal.Image`'s id, or a registry ref built (and
 * cached by Modal) into an image in the target app.
 */
export const resolveSandboxImage = Effect.fn(function* (
  target: SandboxTarget,
  image: SandboxImage | undefined,
) {
  if (image !== undefined && typeof image !== "string") return image.imageId;
  if (image === undefined && target.imageId !== undefined) return target.imageId;
  const spec: ImageBuildSpec = { dockerTag: image ?? "debian:bookworm-slim", commands: [] };
  return yield* buildImage(target.appId, spec);
});

/** The handle for an existing sandbox id. */
export const sandboxHandle = (
  sandboxId: string,
  target: Pick<SandboxTarget, "environment">,
): RawSandboxHandle => {
  let cachedTaskId: string | undefined;
  const taskId = Effect.gen(function* () {
    if (cachedTaskId !== undefined) return cachedTaskId;
    for (let attempt = 0; attempt < 10; attempt++) {
      const response = yield* sandbox.sandboxGetTaskIdV2({
        sandboxId,
        timeout: 55,
        waitUntilReady: true,
      });
      if (response.taskId) {
        cachedTaskId = response.taskId;
        return response.taskId;
      }
      if (
        response.taskResult?.status &&
        response.taskResult.status !== "GENERIC_STATUS_UNSPECIFIED"
      ) {
        return yield* new SandboxNotRunning({
          sandboxId,
          message: `Sandbox ${sandboxId} finished with ${response.taskResult.status}`,
        });
      }
    }
    return yield* new SandboxNotRunning({
      sandboxId,
      message: `Sandbox ${sandboxId} wasn't scheduled within 9 minutes`,
    });
  });

  const viaRouter = <A, E, R>(f: (taskId: string) => Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const id = yield* taskId;
      const access = yield* sandbox.sandboxGetCommandRouterAccess({ sandboxId, taskId: id });
      if (!access.url || !access.jwt) {
        return yield* new SandboxUnexpectedResponse({
          message: `Modal returned no command router for sandbox ${sandboxId}`,
        });
      }
      return yield* f(id).pipe(withTaskCommandRouter({ url: access.url, jwt: access.jwt }));
    });

  /** Run one filesystem request and collect its output bytes. */
  const fsExec = Effect.fn(function* (
    request: container.ExecContainerFilesystemRequest,
    path: string,
  ) {
    const id = yield* taskId;
    const { execId, fileDescriptor } = yield* container.execContainerFilesystem({
      ...request,
      taskId: id,
    });
    if (!execId) {
      return yield* new SandboxUnexpectedResponse({ message: `No exec id for ${path}` });
    }
    const chunks: string[] = [];
    for (let attempt = 0; attempt < 20; attempt++) {
      const { items } = yield* container.containerFilesystemExecGetOutput({ execId, timeout: 55 });
      let eof = false;
      for (const batch of items) {
        if (batch.error?.errorMessage) {
          return yield* new SandboxFilesystemError({ path, message: batch.error.errorMessage });
        }
        chunks.push(...(batch.output ?? []));
        if (batch.eof) eof = true;
      }
      if (eof) break;
    }
    return { fileDescriptor, output: chunks };
  });

  const withFile = Effect.fn(function* <A, E, R>(
    path: string,
    mode: string,
    use: (fd: string) => Effect.Effect<A, E, R>,
  ) {
    const opened = yield* fsExec({ fileOpenRequest: { path, mode } }, path);
    const fd = opened.fileDescriptor;
    if (!fd) return yield* new SandboxFilesystemError({ path, message: `Couldn't open ${path}` });
    return yield* use(fd).pipe(
      Effect.ensuring(Effect.ignore(fsExec({ fileCloseRequest: { fileDescriptor: fd } }, path))),
    );
  });

  const handle: RawSandboxHandle = {
    sandboxId,
    exec: Effect.fn(function* (command, options = {}) {
      const id = yield* taskId;
      const env = Object.entries(options.env ?? {}).map(([key, value]) => `${key}=${value}`);
      const { execId } = yield* container.execContainer({
        taskId: id,
        command: env.length > 0 ? ["env", ...env, ...command] : [...command],
        workdir: options.workdir,
        timeoutSecs: seconds(options.timeout),
        secretIds: options.secrets?.map((s) => s.secretId),
        stdoutOutput: "EXEC_OUTPUT_OPTION_PIPE",
        stderrOutput: "EXEC_OUTPUT_OPTION_PIPE",
      });
      if (!execId)
        return yield* new SandboxUnexpectedResponse({ message: "Modal returned no exec id" });
      if (options.stdin !== undefined) {
        const message = yield* encodeBase64(options.stdin);
        yield* container.containerExecPutInput({ execId, input: { message, messageIndex: "1" } });
        yield* container.containerExecPutInput({ execId, input: { messageIndex: "2", eof: true } });
      }
      const batches: container.RuntimeOutputBatch[] = [];
      let lastBatchIndex: string | undefined;
      let exitCode: number | undefined;
      for (let attempt = 0; exitCode === undefined && attempt < 1_440; attempt++) {
        const { items } = yield* container.containerExecGetOutput({
          execId,
          timeout: 55,
          lastBatchIndex,
          getRawBytes: true,
        });
        for (const batch of items) {
          batches.push(batch);
          if (batch.batchIndex) lastBatchIndex = batch.batchIndex;
          if (batch.exitCode !== undefined) exitCode = batch.exitCode;
        }
        if (exitCode === undefined && items.length === 0) {
          const waited = yield* container.containerExecWait({ execId, timeout: 0 });
          if (waited.completed) exitCode = waited.exitCode ?? 0;
        }
      }
      return {
        exitCode: exitCode ?? -1,
        stdout: outputText(batches, "FILE_DESCRIPTOR_STDOUT"),
        stderr: outputText(batches, "FILE_DESCRIPTOR_STDERR"),
      };
    }),
    readFile: Effect.fn(function* (path) {
      const chunks = yield* withFile(path, "rb", (fd) =>
        fsExec({ fileReadRequest: { fileDescriptor: fd } }, path).pipe(Effect.map((r) => r.output)),
      );
      const parts = yield* Effect.forEach(chunks, decodeBase64);
      const total = parts.reduce((n, part) => n + part.length, 0);
      const out = new Uint8Array(total);
      let offset = 0;
      for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
      }
      return out;
    }),
    readFileString: (path) =>
      handle.readFile(path).pipe(Effect.map((bytes) => new TextDecoder().decode(bytes))),
    writeFile: Effect.fn(function* (path, data) {
      const encoded = yield* encodeBase64(data);
      yield* withFile(path, "wb", (fd) =>
        fsExec({ fileWriteRequest: { fileDescriptor: fd, data: encoded } }, path),
      );
    }),
    listFiles: Effect.fn(function* (path) {
      const { output } = yield* fsExec({ fileLsRequest: { path } }, path);
      const chunks = yield* Effect.forEach(output, decodeBase64);
      const text = chunks.map((bytes) => new TextDecoder().decode(bytes)).join("");
      // Modal answers `ls` with a JSON object: { paths: [...] }.
      const parsed = yield* Effect.try({
        try: () => JSON.parse(text || "{}") as { paths?: string[] },
        catch: () => new SandboxFilesystemError({ path, message: `Unexpected ls output: ${text}` }),
      });
      return (parsed.paths ?? []).map((entry) => ({
        path: entry,
        type: entry.endsWith("/") ? "DIRECTORY" : "FILE",
      }));
    }),
    mkdir: Effect.fn(function* (path) {
      yield* fsExec({ fileMkdirRequest: { path, makeParents: true } }, path);
    }),
    remove: Effect.fn(function* (path, options = {}) {
      yield* fsExec({ fileRmRequest: { path, recursive: options.recursive } }, path);
    }),
    tunnels: Effect.fn(function* (timeout) {
      const { tunnels } = yield* sandbox.sandboxGetTunnelsV2({
        sandboxId,
        timeout: seconds(timeout) ?? 50,
      });
      const out: Record<number, SandboxTunnel> = {};
      for (const tunnel of tunnels ?? []) {
        if (tunnel.containerPort === undefined) continue;
        const encrypted = tunnel.host !== undefined && tunnel.host !== "";
        const host = (encrypted ? tunnel.host : tunnel.unencryptedHost) ?? "";
        const port = (encrypted ? tunnel.port : tunnel.unencryptedPort) ?? 443;
        out[tunnel.containerPort] = {
          host,
          port,
          url: encrypted
            ? `https://${host}${port === 443 ? "" : `:${port}`}`
            : `tcp://${host}:${port}`,
        };
      }
      return out;
    }),
    connectToken: Effect.fn(function* (options = {}) {
      const response = yield* sandbox.sandboxCreateConnectTokenV2({
        sandboxId,
        port: options.port,
        userMetadata: options.userMetadata,
      });
      if (!response.url || !response.token) {
        return yield* new SandboxUnexpectedResponse({ message: "Modal returned no connect token" });
      }
      return { url: response.url, token: response.token };
    }),
    snapshotFilesystem: Effect.fn(function* (timeout) {
      const response = yield* sandbox.sandboxSnapshotFs({
        sandboxId,
        timeout: seconds(timeout) ?? 55,
      });
      if (!response.imageId || response.result?.status !== "GENERIC_STATUS_SUCCESS") {
        return yield* new SandboxUnexpectedResponse({
          message: `Filesystem snapshot of ${sandboxId} failed: ${response.result?.exception ?? response.result?.status}`,
        });
      }
      return { imageId: response.imageId };
    }),
    snapshotMemory: Effect.fn(function* () {
      const { snapshotId } = yield* sandbox.sandboxSnapshot({ sandboxId });
      if (!snapshotId) return yield* new SandboxUnexpectedResponse({ message: "No snapshot id" });
      for (let attempt = 0; attempt < 10; attempt++) {
        const { result } = yield* sandbox.waitSandboxSnapshot({ snapshotId, timeout: 55 });
        if (result?.status === "GENERIC_STATUS_SUCCESS") return { snapshotId };
        if (result?.status && result.status !== "GENERIC_STATUS_UNSPECIFIED") {
          return yield* new SandboxUnexpectedResponse({
            message: `Memory snapshot of ${sandboxId} failed: ${result.exception ?? result.status}`,
          });
        }
      }
      return yield* new SandboxUnexpectedResponse({
        message: `Memory snapshot ${snapshotId} timed out`,
      });
    }),
    snapshotDirectory: (path) =>
      viaRouter((task) => router.taskSnapshotDirectory({ taskId: task, path })).pipe(
        Effect.flatMap((response) =>
          response.imageId
            ? Effect.succeed({ imageId: response.imageId })
            : Effect.fail(new SandboxUnexpectedResponse({ message: `No image for ${path}` })),
        ),
      ),
    mountDirectory: (path, snapshot) =>
      viaRouter((task) =>
        router.taskMountDirectory({ taskId: task, path, imageId: snapshot.imageId }),
      ).pipe(Effect.asVoid),
    setNetworkAccess: (access) =>
      viaRouter((task) =>
        router.taskSetNetworkAccess({
          taskId: task,
          networkAccess: networkAccessOf(access) ?? { networkAccessType: "OPEN" },
        }),
      ).pipe(Effect.asVoid),
    setOutboundPolicy: (policy) =>
      viaRouter((task) =>
        router.taskSetOutboundPolicy({ taskId: task, outboundPolicy: outboundPolicyOf(policy) }),
      ).pipe(Effect.asVoid),
    setTags: Effect.fn(function* (tags) {
      yield* sandbox.sandboxTagsSetV2({
        sandboxId,
        environmentName: environmentOf(target.environment),
        tags: Object.entries(tags).map(([tagName, tagValue]) => ({ tagName, tagValue })),
      });
    }),
    logs: Effect.fn(function* (options = {}) {
      const { items } = yield* sandbox.sandboxGetLogs({
        sandboxId,
        fileDescriptor: "FILE_DESCRIPTOR_STDOUT",
        timeout: seconds(options.timeout) ?? 5,
      });
      return items
        .flatMap((batch) => batch.items ?? [])
        .map((log) => log.data ?? "")
        .join("");
    }),
    wait: Effect.fn(function* (timeout) {
      const { result } = yield* sandbox.sandboxWaitV2({
        sandboxId,
        timeout: seconds(timeout) ?? 0,
      });
      return {
        exitCode: result?.exitcode,
        status: result?.status ?? "GENERIC_STATUS_UNSPECIFIED",
      };
    }),
    terminate: Effect.fn(function* () {
      yield* sandbox
        .sandboxTerminateV2({ sandboxId })
        .pipe(Effect.catchTag("SandboxNotFound", () => Effect.void));
    }),
  };
  return handle;
};

/**
 * Create a sandbox in `target`'s app and return its handle. The one
 * implementation behind `CreateSandbox` and warm-base image builds.
 */
export const createSandbox = Effect.fn(function* (
  target: SandboxTarget,
  options: SandboxCreateOptions = {},
) {
  const imageId = yield* resolveSandboxImage(target, options.image);
  const created = yield* sandbox.sandboxCreateV2({
    appId: target.appId,
    definition: definitionOf(imageId, options),
    tags: Object.entries(options.tags ?? {}).map(([tagName, tagValue]) => ({ tagName, tagValue })),
  });
  if (!created.sandboxId) {
    return yield* new SandboxUnexpectedResponse({ message: "Modal returned no sandbox id" });
  }
  return sandboxHandle(created.sandboxId, target);
});

/** A running sandbox of `target`'s app by name, or `undefined`. */
export const sandboxFromName = Effect.fn(function* (target: SandboxTarget, name: string) {
  const found = yield* sandbox
    .sandboxGetFromNameV2({
      sandboxName: name,
      appName: target.appName,
      environmentName: environmentOf(target.environment),
    })
    .pipe(Effect.catchTag("SandboxNotFound", () => Effect.undefined));
  return found?.sandboxId ? sandboxHandle(found.sandboxId, target) : undefined;
});

/** Running sandboxes of `target`'s app, optionally filtered by tags. */
export const listSandboxes = Effect.fn(function* (
  target: SandboxTarget,
  options: { readonly tags?: Record<string, string>; readonly includeFinished?: boolean } = {},
) {
  const { sandboxes } = yield* sandbox.sandboxListV2({
    appId: target.appId,
    environmentName: environmentOf(target.environment),
    includeFinished: options.includeFinished ?? false,
    tags: Object.entries(options.tags ?? {}).map(([tagName, tagValue]) => ({ tagName, tagValue })),
  });
  return (sandboxes ?? []).flatMap((info) =>
    info.id
      ? [
          {
            sandboxId: info.id,
            name: info.name || undefined,
            createdAt: info.createdAt,
            tags: Object.fromEntries(
              (info.tags ?? []).map((t) => [t.tagName ?? "", t.tagValue ?? ""]),
            ),
          },
        ]
      : [],
  );
});

/** Restore a memory snapshot into a new sandbox. */
export const restoreSandbox = Effect.fn(function* (
  target: SandboxTarget,
  snapshot: { readonly snapshotId: string },
  options: { readonly name?: string } = {},
) {
  const restored = yield* sandbox.sandboxRestoreV2({
    snapshotId: snapshot.snapshotId,
    sandboxNameOverride: options.name,
    sandboxNameOverrideType: options.name ? "SANDBOX_NAME_OVERRIDE_TYPE_STRING" : undefined,
  });
  if (!restored.sandboxId) {
    return yield* new SandboxUnexpectedResponse({ message: "Modal returned no restored sandbox" });
  }
  return sandboxHandle(restored.sandboxId, target);
});
