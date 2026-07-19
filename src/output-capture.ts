import { createHash, type Hash } from "node:crypto";

export interface OutputSnapshot {
  bytes: number;
  sha256: string;
  tail: string;
  truncated: boolean;
}

export class OutputCapture {
  private readonly chunks: Buffer[] = [];
  private readonly hash: Hash = createHash("sha256");
  private retainedBytes = 0;
  private totalBytes = 0;

  constructor(private readonly maxBytes: number) {
    if (!Number.isInteger(maxBytes) || maxBytes < 1) {
      throw new Error("maxBytes must be a positive integer");
    }
  }

  append(chunk: Buffer): void {
    this.hash.update(chunk);
    this.totalBytes += chunk.length;
    this.chunks.push(chunk);
    this.retainedBytes += chunk.length;
    while (this.retainedBytes > this.maxBytes && this.chunks.length > 0) {
      const excess = this.retainedBytes - this.maxBytes;
      const first = this.chunks[0];
      if (!first) break;
      if (first.length <= excess) {
        this.chunks.shift();
        this.retainedBytes -= first.length;
      } else {
        this.chunks[0] = first.subarray(excess);
        this.retainedBytes -= excess;
      }
    }
  }

  snapshot(): OutputSnapshot {
    return {
      bytes: this.totalBytes,
      sha256: this.hash.copy().digest("hex"),
      tail: Buffer.concat(this.chunks, this.retainedBytes).toString("utf8"),
      truncated: this.totalBytes > this.maxBytes,
    };
  }
}
