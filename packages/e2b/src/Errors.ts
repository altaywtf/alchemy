import * as Data from "effect/Data";

/** E2B answered in a way a lifecycle step cannot continue from (e.g. a resource vanished right after create). */
export class E2BUnexpectedResponse extends Data.TaggedError("E2B.UnexpectedResponse")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** A template build finished in a failed state. */
export class TemplateBuildFailed extends Data.TaggedError("E2B.TemplateBuildFailed")<{
  readonly message: string;
  readonly templateId: string;
  readonly buildId: string;
  readonly reason?: string;
  readonly logs?: ReadonlyArray<string>;
}> {}

/** A Dockerfile uses something E2B's builder does not support. Raised at plan time. */
export class UnsupportedDockerfileInstruction extends Data.TaggedError(
  "E2B.UnsupportedDockerfileInstruction",
)<{
  readonly message: string;
  readonly line?: number;
}> {}

/** A command run while building a snapshot exited non-zero. */
export class SnapshotSetupFailed extends Data.TaggedError("E2B.SnapshotSetupFailed")<{
  readonly message: string;
  readonly command: string;
  readonly exitCode: number;
  readonly stderr: string;
}> {}
