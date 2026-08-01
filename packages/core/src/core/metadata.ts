import type { Context } from "./context";

/**
 * Internal metadata key used by client.call(...) to pass operation arguments to
 * policies that derive keys from the wrapped operation arguments without
 * changing the public Context API.
 *
 * @internal
 */
export const OPERATION_ARGS_METADATA_KEY = "resili.operation.args";

/**
 * Creates internal metadata for client.call(...) operation arguments.
 *
 * @internal
 */
export function createOperationArgsMetadata(
  args: readonly unknown[],
): Readonly<Record<string, unknown>> {
  return {
    [OPERATION_ARGS_METADATA_KEY]: args,
  };
}

/**
 * Reads operation arguments from internal context metadata.
 *
 * @internal
 */
export function getOperationArgs(ctx: Context): readonly unknown[] {
  const args = ctx.metadata.get(OPERATION_ARGS_METADATA_KEY);

  return Array.isArray(args) ? args : [];
}
