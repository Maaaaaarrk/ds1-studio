/** Storm encryption table + hashing used by MPQ archives. */

const CRYPT_TABLE = (() => {
  const table = new Uint32Array(0x500);
  let seed = 0x00100001;
  for (let i = 0; i < 0x100; i++) {
    let idx = i;
    for (let j = 0; j < 5; j++) {
      seed = (seed * 125 + 3) % 0x2aaaab;
      const hi = (seed & 0xffff) << 16;
      seed = (seed * 125 + 3) % 0x2aaaab;
      const lo = seed & 0xffff;
      table[idx] = (hi | lo) >>> 0;
      idx += 0x100;
    }
  }
  return table;
})();

export const enum HashType {
  TableOffset = 0,
  NameA = 1,
  NameB = 2,
  FileKey = 3,
}

export function hashString(str: string, type: HashType): number {
  let seed1 = 0x7fed7fed;
  let seed2 = 0xeeeeeeee;
  for (let i = 0; i < str.length; i++) {
    let ch = str.charCodeAt(i);
    if (ch === 0x2f) ch = 0x5c; // '/' -> '\'
    if (ch >= 0x61 && ch <= 0x7a) ch -= 0x20; // upper-case ASCII
    seed1 = (CRYPT_TABLE[type * 0x100 + ch] ^ (seed1 + seed2)) >>> 0;
    seed2 = (ch + seed1 + seed2 + (seed2 << 5) + 3) >>> 0;
  }
  return seed1;
}

/** Decrypts `data` in place, one little-endian dword at a time. Trailing bytes (<4) are left untouched. */
export function decryptBlock(data: Uint8Array, key: number): void {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let seed = 0xeeeeeeee;
  key >>>= 0;
  const n = data.byteLength >>> 2;
  for (let i = 0; i < n; i++) {
    seed = (seed + CRYPT_TABLE[0x400 + (key & 0xff)]) >>> 0;
    const ch = (view.getUint32(i * 4, true) ^ (key + seed)) >>> 0;
    view.setUint32(i * 4, ch, true);
    key = (((~key << 0x15) + 0x11111111) | (key >>> 0x0b)) >>> 0;
    seed = (ch + seed + (seed << 5) + 3) >>> 0;
  }
}
