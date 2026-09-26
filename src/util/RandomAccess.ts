/** Random-access byte source (a browser File, an HTTP resource with Range support, a Node file handle...). */
export interface RandomAccess {
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

export class MemoryAccess implements RandomAccess {
  constructor(private readonly bytes: Uint8Array) {}
  get size() {
    return this.bytes.length;
  }
  async read(offset: number, length: number) {
    return this.bytes.slice(offset, offset + length);
  }
}

export class BlobAccess implements RandomAccess {
  constructor(private readonly blob: Blob) {}
  get size() {
    return this.blob.size;
  }
  async read(offset: number, length: number) {
    return new Uint8Array(await this.blob.slice(offset, offset + length).arrayBuffer());
  }
}

export class HttpRangeAccess implements RandomAccess {
  private constructor(
    private readonly url: string,
    readonly size: number,
  ) {}

  static async open(url: string): Promise<HttpRangeAccess> {
    const res = await fetch(url, { method: 'HEAD' });
    if (!res.ok) throw new Error(`HEAD ${url}: ${res.status}`);
    const size = Number(res.headers.get('content-length'));
    if (!Number.isFinite(size)) throw new Error(`HEAD ${url}: missing content-length`);
    return new HttpRangeAccess(url, size);
  }

  async read(offset: number, length: number) {
    if (length === 0) return new Uint8Array(0);
    const res = await fetch(this.url, { headers: { Range: `bytes=${offset}-${offset + length - 1}` } });
    if (res.status !== 206 && res.status !== 200) throw new Error(`GET ${this.url}: ${res.status}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    // A server that ignores Range returns the whole file.
    return res.status === 200 ? buf.slice(offset, offset + length) : buf;
  }
}
