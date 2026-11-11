// Frames of a screen recording as PNG files, decoded by Electron's own Chromium (no ffmpeg on this machine): how a
// video the user sends is read (AGENTS.md section 0). Copy the video somewhere writable first.
//
//   node_modules/electron/dist/electron.exe scripts/qa/video_frames.cjs <video.mp4> <out-dir> [count=12] [from-s] [to-s]
//
// Prints the video's duration and size, then writes <out-dir>/f00_<t>s.png ... spread evenly over [from, to]. Read the
// PNGs with the image reader; a change that happens between two frames needs a narrower window or more frames.
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const args = process.argv.slice(process.argv.findIndex((arg) => arg.endsWith("video_frames.cjs")) + 1);
const [video, outDir, countText = "12", fromText, toText] = args;
if (!video || !outDir) {
  console.error("usage: electron scripts/qa/video_frames.cjs <video> <out-dir> [count] [from-s] [to-s]");
  process.exit(2);
}

app.disableHardwareAcceleration();
app.on("window-all-closed", () => {});
app.whenReady().then(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: false, webSecurity: false } });
  await win.loadURL("data:text/html,<video id=v muted></video><canvas id=c></canvas>");
  const info = await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const v = document.getElementById('v');
    v.onloadedmetadata = () => resolve({ duration: v.duration, width: v.videoWidth, height: v.videoHeight });
    v.onerror = () => reject(new Error('the video cannot be decoded (MediaError ' + (v.error && v.error.code) + ')'));
    v.src = ${JSON.stringify(pathToFileURL(path.resolve(video)).href)};
  })`);
  console.log(JSON.stringify(info));
  const count = Math.max(1, Number(countText) || 12);
  const from = Math.max(0, Number(fromText) || 0);
  const to = Math.min(info.duration - 0.05, Number(toText) || info.duration - 0.05);
  for (let index = 0; index < count; index += 1) {
    const at = count === 1 ? from : from + ((to - from) * index) / (count - 1);
    const png = await win.webContents.executeJavaScript(`new Promise((resolve) => {
      const v = document.getElementById('v'), c = document.getElementById('c');
      v.onseeked = () => { c.width = v.videoWidth; c.height = v.videoHeight; c.getContext('2d').drawImage(v, 0, 0); resolve(c.toDataURL('image/png')); };
      v.currentTime = ${at};
    })`);
    const file = path.join(outDir, `f${String(index).padStart(2, "0")}_${at.toFixed(2)}s.png`);
    fs.writeFileSync(file, Buffer.from(png.split(",")[1], "base64"));
    console.log(file);
  }
  app.exit(0);
}).catch((error) => {
  console.error("video frames failed:", error?.message || error);
  app.exit(1);
});
