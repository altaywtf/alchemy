import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeModalBinding } from "./BindingHttp.ts";
import type { Dict } from "./Dict.ts";
import { makeWriteDictClient } from "./DictClient.ts";
import { WriteDict } from "./WriteDict.ts";

/**
 * {@link WriteDict} over Modal's API. Binds the deployer's Modal token onto the
 * host; Modal tokens act on the whole workspace.
 *
 * @layer
 * @product Dict
 * @provides Modal.WriteDict
 */
export const WriteDictHttp = Layer.effect(
  WriteDict,
  makeModalBinding({
    tag: "Modal.WriteDict",
    make: Effect.fn(function* (dict: Dict, client) {
      return makeWriteDictClient(yield* dict.dictId, client);
    }),
  }),
);
