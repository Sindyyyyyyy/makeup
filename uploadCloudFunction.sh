#!/usr/bin/env bash
# 逐个部署 cloudfunctions/ 下的云函数（云开发 CLI）
# 用法: ./uploadCloudFunction.sh <cloudfunctions目录> <envId>
set -euo pipefail

functionsDir="${1:-cloudfunctions}"
envId="${2:-}"

if [ -z "$envId" ]; then
  echo "用法: $0 <cloudfunctions目录> <envId>"
  exit 1
fi

installPath=$(command -v cloud || echo "")
if [ -z "$installPath" ]; then
  echo "未找到 cloud CLI，请先执行: npm i -g @cloudbase/cli"
  exit 1
fi

for fn in "$functionsDir"/*/; do
  name=$(basename "$fn")
  echo "==> 部署 $name"
  cloud functions deploy \
    --name "$name" \
    --runtime Nodejs16.13 \
    --envId "$envId" \
    --projectRoot "$(pwd)/$fn" \
    --remoteRoot "/"
  echo "<== $name 完成"
done

echo "全部云函数部署完成"