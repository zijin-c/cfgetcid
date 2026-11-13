# VPS 一键部署

适用于使用 systemd 的 Debian/Ubuntu VPS，需要 root 权限，以及能访问 GitHub、Docker Hub、npm 和微软接口的网络。脚本复用已有 Docker；没有 Docker 时通过系统仓库安装 docker.io。运行环境为容器内的 Node.js 24，不依赖 Cloudflare KV。

## 安装

在 VPS 上直接运行：

```bash
curl -fsSL https://raw.githubusercontent.com/zijin-c/cfgetcid/main/install.sh -o /tmp/cfgetcid-install.sh
sudo env REPO_URL=https://github.com/zijin-c/cfgetcid.git bash /tmp/cfgetcid-install.sh
```

若尚未安装 curl，先运行 `sudo apt-get update && sudo apt-get install -y curl`。分支不是 main 时，需同时修改下载地址，并在第二行添加 `BRANCH=分支名`。

无需申请 API 凭据，安装后手动输入或粘贴 IID 即可查询。

默认访问 `http://服务器IP:9567`；日志后台为 `/logs`。需要在服务商安全组放行 TCP 9567，或配置域名反向代理。首次密码自动随机生成，通过下面命令查看 LOG_PASSWORD：

```bash
sudo cat /etc/cfgetcid/app.env
```

网页修改密码后以新密码为准，重启和更新不会覆盖。请妥善保管密码。

## 配置、管理与更新

| 路径 | 用途 |
| --- | --- |
| /opt/cfgetcid | GitHub 源码，避免直接修改以免阻碍更新 |
| /etc/cfgetcid/app.env | 首次密码、分页、时区和可信代理 |
| /etc/cfgetcid/deploy.env | HOST_PORT 对外端口和 BIND_IP 监听地址 |
| /var/lib/cfgetcid/config.json | 网页密码哈希 |
| /var/lib/cfgetcid/kv_logs | 查询日志，请求完成前写入文件 |

环境文件为 KEY=value 格式，值外不要加引号。修改配置或监听端口后运行 `sudo cfgetcid apply-config`。普通 restart 不重新读取环境文件。

```bash
sudo cfgetcid status
sudo cfgetcid logs
sudo cfgetcid stop
sudo cfgetcid start
sudo cfgetcid restart
sudo cfgetcid apply-config
```

服务开机启动，进程退出后自动重启。容器运行日志每份最多 10MB、保留三份；查询日志可在网页后台清空，不自动过期。

再次运行安装命令即可更新，REPO_URL 必须与首次一致；自定义分支需每次传 BRANCH。先构建成功再停止旧容器，新容器未通过启动检查会恢复旧容器。配置和数据保留。源码有本地修改时脚本会停止，避免覆盖修改。

第一次安装可在命令中添加 `HOST_PORT=端口`，或者 `BIND_IP=127.0.0.1` 仅本机访问。后续更改使用 deploy.env。

## 备份与密码恢复

```bash
sudo cfgetcid stop
sudo tar -czf /root/cfgetcid-backup.tar.gz /etc/cfgetcid /var/lib/cfgetcid
sudo cfgetcid start
```

恢复时先停止服务，将备份恢复到原路径，再运行安装命令以校正容器用户的数据目录权限。忘记密码时，停止服务，将 /var/lib/cfgetcid/config.json 重命名留作备份，在 app.env 中设置新的至少 12 位 LOG_PASSWORD，再运行 apply-config。查询日志不受影响。

## 域名和 HTTPS

可先用 IP 访问，之后通过现有 Nginx 或宝塔设置 HTTPS，反向代理到 http://127.0.0.1:9567。浏览器剪贴板功能通常需要 HTTPS。

使用宿主机反向代理时，将 deploy.env 中 BIND_IP 改为 127.0.0.1，关闭应用端口公网直连。代理必须覆盖客户端提供的转发头。示例放入已配置证书的站点中：

```nginx
location / {
    proxy_pass http://127.0.0.1:9567;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Host $http_host;
    proxy_set_header X-Forwarded-Proto $scheme;
    client_max_body_size 64k;
    proxy_read_timeout 90s;
}
```

要记录代理后的真实 IP，在 app.env 配置 TRUST_PROXY 为容器看到的可信代理 IP。宿主机通过默认 Docker 网桥访问时通常是网桥网关，可用 `sudo docker inspect cfgetcid` 确认实际地址。自定义网络按实际配置填写，避免盲目信任所有来源。修改后运行 apply-config。

Docker 发布公网端口可能绕过部分 UFW 规则，仅允许代理访问时应使用本地绑定。[Docker 官方说明](https://docs.docker.com/engine/install/ubuntu/#firewall-limitations)。可信代理设置参考 [Express 官方文档](https://expressjs.com/en/guide/behind-proxies/)。

## 本地运行和验证

需要 Node.js 24 或更新版本，按根目录 .env.example 创建自己的 .env：

```bash
cd nodejs_ocr
npm ci
node --env-file=../.env server.js
npm test
```

默认数据目录 nodejs_ocr/data，可用 DATA_DIR 修改。GET /healthz 返回服务状态，不检测外部 API 连通性。

外部接口或权限可能变化，部署脚本不能保证微软接口始终可用，需要有效 IID 和对应授权。

自动测试模拟微软响应，覆盖查询、日志删除、后台改密和重启持久化，不执行真实激活。完整 Linux 安装和 Docker 容器运行需要在 VPS 验证。
