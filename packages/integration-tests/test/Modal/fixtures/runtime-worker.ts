import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Modal from "@alchemy.run/modal";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Schedule from "effect/Schedule";
import { AsyncAgent } from "./async-agent.ts";
import Agent from "./program.ts";

/** Starts a sandbox of each program per request and returns its answer. */
export default class RuntimeWorker extends Cloudflare.Worker<RuntimeWorker>()(
  "ModalRuntimeWorker",
  { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
  Effect.gen(function* () {
    const agents = yield* Modal.CreateSandbox(Agent);
    const asyncAgents = yield* Modal.CreateSandbox(AsyncAgent);
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const pool =
          new URL(request.url, "http://worker").pathname === "/async" ? asyncAgents : agents;
        const agent = yield* pool.create({ timeout: "5 minutes" });
        const body = yield* Effect.gen(function* () {
          const response = yield* agent
            .fetch(HttpClientRequest.get("/"))
            // The program needs a few seconds to start listening after boot.
            .pipe(Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 20 }));
          return yield* response.json;
        }).pipe(Effect.ensuring(Effect.ignore(agent.terminate())));
        return yield* HttpServerResponse.json(body);
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(Modal.CreateSandboxHttp)),
) {}
