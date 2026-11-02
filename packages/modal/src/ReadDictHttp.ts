import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeModalBinding } from "./BindingHttp.ts";
import type { Dict } from "./Dict.ts";
import { makeReadDictClient } from "./DictClient.ts";
import { ReadDict } from "./ReadDict.ts";

/**
 * {@link ReadDict} over Modal's API. Binds the deployer's Modal token onto the
 * host; Modal tokens act on the whole workspace.
 *
 * @layer
 * @product Dict
 * @provides Modal.ReadDict
 */
export const ReadDictHttp = Layer.effect(
  ReadDict,
  makeModalBinding({
    tag: "Modal.ReadDict",
    make: Effect.fn(function* (dict: Dict, client) {
      return makeReadDictClient(yield* dict.dictId, client);
    }),
  }),
);
