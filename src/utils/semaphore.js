/**
 * 简单的计数信号量：限制并发数。
 * acquire(timeoutMs) 拿不到槽位且超时 → reject('semaphore timeout')，调用方转 429。
 */
export class Semaphore {
  constructor(limit) {
    this.limit = limit;
    this.active = 0;
    this.waiters = [];
  }

  acquire(timeoutMs) {
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(this._release.bind(this));
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: (release) => resolve(release),
        timer: null,
      };
      if (timeoutMs) {
        waiter.timer = setTimeout(() => {
          const i = this.waiters.indexOf(waiter);
          if (i >= 0) this.waiters.splice(i, 1);
          reject(new Error('semaphore timeout'));
        }, timeoutMs);
      }
      this.waiters.push(waiter);
    });
  }

  _release() {
    this.active -= 1;
    const next = this.waiters.shift();
    if (next) {
      clearTimeout(next.timer);
      this.active += 1;
      next.resolve(this._release.bind(this));
    }
  }

  size() {
    return { active: this.active, waiting: this.waiters.length, limit: this.limit };
  }
}