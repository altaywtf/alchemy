import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { App } from "./App.ts";
import { makeModalBinding } from "./BindingHttp.ts";
import { CreateSandbox, type SandboxesClient } from "./CreateSandbox.ts";
import type { Image } from "./Image.ts";
import type { ModalClient } from "./ModalBindings.ts";
import {
  createSandbox,
  listSandboxes,
  restoreSandbox,
  sandboxFromName,
  sandboxHandle,
  type SandboxHandle,
  type SandboxTarget,
} from "./SandboxClient.ts";

/** Run every method of a handle with the binding's credentials. */
export const withClient = (handle: SandboxHandle, client: ModalClient): SandboxHandle => {
  const wrapped: Record<string, unknown> = { sandboxId: handle.sandboxId };
  for (const [key, value] of Object.entries(handle)) {
    if (typeof value === "function") {
      wrapped[key] = (...args: unknown[]) =>
        client((value as (...a: unknown[]) => Effect.Effect<unknown, unknown, unknown>)(...args));
    }
  }
  return wrapped as unknown as SandboxHandle;
};

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
  restore: (snapshot, options) =>
    client(
      Effect.flatMap(target, (t) =>
        restoreSandbox(t, snapshot, options).pipe(Effect.map((h) => withClient(h, client))),
      ),
    ),
});

const isImage = (target: App | Image): target is Image => target.Type === "Modal.Image";

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
    make: Effect.fn(function* (resource: App | Image, client) {
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
