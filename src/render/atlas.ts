import { decodeTile, type Dt1Tile, type TileImage } from '../formats/dt1';

export const ATLAS_SIZE = 2048;

export interface AtlasEntry {
  image: TileImage;
  layer: number;
  u: number;
  v: number;
}

/**
 * Shelf-packs decoded tile images into ATLAS_SIZE² pages of palette indices (one byte per pixel).
 * Pages become layers of a single WebGL texture array, so the whole map renders in one draw call.
 */
export class TileAtlas {
  readonly entries = new Map<Dt1Tile, AtlasEntry | null>();
  readonly pages: Uint8Array[] = [];
  private shelfX = 0;
  private shelfY = 0;
  private shelfH = 0;

  get(tile: Dt1Tile): AtlasEntry | null {
    if (this.entries.has(tile)) return this.entries.get(tile)!;
    const image = decodeTile(tile);
    const entry = image && image.width > 0 && image.height > 0 ? this.insert(image) : null;
    this.entries.set(tile, entry);
    return entry;
  }

  private insert(image: TileImage): AtlasEntry {
    const { width: w, height: h } = image;
    if (w > ATLAS_SIZE || h > ATLAS_SIZE) throw new Error(`tile too large for atlas: ${w}x${h}`);
    if (this.pages.length === 0) this.newPage();
    if (this.shelfX + w > ATLAS_SIZE) {
      this.shelfX = 0;
      this.shelfY += this.shelfH + 1;
      this.shelfH = 0;
    }
    if (this.shelfY + h > ATLAS_SIZE) this.newPage();
    const layer = this.pages.length - 1;
    const page = this.pages[layer];
    for (let row = 0; row < h; row++) {
      page.set(image.pixels.subarray(row * w, row * w + w), (this.shelfY + row) * ATLAS_SIZE + this.shelfX);
    }
    const entry = { image, layer, u: this.shelfX, v: this.shelfY };
    this.shelfX += w + 1;
    this.shelfH = Math.max(this.shelfH, h);
    return entry;
  }

  private newPage() {
    this.pages.push(new Uint8Array(ATLAS_SIZE * ATLAS_SIZE));
    this.shelfX = 0;
    this.shelfY = 0;
    this.shelfH = 0;
  }
}
