#!/usr/bin/env bash
#
# 在独立服务器上安装并启动 talk2copilot 中继服务（systemd）
#
# 用法：sudo ./install.sh [node 可执行文件路径]
#
# 前置：已安装 Node.js 18+ 与 npm。
# 结果：代码装到 /opt/talk2copilot-relay，配置写在 /etc/talk2copilot-relay.env
#       （首次安装会生成随机预共享密码），服务名 talk2copilot-relay。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INSTALL_DIR=/opt/talk2copilot-relay
ENV_FILE=/etc/talk2copilot-relay.env
UNIT_NAME=talk2copilot-relay.service
UNIT_PATH="/etc/systemd/system/${UNIT_NAME}"
SERVICE_USER=talk2copilot

if [[ $EUID -ne 0 ]]; then
  echo "请用 root 运行：sudo $0" >&2
  exit 1
fi

NODE_BIN="$(readlink -f "${1:-$(command -v node || true)}" 2>/dev/null || true)"
if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  echo "未找到可用的 node，请先安装 Node.js 18+，或用参数指定绝对路径：sudo $0 /usr/bin/node" >&2
  echo "（sudo 下 nvm 的 node 不在 PATH，需显式给出路径，例如 sudo $0 \$HOME/.nvm/versions/node/vX.Y.Z/bin/node）" >&2
  exit 1
fi
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
if (( NODE_MAJOR < 18 )); then
  echo "需要 Node.js 18 或更高，当前为 $("$NODE_BIN" -v)" >&2
  exit 1
fi
NPM_BIN=""
if [[ -x "$(dirname "$NODE_BIN")/npm" ]]; then
  NPM_BIN="$(dirname "$NODE_BIN")/npm"
elif command -v npm >/dev/null 2>&1; then
  NPM_BIN="$(command -v npm)"
fi
if [[ -z "$NPM_BIN" ]]; then
  echo "未找到 npm（安装 Node.js 时应一并提供），无法安装依赖 ws" >&2
  exit 1
fi
echo "使用 node：$NODE_BIN（$("$NODE_BIN" -v)）"
echo "使用 npm：$NPM_BIN"

echo "[1/6] 安装服务代码到 $INSTALL_DIR"
install -d -m 0755 "$INSTALL_DIR"
install -m 0644 "$REPO_ROOT/relay/server.js" "$INSTALL_DIR/server.js"

# systemd 单元的 ProtectHome/PrivateTmp 会隐藏 /home、/root、/tmp，服务进程取不到这些路径下的 node，
# 因此把 node 可执行文件复制进安装目录（node 为自包含二进制，复制即可用）
case "$NODE_BIN" in
  /home/*|/root/*|/run/user/*|/tmp/*)
    SERVICE_NODE="$INSTALL_DIR/node"
    install -m 0755 "$NODE_BIN" "$SERVICE_NODE"
    echo "node 位于受 systemd 保护的目录，已复制到 $SERVICE_NODE"
    ;;
  *)
    SERVICE_NODE="$NODE_BIN"
    ;;
esac
if [[ ! -f "$INSTALL_DIR/package.json" ]]; then
  printf '%s\n' '{"name":"talk2copilot-relay","private":true,"dependencies":{"ws":"^8.18.0"}}' > "$INSTALL_DIR/package.json"
fi

echo "[2/6] 安装依赖（ws）"
# npm 的入口是 `#!/usr/bin/env node` 脚本，须把 node 所在目录加入 PATH 才能执行
(cd "$INSTALL_DIR" && PATH="$(dirname "$NODE_BIN"):$PATH" "$NPM_BIN" install --omit=dev --no-audit --no-fund --loglevel=error)
chown -R root:root "$INSTALL_DIR"
chmod -R go-w "$INSTALL_DIR"

echo "[3/6] 创建服务账号 $SERVICE_USER"
if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --no-create-home --home-dir "$INSTALL_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
fi

echo "[4/6] 准备配置 $ENV_FILE"
if [[ -f "$ENV_FILE" ]]; then
  echo "配置已存在，保留原样"
  # 就地升级：旧配置通常没有管理令牌，缺则补一行——否则升级后管理功能会静默关闭（adminEnabled=false）
  if ! grep -q '^TALK2COPILOT_ADMIN_TOKEN=' "$ENV_FILE"; then
    admin_token="${TALK2COPILOT_ADMIN_TOKEN:-$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | cut -c1-32)}"
    printf '\n# 管理令牌（安装脚本在升级时自动补充）：在扩展「连接 → 中继管理令牌」填入同一字符串\nTALK2COPILOT_ADMIN_TOKEN=%s\n' "$admin_token" >> "$ENV_FILE"
    echo "已为既有配置补充管理令牌（查看：sudo cat $ENV_FILE）"
  fi
else
  umask 077
  token="${TALK2COPILOT_TOKEN:-$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | cut -c1-32)}"
  admin_token="${TALK2COPILOT_ADMIN_TOKEN:-$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | cut -c1-32)}"
  cat > "$ENV_FILE" <<EOF
# talk2copilot 中继服务配置。改动后执行：systemctl restart ${UNIT_NAME}
PORT=8787
HOST=0.0.0.0
TALK2COPILOT_TOKEN=${token}
# 管理令牌：在扩展配置界面「连接 → 中继管理令牌」填入同一字符串即可获得管理权限
TALK2COPILOT_ADMIN_TOKEN=${admin_token}
LOG_LEVEL=info
EOF
  chmod 600 "$ENV_FILE"
  echo "已生成预共享密码与管理令牌，查看：sudo cat $ENV_FILE"
fi

echo "[5/6] 安装并启动 systemd 服务"
install -m 0644 "$REPO_ROOT/relay/deploy/${UNIT_NAME}" "$UNIT_PATH"
sed -i "s|^ExecStart=.*|ExecStart=${SERVICE_NODE} ${INSTALL_DIR}/server.js|" "$UNIT_PATH"
systemctl daemon-reload
systemctl enable "$UNIT_NAME"
# 用 restart 而非 enable --now：后者对已在运行的服务不重启，
# 重跑本脚本时会继续跑旧代码，而健康检查仍通过，导致“以为部署了其实没有”
systemctl restart "$UNIT_NAME"

echo "[6/6] 健康检查"
port="$(sed -n 's/^PORT=//p' "$ENV_FILE" | tail -1)"
port="${port:-8787}"
# 探针按实际监听地址发起；通配地址用环回代替
host="$(sed -n 's/^HOST=//p' "$ENV_FILE" | tail -1)"
case "$host" in
  ''|0.0.0.0|'::'|'[::]') probe_host=127.0.0.1 ;;
  *) probe_host="$host" ;;
esac
probe_url="http://${probe_host}:${port}/healthz"
if ! systemctl is-active --quiet "$UNIT_NAME"; then
  echo "服务未处于 active 状态，请查看：journalctl -u $UNIT_NAME -n 50 --no-pager" >&2
  exit 1
fi

if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsS "$1"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -qO- "$1"; }
else
  fetch() { return 1; }
  echo "提示：未找到 curl/wget，跳过 HTTP 探针；可稍后手动检查 ${probe_url}"
fi

body=""
for _ in $(seq 1 20); do
  body="$(fetch "$probe_url" 2>/dev/null || true)"
  if [[ -n "$body" ]]; then
    break
  fi
  sleep 0.5
done

if [[ -z "$body" ]]; then
  echo "HTTP 探针未通过（${probe_url}），请查看：journalctl -u $UNIT_NAME -n 50 --no-pager" >&2
  exit 1
fi

echo "$body"
# 版本门禁配套检查：/healthz 的中继版本必须与仓库 package.json 一致，
# 否则客户端会因版本不一致被拒绝接入（4008）
repo_version="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$REPO_ROOT/package.json" | head -1)"
body_version="$(printf '%s' "$body" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')"
if [[ -z "$body_version" ]]; then
  echo "警告：/healthz 未返回版本号，运行中的可能仍是旧代码。请执行：sudo systemctl restart ${UNIT_NAME}" >&2
elif [[ -n "$repo_version" && "$repo_version" != "$body_version" ]]; then
  echo "警告：运行中的中继版本为 ${body_version}，仓库当前版本为 ${repo_version}，客户端将被版本门禁拒绝接入。请确认代码已同步部署。" >&2
fi
# 确认进程里跑的是本次安装的代码：/peers 是较新版本才有的端点，旧版会 404
if command -v curl >/dev/null 2>&1; then
  peers_code="$(curl -s -o /dev/null -w '%{http_code}' "http://${probe_host}:${port}/peers" 2>/dev/null || echo 000)"
  if [[ "$peers_code" == "404" || "$peers_code" == "000" ]]; then
    echo "警告：/peers 返回 HTTP ${peers_code}，运行中的可能仍是旧代码。请执行：sudo systemctl restart ${UNIT_NAME}" >&2
  fi
fi
echo
echo "安装完成。客户端「连接 → 中继模式」填写："
echo "  地址 ws://<本机可达 IP>:${port}    密码见 sudo cat $ENV_FILE"
echo "  管理令牌（可选，用于踢出/封禁/管理所有房间）见同一文件；不使用可留空。"
echo "  注意：扩展版本必须与本中继版本一致（${repo_version:-见 package.json}），否则中继会拒绝接入（4008）。"
echo "若本机只应经反向代理 / 隧道对外，请把 $ENV_FILE 里的 HOST 改为 127.0.0.1 后重启服务。"
