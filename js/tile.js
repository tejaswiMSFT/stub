/**
 * Cutting a page into pieces so a small barcode can be found in a large image.
 *
 * A barcode occupies a few percent of a ticket. Handed the whole page at once, a decoder
 * sees it at a fraction of the resolution it was printed at, and the fine structure that
 * carries the data — the narrowest bar, the smallest QR module — falls below one pixel
 * and is lost. The decode then fails on an image where the barcode is perfectly clear to
 * a human, which is the most infuriating kind of failure to report.
 *
 * PDFs already avoid this by pulling out the page's own embedded images. That does not
 * help two common cases:
 *
 *   A screenshot or photograph, which has no embedded images at all — it *is* one image.
 *
 *   A PDF whose barcode is drawn with vector operators rather than placed as an image,
 *   which several airlines do. An IndiGo itinerary printing four plainly visible
 *   barcodes was reported as carrying none.
 *
 * So the page is cut into overlapping tiles and each is tried in turn. Overlap matters:
 * a barcode straddling a tile boundary is destroyed by the cut, and a decoder given half
 * a code returns nothing rather than half an answer.
 */

import { createCanvas } from './canvas.js';

/**
 * How many tiles across and down.
 *
 * Three by three is the smallest grid that meaningfully raises resolution — each tile is
 * roughly nine times the detail of the whole — while keeping the work bounded. Nine
 * tiles plus the full page is ten decode attempts, which is around a second on a phone
 * and only happens when the faster paths have already failed.
 */
const GRID = 3;

/**
 * How far tiles overlap, as a fraction of a tile.
 *
 * A quarter is generous, and deliberately so: a boarding pass barcode is often centred,
 * which is precisely where a 3×3 grid puts its cuts. Too little overlap and the one
 * barcode on the page is the one thing guaranteed to be sliced in half.
 */
const OVERLAP = 0.25;

/** Below this a page is already small enough that tiling gains nothing. */
const MIN_EDGE = 900;

/**
 * Cuts a canvas into overlapping tiles.
 *
 * Returns them ordered by where a barcode is most likely to be rather than by position:
 * tickets put their code at the bottom or the right — beneath the details, or beside
 * them — far more often than at the top left, and trying the likely places first means
 * the common case costs one or two decodes rather than nine.
 *
 * Each tile carries the region it came from, so a hit can be reported in the source's
 * own coordinates and the review screen can point at it.
 */
export function tilePage(canvas, { grid = GRID, overlap = OVERLAP } = {}) {
  if (!canvas?.width || !canvas?.height) return [];
  if (Math.max(canvas.width, canvas.height) < MIN_EDGE) return [];

  const tileWidth = Math.ceil(canvas.width / grid);
  const tileHeight = Math.ceil(canvas.height / grid);
  const padX = Math.round(tileWidth * overlap);
  const padY = Math.round(tileHeight * overlap);

  const tiles = [];

  for (let row = 0; row < grid; row += 1) {
    for (let column = 0; column < grid; column += 1) {
      const x = Math.max(0, column * tileWidth - padX);
      const y = Math.max(0, row * tileHeight - padY);
      const width = Math.min(canvas.width - x, tileWidth + padX * 2);
      const height = Math.min(canvas.height - y, tileHeight + padY * 2);

      if (width < 40 || height < 40) continue;

      tiles.push({
        x, y, width, height, row, column,
        // Bottom and right first. A ticket's barcode is below or beside its details far
        // more often than above or left of them.
        priority: (grid - 1 - row) + (grid - 1 - column) * 0.5,
      });
    }
  }

  return tiles.sort((a, b) => a.priority - b.priority);
}

/**
 * Draws one tile, upscaled.
 *
 * The upscale is the point of the exercise. A decoder works from the pixels it is given,
 * and a tile drawn at its native size carries exactly the detail the full page did —
 * cutting alone gains nothing. Doubling gives the binariser more to work with on a code
 * that was marginal, which is the case tiling exists to rescue.
 */
export function drawTile(source, tile, { scale = 2 } = {}) {
  const canvas = createCanvas(Math.round(tile.width * scale), Math.round(tile.height * scale));
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;

  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(
    source,
    tile.x, tile.y, tile.width, tile.height,
    0, 0, canvas.width, canvas.height,
  );

  return { canvas, scale };
}

/**
 * Tiles as decode candidates, in the shape `readBarcodesFromSource` expects.
 *
 * Lazy on purpose: nine upscaled tiles of an A4 page at decoding resolution is a great
 * deal of memory to hold at once on a phone, and the first tile usually answers. Each
 * canvas is drawn when it is asked for and released immediately afterwards.
 */
export function tileCandidates(canvas, { grid = GRID, scale = 2 } = {}) {
  return tilePage(canvas, { grid }).map((tile) => ({
    region: { x: tile.x, y: tile.y, width: tile.width, height: tile.height },
    tiled: true,
    draw: () => drawTile(canvas, tile, { scale }),
  }));
}

export { GRID, OVERLAP, MIN_EDGE };
