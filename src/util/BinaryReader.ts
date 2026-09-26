/** Little-endian cursor over a byte buffer. Throws on out-of-bounds reads. */
export class BinaryReader {
  readonly view: DataView;
  pos = 0;

  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get length(): number {
    return this.bytes.length;
  }

  get remaining(): number {
    return this.bytes.length - this.pos;
  }

  seek(pos: number): this {
    if (pos < 0 || pos > this.bytes.length) throw new RangeError(`seek ${pos} outside 0..${this.bytes.length}`);
    this.pos = pos;
    return this;
  }

  skip(n: number): this {
    return this.seek(this.pos + n);
  }

  private need(n: number): void {
    if (this.pos + n > this.bytes.length) {
      throw new RangeError(`read of ${n} bytes at ${this.pos} past end (${this.bytes.length})`);
    }
  }

  u8(): number {
    this.need(1);
    return this.bytes[this.pos++];
  }

  i16(): number {
    this.need(2);
    const v = this.view.getInt16(this.pos, true);
    this.pos += 2;
    return v;
  }

  u16(): number {
    this.need(2);
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }

  i32(): number {
    this.need(4);
    const v = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }

  u32(): number {
    this.need(4);
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }

  bytesView(n: number): Uint8Array {
    this.need(n);
    const v = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return v;
  }

  /** Reads a NUL-terminated latin1 string. */
  cstring(): string {
    let end = this.pos;
    while (end < this.bytes.length && this.bytes[end] !== 0) end++;
    if (end >= this.bytes.length) throw new RangeError(`unterminated string at ${this.pos}`);
    let s = '';
    for (let i = this.pos; i < end; i++) s += String.fromCharCode(this.bytes[i]);
    this.pos = end + 1;
    return s;
  }
}
