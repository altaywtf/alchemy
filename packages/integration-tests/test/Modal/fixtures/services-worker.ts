import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Modal from "@alchemy.run/modal";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import Api from "./api-server.ts";
import { AsyncEmbed } from "./async-function.ts";
import Embed from "./embed-function.ts";
import { Services } from "./services.ts";
import Web from "./web-function.ts";

const BindingsLive = Layer.mergeAll(
  Modal.InvokeFunctionHttp,
  Modal.ReadFunctionHttp,
  Modal.ScaleFunctionHttp,
  Modal.FetchServerHttp,
  Modal.ReadServerHttp,
  Modal.ReadAppHttp,
  Modal.WriteAppHttp,
);

/** A Cloudflare Worker calling Modal Functions and Servers through their bindings. */
export default class ServicesWorker extends Cloudflare.Worker<ServicesWorker>()(
  "ModalServicesWorker",
  { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
  Effect.gen(function* () {
    const embed = yield* Modal.InvokeFunction(Embed);
    const asyncEmbed = yield* Modal.InvokeFunction(AsyncEmbed);
    const readEmbed = yield* Modal.ReadFunction(Embed);
    const scaleEmbed = yield* Modal.ScaleFunction(Embed);
    const api = yield* Modal.FetchServer(Api);
    const web = yield* Modal.FetchServer(Web);
    const readApi = yield* Modal.ReadServer(Api);
    const services = yield* Modal.ReadApp(Services);
    const operate = yield* Modal.WriteApp(Services);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://worker");
        switch (url.pathname) {
          case "/call":
            return yield* HttpServerResponse.json(
              yield* embed.call(["hello modal world"], { source: "worker" }),
            );
          case "/call-fails": {
            const failed = yield* embed.call(["fail"]).pipe(Effect.flip);
            return yield* HttpServerResponse.json({ tag: failed._tag, message: failed.message });
          }
          case "/map":
            return yield* HttpServerResponse.json(yield* embed.map([["a"], ["b c"], ["d e f"]]));
          case "/spawn": {
            const job = yield* embed.spawn(["one two"]);
            return yield* HttpServerResponse.json(yield* embed.result(job));
          }
          case "/call-async":
            return yield* HttpServerResponse.json(yield* asyncEmbed.call(["ping"]));
          case "/server":
            return yield* HttpServerResponse.json(
              yield* (yield* api.fetch(HttpClientRequest.get("/hello"))).json,
            );
          case "/web":
            return yield* HttpServerResponse.json(
              yield* (yield* web.fetch(HttpClientRequest.get("/hello"))).json,
            );
          case "/read-function": {
            const stats = yield* readEmbed.stats();
            const calls = yield* readEmbed.calls();
            const autoscaler = yield* readEmbed.autoscaler();
            return yield* HttpServerResponse.json({ stats, calls: calls.length, autoscaler });
          }
          case "/scale": {
            const settings = yield* scaleEmbed.update({ scaledownWindow: 120 });
            return yield* HttpServerResponse.json(settings ?? null);
          }
          case "/read-server": {
            const requests = yield* readApi.requests({ limit: 10 });
            const containers = yield* readApi.containers();
            return yield* HttpServerResponse.json({ requests, containers: containers.length });
          }
          case "/read-app": {
            const layout = yield* services.layout();
            const logs = yield* services.logs({ since: Date.now() - 3_600_000, limit: 50 });
            const deployments = yield* services.deployments();
            const tail = yield* services.tail({ timeout: 2 });
            return yield* HttpServerResponse.json({
              functions: Object.keys(layout.functionIds).sort(),
              logs: logs.length,
              tail: Array.isArray(tail.lines),
              version: deployments.productionAppVersion,
            });
          }
          case "/rollover": {
            yield* operate.rollover();
            return yield* HttpServerResponse.json({ rolled: true });
          }
          default:
            return HttpServerResponse.text("ok");
        }
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(BindingsLive)),
) {}
