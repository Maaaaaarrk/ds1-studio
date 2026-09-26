/**
 * PKWARE Data Compression Library "explode" decompressor.
 * Port of Mark Adler's blast.c (zlib/contrib/blast), which is public-domain-style licensed.
 */

const MAXBITS = 13;

interface Huffman {
  count: Uint16Array; // number of symbols of each length
  symbol: Uint16Array; // canonically ordered symbols
}

/** Builds a canonical Huffman decoder from blast's compact length representation. */
function construct(rep: readonly number[], nSymbols: number): Huffman {
  const length: number[] = [];
  for (const b of rep) {
    const len = b & 15;
    for (let left = (b >> 4) + 1; left > 0; left--) length.push(len);
  }
  if (length.length !== nSymbols) throw new Error(`explode: bad table (${length.length} != ${nSymbols})`);

  const count = new Uint16Array(MAXBITS + 1);
  for (const len of length) count[len]++;
  const offs = new Uint16Array(MAXBITS + 1);
  for (let len = 1; len < MAXBITS; len++) offs[len + 1] = offs[len] + count[len];
  const symbol = new Uint16Array(nSymbols);
  for (let s = 0; s < nSymbols; s++) if (length[s] !== 0) symbol[offs[length[s]]++] = s;
  return { count, symbol };
}

// Bit lengths for literal codes (ASCII mode), length codes, and distance codes.
const LITLEN = [
  11, 124, 8, 7, 28, 7, 188, 13, 76, 4, 10, 8, 12, 10, 12, 10, 8, 23, 8, 9, 7, 6, 7, 8, 7, 6, 55, 8, 23, 24, 12, 11, 7, 9,
  11, 12, 6, 7, 22, 5, 7, 24, 6, 11, 9, 6, 7, 22, 7, 11, 38, 7, 9, 8, 25, 11, 8, 11, 9, 12, 8, 12, 5, 38, 5, 38, 5, 11, 7,
  5, 6, 21, 6, 10, 53, 8, 7, 24, 10, 27, 44, 253, 253, 253, 252, 252, 252, 13, 12, 45, 12, 45, 12, 61, 12, 45, 44, 173,
];
const LENLEN = [2, 35, 36, 53, 38, 23];
const DISTLEN = [2, 20, 53, 230, 247, 151, 248];
const BASE = [3, 2, 4, 5, 6, 7, 8, 9, 10, 12, 16, 24, 40, 72, 136, 264];
const EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8];

let tables: { lit: Huffman; len: Huffman; dist: Huffman } | null = null;
function getTables() {
  tables ??= { lit: construct(LITLEN, 256), len: construct(LENLEN, 16), dist: construct(DISTLEN, 64) };
  return tables;
}

class BitStream {
  private pos = 0;
  private buf = 0;
  private cnt = 0;
  constructor(private readonly src: Uint8Array) {}

  bits(need: number): number {
    while (this.cnt < need) {
      if (this.pos >= this.src.length) throw new Error('explode: unexpected end of input');
      this.buf |= this.src[this.pos++] << this.cnt;
      this.cnt += 8;
    }
    const v = this.buf & ((1 << need) - 1);
    this.buf >>>= need;
    this.cnt -= need;
    return v;
  }

  /** Decodes one symbol; PKWARE stores Huffman codes bit-inverted, LSB first. */
  decode(h: Huffman): number {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len <= MAXBITS; len++) {
      code |= this.bits(1) ^ 1;
      const count = h.count[len];
      if (code - first < count) return h.symbol[index + (code - first)];
      index += count;
      first = (first + count) << 1;
      code <<= 1;
    }
    throw new Error('explode: invalid code');
  }
}

/**
 * Decompresses a PKWARE DCL stream.
 * @param expectedSize output size if known (used to size the buffer; extra output is an error).
 */
export function explode(src: Uint8Array, expectedSize: number): Uint8Array {
  const { lit: litcode, len: lencode, dist: distcode } = getTables();
  const s = new BitStream(src);
  const out = new Uint8Array(expectedSize);
  let outPos = 0;

  const litMode = s.bits(8);
  if (litMode > 1) throw new Error(`explode: bad literal mode ${litMode}`);
  const dict = s.bits(8);
  if (dict < 4 || dict > 6) throw new Error(`explode: bad dictionary size ${dict}`);

  for (;;) {
    if (s.bits(1)) {
      const lsym = s.decode(lencode);
      const len = BASE[lsym] + s.bits(EXTRA[lsym]);
      if (len === 519) break; // end-of-stream code
      const shift = len === 2 ? 2 : dict;
      let dist = s.decode(distcode) << shift;
      dist += s.bits(shift);
      dist++;
      if (dist > outPos) throw new Error('explode: distance too far back');
      if (outPos + len > out.length) throw new Error('explode: output overflow');
      for (let i = 0; i < len; i++, outPos++) out[outPos] = out[outPos - dist];
    } else {
      const sym = litMode ? s.decode(litcode) : s.bits(8);
      if (outPos >= out.length) throw new Error('explode: output overflow');
      out[outPos++] = sym;
    }
    // D2 archives always know the output size; stop early without needing the end code.
    if (outPos === out.length) break;
  }
  return outPos === out.length ? out : out.subarray(0, outPos);
}
