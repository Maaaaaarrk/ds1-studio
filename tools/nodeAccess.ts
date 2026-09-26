import { openSync, readSync, fstatSync } from 'node:fs';
import type { RandomAccess } from '../src/util/RandomAccess';

/** RandomAccess over a local file (Node only; used by tests and CLI tools). */
export class NodeFileAccess implements RandomAccess {
  private readonly fd: number;
  readonly size: number;
  constructor(path: string) {
    this.fd = openSync(path, 'r');
    this.size = fstatSync(this.fd).size;
  }
  async read(offset: number, length: number) {
    const buf = new Uint8Array(length);
    readSync(this.fd, buf, 0, length, offset);
    return buf;
  }
}
