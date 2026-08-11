/**
 * Reading text off a picture.
 *
 * Until now a screenshot or a photograph yielded nothing but a barcode, because every
 * adapter reads a PDF's text layer and an image has none. `linesFromOcr` has been sitting
 * in text.js the whole time, called and never fed — the reader existed, the producer did
 * not. This is the producer.
 *
 * Four things govern the design, and none of them is negotiable:
 *
 *   It runs on the device. Tesseract compiled to WebAssembly, with the language model
 *   served from this origin. Nothing is uploaded, which is the point of the whole app;
 *   a cloud OCR API would be faster to write, better at the job, and a betrayal.
 *
 *   It is loaded only when needed. The engine and its model come to about 5.5 MB, and
 *   most tickets are PDFs with a perfectly good text layer. Making everyone pay that on
 *   first open, to serve the minority who paste a screenshot, is the wrong trade. Nothing
 *   here is imported until a document turns out to be unreadable any other way.
 *
 *   It is never required. OCR failing, being unsupported, or simply taking too long must
 *   leave the user exactly where they were before it existed: a pass they can fill in by
 *   hand, with the barcode and the picture intact. It is an improvement on nothing, not a
 *   dependency.
 *
 *   What it produces is treated as a guess. Every field derived from OCR is marked as
 *   such, so the review screen asks the user to check it. Character recognition confuses
 *   0 with O and 1 with I, and a boarding pass is mostly exactly those characters.
 */

/**
 * How long to allow before giving up.
 *
 * A ticket at a gate is a hurry, and an app that appears to hang has failed regardless of
 * what it would eventually have produced. Thirty seconds is generous for one page on a
 * phone and still short enough that the fallback arrives while the user is waiting.
 */
const TIMEOUT = 30000;

/**
 * Longest edge fed to the engine.
 *
 * Tesseract wants roughly 300dpi to read body text reliably; feeding it a phone
 * screenshot at native resolution is slower and no more accurate, and feeding it
 * something small is accurate at nothing. This is a compromise found by trying.
 */
const WORK_EDGE = 2000;

let workerPromise = null;

/** Whether this browser can run the engine at all. */
export function supported() {
  return typeof WebAssembly === 'object' && typeof Worker === 'function';
}

/**
 * Starts the engine, once.
 *
 * Kept alive between documents: initialisation is by far the slowest part, and a user
 * adding three screenshots in a row should pay it once. The promise is cached rather than
 * the worker so that two concurrent calls cannot start two engines.
 */
async function getWorker(onProgress) {
  if (workerPromise) return workerPromise;

  workerPromise = (async () => {
    const base = new URL('../vendor/tesseract/', import.meta.url).href;

    // Default export, not named. The ESM build ends `export { tesseract_min as default }`,
    // so importing `{ createWorker }` yields undefined and fails with "createWorker is
    // not a function" — a message that points at the call rather than at the import.
    const tesseract = (await import('../vendor/tesseract/tesseract.esm.min.js')).default;
    const { createWorker } = tesseract;

    return createWorker('eng', 1, {
      // Every path is local. Left to itself the library fetches its core and language
      // data from a CDN, which would mean the app quietly needs the network to read a
      // ticket — and would tell that CDN when someone is looking at one.
      //
      // `corePath` names one file rather than a directory. Given a directory the worker
      // feature-detects and asks for a variant by name — relaxed SIMD, on a browser that
      // supports it — and if that exact file was not vendored the whole thing fails with
      // a network error from inside a web worker, which surfaces nowhere useful. Naming
      // the build removes the guess: plain SIMD is supported everywhere this app runs.
      workerPath: `${base}worker.min.js`,
      corePath: `${base}tesseract-core-simd-lstm.wasm.js`,
      langPath: base,
      gzip: true,
      logger: onProgress
        ? (message) => {
          if (message.status === 'recognizing text') onProgress(message.progress || 0);
        }
        : undefined,
    });
  })().catch((error) => {
    // A failed start must not poison every later attempt.
    workerPromise = null;
    throw error;
  });

  return workerPromise;
}

/** Scales a canvas down for the engine, or returns it unchanged if already small. */
async function prepare(canvas) {
  const longest = Math.max(canvas.width, canvas.height);
  if (longest <= WORK_EDGE) return canvas;

  const { createCanvas } = await import('./canvas.js');
  const scale = WORK_EDGE / longest;
  const target = createCanvas(Math.round(canvas.width * scale), Math.round(canvas.height * scale));
  const context = target.getContext('2d');
  if (!context) return canvas;

  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(canvas, 0, 0, target.width, target.height);
  return target;
}

/**
 * Reads a canvas and returns positioned words.
 *
 * The shape matches what `linesFromOcr` in text.js already expects — text with a bounding
 * box — so the whole downstream pipeline, column splitting and label finding included,
 * works on an image exactly as it does on a PDF. That is the entire reason this returns
 * words rather than a string: a boarding pass is a grid, and a grid flattened into prose
 * loses the very relationships the adapters read.
 */
export async function readWords(canvas, { onProgress = null, timeout = TIMEOUT } = {}) {
  if (!supported() || !canvas?.width) return null;

  let timer = null;

  try {
    const source = await prepare(canvas);
    const worker = await getWorker(onProgress);

    const recognition = worker.recognize(source, {}, { blocks: true });

    const raced = await Promise.race([
      recognition,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('OCR timed out')), timeout);
      }),
    ]);

    // Positions come back in the scaled image's coordinates; the caller works in the
    // display canvas's. Reported here so nothing downstream has to know we resized.
    const ratio = canvas.width / source.width;

    const words = [];
    for (const block of raced?.data?.blocks || []) {
      for (const paragraph of block.paragraphs || []) {
        for (const line of paragraph.lines || []) {
          for (const word of line.words || []) {
            const box = word.bbox;
            if (!word.text?.trim() || !box) continue;

            words.push({
              text: word.text,
              confidence: word.confidence ?? 0,
              // `bbox` in the display canvas's own coordinates, which is the shape
              // `linesFromOcr` was written against — it predates this module by months
              // and is what the fixtures assume, so the producer matches the reader
              // rather than the other way round.
              bbox: {
                x0: box.x0 * ratio,
                y0: box.y0 * ratio,
                x1: box.x1 * ratio,
                y1: box.y1 * ratio,
              },
            });
          }
        }
      }
    }

    return words.length ? words : null;
  } catch {
    // Unsupported, out of memory, timed out, or the model failed to load. All of them
    // mean the same thing to the user: no text was read, which is where they were
    // before this existed.
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Shuts the engine down. Called when the app is backgrounded on a memory-tight device. */
export async function release() {
  if (!workerPromise) return;

  const pending = workerPromise;
  workerPromise = null;

  try {
    const worker = await pending;
    await worker.terminate();
  } catch {
    // Already gone.
  }
}

export { TIMEOUT, WORK_EDGE };
