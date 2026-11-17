// Renders build/icon.svg to build/icon.png (512) and src/renderer/icon.png (256) with Electron.
// Run: npx electron build/render-icon.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const svg = fs.readFileSync(path.join(__dirname, 'icon.svg'), 'utf8');
  for (const [size, out] of [[512, path.join(__dirname, 'icon.png')], [256, path.join(__dirname, '..', 'src', 'renderer', 'icon.png')]]) {
    const win = new BrowserWindow({ width: size, height: size, show: false, frame: false, transparent: true, backgroundColor: '#00000000', useContentSize: true, webPreferences: { offscreen: true } });
    const html = `<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`;
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    await new Promise((r) => setTimeout(r, 300));
    const img = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
    fs.writeFileSync(out, img.resize({ width: size, height: size }).toPNG());
    win.destroy();
    console.log('wrote', out);
  }
  app.quit();
});
