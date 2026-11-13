const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { normalizeActivation, networkFailure, storedResult } = require('./activation');

const cid = '654321'.repeat(8);
test('只有格式有效的确认 ID 才算成功，并兼容旧日志', () => {
  for (const data of [{}, { message: 'invalid IID' }, { cid: 'bad' }, { cid: '1'.repeat(49) }]) assert.equal(normalizeActivation(200, data).success, false);
  assert.equal(normalizeActivation(200, { result: { Confirmation_ID: cid.match(/.{6}/g).join('-') } }).cid, cid);
  assert.equal(normalizeActivation(403, { cid }).success, false);
  assert.equal(normalizeActivation(401, {}).outcome, 'auth_required');
  assert.equal(normalizeActivation(429, {}).outcome, 'rate_limited');
  assert.equal(storedResult({ status: 200, success: true, data: {} }).success, false);
  assert.equal(networkFailure({ name: 'TimeoutError' }).outcome, 'timeout');
});

test('VPS 服务：查询、日志、密码和重启持久化', async () => {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'cfgetcid-test-'));
  Object.assign(process.env, { DATA_DIR: data, LOG_PASSWORD: 'initial-password-123', PORT: '0' });
  const realFetch = global.fetch;
  const iid = '1234567'.repeat(9);
  let mode = 'success';
  global.fetch = async (url, options) => {
    if (String(url).includes('visualsupport.microsoft.com')) {
      assert.equal(JSON.parse(options.body).IID, iid);
      assert.ok(options.headers.DPoP);
      if (mode === 'timeout') throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
      if (mode === 'network') throw new TypeError('fetch failed');
      if (mode === 'auth') return Response.json({ message: 'Sign in required' }, { status: 401 });
      if (mode === 'no-cid') return Response.json({ message: 'Invalid IID' });
      return Response.json({ confirmationId: cid });
    }
    throw new Error('测试禁止访问外部地址：' + url);
  };
  let server;
  try {
    const { start } = require('./server');
    server = await start();
    if (!server.listening) await once(server, 'listening');
    const base = 'http://127.0.0.1:' + server.address().port;
    const request = (route, options) => realFetch(base + route, options);
    assert.equal((await request('/healthz')).status, 200);
    const html = await (await request('/')).text();
    assert.doesNotMatch(html, /OCR|type="file"|ocrBox/);
    assert.match(html, /重试失败项/);
    assert.equal((await request('/assets/style.css')).status, 200);
    new Function(await (await request('/assets/app.js')).text());
    for (const route of ['/api/ocr-only', '/api/ocr-iid']) assert.equal((await request(route, { method: 'POST' })).status, 404);
    // 检查服务端模板输出的浏览器脚本能正确解析。
    for (const [, code] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Function(code);
    assert.equal((await request('/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"IID":"bad"}' })).status, 400);
    let response = await request('/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ IID: iid }) });
    const success = await response.json();
    assert.equal(success.cid, cid);
    assert.equal(success.success, true);
    assert.equal((await fs.readdir(path.join(data, 'kv_logs'))).length, 1);
    assert.equal((await request('/logs/delete', { method: 'POST', body: 'x' })).status, 403);
    response = await request('/logs', { method: 'POST', body: new URLSearchParams({ pwd: process.env.LOG_PASSWORD }), redirect: 'manual' });
    assert.equal(response.status, 302);
    const cookie = response.headers.get('set-cookie').split(';')[0];
    assert.ok(!cookie.includes(process.env.LOG_PASSWORD));
    response = await request('/logs?search=%22%3E%3Cimg%20src=x%3E', { headers: { Cookie: cookie } });
    const logs = await response.text();
    assert.ok(!logs.includes('<img src=x>'));
    assert.ok((await (await request('/logs', { headers: { Cookie: cookie } })).text()).includes(cid));
    for (const [, code] of logs.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Function(code);
    const file = (await fs.readdir(path.join(data, 'kv_logs')))[0];
    const [item] = JSON.parse(await fs.readFile(path.join(data, 'kv_logs', file)));
    response = await request('/logs/delete', { method: 'POST', headers: { Cookie: cookie }, body: item.id });
    assert.equal(response.status, 200);
    assert.equal((await fs.readdir(path.join(data, 'kv_logs'))).length, 0);
    for (const [behavior, outcome] of [['no-cid', 'not_confirmed'], ['auth', 'auth_required'], ['timeout', 'timeout'], ['network', 'network_error']]) {
      mode = behavior;
      response = await request('/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ IID: iid }) });
      const result = await response.json();
      assert.equal(result.success, false);
      assert.equal(result.outcome, outcome);
      assert.ok(Number.isFinite(result.durationMs));
    }
    const failures = await fs.readdir(path.join(data, 'kv_logs'));
    assert.equal(failures.length, 4);
    for (const file of failures) {
      const [entry] = JSON.parse(await fs.readFile(path.join(data, 'kv_logs', file)));
      assert.equal(entry.result.success, false);
      assert.ok(entry.result.message);
    }
    mode = 'success';
    assert.equal((await request('/logs/clear', { method: 'POST', headers: { Cookie: cookie }, redirect: 'manual' })).status, 302);
    assert.equal((await fs.readdir(path.join(data, 'kv_logs'))).length, 0);
    response = await request('/logs/clear', { method: 'POST', headers: { Cookie: cookie, Origin: 'https://other.example' } });
    assert.equal(response.status, 403);
    await request('/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ IID: iid }) });
    response = await request('/logs/change-password', { method: 'POST', headers: { Cookie: cookie }, body: new URLSearchParams({ oldPwd: process.env.LOG_PASSWORD, newPwd: 'new-password-123', confirmPwd: 'new-password-123' }), redirect: 'manual' });
    assert.equal(response.status, 302);
    assert.match(await (await request('/logs', { headers: { Cookie: cookie } })).text(), /日志后台登录/);
    const saved = await fs.readFile(path.join(data, 'config.json'), 'utf8');
    assert.ok(!saved.includes('new-password-123'));
    await new Promise(resolve => server.close(resolve));
    server = await start();
    if (!server.listening) await once(server, 'listening');
    response = await realFetch('http://127.0.0.1:' + server.address().port + '/logs', { method: 'POST', body: new URLSearchParams({ pwd: 'new-password-123' }), redirect: 'manual' });
    assert.equal(response.status, 302);
    assert.equal((await fs.readdir(path.join(data, 'kv_logs'))).length, 1);
  } finally {
    global.fetch = realFetch;
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    await fs.rm(data, { recursive: true, force: true });
  }
});
