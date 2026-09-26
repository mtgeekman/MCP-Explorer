// Renders build/icon.svg into the files packaging needs, and writes them
// beside it: build/icon.ico (Windows: every size the shell asks for, each
// drawn from the SVG at that size rather than scaled down from a large one)
// and build/icon.png (1024 px: Linux, and the window icon). Run under
// Electron, which has the renderer to draw the SVG:
//
//   npm run icons
//
// The outputs are committed, so packaging needs no display. Run this again
// after changing the SVG. test/icons.test.mjs checks what it wrote.
const { app, BrowserWindow } = require('electron');
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const PNG_SIZE = 1024;
const dir = join(__dirname, '..', 'build');

/** An ICO of PNG images (Windows Vista and later read PNG entries at every size). */
function ico(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  let offset = 6 + 16 * pngs.length;
  const entries = pngs.map(({ size, data }) => {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2);
    e.writeUInt8(0, 3);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    return e;
  });
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]);
}

app.whenReady().then(async () => {
  try {
    const svg = readFileSync(join(dir, 'icon.svg'));
    const w = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
    await w.loadURL('about:blank');
    const src = `data:image/svg+xml;base64,${svg.toString('base64')}`;
    // Each size drawn from the vector at that size, with its transparency kept.
    const draw = async (size) => {
      const url = await w.webContents.executeJavaScript(`new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const c = document.createElement('canvas');
          c.width = c.height = ${size};
          const g = c.getContext('2d');
          g.imageSmoothingQuality = 'high';
          g.drawImage(img, 0, 0, ${size}, ${size});
          resolve(c.toDataURL('image/png'));
        };
        img.onerror = () => reject(new Error('the SVG did not load'));
        img.src = ${JSON.stringify(src)};
      })`);
      return Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
    };
    const pngs = [];
    for (const size of ICO_SIZES) pngs.push({ size, data: await draw(size) });
    writeFileSync(join(dir, 'icon.ico'), ico(pngs));
    writeFileSync(join(dir, 'icon.png'), await draw(PNG_SIZE));
    console.log(`wrote build/icon.ico (${ICO_SIZES.join(', ')}) and build/icon.png (${PNG_SIZE})`);
    app.exit(0);
  } catch (e) {
    console.error(e);
    app.exit(1);
  }
});
