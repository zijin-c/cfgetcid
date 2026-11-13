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

查询页面会合并重复输入，提示格式错误，并逐条显示确认 ID、失败原因和进度。支持停止后续查询、继续未完成项、只重试失败项、复制单条确认 ID 和成功结果。手机端以卡片形式显示结果。刷新页面不会保留当前批次，请先复制结果；已完成的服务器查询可在日志后台查看。

请求至少间隔 2.1 秒，触发服务器限流时会按提示等待后重试。停止不会中断已发出的请求；当前请求完成后才停止，结果仍保存到日志。服务端的超时、网络连接失败、授权失败也会记录原因和耗时。

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

安装或更新后，运行 `sudo cfgetcid` 即可进入中文维护菜单，无需记住下面的子命令。旧版用户先重新运行一次安装命令，才能使用新菜单。

```bash
sudo cfgetcid status
sudo cfgetcid logs
sudo cfgetcid stop
sudo cfgetcid start
sudo cfgetcid restart
sudo cfgetcid apply-config
sudo cfgetcid update
sudo cfgetcid backup
sudo cfgetcid reset-password
```

服务开机启动，进程退出后自动重启。容器运行日志每份最多 10MB、保留三份；查询日志可在网页后台清空，不自动过期。

菜单里的更新或 `cfgetcid update` 会先备份，再按首次安装时的仓库和分支拉取新版。再次运行安装命令也可更新，REPO_URL 必须与首次一致；自定义分支需每次传 BRANCH。先构建成功再停止旧容器，新容器未通过启动检查会恢复旧容器。配置和数据保留。源码有本地修改时脚本会停止，避免覆盖修改。

第一次安装可在命令中添加 `HOST_PORT=端口`，或者 `BIND_IP=127.0.0.1` 仅本机访问。后续更改使用 deploy.env。

## 备份与密码恢复

使用菜单的“备份配置和查询日志”或 `sudo cfgetcid backup`。备份存放在 `/var/backups/cfgetcid`，包含配置、密码哈希和查询日志。备份时短暂停止服务，完成后会恢复原先运行状态；备份失败也会尝试恢复。建议定期将备份下载到其他设备。

恢复时先停止服务，将备份恢复到原路径，再运行安装命令以校正容器用户的数据目录权限。忘记密码时，在菜单选择“重置后台密码”，或执行 `sudo cfgetcid reset-password`，输入 RESET 确认后自动备份并生成新密码。查询日志保留，旧登录会话失效。

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

自动测试模拟微软响应，覆盖确认 ID 解析、HTTP 200 但无确认 ID、授权失败、超时、连接失败及其日志、后台改密和重启持久化，不执行真实激活。维护脚本可运行 `bash scripts/manager.test.sh`，使用替身检查备份和更新失败的恢复逻辑。完整 Linux 安装和 Docker 容器运行需要在 VPS 验证。

本次没有增加微软账号登录、邮箱登录或登录后跳转。当前接口仍沿用原项目的调用方式；需要有效授权或人工验证时，会显示失败原因，无法保证接口始终可用。
