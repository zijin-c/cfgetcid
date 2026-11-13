const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { spawnSync } = require('node:child_process');

test('VPS 服务：查询、OCR、日志、密码和重启持久化', async () => {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'cfgetcid-test-'));
  Object.assign(process.env, { DATA_DIR: data, LOG_PASSWORD: 'initial-password-123', PORT: '0', BAIDU_APP_ID: 'test', BAIDU_API_KEY: 'test', BAIDU_SECRET_KEY: 'test' });
  const realFetch = global.fetch;
  const iid = '1234567'.repeat(9);
  let ocrError = false;
  let tokenCalls = 0;
  global.fetch = async (url, options) => {
    if (String(url).includes('/oauth/2.0/token')) {
      tokenCalls++;
      return Response.json({ access_token: 'mock-token', expires_in: 3600 });
    }
    if (String(url).includes('/ocr/v1/')) {
      assert.equal(options.body.get('image'), 'aW1hZ2U=');
      return Response.json(ocrError ? { error_code: 17, error_msg: 'quota exceeded' } : { words_result: [{ words: iid }] });
    }
    if (String(url).includes('visualsupport.microsoft.com')) {
      assert.equal(JSON.parse(options.body).IID, iid);
      assert.ok(options.headers.DPoP);
      return Response.json({ confirmationId: 'mock-cid' });
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
    assert.match(html, /OCR/);
    // 检查服务端模板输出的浏览器脚本能正确解析。
    for (const [, code] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Function(code);
    assert.equal((await request('/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"IID":"bad"}' })).status, 400);
    let response = await request('/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ IID: iid }) });
    assert.equal((await response.json()).data.confirmationId, 'mock-cid');
    assert.equal((await fs.readdir(path.join(data, 'kv_logs'))).length, 1);
    assert.equal((await request('/logs/delete', { method: 'POST', body: 'x' })).status, 403);
    response = await request('/logs', { method: 'POST', body: new URLSearchParams({ pwd: process.env.LOG_PASSWORD }), redirect: 'manual' });
    assert.equal(response.status, 302);
    const cookie = response.headers.get('set-cookie').split(';')[0];
    assert.ok(!cookie.includes(process.env.LOG_PASSWORD));
    response = await request('/logs?search=%22%3E%3Cimg%20src=x%3E', { headers: { Cookie: cookie } });
    const logs = await response.text();
    assert.ok(!logs.includes('<img src=x>'));
    assert.match(await (await request('/logs', { headers: { Cookie: cookie } })).text(), /mock-cid/);
    for (const [, code] of logs.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Function(code);
    const file = (await fs.readdir(path.join(data, 'kv_logs')))[0];
    const [item] = JSON.parse(await fs.readFile(path.join(data, 'kv_logs', file)));
    response = await request('/logs/delete', { method: 'POST', headers: { Cookie: cookie }, body: item.id });
    assert.equal(response.status, 200);
    assert.equal((await fs.readdir(path.join(data, 'kv_logs'))).length, 0);
    const image = () => { const form = new FormData(); form.append('image', new Blob(['image'], { type: 'image/png' }), 'test.png'); return form; };
    assert.equal((await request('/api/ocr-only', { method: 'POST', body: new FormData() })).status, 400);
    assert.equal((await (await request('/api/ocr-only', { method: 'POST', body: image() })).json()).ocrText, iid);
    assert.equal((await (await request('/api/ocr-iid', { method: 'POST', body: image() })).json()).data.confirmationId, 'mock-cid');
    assert.equal(tokenCalls, 1);
    ocrError = true;
    assert.equal((await request('/api/ocr-only', { method: 'POST', body: image() })).status, 502);
    response = await request('/logs/clear', { method: 'POST', headers: { Cookie: cookie, Origin: 'https://other.example' } });
    assert.equal(response.status, 403);
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
    const noOcr = spawnSync(process.execPath, ['-e', "const {app}=require('./server'); const s=app.listen(0,'127.0.0.1',async()=>{const r=await fetch('http://127.0.0.1:'+s.address().port+'/api/ocr-only',{method:'POST'});s.close();process.exit(r.status===503?0:1)});"], { cwd: __dirname, env: { ...process.env, BAIDU_APP_ID: '', BAIDU_API_KEY: '', BAIDU_SECRET_KEY: '' }, timeout: 10000 });
    assert.equal(noOcr.status, 0, noOcr.stderr?.toString());
  } finally {
    global.fetch = realFetch;
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    await fs.rm(data, { recursive: true, force: true });
  }
});
