import type { RawApi, Transformer } from 'grammy';

export function parseMode(mode: 'HTML'): Transformer<RawApi> {
  return async (prev, method, payload, signal) => {
    if (payload && typeof payload === 'object' && !('parse_mode' in payload)) {
      return prev(
        method,
        {
          ...payload,
          parse_mode: mode,
        },
        signal,
      );
    }

    return prev(method, payload, signal);
  };
}
