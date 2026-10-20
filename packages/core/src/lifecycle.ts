// Process lifecycle kernel: signal-driven graceful shutdown with a hard
// timeout, shared by every entrypoint (web, worker, future one-shot jobs).
// First signal begins shutdown; a second signal force-exits immediately —
// operators always retain control (Operations spec §4/§17 restart policy
// context; runtime not root, no special privileges involved).
export interface GracefulShutdownOptions {
  /** Performs the actual shutdown (close server, end pool, …). */
  shutdown: () => Promise<void>;
  /** Hard limit after which the process exits with code 1 regardless. */
  shutdownTimeoutMilliseconds: number;
  /** Notified on the first signal (for a "shutdown.begin" log line). */
  onSignal?: (signal: string) => void;
  /** Notified when the graceful timeout fires (for a warning log line). */
  onTimeout?: () => void;
}

const HANDLED_SIGNALS: readonly NodeJS.Signals[] = ["SIGTERM", "SIGINT"];

export function installSignalHandlers(options: GracefulShutdownOptions): void {
  let shuttingDown = false;
  const handle = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      process.exit(1);
    }
    shuttingDown = true;
    options.onSignal?.(signal);
    const timer = setTimeout(() => {
      options.onTimeout?.();
      process.exit(1);
    }, options.shutdownTimeoutMilliseconds);
    timer.unref();
    void options.shutdown().then(
      () => process.exit(0),
      (error) => {
        console.error("[pcms:lifecycle] shutdown error:", error);
        process.exit(1);
      },
    );
  };
  for (const signal of HANDLED_SIGNALS) {
    process.on(signal, handle);
  }
}
