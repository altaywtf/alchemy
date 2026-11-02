import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeModalBinding } from "./BindingHttp.ts";
import type { Dict } from "./Dict.ts";
import { makeReadWriteDictClient } from "./DictClient.ts";
import { ReadWriteDict } from "./ReadWriteDict.ts";

/**
 * {@link ReadWriteDict} over Modal's API. Binds the deployer's Modal token onto the
 * host; Modal tokens act on the whole workspace.
 *
 * @layer
 * @product Dict
 * @provides Modal.ReadWriteDict
 */
export const ReadWriteDictHttp = Layer.effect(
  ReadWriteDict,
  makeModalBinding({
    tag: "Modal.ReadWriteDict",
    make: Effect.fn(function* (dict: Dict, client) {
      return makeReadWriteDictClient(yield* dict.dictId, client);
    }),
  }),
);
