// icon.svg から icon.png / icon.ico を生成する
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'icon.svg');
const OUT_DIR = path.join(__dirname, '..');

async function main() {
  const svg = fs.readFileSync(SRC);

  // PNG各サイズ
  const sizes = [256, 128, 64, 48, 32, 16];
  const pngBuffers = {};
  for (const s of sizes) {
    pngBuffers[s] = await sharp(svg, { density: 300 })
      .resize(s, s)
      .png()
      .toBuffer();
    fs.writeFileSync(path.join(OUT_DIR, `icon-${s}.png`), pngBuffers[s]);
  }
  fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), pngBuffers[256]);

  // ICO作成（PNG埋め込み形式: 各エントリは PNG データそのまま）
  const entries = [16, 32, 48, 256];
  const headerSize = 6;
  const dirSize = entries.length * 16;
  let offset = headerSize + dirSize;
  const dirEntries = [];
  const imageData = [];
  for (const s of entries) {
    const data = pngBuffers[s];
    dirEntries.push({
      w: s >= 256 ? 0 : s, // 256は0で表す
      h: s >= 256 ? 0 : s,
      size: data.length,
      offset
    });
    imageData.push(data);
    offset += data.length;
  }
  const ico = Buffer.alloc(offset);
  ico.writeUInt16LE(0, 0);       // reserved
  ico.writeUInt16LE(1, 2);       // type: icon
  ico.writeUInt16LE(entries.length, 4);
  let pos = headerSize;
  for (let i = 0; i < entries.length; i++) {
    const e = dirEntries[i];
    ico[pos] = e.w; ico[pos + 1] = e.h;
    ico[pos + 2] = 0; ico[pos + 3] = 0; // colors, reserved
    ico[pos + 4] = 1; ico[pos + 5] = 32; // planes, bpp
    ico.writeUInt32LE(e.size, pos + 8);
    ico.writeUInt32LE(e.offset, pos + 12);
    pos += 16;
  }
  let dataPos = headerSize + dirSize;
  for (const d of imageData) {
    d.copy(ico, dataPos);
    dataPos += d.length;
  }
  fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), ico);
  console.log('生成完了: icon.ico, icon.png, icon-*.png');
}

main().catch(e => { console.error(e); process.exit(1); });
