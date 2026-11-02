import * as Cloudflare from "@alchemy.run/cloudflare";
import * as E2B from "@alchemy.run/e2b";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";

/** Where the events worker records the deliveries it verified. */
export const SeenEvents = Cloudflare.KV.Namespace("SeenEvents", {});

/** The webhook the events worker's subscription creates, read back with ReadWebhook. */
export const EVENTS_PATH = "/__alchemy/e2b/events";

export default class E2BEventsWorker extends Cloudflare.Worker<E2BEventsWorker>()(
  "E2BEventsWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const seen = yield* Cloudflare.KV.ReadWriteNamespace(SeenEvents);
    yield* E2B.consumeSandboxEvents(
      { events: ["sandbox.lifecycle.created", "sandbox.lifecycle.killed"] },
      (event) =>
        seen
          .put(`${event.sandbox_id}:${event.type}`, event.id, { expirationTtl: 3600 })
          .pipe(Effect.orDie),
    );
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://worker");
        const sandboxId = url.searchParams.get("sandbox") ?? "";
        const created = yield* seen.get(`${sandboxId}:sandbox.lifecycle.created`, "text");
        const killed = yield* seen.get(`${sandboxId}:sandbox.lifecycle.killed`, "text");
        return yield* HttpServerResponse.json({
          created: created !== null,
          killed: killed !== null,
        });
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(Layer.mergeAll(E2B.SandboxEventsLive, Cloudflare.KV.ReadWriteNamespaceBinding)),
  ),
) {}
