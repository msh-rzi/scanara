type ApiCall = (
  method: string,
  payload: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<unknown>;

export function parseMode(mode: 'HTML') {
  return async (
    prev: ApiCall,
    method: string,
    payload: Record<string, unknown> = {},
    signal?: AbortSignal,
  ) => {
    const nextPayload =
      payload.parse_mode === undefined
        ? {
            ...payload,
            parse_mode: mode,
          }
        : payload;

    return prev(method, nextPayload, signal);
  };
}
