import * as sandboxes from "@distilled.cloud/e2b/sandboxes";
import * as secrets from "@distilled.cloud/e2b/secrets";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { Providers } from "./Providers.ts";

/** What a host creates at runtime that its sweep cleans up. */
export type SweptKind = "sandboxes" | "secrets";

export interface SweepProps {
  /** The ownership stamp the host's runtime-created objects carry in their metadata. */
  stamp: Record<string, string>;
  /** The kinds to clean up. */
  kinds: SweptKind[];
  /**
   * What happens to the host's runtime-created objects when the host is
   * destroyed: `"delete"` removes them, `"retain"` leaves them.
   * @default "delete"
   */
  onDestroy?: "delete" | "retain";
}

export interface SweepAttributes {
  stamp: Record<string, string>;
  kinds: SweptKind[];
  onDestroy: "delete" | "retain";
}

export interface Sweep extends Resource<
  "E2B.Sweep",
  SweepProps,
  SweepAttributes,
  never,
  Providers
> {}

/**
 * Cleans up the sandboxes and secrets a host created at runtime when the
 * host is destroyed. Declared for you by `E2B.CreateSandbox()` and
 * `E2B.CreateSecret()`; objects are matched by the ownership stamp those
 * clients write into each object's metadata (`alchemy::stack`,
 * `alchemy::stage`, `alchemy::host`).
 *
 * @internal
 */
export const Sweep = Resource<Sweep>("E2B.Sweep");

/** The metadata query string E2B's sandbox list filters by. */
export const metadataQuery = (metadata: Readonly<Record<string, string>>) =>
  new URLSearchParams(Object.entries(metadata)).toString();

const matches = (
  stamp: Readonly<Record<string, string>>,
  metadata: Readonly<Record<string, string | undefined>> | undefined,
) => Object.entries(stamp).every(([key, value]) => metadata?.[key] === value);

export const SweepProvider = () =>
  Provider.effect(
    Sweep,
    Effect.gen(function* () {
      return {
        reconcile: Effect.fn(function* ({ news }) {
          return { stamp: news.stamp, kinds: news.kinds, onDestroy: news.onDestroy ?? "delete" };
        }),
        delete: Effect.fn(function* ({ output, session }) {
          if (output.onDestroy === "retain" || Object.keys(output.stamp).length === 0) return;
          if (output.kinds.includes("sandboxes")) {
            const running = Array.from(
              yield* Stream.runCollect(
                sandboxes.listSandboxes.items({
                  metadata: metadataQuery(output.stamp),
                  state: ["running", "paused"],
                  limit: 100,
                }),
              ),
            );
            const owned = running.filter((sandbox) => matches(output.stamp, sandbox.metadata));
            if (owned.length > 0) yield* session.note(`Killing ${owned.length} sandbox(es)...`);
            yield* Effect.forEach(
              owned,
              (sandbox) =>
                sandboxes
                  .deleteSandbox({ sandboxID: sandbox.sandboxID })
                  .pipe(Effect.catchTag("NotFound", () => Effect.void)),
              { concurrency: 8, discard: true },
            );
          }
          if (output.kinds.includes("secrets")) {
            const all = Array.from(
              yield* Stream.runCollect(secrets.listSecrets.items({ limit: 100 })),
            );
            const owned = all.filter((secret) => matches(output.stamp, secret.metadata));
            if (owned.length > 0) yield* session.note(`Deleting ${owned.length} secret(s)...`);
            yield* Effect.forEach(
              owned,
              (secret) =>
                secrets
                  .deleteSecret({ secretID: secret.secretID })
                  .pipe(Effect.catchTag("NotFound", () => Effect.void)),
              { concurrency: 8, discard: true },
            );
          }
        }),
      };
    }),
  );
