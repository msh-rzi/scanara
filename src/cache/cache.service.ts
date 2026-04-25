import { Injectable } from '@nestjs/common';

interface CacheEntry<T> {
  expiresAt: number;
  value: T;
}

@Injectable()
export class CacheService {
  private readonly defaultTtlSeconds = 300;
  private readonly cache = new Map<string, CacheEntry<unknown>>();

  get<T>(key: string): T | undefined {
    const entry = this.cache.get(key);

    if (!entry) {
      return undefined;
    }

    if (entry.expiresAt <= Date.now()) {
      this.cache.delete(key);
      return undefined;
    }

    return entry.value as T;
  }

  set<T>(key: string, value: T, ttlSeconds = this.defaultTtlSeconds): void {
    this.cache.set(key, {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }

  delete(key: string): void {
    this.cache.delete(key);
  }

  getRateLimit(key: string): number {
    const count = this.get<number>(`ratelimit:${key}`) ?? 0;
    return count;
  }

  setRateLimit(key: string): void {
    const current = this.getRateLimit(key);
    this.set(`ratelimit:${key}`, current + 1, 60); // 60 seconds TTL
  }
}
