const express = require('express');
const { rateLimit } = require('express-rate-limit');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');

const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY);
app.use(express.json({ limit: '64kb' }));
app.use(express.urlencoded({ extended: false, limit: '16kb' }));
app.use(express.text({ type: 'text/plain', limit: '1kb' }));
app.use('/logs', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  if (req.method !== 'GET' && req.headers.origin && req.headers.origin !== req.protocol + '://' + req.get('host')) {
    return res.status(403).send('请求来源不匹配');
  }
  next();
});
app.use('/logs', rateLimit({ windowMs: 300000, limit: 30, skip: req => req.method !== 'POST' || req.path !== '/', message: { error: '登录尝试过多，请稍后重试' } }));
app.use('/api', rateLimit({ windowMs: 60000, limit: 20 }));
app.post('/', rateLimit({ windowMs: 60000, limit: 30 }));

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const KV_DIR = path.join(DATA_DIR, 'kv_logs');
const PORT = Number(process.env.PORT || 9567);
const PAGE_SIZE = Math.max(1, Math.min(100, Number(process.env.PAGE_SIZE) || 20));
const TIMEZONE = Number(process.env.TIMEZONE_OFFSET || 8);
let passwordHash;

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return salt + ':' + crypto.scryptSync(password, salt, 64).toString('hex');
}
function checkPassword(password) {
  if (typeof password !== 'string' || password.length > 1024) return false;
  const candidate = hashPassword(password, passwordHash.split(':')[0]);
  return crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(passwordHash));
}
async function initConfig() {
  await fs.mkdir(KV_DIR, { recursive: true });
  try {
    const config = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
    if (!/^[a-f0-9]{32}:[a-f0-9]{128}$/.test(config.passwordHash || '')) throw new Error('密码配置损坏');
    passwordHash = config.passwordHash;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (!process.env.LOG_PASSWORD || process.env.LOG_PASSWORD.length < 12) throw new Error('首次启动请设置至少 12 位的 LOG_PASSWORD');
    await savePassword(process.env.LOG_PASSWORD);
  }
}
async function savePassword(password) {
  const nextHash = hashPassword(password);
  await fs.writeFile(CONFIG_PATH + '.tmp', JSON.stringify({ passwordHash: nextHash }), { mode: 0o600 });
  await fs.rename(CONFIG_PATH + '.tmp', CONFIG_PATH);
  passwordHash = nextHash;
}
function sessionToken(expires) {
  return crypto.createHmac('sha256', passwordHash).update(String(expires)).digest('hex');
}
function isAuth(req) {
  const value = (req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith('log_token='))?.slice(10) || '';
  const [expires, signature] = value.split('.');
  if (!/^\d+$/.test(expires || '') || Number(expires) < Date.now() || !/^[a-f0-9]{64}$/.test(signature || '')) return false;
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(sessionToken(expires)));
}
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
const BAIDU_APP_ID = process.env.BAIDU_APP_ID;
const BAIDU_API_KEY = process.env.BAIDU_API_KEY;
const BAIDU_SECRET_KEY = process.env.BAIDU_SECRET_KEY;
const ocrEnabled = Boolean(BAIDU_APP_ID && BAIDU_API_KEY && BAIDU_SECRET_KEY);
let ocrToken;
let tokenExpires = 0;
async function getOcrToken() {
  if (ocrToken && Date.now() < tokenExpires) return ocrToken;
  const response = await fetch('https://aip.baidubce.com/oauth/2.0/token', {
    method: 'POST', signal: AbortSignal.timeout(15000),
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: BAIDU_API_KEY, client_secret: BAIDU_SECRET_KEY })
  });
  const result = await response.json();
  if (!response.ok || !result.access_token) throw new Error('百度 OCR 鉴权失败，请检查 API_KEY 和 SECRET_KEY');
  ocrToken = result.access_token;
  tokenExpires = Date.now() + Math.max(0, Number(result.expires_in || 0) - 60) * 1000;
  return ocrToken;
}
async function requestOcr(image, retry = true) {
  const token = await getOcrToken();
  const response = await fetch('https://aip.baidubce.com/rest/2.0/ocr/v1/accurate_basic?access_token=' + encodeURIComponent(token), {
    method: 'POST', signal: AbortSignal.timeout(15000),
    body: new URLSearchParams({ image })
  });
  const result = await response.json();
  if (retry && [110, 111].includes(result.error_code)) {
    ocrToken = null;
    return requestOcr(image, false);
  }
  if (!response.ok || result.error_code) throw new Error('百度 OCR: ' + (result.error_msg || '服务返回错误'));
  return result;
}
const upload = multer({
  storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 0 },
  fileFilter: (req, file, cb) => cb(null, ['image/png', 'image/jpeg', 'image/gif', 'image/bmp'].includes(file.mimetype))
});
function requireOcr(req, res, next) {
  if (!ocrEnabled) return res.status(503).json({ error: '请先配置百度 OCR 的 APP_ID、API_KEY 和 SECRET_KEY' });
  next();
}
async function recognize(req) {
  if (!req.file) { const error = new Error('请上传 PNG、JPEG、GIF 或 BMP 图片'); error.status = 400; throw error; }
  const result = await requestOcr(req.file.buffer.toString('base64'));
  return result.words_result?.map(p => p.words).join('\n') || '';
}

function eI(t) {
  const e = t instanceof ArrayBuffer ? new Uint8Array(t) : new TextEncoder().encode(t);
  let n = '';
  for (const o of e) n += String.fromCharCode(o);
  return btoa(n).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

let tI = null;
async function yT() {
  if (!tI) {
    tI = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  }
  return tI;
}

async function c1(t, e) {
  const key = await yT();
  const jwk = await crypto.subtle.exportKey('jwk', key.publicKey);
  const header = eI(JSON.stringify({ alg: 'ES256', typ: 'dpop+jwt', jwk }));
  const payload = eI(JSON.stringify({
    htu: t, htm: e, jti: crypto.randomUUID(), iat: Math.floor(Date.now() / 1000)
  }));
  const unsigned = header + '.' + payload;
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key.privateKey,
    new TextEncoder().encode(unsigned)
  );
  return unsigned + '.' + eI(signature);
}

function GenerateSessionId() {
  //return 'app_' + Math.random().toString(36).slice(2, 15);
  const t = Date.now().toString(36);
  const e = Math.random().toString(36).substr(2, 9);
  return `app_${t}_${e}`;
}

async function safeParse(resp) {
  const text = await resp.text();
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

// ✅ 修复：保留时区偏移，正确计算东八区时间，日期+时间完全准确
function getFormatTime(offset = TIMEZONE) {
  return new Date(Date.now() + offset * 3600000).toISOString().replace('T', ' ').slice(0, 19);
}
function getClientIp(req) { return req.ip || 'unknown'; }

// ====================== IID 提取规则（修正：过滤无关数字，优先7位组→6位组） ======================
function extractIIDs(text) {
  const results = [];

  // 新增：过滤无关数字（解决800/400电话号码、短数字误识别问题）
  // 1. 过滤800/400开头的10位电话号码（如8008203800、4008203800）
  let filteredText = text.replace(/\b(800|400)\d{1,7}\b/g, '');
  // 2. 过滤非6位、非7位的短数字（如12345678，避免干扰IID提取）
  filteredText = filteredText.replace(/\b\d{1,5}\b|\b\d{8,9}\b/g, '');

  // 原有格式匹配（保留，基于过滤后文本匹配）
  const pattern54 = /\b(?:\d{6}\s+){8}\d{6}\b/g;
  const pattern63 = /\b(?:\d{7}\s+){8}\d{7}\b/g;

  const m54 = filteredText.match(pattern54) || [];
  const m63 = filteredText.match(pattern63) || [];

  // 优先级1：先处理 63位（7位一组）IID
  for (const s of m63) {
    const c = s.replace(/\s+/g, '');
    if (c.length === 63) results.push(c);
  }

  // 优先级2：再处理 54位（6位一组）IID
  for (const s of m54) {
    const c = s.replace(/\s+/g, '');
    if (c.length === 54) results.push(c);
  }

  // 优先级3：纯数字长串（优先63位，再54位，基于过滤后文本）
  const nums = filteredText.match(/\d{54,63}/g) || [];
  // 先取63位
  for (const n of nums) {
    if (n.length === 63) {
      results.push(n);
    }
  }
  // 再取54位
  for (const n of nums) {
    if (n.length === 54) {
      results.push(n);
    }
  }

  // 优先级4：兜底（过滤后所有数字拼接，优先63位，再54位）
  const allDigits = filteredText.replace(/\D/g, '');
  if (allDigits.length >= 63) {
    results.push(allDigits.slice(0, 63));
  } else if (allDigits.length >= 54) {
    results.push(allDigits.slice(0, 54));
  }

  // 去重，避免重复提取
  return [...new Set(results)];
}

// ====================== KV 存储 ======================
async function writeLog(item) {
  await fs.writeFile(path.join(KV_DIR, 'log_' + item.id + '.json'), JSON.stringify([item]), { mode: 0o600 });
}

async function getAllLogs() {
  try {
    const files = await fs.readdir(KV_DIR);
    const all = [];
    for (const f of files.filter(f => f.endsWith('.json'))) {
      try {
        const txt = await fs.readFile(path.join(KV_DIR, f), 'utf8');
        const arr = JSON.parse(txt);
        if (Array.isArray(arr)) all.push(...arr);
      } catch { }
    }
    return all.sort((a, b) => (b.time || '').localeCompare(a.time || ''));
  } catch { return []; }
}

async function deleteLogById(targetId) {
  if (!targetId) return false;
  const files = await fs.readdir(KV_DIR);
  let deleted = false;

  for (const f of files) {
    const file = path.join(KV_DIR, f);
    try {
      const txt = await fs.readFile(file, 'utf8');
      const arr = JSON.parse(txt);
      if (!Array.isArray(arr)) continue;

      const filtered = arr.filter(x => x.id !== targetId);
      if (filtered.length !== arr.length) {
        deleted = true;
        if (filtered.length === 0) {
          await fs.unlink(file);
        } else {
          await fs.writeFile(file, JSON.stringify(filtered), 'utf8');
        }
      }
    } catch (e) {}
  }
  return deleted;
}

async function clearAllLogs() {
  const files = await fs.readdir(KV_DIR);
  await Promise.all(files.map(f => fs.unlink(path.join(KV_DIR, f))));
}

// ====================== 页面 ======================
function loginPage(msg = '') {
  return `<!DOCTYPE html><meta charset="utf-8"><title>登录</title><style>body{display:grid;place-items:center;height:100vh;margin:0}.box{padding:24px;background:#fff;border-radius:12px;box-shadow:0 2px 10px rgba(0,0,0,0.1);width:320px}input,button{width:100%;padding:10px;margin:8px 0;border-radius:6px;border:1px solid #ddd}button{background:#0066cc;color:white;border:none;cursor:pointer}.msg{color:green;text-align:center;margin:8px 0}.err{color:red}</style><div class="box"><h3>日志后台登录</h3>${msg ? `<div class="${msg.includes('成功') ? 'msg' : 'err'}">${escapeHtml(msg)}</div>` : ''}<form method="post"><input type="password" name="pwd" required placeholder="密码"><button>登录</button></form></div>`;
}

// 新增：修改密码页面
function changePasswordPage(msg = '') {
  return `<!DOCTYPE html><meta charset="utf-8"><title>修改登录密码</title>
<style>
body{display:grid;place-items:center;height:100vh;margin:0;background:#fafafa}
.box{padding:24px;background:#fff;border-radius:12px;box-shadow:0 2px 10px rgba(0,0,0,0.1);width:380px}
input,button{width:100%;padding:10px;margin:8px 0;border-radius:6px;border:1px solid #ddd}
button{background:#0066cc;color:white;border:none;cursor:pointer}
.back{background:#6c757d;margin-top:10px}
.msg{color:red;text-align:center;margin:8px 0}
</style>
<div class="box">
  <h3>修改日志后台密码</h3>
  ${msg ? `<div class="msg">${escapeHtml(msg)}</div>` : ''}
  <form method="post">
    <input type="password" name="oldPwd" required placeholder="请输入旧密码">
    <input type="password" name="newPwd" required placeholder="请输入新密码">
    <input type="password" name="confirmPwd" required placeholder="请确认新密码">
    <button type="submit">确认修改</button>
    <button type="button" class="back" onclick="location.href='/logs'">返回日志页</button>
  </form>
</div>`;
}

function logPage(logs, page, totalPages, search) {
  const start = (page - 1) * PAGE_SIZE;
  const end = start + PAGE_SIZE;
  const paginated = logs.slice(start, end);
  const rows = paginated.map(item => `
  <tr>
    <td>${escapeHtml(item.time)}</td>
    <td style="font-family:monospace">${escapeHtml(item.IID)}</td>
    <td>${escapeHtml(item.ip)}</td>
    <td>${item.result?.success ? '✅成功' : '❌失败'}</td>
    <td>
      <button onclick="del('${item.id}')" style="background:red;color:white;border:none;padding:4px 8px;border-radius:4px;cursor:pointer">删除</button>
      <button onclick="searchIID('${encodeURIComponent(item.IID || '')}')" style="background:#6c757d;color:white;border:none;padding:4px 8px;border-radius:4px;cursor:pointer;margin:0 2px">同IID</button>
      <button onclick="showDetail('${encodeURIComponent(JSON.stringify(item.result)).replace(/'/g, '%27')}')" style="background:#0066cc;color:white;border:none;padding:4px 8px;border-radius:4px;cursor:pointer;margin:0 2px">详情</button>
    </td>
  </tr>`).join('');

  const pages = [];
  for (let i = 1; i <= totalPages; i++) {
    pages.push(`<a href="?page=${i}&search=${encodeURIComponent(search)}" style="margin:0 5px;color:${page === i ? 'red' : '#0066cc'}">${i}</a>`);
  }

  return `<!DOCTYPE html><meta charset="utf-8"><title>IID 激活日志</title>
<style>
body{margin:20px;font-family:system-ui;background:#fafafa}
.card{background:white;padding:20px;border-radius:12px;box-shadow:0 2px 10px rgba(0,0,0,0.1)}
.bar{display:flex;gap:10px;margin:10px 0}
input{flex:1;padding:8px;border-radius:6px;border:1px solid #ddd}
button{padding:8px 12px;border:none;border-radius:6px;color:white;cursor:pointer}
.red{background:red}
table{width:100%;border-collapse:collapse}
th,td{padding:10px;border:1px solid #eee}
#detailModal{display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:9999;align-items:center;justify-content:center}
#detailModal .modal-content{background:#fff;border-radius:8px;padding:20px;width:90%;max-width:800px;max-height:80vh;overflow:auto;position:relative}
#detailModal .modal-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px}
#detailModal .modal-header h3{margin:0;font-size:20px}
#detailModal .btn-group{display:flex;gap:10px}
#detailModal .btn-copy{background:#28a745;color:white;border:none;padding:8px 16px;border-radius:6px;cursor:pointer;font-size:16px}
#detailModal .btn-close{background:#6c757d;color:white;border:none;padding:8px 16px;border-radius:6px;cursor:pointer;font-size:16px}
#detailContent{background:#f8f9fa;padding:16px;border-radius:6px;white-space:pre-wrap;font-family:monospace;min-height:200px;max-height:50vh;overflow:auto}
.toast{position:fixed;top:20px;left:50%;transform:translateX(-50%);background:#222;color:#fff;padding:10px 16px;border-radius:10px;opacity:0;transition:0.3s}
.toast.show{opacity:1;top:30px}
</style>
<div class="card">
  <h3>IID 激活日志</h3>
  <div class="bar">
    <input id="s" value="${escapeHtml(search)}" placeholder="搜索 IID">
    <button onclick="location.href='?search='+encodeURIComponent(document.getElementById('s').value)">搜索</button>
    <a href="/logs/change-password"><button style="background:#0066cc;color:white;border:none;padding:8px 12px;border-radius:6px;cursor:pointer">修改密码</button></a>
    <form method="post" action="/logs/clear" onsubmit="return confirm('确认清空全部日志？')"><button class="red">清空全部</button></form>
  </div>
  <div style="margin:10px 0">${pages.join('')}</div>
  <table>
    <tr><th>时间</th><th>IID</th><th>IP</th><th>状态</th><th>操作</th></tr>
    ${rows}
  </table>
</div>
<div id="detailModal"><div class="modal-content"><div class="modal-header"><h3>激活详情</h3><div class="btn-group"><button class="btn-close" onclick="closeDetailModal()">关闭</button><button class="btn-copy" onclick="copyDetailJson()">复制JSON</button></div></div><div id="detailContent"></div></div></div>
<div class="toast" id="toast"></div>
<script>
const $ = s => document.querySelector(s);
const toast = msg => { const t=$('#toast');t.textContent=msg;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),2000); };
function searchIID(iid){ location.href='?search='+decodeURIComponent(iid); }
function showDetail(s){ try{const r=JSON.parse(decodeURIComponent(s));$('#detailContent').textContent=JSON.stringify(r,null,2);}catch(e){$('#detailContent').textContent='解析失败：'+e;}finally{$('#detailModal').style.display='flex';} }
function closeDetailModal(){ $('#detailModal').style.display='none'; }
async function copyDetailJson(){ const txt=$('#detailContent').textContent; if(!txt){toast('暂无内容');return;} try{await navigator.clipboard.writeText(txt);toast('已复制');}catch{toast('复制失败');} }
async function del(id){ if(!confirm('确认删除？'))return; await fetch('/logs/delete',{method:'POST',body:id}); location.reload(); }
</script>`;
}

function toolPage() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>IID 确认 ID 工具</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;font-family:system-ui}
body{background:#f0f7ff;padding:20px;max-width:800px;margin:0 auto}
.card{background:#fff;border-radius:16px;box-shadow:0 8px 24px rgba(0,120,212,0.1);padding:24px;margin-bottom:20px}
h1{font-size:20px;margin-bottom:16px;display:flex;align-items:center;gap:10px}
img{width:22px;height:22px}
label{font-weight:600;margin:8px 0;display:block}
textarea{width:100%;padding:12px;border-radius:10px;border:1px solid #ddd;min-height:120px}
button{padding:12px 16px;border-radius:10px;border:none;background:#0078d4;color:#fff;font-weight:600;cursor:pointer}
.btn-gray{background:#64748b}
.btn-red{background:#d93034}
.btn-group{display:flex;gap:10px;margin:10px 0;flex-wrap:wrap}
.result{background:#f8f9fa;padding:12px;border-radius:10px;white-space:pre-wrap;font-family:monospace;min-height:200px;max-height:400px;overflow:auto}
.status{margin:10px 0;color:#059669}
.toast{position:fixed;top:20px;left:50%;transform:translateX(-50%);background:#222;color:#fff;padding:10px 16px;border-radius:10px;opacity:0;transition:0.3s}
.toast.show{opacity:1;top:30px}
.footer{text-align:center;color:#666;font-size:14px;line-height:1.6;margin-top:24px}
.footer a{color:#0078dc;text-decoration:none}
.ocr-box{border:2px dashed #ccc;padding:20px;text-align:center;border-radius:10px;margin:10px 0}
.preview{max-width:100%;max-height:200px;margin-top:10px;border-radius:8px;display:none}
</style>
</head>
<body>

<div class="card">
  <h1><img src="https://icons.duckduckgo.com/ip3/microsoft.com.ico"> IID 确认 ID 批量工具</h1>
  
  <label>IID 列表（一行一个）</label>
  <textarea id="iids" placeholder="一行一个 IID，支持批量粘贴"></textarea>
  <div class="btn-group">
    <button id="runBtn">获取确认ID</button>
    <button id="copyBtn" class="btn-gray">复制结果</button>
    <button id="clearAllBtn" class="btn-red">清空</button>
  </div>

  <label style="margin-top:20px">📷 图片 OCR 识别（粘贴/拖拽/选择）</label>
  <div class="ocr-box" id="ocrBox">
    点击选择 / 拖拽图片 / Ctrl+V 粘贴截图
    <input type="file" id="imgFile" accept="image/*" hidden>
    <button onclick="document.getElementById('imgFile').click()" style="margin-top:10px">选择图片</button>
    <img id="preview" class="preview">
  </div>
  <div class="btn-group">
    <button id="btnOcrIid">OCR识别并获取CID</button>
    <button id="btnOcrOnly" class="btn-gray">仅OCR识别文字</button>
  </div>

  <div class="status" id="status"></div>
  <label>运行结果</label>
  <div class="result" id="resultBox"></div>
</div>

<div class="footer">本工具后端服务器通过官方接口获取确认ID<br>仅用于合法授权设备激活<br><br><a href="/logs">日志后台管理</a><br><br>本页面使用<a href="https://github.com/wpyok168/cfgetcid" target="_blank">Github</a>开源项目进行部署，如果需要可以自行部署</div>
<div class="toast" id="toast"></div>

<script>
const $ = s => document.querySelector(s);
const toast = msg => { const t=$('#toast');t.textContent=msg;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),2000); };

let currentFile = null;
const preview = $('#preview');

// 清空所有（含图片）
$('#clearAllBtn').onclick = () => {
  $('#iids').value = '';
  $('#resultBox').textContent = '';
  $('#status').textContent = '';
  
  // 清空图片
  currentFile = null;
  preview.src = '';
  preview.style.display = 'none';
  
  toast('已清空全部内容');
};

// 复制结果
$('#copyBtn').onclick = async () => {
  const txt = $('#resultBox').textContent;
  if (!txt) { toast('无内容可复制'); return; }
  await navigator.clipboard.writeText(txt);
  toast('已复制');
};

// 批量获取CID
$('#runBtn').onclick = async () => {
  const text = $('#iids').value;
  const lines = text.split('\\n').map(i => i.trim().replace(/\\D/g, '')).filter(Boolean);
  if (!lines.length) { toast('请输入 IID'); return; }
  
  const btn = $('#runBtn');
  btn.disabled = true;
  btn.textContent = '处理中...';
  
  const out = [];
  for (const iid of lines) {
    $('#status').textContent = '处理：' + iid;
    try {
      const r = await fetch('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ IID: iid })
      });
      const j = await r.json();
      out.push(JSON.stringify(j, null, 2) + '\\n------------------------------------\\n');
    } catch (e) {
      out.push('请求失败\\n------------------------------------\\n');
    }
  }
  
  $('#resultBox').textContent = out.join('');
  $('#status').textContent = '完成：' + lines.length + ' 条';
  btn.disabled = false;
  btn.textContent = '批量获取';
  toast('完成');
};

// 粘贴图片
document.addEventListener('paste', e => {
  const f = e.clipboardData.files[0];
  if (f) setFile(f);
});

// 拖拽
['dragenter', 'dragover', 'dragleave', 'drop'].forEach(evt => {
  $('#ocrBox').addEventListener(evt, e => { e.preventDefault(); e.stopPropagation(); });
});
$('#ocrBox').addEventListener('drop', e => setFile(e.dataTransfer.files[0]));

// 选择图片
$('#imgFile').onchange = e => setFile(e.target.files[0]);

function setFile(f) {
  if (!f) return;
  if (!['image/png', 'image/jpeg', 'image/gif', 'image/bmp'].includes(f.type)) { toast('请选择 PNG、JPEG、GIF 或 BMP 图片'); return; }
  if (f.size > 10 * 1024 * 1024) { toast('图片不能超过 10MB'); return; }
  if (currentFile) URL.revokeObjectURL(preview.src);
  currentFile = f;
  preview.src = URL.createObjectURL(f);
  preview.style.display = 'block';
  toast('图片已加载');
}

async function runOcr(route) {
  if (!currentFile) { toast('请选择图片'); return; }
  const fd = new FormData();
  fd.append('image', currentFile);
  $('#btnOcrIid').disabled = $('#btnOcrOnly').disabled = true;
  $('#status').textContent = 'OCR识别中...';
  try {
    const res = await fetch(route, { method: 'POST', body: fd });
    const json = await res.json();
    $('#resultBox').textContent = JSON.stringify(json, null, 2);
    if (!res.ok || json.error) throw new Error(json.error || '识别失败');
    $('#status').textContent = '完成';
    toast('完成');
  } catch (error) {
    $('#status').textContent = error.message || '请求失败，请稍后重试';
    toast('识别失败');
  } finally {
    $('#btnOcrIid').disabled = $('#btnOcrOnly').disabled = false;
  }
}
$('#btnOcrIid').onclick = () => runOcr('/api/ocr-iid');
$('#btnOcrOnly').onclick = () => runOcr('/api/ocr-only');
</script>
</body></html>`;
}

// ====================== 激活接口 ======================
async function sendActivationRequest(IID) {
  if (!IID) throw new Error('missing IID');
  const dpop = await c1('/api/productActivation/validateIID', 'POST');
  const sid = GenerateSessionId();
  const digits = Math.floor(IID.length / 9);
  const res = await fetch('https://visualsupport.microsoft.com/api/productActivation/validateIID', {
    method: 'POST',
    signal: AbortSignal.timeout(30000),
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer govUrlID',
      'DPoP': dpop,
      'x-session-id': sid
    },
    body: JSON.stringify({
      IID, ProductType: 'windows', productGroup: 'Windows', productName: 'Windows 11',
      numberOfDigits: digits, Country: 'CHN', Region: 'APAC', InstalledDevices: 1,
      OverrideStatusCode: 'MUL', InitialReasonCode: '45164'
    })
  });
  return { status: res.status, success: res.ok, data: await safeParse(res) };
}

// ====================== OCR 接口 ======================
app.post('/api/ocr-iid', requireOcr, upload.single('image'), async (req, res) => {
  try {
    const text = await recognize(req);
    const iids = extractIIDs(text);
    if (iids.length === 0) return res.json({ error: "未识别到IID", ocrText: text });
    const first = iids[0];
    const result = await sendActivationRequest(first);
    // ✅ 修复：记录真实客户端IP
    await writeLog({ id: crypto.randomUUID(), time: getFormatTime(), IID: first, ip: getClientIp(req), result });
    return res.json(result);
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message });
  }
});

app.post('/api/ocr-only', requireOcr, upload.single('image'), async (req, res) => {
  try {
    const text = await recognize(req);
    res.json({ ocrText: text });
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message });
  }
});

// ====================== 路由 ======================
// 新增：修改密码路由（修改后强制退出重新登录）
app.all('/logs/change-password', async (req, res) => {
  if (!isAuth(req)) return res.send(loginPage());
  if (req.method === 'POST') {
    const { oldPwd, newPwd, confirmPwd } = req.body;
    if (!checkPassword(oldPwd)) return res.send(changePasswordPage('❌ 旧密码错误'));
    if (newPwd !== confirmPwd) return res.send(changePasswordPage('❌ 两次密码不一致'));
    if (typeof newPwd !== 'string' || newPwd.trim().length < 12 || newPwd.length > 1024) return res.send(changePasswordPage('❌ 新密码需为 12 到 1024 位'));
    await savePassword(newPwd.trim());
    
    // 清除登录Cookie，强制重新登录
    res.clearCookie('log_token', { path: '/logs' });
    // 跳转到登录页，提示修改成功
    return res.redirect('/logs?msg=密码修改成功，请使用新密码登录');
  }
  res.send(changePasswordPage());
});

app.post('/logs/clear', async (req, res) => {
  if (!isAuth(req)) return res.sendStatus(403);
  await clearAllLogs();
  res.redirect('/logs');
});

app.post('/logs/delete', async (req, res) => {
  if (!isAuth(req)) return res.sendStatus(403);
  
  const id = typeof req.body === 'string' ? req.body.trim() : '';
  if (!id) return res.send('no id');
  await deleteLogById(id);
  res.send('ok');
});

app.all('/logs', async (req, res) => {
  const msg = req.query.msg || '';
  if (req.method === 'POST') {
    const pwd = req.body.pwd;
    if (checkPassword(pwd)) {
      const expires = Date.now() + 86400000;
      return res.cookie('log_token', expires + '.' + sessionToken(expires), {
        path: '/logs', httpOnly: true, maxAge: 86400000, sameSite: 'strict', secure: req.secure
      }).redirect('/logs');
    }
    return res.send(loginPage('❌ 密码错误'));
  }
  if (!isAuth(req)) return res.send(loginPage(msg));
  const search = typeof req.query.search === 'string' ? req.query.search.slice(0, 100) : '';
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const logs = await getAllLogs();
  const filtered = search ? logs.filter(x => (x.IID || '').includes(search)) : logs;
  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  res.send(logPage(filtered, page, totalPages, search));
});

app.all('/', async (req, res) => {
  if (req.method === 'GET') return res.send(toolPage());
  try {
    const IID = typeof req.body?.IID === 'string' ? req.body.IID.replace(/[\s-]/g, '') : '';
    if (!/^(?:\d{54}|\d{63})$/.test(IID)) return res.status(400).json({ error: 'IID 必须为 54 或 63 位数字' });
    const ip = getClientIp(req);
    const result = await sendActivationRequest(IID);
    await writeLog({
      id: crypto.randomUUID(),
      time: getFormatTime(),
      IID, ip, result
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'error', detail: err + '' });
  }
});

app.get('/healthz', (req, res) => res.json({ status: 'ok', ocrEnabled }));
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : error.status || 500).json({ error: error.code === 'LIMIT_FILE_SIZE' ? '图片不能超过 10MB' : error.message });
});
async function start() {
  await initConfig();
  const server = app.listen(PORT, '0.0.0.0', () => console.log('服务已启动，端口 ' + server.address().port + '，OCR: ' + ocrEnabled));
  const stop = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 35000).unref();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  return server;
}
if (require.main === module) start().catch(error => { console.error(error.message); process.exit(1); });
module.exports = { app, start, extractIIDs };
