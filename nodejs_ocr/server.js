const express = require('express');
const { rateLimit } = require('express-rate-limit');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { normalizeActivation, networkFailure, storedResult } = require('./activation');

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
app.post('/', rateLimit({ windowMs: 60000, limit: 30 }));
app.use('/assets', express.static(path.join(__dirname, 'public'), { index: false, maxAge: 0 }));

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

// ====================== KV 存储 ======================
async function writeLog(item) {
  const file = path.join(KV_DIR, 'log_' + item.id + '.json');
  await fs.writeFile(file + '.tmp', JSON.stringify([item]), { mode: 0o600 });
  await fs.rename(file + '.tmp', file);
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
  return `<!DOCTYPE html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>登录</title><style>body{display:grid;place-items:center;height:100vh;margin:0}.box{padding:24px;background:#fff;border-radius:12px;box-shadow:0 2px 10px rgba(0,0,0,0.1);width:320px;box-sizing:border-box;max-width:calc(100vw - 32px)}input,button{width:100%;padding:10px;margin:8px 0;border-radius:6px;border:1px solid #ddd}button{background:#0066cc;color:white;border:none;cursor:pointer}.msg{color:green;text-align:center;margin:8px 0}.err{color:red}</style><div class="box"><h3>日志后台登录</h3>${msg ? `<div class="${msg.includes('成功') ? 'msg' : 'err'}">${escapeHtml(msg)}</div>` : ''}<form method="post"><input type="password" name="pwd" required placeholder="密码"><button>登录</button></form></div>`;
}

// 新增：修改密码页面
function changePasswordPage(msg = '') {
  return `<!DOCTYPE html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>修改登录密码</title>
<style>
body{display:grid;place-items:center;height:100vh;margin:0;background:#fafafa}
.box{padding:24px;background:#fff;border-radius:12px;box-shadow:0 2px 10px rgba(0,0,0,0.1);width:380px;box-sizing:border-box;max-width:calc(100vw - 32px)}
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
    <td>${item.result?.success ? '✅成功' : '❌失败'}<div style="font-size:12px;margin-top:6px">${escapeHtml(item.result?.message)}</div></td>
    <td style="font-family:monospace;word-break:break-all">${escapeHtml(item.result?.cid || '—')}</td>
    <td>${Number.isFinite(item.durationMs) ? item.durationMs + ' ms' : '—'}</td>
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

  return `<!DOCTYPE html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>IID 激活日志</title>
<style>
body{margin:20px;font-family:system-ui;background:#fafafa}
.card{background:white;padding:20px;border-radius:12px;box-shadow:0 2px 10px rgba(0,0,0,0.1)}
.bar{display:flex;gap:10px;margin:10px 0;flex-wrap:wrap;align-items:center}
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
    <a href="/">返回查询</a>
    <form method="post" action="/logs/logout"><button style="background:#64748b">退出登录</button></form>
    <form method="post" action="/logs/clear" onsubmit="return confirm('确认清空全部日志？')"><button class="red">清空全部</button></form>
  </div>
  <div style="margin:10px 0">${pages.join('')}</div>
  <div style="overflow-x:auto"><table>
    <tr><th>时间</th><th>IID</th><th>IP</th><th>状态 / 原因</th><th>确认 ID</th><th>耗时</th><th>操作</th></tr>
    ${rows}
  </table></div>
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
  return normalizeActivation(res.status, await safeParse(res));
}

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

app.post('/logs/logout', (req, res) => res.clearCookie('log_token', { path: '/logs' }).redirect('/logs'));

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
  const requestedPage = Math.max(1, parseInt(req.query.page) || 1);
  const logs = (await getAllLogs()).map(item => ({ ...item, result: storedResult(item.result) }));
  const filtered = search ? logs.filter(x => (x.IID || '').includes(search)) : logs;
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const page = Math.min(requestedPage, totalPages);
  res.send(logPage(filtered, page, totalPages, search));
});

app.all('/', async (req, res) => {
  if (req.method === 'GET') return res.sendFile(path.join(__dirname, 'public', 'index.html'));
  if (req.method !== 'POST') return res.sendStatus(405);
  const IID = typeof req.body?.IID === 'string' ? req.body.IID.replace(/[\s-]/g, '') : '';
  if (!/^(?:\d{54}|\d{63})$/.test(IID)) return res.status(400).json({ success: false, outcome: 'invalid_input', message: 'IID 必须为 54 或 63 位数字' });
  const startedAt = Date.now();
  let result;
  try {
    result = await sendActivationRequest(IID);
  } catch (err) {
    result = networkFailure(err);
  }
  result.durationMs = Date.now() - startedAt;
  await writeLog({ id: crypto.randomUUID(), time: getFormatTime(), IID, ip: getClientIp(req), durationMs: result.durationMs, result });
  res.status(['network_error', 'timeout'].includes(result.outcome) ? result.status : 200).json(result);
});

app.get('/healthz', (req, res) => res.json({ status: 'ok' }));
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  res.status(error.status || 500).json({ error: error.message });
});
async function start() {
  await initConfig();
  const server = app.listen(PORT, '0.0.0.0', () => console.log('服务已启动，端口 ' + server.address().port));
  const stop = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 35000).unref();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  return server;
}
if (require.main === module) start().catch(error => { console.error(error.message); process.exit(1); });
module.exports = { app, start };
