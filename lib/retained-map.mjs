// Bounded session metadata. TTL is measured since last write, not since read.
export class RetainedMap extends Map {
  constructor({ max = 512, ttlMs = 30 * 60 * 1000, clock = Date.now } = {}) {
    super();
    if (!Number.isInteger(max) || max < 1 || max > 4096 || !Number.isFinite(ttlMs) || ttlMs <= 0 || typeof clock !== "function") {
      throw new RangeError("Invalid retention limits");
    }
    this.max = max;
    this.ttlMs = ttlMs;
    this.clock = clock;
    this.expiry = new Map();
  }
  set(key, value) {
    this.prune();
    super.delete(key);
    this.expiry.delete(key);
    super.set(key, value);
    this.expiry.set(key, this.clock() + this.ttlMs);
    while (super.size > this.max) this.delete(super.keys().next().value);
    return this;
  }
  get(key) { this.prune(); return super.get(key); }
  has(key) { this.prune(); return super.has(key); }
  delete(key) { this.expiry.delete(key); return super.delete(key); }
  clear() { super.clear(); this.expiry.clear(); }
  prune() {
    const now = this.clock();
    for (const [key, expiry] of this.expiry) if (expiry <= now) this.delete(key);
  }
}

// Host callbacks and logger methods may return promises across IPC.
export function observeAsync(work, onError = () => {}) {
  try {
    Promise.resolve(work()).catch(error => {
      try { Promise.resolve(onError(error)).catch(() => {}); } catch {}
    });
  } catch (error) {
    try { Promise.resolve(onError(error)).catch(() => {}); } catch {}
  }
}
