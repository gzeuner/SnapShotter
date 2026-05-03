'use strict';

class SerialTaskQueue {
  constructor() {
    this.queue = [];
    this.running = false;
    this.idleResolvers = [];
  }

  enqueue(taskFn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ taskFn, resolve, reject });
      this.ensureDrain();
    });
  }

  async whenIdle() {
    if (!this.running && this.queue.length === 0) {
      return;
    }
    await new Promise((resolve) => {
      this.idleResolvers.push(resolve);
    });
  }

  ensureDrain() {
    if (this.running) {
      return;
    }
    this.running = true;
    void this.drain();
  }

  async drain() {
    try {
      while (this.queue.length) {
        const item = this.queue.shift();
        try {
          const result = await item.taskFn();
          item.resolve(result);
        } catch (error) {
          item.reject(error);
        }
      }
    } finally {
      this.running = false;
      const resolvers = this.idleResolvers.splice(0);
      for (const resolve of resolvers) {
        resolve();
      }
      if (this.queue.length) {
        this.ensureDrain();
      }
    }
  }
}

module.exports = {
  SerialTaskQueue
};
