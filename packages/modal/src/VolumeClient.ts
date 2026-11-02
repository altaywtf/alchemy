import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import type { ModalClient } from "./ModalBindings.ts";
import {
  copyVolumeFiles,
  listVolumeFiles,
  readVolumeFile,
  removeVolumeFile,
  writeVolumeFile,
  type VolumeFileEntry,
} from "./VolumeFiles.ts";

/** Read access to one volume's files. */
export interface ReadVolumeClient {
  /** The volume's id. */
  readonly volumeId: Effect.Effect<string>;
  /** Read a file. */
  readFile(path: string): Effect.Effect<Uint8Array, any, RuntimeContext>;
  /** Read a UTF-8 file. */
  readFileString(path: string): Effect.Effect<string, any, RuntimeContext>;
  /** List a directory (`recursive` walks it). */
  listFiles(
    path: string,
    options?: { readonly recursive?: boolean },
  ): Effect.Effect<ReadonlyArray<VolumeFileEntry>, any, RuntimeContext>;
}

/** Write access to one volume's files. */
export interface WriteVolumeClient {
  /** The volume's id. */
  readonly volumeId: Effect.Effect<string>;
  /** Write (create or replace) a file. */
  writeFile(
    path: string,
    data: string | Uint8Array,
    options?: { readonly mode?: number },
  ): Effect.Effect<void, any, RuntimeContext>;
  /** Remove a file, or a directory with `recursive`. */
  removeFile(
    path: string,
    options?: { readonly recursive?: boolean },
  ): Effect.Effect<void, any, RuntimeContext>;
  /** Copy files to `destination` inside the volume. */
  copyFiles(
    sources: ReadonlyArray<string>,
    destination: string,
    options?: { readonly recursive?: boolean },
  ): Effect.Effect<void, any, RuntimeContext>;
}

/** Read and write access to one volume's files. */
export interface ReadWriteVolumeClient extends ReadVolumeClient, WriteVolumeClient {}

/** The read half of a volume client over `volumeId`. */
export const makeReadVolumeClient = (
  volumeId: Effect.Effect<string>,
  client: ModalClient,
): ReadVolumeClient => ({
  volumeId,
  readFile: (path) => client(Effect.flatMap(volumeId, (id) => readVolumeFile(id, path))),
  readFileString: (path) =>
    client(
      Effect.flatMap(volumeId, (id) => readVolumeFile(id, path)).pipe(
        Effect.map((bytes) => new TextDecoder().decode(bytes)),
      ),
    ),
  listFiles: (path, options) =>
    client(Effect.flatMap(volumeId, (id) => listVolumeFiles(id, path, options))),
});

/** The write half of a volume client over `volumeId`. */
export const makeWriteVolumeClient = (
  volumeId: Effect.Effect<string>,
  client: ModalClient,
): WriteVolumeClient => ({
  volumeId,
  writeFile: (path, data, options) =>
    client(Effect.flatMap(volumeId, (id) => writeVolumeFile(id, path, data, options))),
  removeFile: (path, options) =>
    client(Effect.flatMap(volumeId, (id) => removeVolumeFile(id, path, options))),
  copyFiles: (sources, destination, options) =>
    client(Effect.flatMap(volumeId, (id) => copyVolumeFiles(id, sources, destination, options))),
});

/** A read-write volume client over `volumeId`. */
export const makeReadWriteVolumeClient = (
  volumeId: Effect.Effect<string>,
  client: ModalClient,
): ReadWriteVolumeClient => ({
  ...makeReadVolumeClient(volumeId, client),
  ...makeWriteVolumeClient(volumeId, client),
});
