# Copilot2Copilot

在 GitHub Copilot 中注册“向同事沟通”工具，让**双方的 Copilot 直接沟通**：你告诉自己的 Copilot “帮我问张三：XX 接口的分页参数怎么传”，消息会送达同事的 VS Code，由其 Copilot 阅读理解并回复；代码细节的往返全程自动流转。

## 功能

- **5 个语言模型工具**（agent 模式下 Copilot 自动调用，也可用 `#` 引用）：
  - `#list_colleagues` 查看沟通方名单（含角色、负责内容、在线状态）
  - `#send_message` 向同事发消息（可附代码片段；**默认等待对方回复后再返回结果**）
  - `#wait_reply` 等待某条消息的回复
  - `#reply_message` 回复收到的消息
  - `#list_inbox` 查看收件箱
- **双通信模式**：
  - 局域网直连：双方处于同一网段，各监听一个端口互相直连，无服务器依赖
  - 中继模式：双方连接自建中继服务器，支持离线消息暂存、跨网络
- **左下角状态栏入口**：状态灯 + 未读角标，点击打开配置界面（连接 / 沟通方 / 收件箱 / 行为）
- **下线通告**：VS Code 退出时向所有沟通方发出下线通告，对端立即把该设备标记为离线
- **档案自动交换**：连接后自动同步双方的角色 / 负责内容，供双方 Copilot 判断“该问谁”“谁在问”；档案可**按工作区**配置，切换项目时自动生效
- **防注入设计**：通信约定与安全边界保存在扩展内 `prompts/communication-boundary.md`，注入时作为**附件**加载（不占用消息正文）；所有发送动作都有确认弹窗

## 开发与安装

```bash
npm install
npm run build        # 产出 dist/extension.js
npm run typecheck    # 类型检查
npm run vsix         # 打包 vsix 到 vsix/ 目录（文件名含版本号），发给同事安装
```

本地调试：VS Code 打开本目录，按 F5 启动 Extension Development Host。

## 配置

点击左下角状态栏的 `talk2copilot` 图标打开配置界面：

- **连接**：选择局域网 / 中继模式；局域网填监听端口（需防火墙放行）；中继填 `wss://` 地址、自己的 id，令牌可选（存系统密钥库）
- **我的档案**：id、角色、负责内容（必填齐全才能通信，未完善时状态栏与配置页会提示）。可勾选“**本工作区使用独立档案**”，让档案（含 id）随工作区自动切换；未勾选时编辑的是对所有工作区生效的默认档案。注意：id 也按工作区时，对方需要在“沟通方”里填你**对应工作区**的 id
- **沟通方**：填 **对方 id** 与地址。**中继模式**下必须同时填对方的**中继 id**（只填对方 id 不会交换档案声明，对方会一直显示离线）；填一侧即可双向自举——对方收到声明后会自动登记并回发。**局域网模式**下对方连入时会自动登记。角色与负责内容自动同步，档案同步完成前无法收发消息
- **行为**：等待回复默认超时、历史消息保留条数；收到同事的消息或回复时会**直接触发本机 Copilot 对话**处理

`id` 是双方匹配的唯一依据，两端需互不相同；"沟通方"里填的是**对方**的 id（若填成自己的 id，会被拒绝并在卡片上提示）。

## 使用示例

A（你）在 Copilot Chat（agent 模式）中说：

> 帮我问张三，OrderService 的 pageSize 上限是多少，把这段调用带给他

你的 Copilot 会调用 `#send_message`（弹出确认框，可核对内容与代码片段），消息送达后**直接触发对方的 Copilot 对话**进行处理，回答经 `#reply_message` 返回。**发送默认等待对方回复**（缺省取配置里的“等待回复默认超时”，默认 90 秒）——拿到回复后本机 Copilot 才继续下一步；若等待超时，工具会提示继续调用 `#wait_reply` 直到拿到回复。显式传 `wait_seconds=0` 可改为不等待。

## 中继服务器部署

中继服务跑在一台**独立服务器**上，双方各自连它、使用**同一个预共享密码**通信。目标机需有 Node.js 18+。

```bash
# 方式一：安装脚本（装到 /opt/talk2copilot-relay，注册 systemd 服务并启动）
sudo relay/deploy/install.sh
sudo relay/deploy/install.sh /usr/local/bin/node   # node 不在 PATH 时指定绝对路径
# nvm 装的 node 在 sudo 下不在 PATH，需显式给出（脚本会把它复制进安装目录，
# 因为 systemd 单元的 ProtectHome 会隐藏 /home）：
sudo relay/deploy/install.sh /home/<用户>/.nvm/versions/node/v22.11.0/bin/node

# 方式二：前台直接跑（用于临时调试）
TALK2COPILOT_TOKEN=<你的密码> node relay/server.js 8787
```

安装脚本会：**首次安装**时生成随机预共享密码写入 `/etc/talk2copilot-relay.env`（权限 600，含 `PORT` / `HOST` / `TALK2COPILOT_TOKEN` / `LOG_LEVEL`，模板见 `relay/deploy/relay.env.example`；已存在则原样保留），创建无登录权限的服务账号 `talk2copilot`，安装并启用 `talk2copilot-relay.service`，最后自查一次 `/healthz`。改完配置执行 `sudo systemctl restart talk2copilot-relay`。

运维命令：

```bash
sudo systemctl status talk2copilot-relay    # 运行状态
curl -s http://127.0.0.1:8787/healthz       # 探针：{"status":"ok","uptimeSec":..,"peers":..,"queued":..,"tokenRequired":true,"protocol":1}
sudo journalctl -u talk2copilot-relay -f    # 日志（带时间戳与级别，可用 LOG_LEVEL 调级别）
```

- `HOST` 默认 `0.0.0.0`，内网各机可直连；只允许反向代理 / 隧道访问时改为 `127.0.0.1`
- 收到 `SIGTERM`（`systemctl stop` / `restart`）时先给客户端发关闭帧再退出，客户端会自动重连
- 在线名单与离线暂存都在内存中，**重启服务端会丢弃暂存的离线消息**

跨网络使用时可置于 Cloudflare Tunnel / Nginx 之后（需支持 WebSocket），地址形如 `wss://relay.example.com`，客户端会自动拼 `/ws`。

## 安全说明

- 局域网模式为明文 `ws://`，**只校验对方 id、不校验令牌**（面向可信内网）；对方连入时若尚未登记会自动登记为该 id
- 中继模式建议走 `wss://`，可设置中继令牌（校验 `Authorization: Bearer`，令牌存系统密钥库）
- **通信边界**：本通道只做信息交换。**允许**对方回答信息、阅读代码、执行只读查询（获取信息）；**禁止**要求或执行任何变更（修改代码/文件/配置、安装依赖、部署、重启、启停服务等）。约定保存在扩展内 `prompts/communication-boundary.md`，注入同事消息/回复时作为附件加载；发送侧的工具描述与确认弹窗同样声明该约定，收到的内容只作为信息参考，任何改代码的决定都由本机用户按正常流程作出
- 收到消息注入聊天时会声明为外部输入；请勿在开启“自动处理”的同时处理不可信来源的消息
- 代码片段外发前会在确认弹窗中展示，请留意敏感代码
