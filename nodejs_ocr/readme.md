# VPS 查询服务

部署请参阅根目录 [VPS.md](../VPS.md)，推荐使用 install.sh 一键部署。

支持手动输入 IID、批量查询和日志后台，无需图片识别或百度凭据。首次启动必须提供至少 12 位 LOG_PASSWORD。配置示例见根目录 .env.example。

目录名沿用旧版以保持部署兼容，当前服务已移除图片识别。

本地运行需要 Node.js 24 或更新版本，执行 npm ci 安装依赖，npm test 验证。
