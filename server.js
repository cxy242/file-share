const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const fastify = require("fastify")({ logger: false });
const DATA_DIR = "/tmp/file-share-data";

// ── Ensure data dir ─────────────────────────────────────────────────────────
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ── In-memory file index ────────────────────────────────────────────────────
// Map<code, { name, diskName, size, mimeType, uploadTime }>
const files = new Map();

// Load existing files from disk on startup
for (const f of fs.readdirSync(DATA_DIR)) {
  const fullPath = path.join(DATA_DIR, f);
  const stat = fs.statSync(fullPath);
  const code = f.split(".")[0];
  files.set(code, {
    name: f.replace(/^[^.]+\./, ""),
    diskName: f,
    size: stat.size,
    mimeType: "application/octet-stream",
    uploadTime: stat.mtimeMs,
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function genCode() {
  return crypto.randomBytes(4).toString("base64url").slice(0, 6);
}

function fmtSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function mimeToIcon(mime) {
  if (!mime) return "📄";
  if (mime.startsWith("image/")) return "🖼️";
  if (mime.startsWith("video/")) return "🎬";
  if (mime.startsWith("audio/")) return "🎵";
  if (mime.includes("pdf")) return "📕";
  if (mime.includes("zip") || mime.includes("rar") || mime.includes("tar") || mime.includes("gz")) return "📦";
  if (mime.includes("apk")) return "📱";
  if (mime.includes("text")) return "📝";
  return "📄";
}

// ── Expired-file cleanup (every 5 min) ──────────────────────────────────────
function cleanup() {
  const now = Date.now();
  const TTL = 24 * 60 * 60 * 1000;
  for (const [code, meta] of files) {
    if (now - meta.uploadTime > TTL) {
      try { fs.unlinkSync(path.join(DATA_DIR, meta.diskName)); } catch {}
      files.delete(code);
    }
  }
}
setInterval(cleanup, 5 * 60 * 1000);
cleanup();

// ── Plugins ──────────────────────────────────────────────────────────────────
fastify.register(require("@fastify/multipart"), {
  limits: { fileSize: 50 * 1024 * 1024 },
});
// ── API: Download ────────────────────────────────────────────────────────────
fastify.get("/dl/:code", async (req, reply) => {
  const code = req.params.code;
  const meta = files.get(code);
  if (!meta) return reply.code(404).send({ error: "文件不存在或已过期" });

  const filePath = path.join(DATA_DIR, meta.diskName);
  if (!fs.existsSync(filePath)) {
    files.delete(code);
    return reply.code(404).send({ error: "文件不存在或已过期" });
  }

  reply.header("Content-Type", meta.mimeType || "application/octet-stream");
  reply.header("Content-Disposition", `attachment; filename="${encodeURIComponent(meta.name)}"`);
  reply.header("Content-Length", meta.size);
  return reply.send(fs.createReadStream(filePath));
});

// ── API: Upload ──────────────────────────────────────────────────────────────
fastify.post("/api/upload", async (req, reply) => {
  const data = await req.file();
  if (!data) return reply.code(400).send({ error: "没有文件" });

  const code = genCode();
  const ext = path.extname(data.filename);
  const diskName = code + ext;
  const filePath = path.join(DATA_DIR, diskName);

  await new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(filePath);
    data.file.pipe(ws);
    ws.on("finish", resolve);
    ws.on("error", reject);
  });

  const stat = fs.statSync(filePath);
  files.set(code, {
    name: data.filename,
    diskName,
    size: stat.size,
    mimeType: data.mimetype || "application/octet-stream",
    uploadTime: Date.now(),
  });

  const proto = req.headers["x-forwarded-proto"] || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const base = `${proto}://${host}`;

  return reply.send({
    code,
    url: `${base}/dl/${code}`,
    name: data.filename,
    size: stat.size,
    sizeFmt: fmtSize(stat.size),
  });
});

// ── API: File list ───────────────────────────────────────────────────────────
fastify.get("/api/files", async () => {
  const list = [...files.entries()]
    .sort((a, b) => b[1].uploadTime - a[1].uploadTime)
    .slice(0, 50)
    .map(([code, m]) => ({
      code,
      name: m.name,
      size: m.size,
      sizeFmt: fmtSize(m.size),
      icon: mimeToIcon(m.mimeType),
      url: `/dl/${code}`,
      time: m.uploadTime,
    }));
  return list;
});

// ── Frontend HTML ────────────────────────────────────────────────────────────
fastify.get("/", async (req, reply) => {
  reply.type("text/html; charset=utf-8");
  return HTML;
});

// ── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
fastify.listen({ port: PORT, host: "0.0.0.0" }, (err) => {
  if (err) { console.error(err); process.exit(1); }
  console.log(`🚀 文件分享服务已启动: http://localhost:${PORT}`);
});

// ── Inline HTML ──────────────────────────────────────────────────────────────
const HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>文件快传</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{
  background:#0a0a1a;color:#e0e0e0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  min-height:100vh;display:flex;justify-content:center;
}
.wrap{
  width:100%;max-width:500px;padding:16px;display:flex;flex-direction:column;gap:20px;
}
h1{
  text-align:center;font-size:1.6rem;margin-top:24px;
  background:linear-gradient(135deg,#f2a7b3,#c273ed);
  -webkit-background-clip:text;-webkit-text-fill-color:transparent;
}
.subtitle{text-align:center;color:#888;font-size:.85rem;margin-top:-12px}
.card{
  background:#1a1a2e;border-radius:16px;padding:24px;
  box-shadow:0 4px 24px rgba(0,0,0,.4);
}

/* Drop zone */
#dropzone{
  border:2px dashed #f2a7b3;border-radius:12px;padding:40px 16px;text-align:center;
  cursor:pointer;transition:all .2s;position:relative;
}
#dropzone:hover,#dropzone.drag{background:rgba(242,167,179,.08);border-color:#e0607a}
#dropzone input{display:none}
#dropzone .icon{font-size:2.4rem;margin-bottom:8px}
#dropzone p{color:#aaa;font-size:.9rem}
#dropzone .hint{color:#666;font-size:.75rem;margin-top:6px}

/* Progress */
.progress-wrap{display:none;margin-top:12px}
.progress-bar{
  height:6px;border-radius:3px;background:#2a2a3e;overflow:hidden;
}
.progress-bar .fill{
  height:100%;width:0;border-radius:3px;
  background:linear-gradient(90deg,#f2a7b3,#c273ed);
  transition:width .3s;
}
.progress-text{text-align:center;color:#888;font-size:.8rem;margin-top:6px}

/* Result */
.result{
  display:none;margin-top:16px;padding:16px;border-radius:12px;
  background:#12122a;border:1px solid #2a2a3e;text-align:center;
}
.result.show{display:block}
.result .name{font-weight:600;word-break:break-all}
.result .size{color:#888;font-size:.85rem;margin:4px 0 12px}
.result .link-box{
  display:flex;border-radius:8px;overflow:hidden;border:1px solid #f2a7b3;
}
.result .link-box input{
  flex:1;border:none;padding:10px 12px;background:#0f0f20;color:#f2a7b3;
  font-size:.85rem;outline:none;
}
.result .link-box button{
  border:none;padding:10px 16px;cursor:pointer;font-weight:600;
  background:linear-gradient(135deg,#f2a7b3,#c273ed);color:#0a0a1a;
  font-size:.85rem;
}
.result .link-box button:hover{opacity:.9}
.result .copy-ok{color:#6dc;color:#6ddf6d;font-size:.8rem;margin-top:6px;display:none}

/* File list */
.list-header{
  display:flex;justify-content:space-between;align-items:center;
}
.list-header h2{font-size:1.1rem}
.list-header .refresh{
  background:none;border:1px solid #333;color:#888;padding:4px 12px;
  border-radius:8px;cursor:pointer;font-size:.8rem;
}
.list-header .refresh:hover{border-color:#f2a7b3;color:#f2a7b3}

.file-list{display:flex;flex-direction:column;gap:8px;margin-top:12px}
.file-item{
  display:flex;align-items:center;gap:12px;padding:12px;
  background:#12122a;border-radius:12px;
  text-decoration:none;color:#e0e0e0;transition:background .2s;
}
.file-item:hover{background:#1e1e38}
.file-item .fi-icon{font-size:1.4rem;flex-shrink:0}
.file-item .fi-info{flex:1;min-width:0}
.file-item .fi-name{
  font-size:.9rem;font-weight:500;white-space:nowrap;
  overflow:hidden;text-overflow:ellipsis;
}
.file-item .fi-meta{font-size:.75rem;color:#666;margin-top:2px}
.file-item .fi-dl{
  background:linear-gradient(135deg,#f2a7b3,#c273ed);
  color:#0a0a1a;border:none;border-radius:8px;padding:6px 14px;
  font-size:.8rem;font-weight:600;cursor:pointer;flex-shrink:0;
}
.file-item .fi-dl:hover{opacity:.85}
.empty{text-align:center;color:#555;padding:32px 0;font-size:.9rem}

.toast{
  position:fixed;bottom:24px;left:50%;transform:translateX(-50%);
  background:#f2a7b3;color:#0a0a1a;padding:10px 24px;border-radius:24px;
  font-size:.85rem;font-weight:600;opacity:0;transition:opacity .3s;pointer-events:none;z-index:99;
}
.toast.show{opacity:1}

@media(max-width:500px){
  .wrap{padding:12px}
  h1{font-size:1.3rem}
  #dropzone{padding:28px 12px}
}
</style>
</head>
<body>
<div class="wrap">
  <h1>📁 文件快传</h1>
  <p class="subtitle">上传文件，生成短链，24小时有效</p>

  <!-- Upload -->
  <div class="card">
    <div id="dropzone">
      <div class="icon">☁️</div>
      <p>点击选择 / 拖拽 / 粘贴上传</p>
      <p class="hint">支持任意文件，最大 50MB</p>
      <input type="file" id="fileInput" />
    </div>
    <div class="progress-wrap" id="progWrap">
      <div class="progress-bar"><div class="fill" id="progFill"></div></div>
      <p class="progress-text" id="progText">上传中…</p>
    </div>
    <div class="result" id="result">
      <p class="name" id="resName"></p>
      <p class="size" id="resSize"></p>
      <div class="link-box">
        <input id="resLink" readonly />
        <button onclick="copyLink()">复制</button>
      </div>
      <p class="copy-ok" id="copyOk">✓ 已复制</p>
    </div>
  </div>

  <!-- File list -->
  <div class="card">
    <div class="list-header">
      <h2>📂 最近文件</h2>
      <button class="refresh" onclick="loadFiles()">刷新</button>
    </div>
    <div class="file-list" id="fileList">
      <div class="empty">加载中…</div>
    </div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
const dz = document.getElementById('dropzone');
const fi = document.getElementById('fileInput');
const progWrap = document.getElementById('progWrap');
const progFill = document.getElementById('progFill');
const progText = document.getElementById('progText');
const result = document.getElementById('result');
const resName = document.getElementById('resName');
const resSize = document.getElementById('resSize');
const resLink = document.getElementById('resLink');
const copyOk = document.getElementById('copyOk');
const fileList = document.getElementById('fileList');
const toast = document.getElementById('toast');

// ── Drag & Drop ─────────────────────────────────────────────
dz.addEventListener('click', () => fi.click());
fi.addEventListener('change', () => { if (fi.files[0]) upload(fi.files[0]); });
['dragenter','dragover'].forEach(e => dz.addEventListener(e, ev => { ev.preventDefault(); dz.classList.add('drag'); }));
['dragleave','drop'].forEach(e => dz.addEventListener(e, ev => { ev.preventDefault(); dz.classList.remove('drag'); }));
dz.addEventListener('drop', ev => {
  const f = ev.dataTransfer.files[0];
  if (f) upload(f);
});

// ── Paste ───────────────────────────────────────────────────
document.addEventListener('paste', ev => {
  const items = ev.clipboardData.items;
  for (const it of items) {
    if (it.kind === 'file') { upload(it.getAsFile()); return; }
  }
});

// ── Upload ──────────────────────────────────────────────────
function upload(file) {
  if (file.size > 50 * 1024 * 1024) { showToast('文件不能超过 50MB'); return; }
  result.classList.remove('show');
  progWrap.style.display = 'block';
  progFill.style.width = '0%';
  progText.textContent = '上传中…';

  const fd = new FormData();
  fd.append('file', file);

  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/upload');
  xhr.upload.onprogress = e => {
    if (e.lengthComputable) {
      const pct = Math.round(e.loaded / e.total * 100);
      progFill.style.width = pct + '%';
      progText.textContent = pct + '%';
    }
  };
  xhr.onload = () => {
    progWrap.style.display = 'none';
    if (xhr.status === 200) {
      const d = JSON.parse(xhr.responseText);
      resName.textContent = d.name;
      resSize.textContent = d.sizeFmt;
      resLink.value = d.url;
      result.classList.add('show');
      copyOk.style.display = 'none';
      loadFiles();
    } else {
      showToast('上传失败: ' + (xhr.responseText || '未知错误'));
    }
  };
  xhr.onerror = () => { progWrap.style.display = 'none'; showToast('网络错误'); };
  xhr.send(fd);
}

// ── Copy ────────────────────────────────────────────────────
function copyLink() {
  navigator.clipboard.writeText(resLink.value).then(() => {
    copyOk.style.display = 'block';
    setTimeout(() => copyOk.style.display = 'none', 2000);
  });
}

// ── File list ───────────────────────────────────────────────
function loadFiles() {
  fetch('/api/files').then(r => r.json()).then(list => {
    if (!list.length) { fileList.innerHTML = '<div class="empty">暂无文件</div>'; return; }
    fileList.innerHTML = list.map(f => \`
      <a class="file-item" href="\${f.url}" download>
        <span class="fi-icon">\${f.icon}</span>
        <div class="fi-info">
          <div class="fi-name">\${esc(f.name)}</div>
          <div class="fi-meta">\${f.sizeFmt}</div>
        </div>
        <span class="fi-dl">下载</span>
      </a>
    \`).join('');
  }).catch(() => { fileList.innerHTML = '<div class="empty">加载失败</div>'; });
}

function esc(s) {
  const d = document.createElement('div'); d.textContent = s; return d.innerHTML;
}

function showToast(msg) {
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2500);
}

// Init
loadFiles();
</script>
</body>
</html>`;
