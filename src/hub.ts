import type { ServerResponse } from "node:http";
import type { StoredEvent } from "./schema.js";

/** Fan-out of newly stored events to connected Server-Sent-Events clients. */
export class EventHub {
  private clients = new Set<ServerResponse>();
  private keepAlive?: NodeJS.Timeout;

  constructor(keepAliveMs = 15_000) {
    if (keepAliveMs > 0) {
      this.keepAlive = setInterval(() => this.write(": ping\n\n"), keepAliveMs);
      this.keepAlive.unref();
    }
  }

  get size() {
    return this.clients.size;
  }

  add(res: ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "Access-Control-Allow-Origin": "*",
    });
    res.write(": connected\n\n");
    this.clients.add(res);
    res.on("close", () => this.clients.delete(res));
  }

  broadcast(events: StoredEvent[]): void {
    for (const e of events) this.write(`data: ${JSON.stringify(e)}\n\n`);
  }

  close(): void {
    if (this.keepAlive) clearInterval(this.keepAlive);
    for (const c of this.clients) c.end();
    this.clients.clear();
  }

  private write(chunk: string) {
    for (const c of this.clients) {
      try {
        c.write(chunk);
      } catch {
        this.clients.delete(c);
      }
    }
  }
}
