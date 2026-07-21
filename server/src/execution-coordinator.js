export class ExecutionCoordinator {
  constructor() {
    this.tail = Promise.resolve();
    this.pending = 0;
  }

  async runExclusive(task) {
    if (typeof task !== "function") throw new TypeError("task must be a function");

    const predecessor = this.tail;
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    this.tail = predecessor.then(
      () => gate,
      () => gate
    );
    this.pending += 1;

    await predecessor.catch(() => {});
    try {
      return await task();
    } finally {
      this.pending -= 1;
      release();
    }
  }
}
