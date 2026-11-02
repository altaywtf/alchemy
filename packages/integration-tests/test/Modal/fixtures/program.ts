import * as Modal from "@alchemy.run/modal";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { Coder, Workspace } from "./resources.ts";

/** An Effect program in a Modal sandbox, reading a bound volume. */
export default class Agent extends Modal.Sandbox<Agent>()(
  "Agent",
  { main: import.meta.url, app: Coder },
  Effect.gen(function* () {
    const workspace = yield* Modal.ReadVolume(Workspace);
    return {
      fetch: Effect.gen(function* () {
        const files = yield* workspace.listFiles("/");
        return yield* HttpServerResponse.json({ agent: "effect", files: files.length });
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(Modal.ReadVolumeHttp)),
) {}
