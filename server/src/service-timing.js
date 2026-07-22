export class ServiceTiming {
  constructor({ now = () => Date.now(), phaseNames = [] } = {}) {
    this.now = now;
    this.serviceStartedAt = now();
    this.coordinatorRequestedAt = null;
    this.acquiredAt = null;
    this.values = {
      dispatcherQueueMs: null,
      validationMs: 0,
      coordinatorQueueMs: 0,
      ...Object.fromEntries(phaseNames.map((name) => [name, 0])),
      operationMs: 0,
      serviceTotalMs: 0,
    };
  }

  requestCoordinator() {
    if (this.coordinatorRequestedAt !== null) return;
    this.coordinatorRequestedAt = this.now();
    this.values.validationMs = elapsed(this.serviceStartedAt, this.coordinatorRequestedAt);
  }

  acquiredCoordinator() {
    if (this.coordinatorRequestedAt === null) this.requestCoordinator();
    this.acquiredAt = this.now();
    this.values.coordinatorQueueMs = elapsed(this.coordinatorRequestedAt, this.acquiredAt);
  }

  async measure(name, action) {
    if (!Object.hasOwn(this.values, name)) this.values[name] = 0;
    const startedAt = this.now();
    try {
      return await action();
    } finally {
      this.values[name] += elapsed(startedAt, this.now());
    }
  }

  finish() {
    const finishedAt = this.now();
    if (this.coordinatorRequestedAt === null) {
      this.values.validationMs = elapsed(this.serviceStartedAt, finishedAt);
    }
    if (this.acquiredAt !== null) {
      this.values.operationMs = elapsed(this.acquiredAt, finishedAt);
    }
    this.values.serviceTotalMs = elapsed(this.serviceStartedAt, finishedAt);
    return { ...this.values };
  }
}

export function elapsed(startedAt, finishedAt) {
  return Math.max(0, finishedAt - startedAt);
}
