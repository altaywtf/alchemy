import * as sandboxes from "@distilled.cloud/daytona/sandbox";
import * as secrets from "@distilled.cloud/daytona/secret";
import * as snapshots from "@distilled.cloud/daytona/snapshots";
import * as volumes from "@distilled.cloud/daytona/volumes";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { createInternalTags } from "alchemy/Tags";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { RUNTIME_OWNER_LABEL } from "./internal/Labels.ts";
import type { Providers } from "./Providers.ts";
import { deleteSandboxById } from "./Sandbox.ts";
import { deleteSnapshot } from "./Snapshot.ts";
import { deleteVolumeById } from "./Volume.ts";

/** The kinds of object a runtime binding can create. */
export type RuntimeObjectKind = "sandbox" | "volume" | "secret" | "snapshot";

/** What happens to objects a binding created at runtime when the stack is destroyed. */
export type OnDestroy = "delete" | "retain";

export interface RuntimeObjectsProps {
  /** The kind of object the binding creates. */
  kind: RuntimeObjectKind;
  /** Delete the binding's objects on destroy, or keep them. */
  onDestroy: OnDestroy;
  /**
   * Volumes and snapshots carry no labels, so they are swept by name: only
   * those whose name starts with this prefix. Required to sweep them.
   */
  prefix?: string;
}

export interface RuntimeObjectsAttributes {
  /** The owner mark stamped on every object the binding creates. */
  owner: string;
  /** Labels stamped on sandboxes the binding creates. */
  labels: Record<string, string>;
  /** Marker appended to the description of secrets the binding creates. */
  descriptionMarker: string;
  /** What destroy does with them. */
  onDestroy: OnDestroy;
  /** Name prefix for volumes and snapshots. */
  prefix: string | undefined;
  /** The kind. */
  kind: RuntimeObjectKind;
}

export type RuntimeObjects = Resource<
  "Daytona.RuntimeObjects",
  RuntimeObjectsProps,
  RuntimeObjectsAttributes,
  never,
  Providers
>;

/**
 * Bookkeeping for the objects a runtime binding creates (sandboxes per
 * request, volumes and secrets per user, snapshots of running sandboxes).
 * They are not in alchemy state, so the binding declares this resource:
 * it carries the owner mark the binding stamps on everything it creates,
 * and, with `onDestroy: "delete"`, deletes those objects when the stack is
 * destroyed.
 *
 * Sandboxes are marked with labels and secrets with a description marker.
 * Volumes and snapshots have neither, so they are swept by name prefix.
 *
 * Bindings declare this for you; you don't use it directly.
 * @internal
 */
export const RuntimeObjects = Resource<RuntimeObjects>("Daytona.RuntimeObjects");

const ownerOf = Effect.fn(function* (id: string) {
  const tags = yield* createInternalTags(id);
  const values = Object.values(tags);
  return values.join("/");
});

const sweep = Effect.fn(function* (attrs: RuntimeObjectsAttributes) {
  switch (attrs.kind) {
    case "sandbox": {
      const owned = yield* sandboxes.listSandboxes
        .items({ labels: JSON.stringify({ [RUNTIME_OWNER_LABEL]: attrs.owner }) })
        .pipe(
          Stream.filter((s) => s.labels?.[RUNTIME_OWNER_LABEL] === attrs.owner),
          Stream.runCollect,
        );
      yield* Effect.forEach(Array.from(owned), (s) => deleteSandboxById(s.id), { concurrency: 8 });
      return;
    }
    case "secret": {
      const owned = yield* secrets.listSecretsPaginated.items({}).pipe(
        Stream.filter((s) => (s.description ?? "").includes(attrs.descriptionMarker)),
        Stream.runCollect,
      );
      yield* Effect.forEach(
        Array.from(owned),
        (s) =>
          secrets
            .deleteSecret({ secretId: s.id })
            .pipe(Effect.catchTag("SecretNotFound", () => Effect.void)),
        { concurrency: 8 },
      );
      return;
    }
    case "volume": {
      if (attrs.prefix === undefined) return;
      const all = yield* volumes.listVolumes({});
      yield* Effect.forEach(
        all.filter((v) => v.name.startsWith(attrs.prefix!) && v.state !== "deleted"),
        (v) => deleteVolumeById(v.id),
        { concurrency: 8 },
      );
      return;
    }
    case "snapshot": {
      if (attrs.prefix === undefined) return;
      const owned = yield* snapshots.getAllSnapshots.items({ name: attrs.prefix }).pipe(
        Stream.filter((s) => s.name.startsWith(attrs.prefix!) && !s.general),
        Stream.runCollect,
      );
      yield* Effect.forEach(Array.from(owned), (s) => deleteSnapshot(s.id), { concurrency: 8 });
      return;
    }
  }
});

export const RuntimeObjectsProvider = () =>
  Provider.effect(
    RuntimeObjects,
    Effect.succeed({
      stables: ["owner", "labels", "descriptionMarker"],
      nuke: { skip: true },
      list: () => Effect.succeed([]),
      reconcile: Effect.fn(function* ({ id, news }) {
        const owner = yield* ownerOf(id);
        return {
          owner,
          labels: { [RUNTIME_OWNER_LABEL]: owner },
          descriptionMarker: `[alchemy:${owner}]`,
          onDestroy: news.onDestroy,
          prefix: news.prefix,
          kind: news.kind,
        };
      }),
      delete: Effect.fn(function* ({ output }) {
        if (output.onDestroy === "delete") yield* sweep(output);
      }),
    }),
  );
