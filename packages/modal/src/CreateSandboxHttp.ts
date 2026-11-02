import * as sandbox from "@distilled.cloud/modal/sandbox";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { App } from "./App.ts";
import { makeModalBinding } from "./BindingHttp.ts";
import { CreateSandbox, type SandboxesClient, type SandboxUsageGroup } from "./CreateSandbox.ts";
import type { Image } from "./Image.ts";
import { timestampOf } from "./internal.ts";
import type { ModalClient } from "./ModalBindings.ts";
import type { Sandbox } from "./Sandbox.ts";
import {
  createPersistentSandbox,
  createSandbox,
  persistentSandboxHandle,
  listSandboxes,
  restoreSandbox,
  sandboxFromName,
  sandboxHandle,
  type PersistentSandboxHandle,
  type RawPersistentSandboxHandle,
  type RawSandboxHandle,
  type SandboxHandle,
  type SandboxTarget,
} from "./SandboxClient.ts";

/** Run every method of a handle with the binding's credentials. */
export const withClient = (handle: RawSandboxHandle, client: ModalClient): SandboxHandle => {
  const wrapped: Record<string, unknown> = { sandboxId: handle.sandboxId };
  for (const [key, value] of Object.entries(handle)) {
    if (typeof value === "function") {
      wrapped[key] = (...args: unknown[]) =>
        client((value as (...a: unknown[]) => Effect.Effect<unknown, unknown, unknown>)(...args));
    }
  }
  return wrapped as unknown as SandboxHandle;
};

/** Run a persistent sandbox's methods with the binding's credentials. */
const withPersistentClient = (
  handle: RawPersistentSandboxHandle,
  client: ModalClient,
): PersistentSandboxHandle => ({
  persistentSandboxId: handle.persistentSandboxId,
  session: () => client(handle.session().pipe(Effect.map((h) => withClient(h, client)))),
  terminate: () => client(handle.terminate()),
});

/** A sandboxes client over a target resolved per call. */
export const makeSandboxesClient = (
  target: Effect.Effect<SandboxTarget>,
  client: ModalClient,
): SandboxesClient => ({
  appId: Effect.map(target, (t) => t.appId),
  create: (options) =>
    client(
      Effect.flatMap(target, (t) =>
        createSandbox(t, options).pipe(Effect.map((h) => withClient(h, client))),
      ),
    ),
  fromName: (name) =>
    client(
      Effect.flatMap(target, (t) =>
        sandboxFromName(t, name).pipe(Effect.map((h) => (h ? withClient(h, client) : undefined))),
      ),
    ),
  fromId: (sandboxId) => Effect.map(target, (t) => withClient(sandboxHandle(sandboxId, t), client)),
  list: (options) => client(Effect.flatMap(target, (t) => listSandboxes(t, options))),
  usage: (query) =>
    client(
      Effect.gen(function* () {
        const t = yield* target;
        const groups: Array<SandboxUsageGroup> = [];
        let pageToken: string | undefined;
        for (let page = 0; page < 100; page++) {
          const response = yield* sandbox.sandboxGetTimeRangeStats({
            appId: t.appId,
            since: timestampOf(query.since),
            until: timestampOf(query.until ?? Date.now()),
            groupByTags: query.groupByTags ? [...query.groupByTags] : undefined,
            tags: query.tags,
            pageToken,
          });
          for (const group of response.groups ?? []) {
            groups.push({
              tags: Object.fromEntries(
                Object.entries(group.tags ?? {}).map(([key, value]) => [key, value?.value ?? ""]),
              ),
              cost: group.cost ?? 0,
              costByResource: Object.fromEntries(
                Object.entries(group.costByResource ?? {}).map(([key, value]) => [key, value ?? 0]),
              ),
            });
          }
          pageToken = response.nextPageToken || undefined;
          if (pageToken === undefined) break;
        }
        return groups;
      }),
    ),
  createPersistent: (options) =>
    client(
      Effect.flatMap(target, (t) =>
        createPersistentSandbox(t, options).pipe(
          Effect.map((h) => withPersistentClient(h, client)),
        ),
      ),
    ),
  persistent: (box) =>
    Effect.map(target, (t) =>
      withPersistentClient(
        persistentSandboxHandle(typeof box === "string" ? box : box.persistentSandboxId, t),
        client,
      ),
    ),
  restore: (snapshot, options) =>
    client(
      Effect.flatMap(target, (t) =>
        restoreSandbox(t, snapshot, options).pipe(Effect.map((h) => withClient(h, client))),
      ),
    ),
});

const isImage = (target: App | Image | Sandbox): target is Image => target.Type === "Modal.Image";
const isProgram = (target: App | Image | Sandbox): target is Sandbox =>
  target.Type === "Modal.Sandbox";

/**
 * {@link CreateSandbox} over Modal's API. Binds the deployer's Modal token
 * onto the host; Modal tokens act on the whole workspace.
 *
 * @layer
 * @product Sandbox
 * @provides Modal.CreateSandbox
 */
export const CreateSandboxHttp = Layer.effect(
  CreateSandbox,
  makeModalBinding({
    tag: "Modal.CreateSandbox",
    make: Effect.fn(function* (resource: App | Image | Sandbox, client) {
      if (isProgram(resource)) {
        const imageId = yield* resource.imageId;
        const appId = yield* resource.appId;
        const appName = yield* resource.appName;
        const environment = yield* resource.environment;
        const secretId = yield* resource.secretId;
        const command = yield* resource.command;
        const port = yield* resource.port;
        const target = Effect.all({
          imageId,
          appId,
          appName,
          environment,
          secretId,
          command,
          port,
        }).pipe(
          Effect.map((t): SandboxTarget => ({
            imageId: t.imageId,
            appId: t.appId,
            appName: t.appName,
            environment: t.environment,
            program: { secretId: t.secretId, command: t.command, port: t.port },
          })),
        );
        return makeSandboxesClient(target, client);
      }
      if (isImage(resource)) {
        const imageId = yield* resource.imageId;
        const appId = yield* resource.appId;
        const appName = yield* resource.appName;
        const environment = yield* resource.environment;
        const target = Effect.all({ imageId, appId, appName, environment }).pipe(
          Effect.map((t): SandboxTarget => t),
        );
        return makeSandboxesClient(target, client);
      }
      const appId = yield* resource.appId;
      const appName = yield* resource.name;
      const environment = yield* resource.environment;
      const target = Effect.all({ appId, appName, environment }).pipe(
        Effect.map((t): SandboxTarget => t),
      );
      return makeSandboxesClient(target, client);
    }),
  }),
);
