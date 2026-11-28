export type WakeReason = 'event' | 'timeout' | 'aborted' | 'superseded' | 'shutdown';

type DeviceWaiter = {
  id: number;
  boot: string;
  ready: boolean;
  wake: (reason: WakeReason) => void;
};

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  const err = new Error(typeof reason === 'string' && reason ? reason : 'The operation was aborted');
  err.name = 'AbortError';
  return err;
}

/** In-memory coordinator for Agent HTTP long-polling waiters and task completion notifications. */
export class SyncHub {
  private nextWaiterId = 1;
  private readonly activeWaiters = new Map<string, DeviceWaiter>();
  private readonly taskListeners = new Map<string, Set<() => void>>();

  hasActiveWaiter(deviceId: string, boot?: string | null): boolean {
    const waiter = this.activeWaiters.get(deviceId);
    if (!waiter || !waiter.ready) return false;
    return !boot || waiter.boot === boot;
  }

  waitForDevice(
    deviceId: string,
    boot: string,
    ready: boolean,
    waitMs: number,
    signal?: AbortSignal
  ): Promise<WakeReason> {
    if (signal?.aborted) return Promise.resolve('aborted');
    if (waitMs <= 0) return Promise.resolve('timeout');

    const older = this.activeWaiters.get(deviceId);
    if (older) older.wake('superseded');

    const id = this.nextWaiterId++;
    return new Promise<WakeReason>(resolve => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const onAbort = () => finish('aborted');
      const finish = (reason: WakeReason) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        const current = this.activeWaiters.get(deviceId);
        if (current?.id === id) this.activeWaiters.delete(deviceId);
        resolve(reason);
      };

      this.activeWaiters.set(deviceId, { id, boot, ready, wake: finish });
      timer = setTimeout(() => finish('timeout'), waitMs);
      timer.unref?.();
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  wakeDevice(deviceId: string, reason: WakeReason = 'event'): boolean {
    const waiter = this.activeWaiters.get(deviceId);
    if (!waiter) return false;
    waiter.wake(reason);
    return true;
  }

  wakeAll(reason: WakeReason = 'shutdown'): number {
    const waiters = [...this.activeWaiters.values()];
    for (const waiter of waiters) waiter.wake(reason);
    return waiters.length;
  }

  notifyTask(taskId: string): void {
    const listeners = this.taskListeners.get(taskId);
    if (!listeners || listeners.size === 0) return;
    for (const listener of [...listeners]) listener();
  }

  waitForTaskEvent<T>(
    taskId: string,
    check: () => T | undefined,
    isReady: (value: T) => boolean,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<T | undefined> {
    return new Promise<T | undefined>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let listeners = this.taskListeners.get(taskId);
      if (!listeners) {
        listeners = new Set();
        this.taskListeners.set(taskId, listeners);
      }

      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        const current = this.taskListeners.get(taskId);
        if (current) {
          current.delete(onNotify);
          if (current.size === 0) this.taskListeners.delete(taskId);
        }
      };

      const finish = (value: T | undefined) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };

      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };

      const onAbort = () => {
        if (signal) fail(abortError(signal));
      };

      const onNotify = () => {
        if (settled) return;
        try {
          const current = check();
          if (current === undefined || isReady(current)) finish(current);
        } catch (err) {
          fail(err instanceof Error ? err : new Error(String(err)));
        }
      };

      // Subscribe before reading initial state so no commit-time event is missed.
      listeners.add(onNotify);

      if (signal?.aborted) {
        onAbort();
        return;
      }

      let initial: T | undefined;
      try {
        initial = check();
      } catch (err) {
        fail(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      if (initial === undefined || isReady(initial) || timeoutMs <= 0) {
        finish(initial);
        return;
      }

      timer = setTimeout(() => {
        if (settled) return;
        try {
          finish(check());
        } catch (err) {
          fail(err instanceof Error ? err : new Error(String(err)));
        }
      }, timeoutMs);
      timer.unref?.();
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}
