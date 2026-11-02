/**
 * The files a template build's `COPY` steps send to E2B.
 *
 * E2B's builder has no access to your machine: each `COPY` step names a
 * content hash, and the files behind it are uploaded once, as a gzipped tar
 * of the matched paths relative to the build context, to a presigned URL the
 * API hands back (`getTemplateFileUploadLink`). A hash E2B already has is not
 * uploaded again.
 *
 * Sources are a path relative to the context: a file, a directory (copied
 * recursively), or a pattern with `*` / `?` in its last segment.
 */
import * as crypto from "node:crypto";
import * as zlib from "node:zlib";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import { UnsupportedDockerfileInstruction } from "../Errors.ts";

export interface ContextFile {
  /** Path inside the archive, relative to the context, `/`-separated. */
  readonly path: string;
  readonly mode: number;
  readonly contents: Uint8Array;
}

/** An in-memory file to copy, for builds that have no directory on disk (runtime builds, bundles). */
export interface InlineFile {
  readonly path: string;
  readonly contents: Uint8Array | string;
  readonly mode?: number;
}

const encoder = new TextEncoder();

const globToRegExp = (pattern: string) =>
  new RegExp(
    `^${pattern
      .split("")
      .map((c) =>
        c === "*" ? "[^/]*" : c === "?" ? "[^/]" : c.replace(/[.+^${}()|[\]\\]/g, "\\$&"),
      )
      .join("")}$`,
  );

/** Every file under `relative` (a file, a directory, or a last-segment glob), sorted. */
export const resolveSource = Effect.fn(function* (context: string, relative: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const normalized = relative.replace(/^\.\/+/, "").replace(/\/+$/, "") || ".";

  const walk = (rel: string): Effect.Effect<ContextFile[], PlatformError.PlatformError> =>
    Effect.gen(function* () {
      const absolute = path.join(context, rel);
      const info = yield* fs.stat(absolute);
      if (info.type === "Directory") {
        const entries = (yield* fs.readDirectory(absolute)).sort();
        const nested = yield* Effect.forEach(entries, (entry) =>
          walk(rel === "." ? entry : `${rel}/${entry}`),
        );
        return nested.flat();
      }
      if (info.type !== "File") return [];
      return [{ path: rel, mode: info.mode & 0o7777, contents: yield* fs.readFile(absolute) }];
    });

  const last = normalized.split("/").at(-1) ?? normalized;
  if (/[*?]/.test(last)) {
    const parent = normalized.includes("/")
      ? normalized.slice(0, normalized.lastIndexOf("/"))
      : ".";
    const matcher = globToRegExp(last);
    const entries = (yield* fs.readDirectory(path.join(context, parent)))
      .filter((e) => matcher.test(e))
      .sort();
    const nested = yield* Effect.forEach(entries, (entry) =>
      walk(parent === "." ? entry : `${parent}/${entry}`),
    );
    return nested.flat();
  }
  return yield* walk(normalized);
});

/**
 * The content hash E2B caches a `COPY` step's files under: sha256 over the
 * step, then each file's path, mode, size and contents. Stable across
 * machines (no owners or timestamps).
 */
export const filesHash = (src: string, dest: string, files: ReadonlyArray<ContextFile>): string => {
  const hash = crypto.createHash("sha256");
  hash.update(`COPY ${src} ${dest}`);
  for (const file of files) {
    hash.update(file.path);
    hash.update(String(file.mode));
    hash.update(String(file.contents.length));
    hash.update(file.contents);
  }
  return hash.digest("hex");
};

// ---- tar (ustar + pax for long names) ---------------------------------------

const octal = (value: number, length: number) => value.toString(8).padStart(length - 1, "0") + "\0";

const header = (name: string, size: number, mode: number, type: "0" | "x"): Uint8Array => {
  const block = new Uint8Array(512);
  const write = (text: string, offset: number) => block.set(encoder.encode(text), offset);
  write(name.slice(0, 100), 0);
  write(octal(mode, 8), 100);
  write(octal(0, 8), 108);
  write(octal(0, 8), 116);
  write(octal(size, 12), 124);
  write(octal(0, 12), 136);
  write("        ", 148);
  write(type, 156);
  write("ustar\0", 257);
  write("00", 263);
  let checksum = 0;
  for (const byte of block) checksum += byte;
  write(octal(checksum, 7) + " ", 148);
  return block;
};

const padded = (bytes: Uint8Array): Uint8Array[] => {
  const pad = (512 - (bytes.length % 512)) % 512;
  return pad === 0 ? [bytes] : [bytes, new Uint8Array(pad)];
};

const paxRecord = (key: string, value: string) => {
  // "<len> <key>=<value>\n", where <len> counts itself.
  const body = ` ${key}=${value}\n`;
  let length = body.length + 1;
  while (String(length).length + body.length !== length)
    length = String(length).length + body.length;
  return `${length}${body}`;
};

/** A gzipped tar of the files, as E2B's builder extracts it. */
export const tarGzip = (files: ReadonlyArray<ContextFile>) =>
  Effect.sync(() => {
    const parts: Uint8Array[] = [];
    for (const file of files) {
      if (encoder.encode(file.path).length > 100) {
        const pax = encoder.encode(paxRecord("path", file.path));
        parts.push(header("PaxHeader", pax.length, 0o644, "x"), ...padded(pax));
      }
      parts.push(header(file.path, file.contents.length, file.mode, "0"), ...padded(file.contents));
    }
    parts.push(new Uint8Array(1024));
    const size = parts.reduce((n, p) => n + p.length, 0);
    const tar = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
      tar.set(part, offset);
      offset += part.length;
    }
    return new Uint8Array(zlib.gzipSync(tar));
  });

/** Inline files as context files. */
export const inlineFiles = (files: ReadonlyArray<InlineFile>): ContextFile[] =>
  files.map((file) => ({
    path: file.path.replace(/^\/+/, ""),
    mode: file.mode ?? 0o644,
    contents: typeof file.contents === "string" ? encoder.encode(file.contents) : file.contents,
  }));

/** Fails when a `COPY` source matches nothing. */
export const requireFiles = (src: string, files: ReadonlyArray<ContextFile>) =>
  files.length > 0
    ? Effect.succeed(files)
    : Effect.fail(
        new UnsupportedDockerfileInstruction({
          message: `COPY ${src} matches no files in the build context`,
        }),
      );
