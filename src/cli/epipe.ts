// `kitchen status | head`: the reader goes away, the next write fails with EPIPE. That is the reader's choice,
// not Kitchen's failure: leave quietly, like any Unix tool. Any other stream error is still an error.
import type { EventEmitter } from "node:events";

export function quietOnEpipe(stream: EventEmitter, exit: (code: number) => void = (c) => process.exit(c)): void {
  stream.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code === "EPIPE") exit(0);
    else throw e;
  });
}
