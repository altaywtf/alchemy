import * as archil from "@distilled.cloud/archil";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import type { Providers } from "./Providers.ts";

export class DiskUserUnexpectedResponse extends Data.TaggedError(
  "Archil.DiskUserUnexpectedResponse",
)<{
  readonly message: string;
}> {}

export interface DiskUserProps {
  /** Id of the disk the user can mount (e.g. `disk.diskId`). Changing it replaces the user. */
  disk: string;
  /**
   * Name shown in the console. If omitted, a unique name is generated from
   * the stack, stage, and logical ID. Changing it replaces the user.
   */
  nickname?: string;
  /**
   * An AWS IAM role or user ARN that mounts with its own AWS identity
   * instead of a token, e.g. an ECS task role. Changing it replaces the user.
   */
  principal?: string;
}

export interface DiskUserAttributes {
  /** Id of the disk. */
  diskId: string;
  /** `token`, or `awssts` for an IAM principal. */
  type: "token" | "awssts";
  /** Archil's identifier for the user, used to revoke it. */
  identifier: string;
  /** Name shown in the console. */
  nickname: string;
  /** The IAM ARN, for an `awssts` user. */
  principal: string | undefined;
  /**
   * The disk token, for a `token` user. Pass it to `archil mount` as
   * `ARCHIL_MOUNT_TOKEN`. It works only for this disk.
   */
  token: Redacted.Redacted<string> | undefined;
}

export type DiskUser = Resource<
  "Archil.DiskUser",
  DiskUserProps,
  DiskUserAttributes,
  never,
  Providers
>;

/**
 * Access to mount one disk. A token user gets a disk token that only works
 * for that disk; an IAM user lets an AWS principal mount with its own
 * identity, so no token exists at all. Archil checks both itself, so a
 * host holding a disk user can't reach any other disk.
 *
 * Archil only shows a token once, when it's created, so Alchemy stores it
 * in state as a `Redacted` value. Destroying the user revokes it.
 * `Archil.MountDisk(disk)` creates one per host for you.
 * @see https://docs.archil.com/concepts/sharing-disks
 *
 * ### Creating a Disk User
 * **Example:** A token for one machine
 * ```typescript
 * const user = yield* Archil.DiskUser("Indexer", { disk: dataset.diskId });
 * // ARCHIL_MOUNT_TOKEN=<user.token> archil mount <disk> /mnt/data --region aws-us-east-1
 * ```
 *
 * **Example:** An ECS task role that mounts with its own identity
 * ```typescript
 * const user = yield* Archil.DiskUser("Workers", {
 *   disk: dataset.diskId,
 *   principal: taskRole.roleArn,
 * });
 * ```
 *
 * @resource
 * @product Disk
 */
export const DiskUser = Resource<DiskUser>("Archil.DiskUser");

const userNickname = (id: string, nickname: string | undefined) =>
  nickname ? Effect.succeed(nickname) : createPhysicalName({ id, maxLength: 64, delimiter: "-" });

/** The authorized user on a disk with this nickname or principal. */
export const findDiskUser = Effect.fn(function* (
  diskId: string,
  match: { nickname?: string; principal?: string; identifier?: string },
) {
  const { data } = yield* archil.getDisk({ id: diskId });
  return (data.authorizedUsers ?? []).find((user) =>
    match.identifier !== undefined
      ? user.identifier === match.identifier
      : match.principal !== undefined
        ? user.principal === match.principal
        : user.nickname === match.nickname,
  );
});

/** Add a token or IAM user to a disk. */
export const addDiskUser = Effect.fn(function* (
  diskId: string,
  user: { nickname: string; principal?: string },
) {
  const { data } = yield* archil.addDiskUser({
    id: diskId,
    body: user.principal
      ? { type: "awssts", principal: user.principal }
      : { type: "token", nickname: user.nickname },
  });
  if (!user.principal && (!data.token || !data.identifier)) {
    return yield* new DiskUserUnexpectedResponse({
      message: `Archil returned no token for disk user ${user.nickname} on ${diskId}`,
    });
  }
  const token = data.token;
  return {
    diskId,
    type: user.principal ? ("awssts" as const) : ("token" as const),
    identifier: data.identifier ?? user.principal ?? "",
    nickname: data.nickname ?? user.nickname,
    principal: user.principal,
    token:
      token === undefined ? undefined : typeof token === "string" ? Redacted.make(token) : token,
  } satisfies DiskUserAttributes;
});

/** Revoke a disk user. Revoking a missing user (or one on a deleted disk) succeeds. */
export const removeDiskUser = Effect.fn(function* (attrs: {
  diskId: string;
  type: "token" | "awssts";
  identifier: string;
  principal?: string;
}) {
  yield* archil
    .removeDiskUser({
      id: attrs.diskId,
      userType: attrs.type,
      identifier: attrs.type === "token" ? attrs.identifier : undefined,
      principal: attrs.type === "awssts" ? attrs.principal : undefined,
    })
    .pipe(Effect.catchTag("DiskNotFound", () => Effect.void));
});

export const DiskUserProvider = () =>
  Provider.effect(
    DiskUser,
    Effect.gen(function* () {
      return {
        stables: ["diskId", "type", "identifier", "nickname", "principal", "token"],
        diff: Effect.fn(function* ({ id, olds, news, output }) {
          if (!isResolved(news)) return undefined;
          const nickname = output?.nickname ?? (yield* userNickname(id, olds?.nickname));
          if (
            news.disk !== (output?.diskId ?? olds?.disk) ||
            (news.nickname !== undefined && news.nickname !== nickname) ||
            news.principal !== (output?.principal ?? olds?.principal)
          ) {
            return { action: "replace" } as const;
          }
          return undefined;
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          if (!output && !olds) return undefined;
          const diskId = output?.diskId ?? olds!.disk;
          const nickname = output?.nickname ?? (yield* userNickname(id, olds?.nickname));
          const observed = yield* findDiskUser(diskId, {
            identifier: output?.identifier,
            principal: output?.principal ?? olds?.principal,
            nickname,
          }).pipe(Effect.catchTag("DiskNotFound", () => Effect.undefined));
          if (!observed) return undefined;
          return (
            output ?? {
              diskId,
              type: (observed.type ?? "token") as "token" | "awssts",
              identifier: observed.identifier ?? observed.principal ?? "",
              nickname: observed.nickname ?? nickname,
              principal: observed.principal,
              // The token is only shown at creation; reconcile re-mints.
              token: undefined,
            }
          );
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const nickname = output?.nickname ?? (yield* userNickname(id, news.nickname));
          // Observe
          const observed = yield* findDiskUser(news.disk, {
            identifier: output?.identifier,
            principal: news.principal,
            nickname,
          });
          const hasSecret = news.principal !== undefined || output?.token !== undefined;
          if (observed && output && hasSecret) return output;
          // Ensure — a token we hold no secret for (a lost create, or an
          // adoption) is revoked and re-minted.
          if (observed) {
            yield* session.note(`Re-minting disk user ${nickname}...`);
            yield* removeDiskUser({
              diskId: news.disk,
              type: (observed.type ?? "token") as "token" | "awssts",
              identifier: observed.identifier ?? "",
              principal: observed.principal,
            });
          }
          return yield* addDiskUser(news.disk, { nickname, principal: news.principal });
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* removeDiskUser(output);
        }),
      };
    }),
  );
