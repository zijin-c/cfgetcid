function extractCid(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 5) return '';
  for (const [key, item] of Object.entries(value)) {
    if (/^(cid|confirmationid|confirmationcode)$/i.test(key.replace(/[_-]/g, '')) && typeof item === 'string') {
      const digits = item.replace(/[\s-]/g, '');
      if (/^\d{48}$/.test(digits)) return digits;
    }
  }
  for (const item of Object.values(value)) {
    const cid = extractCid(item, depth + 1);
    if (cid) return cid;
  }
  return '';
}

function errorMessage(data) {
  if (!data || typeof data !== 'object') return '';
  for (const key of ['error_description', 'errorMessage', 'message', 'Message', 'error', 'Error']) {
    if (typeof data[key] === 'string') return data[key].slice(0, 500);
    if (data[key] && typeof data[key] === 'object') return errorMessage(data[key]);
  }
  return '';
}

function normalizeActivation(status, data) {
  const cid = extractCid(data);
  const success = status >= 200 && status < 300 && Boolean(cid);
  let outcome = success ? 'success' : 'not_confirmed';
  let message = success ? '已获取确认 ID' : errorMessage(data) || '接口已返回，未获取到有效的 48 位确认 ID，请查看详情';
  if (status === 401) { outcome = 'auth_required'; message = '微软接口要求有效授权，当前请求未获授权'; }
  else if (status === 403) { outcome = 'access_denied'; message = '微软接口拒绝访问，可能需要授权或人工验证，请查看详情'; }
  else if (status === 429) { outcome = 'rate_limited'; message = '微软接口请求过于频繁，请稍后重试'; }
  else if (status >= 400) { outcome = 'upstream_error'; message = errorMessage(data) || '微软接口返回 HTTP ' + status; }
  return { status, success, cid: success ? cid : '', outcome, message, data };
}

function networkFailure(error) {
  const timeout = error.name === 'TimeoutError' || error.name === 'AbortError';
  return { status: timeout ? 504 : 502, success: false, cid: '', outcome: timeout ? 'timeout' : 'network_error', message: timeout ? '微软接口响应超时，请稍后重试' : '无法连接微软接口，请检查服务器网络后重试', data: null };
}

// 兼容升级前只保存 HTTP 状态的日志，重新判断是否拿到了确认 ID。
function storedResult(result) {
  return result?.outcome ? result : normalizeActivation(result?.status || 0, result?.data);
}
module.exports = { extractCid, normalizeActivation, networkFailure, storedResult };
