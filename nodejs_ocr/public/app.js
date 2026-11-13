'use strict';
const $ = selector => document.querySelector(selector);
const states = { pending: '待查询', running: '查询中', waiting: '等待重试', success: '成功', failed: '失败', invalid: '格式错误' };
let records = [];
let running = false;
let stopRequested = false;
let nextRequestAt = 0;
let toastTimer;

function toast(message) {
  $('#toast').textContent = message;
  $('#toast').style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('#toast').style.display = 'none'; }, 2500);
}
function showText(title, text, hint) {
  $('#dialogTitle').textContent = title;
  $('#detailText').value = text;
  $('#dialogHint').textContent = hint || '可查看并手动复制原始返回内容。';
  if (!$('#detailDialog').open) $('#detailDialog').showModal();
}
async function copy(text) {
  if (!text) return toast('没有可复制的内容');
  try { await navigator.clipboard.writeText(text); toast('已复制'); }
  catch { showText('手动复制', text, '当前浏览器无法自动复制，请选择文本后手动复制。'); $('#detailText').select(); }
}
function cell(row, text, className) {
  const td = document.createElement('td');
  td.dataset.label = ['序号', '安装 ID', '确认 ID', '状态', '操作'][row.children.length];
  td.textContent = text;
  if (className) td.className = className;
  row.append(td);
  return td;
}
function render() {
  const body = $('#results');
  body.replaceChildren();
  if (!records.length) {
    const td = cell(document.createElement('tr'), '还没有查询结果');
    td.colSpan = 5;
    td.parentElement.className = 'empty';
    body.append(td.parentElement);
  }
  records.forEach((item, index) => {
    const row = document.createElement('tr');
    cell(row, String(index + 1));
    cell(row, item.iid, 'digits');
    cell(row, item.result?.cid?.match(/.{1,6}/g)?.join(' ') || '—', 'digits');
    const status = cell(row, '');
    const badge = document.createElement('span');
    badge.className = 'badge ' + (item.state === 'invalid' ? 'failed' : item.state);
    badge.textContent = states[item.state];
    status.append(badge);
    const message = document.createElement('div');
    message.className = 'message';
    message.textContent = item.message || item.result?.message || '';
    status.append(message);
    const actions = cell(row, '');
    const group = document.createElement('div'); group.className = 'row-actions';
    if (item.result?.cid) {
      const button = document.createElement('button'); button.textContent = '复制 CID'; button.className = 'secondary';
      button.onclick = () => copy(item.result.cid); group.append(button);
    }
    if (item.result) {
      const button = document.createElement('button'); button.textContent = '详情'; button.className = 'quiet';
      button.onclick = () => showText('查询详情', JSON.stringify({ IID: item.iid, ...item.result }, null, 2)); group.append(button);
    }
    actions.append(group); body.append(row);
  });
  $('#runBtn').disabled = running;
  $('#iids').disabled = running;
  $('#clearBtn').disabled = running;
  $('#retryBtn').disabled = running || !records.some(item => item.state === 'failed');
  $('#stopBtn').disabled = !running || stopRequested;
  $('#copyBtn').disabled = !records.some(item => item.state === 'success');
  $('#jsonBtn').disabled = !records.length;
  const completed = records.filter(item => ['success', 'failed', 'invalid'].includes(item.state)).length;
  $('#progress').max = Math.max(1, records.length);
  $('#progress').value = completed;
}
function summary(prefix) {
  const count = state => records.filter(item => item.state === state).length;
  $('#status').textContent = prefix + ' · 成功 ' + count('success') + ' / 失败 ' + count('failed') + ' / 格式错误 ' + count('invalid') + ' / 未完成 ' + (count('pending') + count('waiting') + count('running'));
}
async function wait(ms) {
  const until = Date.now() + ms;
  while (!stopRequested && Date.now() < until) await new Promise(resolve => setTimeout(resolve, Math.min(150, until - Date.now())));
}
async function query(item) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const delay = Math.max(0, nextRequestAt - Date.now());
    if (delay > 0) {
      item.state = 'waiting'; item.message = delay > 2100 ? '等待请求频率限制恢复' : '等待下一条查询'; render(); summary('查询中');
      await wait(delay);
    }
    if (stopRequested) { item.state = 'pending'; item.message = ''; return false; }
    item.state = 'running'; item.message = ''; render(); summary('查询中');
    nextRequestAt = Date.now() + 2100;
    try {
      const response = await fetch('/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ IID: item.iid }), signal: AbortSignal.timeout(40000) });
      if (response.status === 429 && attempt < 2) {
        const retry = response.headers.get('Retry-After');
        const seconds = /^\d+$/.test(retry || '') ? Number(retry) : 60;
        item.state = 'waiting'; item.message = '请求频率受限，等待 ' + Math.min(300, seconds) + ' 秒后重试'; render(); summary('等待限流恢复');
        nextRequestAt = Math.max(nextRequestAt, Date.now() + Math.min(300, seconds) * 1000);
        await wait(Math.max(0, nextRequestAt - Date.now()));
        if (stopRequested) { item.state = 'pending'; item.message = ''; return false; }
        continue;
      }
      const raw = await response.text();
      let result;
      try { result = JSON.parse(raw); } catch { result = { message: '服务器返回了无法解析的内容，请查看运行日志' }; }
      item.result = result;
      item.state = response.ok && result.success && result.cid ? 'success' : 'failed';
      item.message = result.message || result.error || '请求失败（HTTP ' + response.status + '）';
    } catch (error) {
      item.state = 'failed'; item.message = error.name === 'TimeoutError' ? '等待服务器响应超时，请检查日志后重试' : '连接服务器失败，请检查网络后重试';
      item.result = { success: false, outcome: 'client_error', message: item.message };
    }
    return true;
  }
}
async function run(items) {
  if (running) return;
  running = true; stopRequested = false; render(); summary('准备查询');
  try {
    for (let i = 0; i < items.length; i++) {
      if (stopRequested || !await query(items[i])) break;
      render(); summary('已处理 ' + (i + 1) + '/' + items.length);
    }
  } finally {
    running = false; render(); summary(stopRequested ? '已停止，待查询项可继续' : '本次查询完成');
    if (stopRequested && records.some(item => item.state === 'pending')) $('#runBtn').textContent = '继续未完成项';
    else $('#runBtn').textContent = '开始查询';
  }
}
$('#runBtn').onclick = () => {
  if (records.some(item => item.state === 'pending') && $('#runBtn').textContent === '继续未完成项') return run(records.filter(item => item.state === 'pending'));
  const inputs = $('#iids').value.split(/\r?\n/).map(line => line.replace(/[\s-]/g, '')).filter(Boolean);
  if (!inputs.length) return toast('请先输入 IID');
  const unique = [...new Set(inputs)];
  records = unique.map(iid => ({ iid, state: /^(?:\d{54}|\d{63})$/.test(iid) ? 'pending' : 'invalid', message: /^(?:\d{54}|\d{63})$/.test(iid) ? '' : '需为 54 或 63 位数字，请修改输入后重新查询' }));
  if (unique.length < inputs.length) toast('已合并 ' + (inputs.length - unique.length) + ' 条重复 IID');
  return run(records.filter(item => item.state === 'pending'));
};
$('#iids').addEventListener('input', () => { $('#runBtn').textContent = '开始查询'; });
$('#stopBtn').onclick = () => { stopRequested = true; render(); summary('正在停止，当前请求完成后不再发送'); };
$('#retryBtn').onclick = () => { const items = records.filter(item => item.state === 'failed'); items.forEach(item => { item.state = 'pending'; item.result = null; item.message = ''; }); return run(items); };
$('#clearBtn').onclick = () => { records = []; $('#iids').value = ''; $('#runBtn').textContent = '开始查询'; render(); $('#status').textContent = '等待查询'; };
$('#copyBtn').onclick = () => copy(records.filter(item => item.state === 'success').map(item => 'IID: ' + item.iid + '\nCID: ' + item.result.cid).join('\n\n'));
$('#jsonBtn').onclick = () => copy(JSON.stringify(records, null, 2));
$('#closeDialog').onclick = () => $('#detailDialog').close();
window.addEventListener('beforeunload', event => { if (running) { event.preventDefault(); event.returnValue = ''; } });
render();
