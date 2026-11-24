const express = require("express");
const multer = require("multer");
const ffmpegPath = require("ffmpeg-static");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const dns = require("dns").promises;
const net = require("net");

const app = express();
const PORT = process.env.PORT || 10000;
const TMP = path.join(os.tmpdir(), "video-point");
fs.mkdirSync(TMP, { recursive: true });
app.use(express.static(path.join(__dirname, "public")));

const upload = multer({
  dest: TMP,
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = /^(video\/|audio\/)/i.test(file.mimetype);
    cb(ok ? null : new Error("Choose a video or audio file."), ok);
  }
});

function privateIP(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split(".").map(Number);
    return p[0] === 10 || p[0] === 127 || p[0] === 0 ||
      (p[0] === 169 && p[1] === 254) ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 168) || p[0] >= 224;
  }
  if (net.isIPv6(ip)) {
    const s = ip.toLowerCase();
    return s === "::" || s === "::1" || s.startsWith("fc") ||
      s.startsWith("fd") || s.startsWith("fe80");
  }
  return true;
}

async function validateURL(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error("Enter a valid direct media URL."); }
  if (u.protocol !== "https:" || u.username || u.password)
    throw new Error("Only HTTPS links without embedded credentials are accepted.");
  if (!/\.(mp4|webm|mov|m4v|mp3|m4a|wav|ogg)$/i.test(u.pathname))
    throw new Error("Use a direct media-file URL, not a YouTube, Instagram or TikTok page URL.");
  const ips = await dns.lookup(u.hostname, { all: true });
  if (!ips.length || ips.some(x => privateIP(x.address)))
    throw new Error("This media host is not allowed.");
  return u;
}

async function fetchDirect(raw, destination) {
  let u = await validateURL(raw);
  for (let i = 0; i < 4; i++) {
    const response = await fetch(u, { redirect: "manual", signal: AbortSignal.timeout(60000) });
    if ([301,302,303,307,308].includes(response.status)) {
      const loc = response.headers.get("location");
      if (!loc) throw new Error("Invalid media redirect.");
      u = await validateURL(new URL(loc, u).href);
      continue;
    }
    if (!response.ok) throw new Error(`Media host returned HTTP ${response.status}.`);
    const type = response.headers.get("content-type") || "";
    if (!(type.startsWith("video/") || type.startsWith("audio/") || type.includes("octet-stream")))
      throw new Error("The link did not return a media file.");
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > 100 * 1024 * 1024) throw new Error("Maximum direct-link file size is 100 MB.");
    fs.writeFileSync(destination, buffer);
    return;
  }
  throw new Error("Too many redirects.");
}

function convert(input, output, format, resolution) {
  return new Promise((resolve, reject) => {
    const args = ["-y", "-i", input];
    if (format === "mp3") {
      args.push("-vn", "-c:a", "libmp3lame", "-q:a", "2");
    } else if (format === "webm") {
      args.push("-c:v", "libvpx-vp9", "-c:a", "libopus");
    } else if (format === "mp4") {
      args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-c:a", "aac", "-b:a", "160k");
    } else {
      args.push("-c", "copy");
    }
    const h = { "4320":4320, "2160":2160, "1440":1440, "1080":1080, "720":720, "480":480, "360":360 }[resolution];
    if (h && format !== "mp3" && format !== "original") {
      args.push("-vf", `scale=-2:min(ih\\,${h})`);
    }
    if (format === "mp4") args.push("-movflags", "+faststart");
    args.push(output);
    const child = spawn(ffmpegPath, args);
    let errorText = "";
    child.stderr.on("data", d => { errorText = (errorText + d.toString()).slice(-4000); });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve() : reject(new Error("FFmpeg conversion failed. Check that the source file is valid and the selected format is supported.")));
  });
}

app.post("/api/convert", upload.single("media"), async (req, res) => {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const input = path.join(TMP, id + "-input");
  const format = String(req.body.format || "mp4").toLowerCase();
  const resolution = String(req.body.resolution || "original");
  if (!["mp4", "webm", "mp3", "original"].includes(format)) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: "Unsupported output format." });
  }
  try {
    let originalName = "video.mp4";
    if (req.file) {
      fs.renameSync(req.file.path, input);
      originalName = req.file.originalname;
    } else if (req.body.url) {
      const u = await validateURL(req.body.url);
      originalName = path.basename(u.pathname) || originalName;
      await fetchDirect(u.href, input);
    } else {
      return res.status(400).json({ error: "Upload a file or enter a direct media-file URL." });
    }
    const ext = format === "original" ? (path.extname(originalName).slice(1) || "mp4") : format;
    const output = path.join(TMP, id + "-output." + ext);
    await convert(input, output, format, resolution);
    res.download(output, `video-point.${ext}`, () => {
      fs.unlink(input, () => {});
      fs.unlink(output, () => {});
    });
  } catch (e) {
    fs.unlink(input, () => {});
    if (req.file) fs.unlink(req.file.path, () => {});
    if (!res.headersSent) res.status(400).json({ error: e.message || "Conversion failed." });
  }
});

app.use((err, _req, res, _next) => res.status(400).json({ error: err.message || "Upload error." }));
app.listen(PORT, "0.0.0.0", () => console.log(`Video Point listening on ${PORT}`));
