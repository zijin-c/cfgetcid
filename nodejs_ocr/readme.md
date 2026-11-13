# 带 OCR 的 VPS 版本

部署请参阅根目录 [VPS.md](../VPS.md)，推荐使用 install.sh 一键部署。

OCR 凭据通过环境变量 BAIDU_APP_ID、BAIDU_API_KEY、BAIDU_SECRET_KEY 配置。首次启动必须提供至少 12 位 LOG_PASSWORD。配置示例见根目录 .env.example。

本地运行需要 Node.js 24 或更新版本，执行 npm ci 安装依赖，npm test 验证。
