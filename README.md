# Sub2API Turn-State

可选的 Linux 入口扩展：按模型观察 / 配置 `x-codex-turn-state`，提供登录控制台、固定候选值、刷新倒计时、手动刷新及可回滚的 Nginx 接管。

```text
客户端 → Nginx → 本扩展 127.0.0.1:17890 → Sub2API 127.0.0.1:18080
                                             ↓
                               Sub2API 原有账号代理 → 上游
```

**不替换 Sub2API 的账号代理，不修改 Docker 网络，也不读取系统代理变量。** 同时处理 `/responses` 和 `/v1/responses` 路径族（包括 `/compact`）；不改写这两类请求原有的上游路径。其他流量保持原入口路由。完全撤销接管后，Nginx 恢复直接访问 Sub2API。

## 安装

需要 Linux、systemd、Nginx 和系统可读的 Node.js 22+。零第三方运行依赖。系统 Node 版本较旧时，可以将官方 Node 22 放在 `/opt` 并使用独立 npm prefix，不必升级或替换其他应用的 Node。

GitHub Release 提供标准 npm tarball；这是 **GitHub 发布资产，不代表已经发布 npm registry**：

```bash
# 建议使用私有 prefix，避免与系统已有 CLI 冲突。
npm install -g --prefix /opt/sub2api-turnstate/npm --ignore-scripts \
  https://github.com/babadaren/sub2api-turnstate/releases/download/v0.3.0/babadaren-sub2api-turnstate-0.3.0.tgz

# 使用 Node 22+ 运行安装入口。安装会创建 systemd 服务、自动启动并设置开机启动。
# --nginx-conf 指向你现有的 Sub2API 反向代理配置。
sudo node /opt/sub2api-turnstate/npm/lib/node_modules/@babadaren/sub2api-turnstate/bin/turnstate.mjs install \
  --admin-origin https://state.example.com \
  --domain state.example.com \
  --nginx-conf /etc/nginx/conf.d/sub2api.conf --apply
```

安装完成后 `/usr/local/bin/turnstate` 会使用安装时的 Node 绝对路径，不依赖交互式 shell 中的 Node 版本。

安装默认是 **observe**：自动接管入口并采集已配置模型的候选值，不改写状态头。确认模型、账号粘性和风险后，在控制台选择“启用模型固定 / 回灌”，或：

```bash
sudo turnstate mode pin --ack-experimental
```

npm 安装本身没有 postinstall 副作用，不会静默修改生产 Nginx。系统安装需要显式 `install --apply`。

### 管理账号与域名

默认用户名：`admin`。随机初始密码写入 root 专用文件，而不是发布日志：

```bash
sudo cat /etc/sub2api-turnstate/initial-admin-password
```

请将密码保存到密码管理器，并删除此初始密码文件（不影响密码哈希）。重置密码：

```bash
read -rs -p 'New password: ' PW; echo
printf '%s' "$PW" | sudo turnstate password --password-stdin
unset PW
sudo systemctl restart sub2api-turnstate
```

DNS 尚未就绪时，安装只生成 HTTP-01 验证入口和返回 503 的占位页，不开放明文登录。添加 DNS 后执行：

```bash
sudo turnstate domain-enable --domain state.example.com --apply
```

该命令通过系统 `certbot` 的 webroot 模式申请独立证书，验证证书域名，配置 HTTPS 控制台并 reload Nginx。需要服务器可被公网的 80/443 端口访问、已有可用 Certbot 账户或预先设置好账户。它不操作 DNS 服务商，不关闭防火墙，也不替换其他站点证书。成功后安装证书续签的 Nginx reload hook。

## 多模型规则

模型来自 HTTP JSON 正文中的 `model`，而不是从不透明的 state 字符串“猜”出来。模型为空、无法识别、编码正文或正文超过 1 MiB 时，不套用默认模型；请求字节仍原样转发。超过检查上限的请求以有界缓冲 + 流式转发处理。

控制台可新增任意模型，包括 `gpt-5.6-sol` 等自定义上游名称。预置规则如下；这些名称是否由上游提供，须由你的服务确定：

| 模型 | 固定长度 | 丢弃长度 | 周期 | 初始状态 |
|---|---|---|---|---|
| `gpt-6-astra` | 292 | 312 | 300 秒 | 规则启用，但全局仍为 observe |
| `gpt-5.6-sol` | 未配置 | 无 | 300 秒 | 规则关闭，等待观察后配置 |
| 其他模型 | 不猜测 | 不猜测 | 可配置 | 未配置时只观察 |

292/312 是用户提供的特定兼容规则，**不是公开协议的通用有效性判断**。同模型可以设置多个固定长度和丢弃长度。未知长度默认透传。可选“自动学习”只表示接受未被排除的成功响应长度作为候选，不证明其真正可用。

示例规则对象（其他模型的具体长度请根据实际记录填写，不要照抄测试数据）：

```json
{
  "gpt-6-astra": {
    "enabled": true,
    "pinLengths": [292],
    "discardLengths": [312],
    "ttlSeconds": 300,
    "scope": "session",
    "unknownPolicy": "pass",
    "autoLearn": false
  }
}
```

```bash
sudo turnstate rules --file ./rules.json --ack-experimental
sudo turnstate states
```

上传完整规则对象会替换当前规则集合；页面编辑单个模型会保留其他模型规则。

### 固定、隔离和刷新

候选仅从 **2xx 成功响应**获取，不从客户端请求重新采纳旧值。默认按 API Key 的 HMAC、模型和会话隔离；可改为显式轮次范围，或更宽的 API Key 范围。没有必要标识时绕过回灌。不会跨 API Key 或模型共用一个固定值。

- `turn`：API Key + 模型 + 会话 + 显式 `x-codex-turn-id` / `metadata.turn_id`。缺少轮次不固定。
- `session`：API Key + 模型 + 会话；属于跨轮兼容实验，不能保证符合上游路由生命周期。
- `credential`：API Key + 模型；范围更宽，不建议用于多账号池。

**前置代理不知道 Sub2API 内部实际选择的账号。** API Key 隔离不能替代上游账号隔离；账号池切换、认证变化、跨轮复用可能导致错误。生产环境先 observe；仅在已验证的单账号或粘性会话链路上主动启用 pin。真正的账号感知集成点见 `deploy/INTEGRATION.md`，本版本未修改 Sub2API 源码。

控制台显示模型、固定长度、脱敏预览、指纹、来源、采集时间、隔离标识及倒计时。管理员点“查看完整值”后才调用受保护的 POST 接口获取完整 state；不会进入普通转发日志。完整值的 UI 显示会自动清除。

**倒计时是本工具本地配置的刷新周期，不是解密出的上游有效期。** 重复收到同一个值不会无期限延长倒计时。到期 / 手动刷新会使旧绑定失效；固定模式下下一条同绑定请求不带旧 state，等待新的成功响应采集。没有真实流量时明确显示“等待新响应”，不会伪造“刷新成功”。刷新前已在途的响应不会恢复旧绑定。

```bash
sudo turnstate refresh --model gpt-6-astra
```

支持管理员对已有隔离绑定手动粘贴符合该模型长度的 state。当前版本 **不持久化探测 API Key，不后台定期探测，不遍历代理节点**。普通刷新不会主动请求或切换出口；v0.3.0 增加了单独确认、次数受限的主动探测，见下节。

## 主动探测（v0.3.0）

控制台新增“主动探测”。它直接连接配置中的本机 Sub2API，不经过自己的状态回灌链路，**不带旧 state，不改变指定 model**，继续由 Sub2API 选择账号并使用原来的出站代理。

先给目标模型配置并启用明确的固定长度，例如用户提供的 `gpt-6-astra → 292`。探测目标只能是该模型已配置的固定长度；不会把 292 当作所有模型的通用规则。

两种启动方式：

- **选定会话的下一条成功请求**：先用目标模型发一条正常请求，再在控制台选择对应的脱敏客户/会话，点击开始。下一条同绑定的正常请求成功结束后，仅本次借用其认证、会话和路由标识启动探测。不会保留聊天正文，也不会借用其他模型或其他 API Key 的请求。等待超过 120 秒即取消。
- **手动输入**：输入 Sub2API API Key，以及与真实客户端相同的 session/turn 标识。密钥仅在本次任务内存中保存，结束/取消后移除引用，不进入记录或配置文件。标识不同就不是同一个固定绑定。

默认 3 次、硬上限 10 次、串行、间隔至少 2 秒；每次请求 15 秒超时、运行最多 180 秒。每进程限制每 10 分钟最多启动 3 次、每小时最多 30 次请求；重启会重置这些内存限额。每次发送固定小提示及 `max_output_tokens: 16`，上游不支持该参数时直接报告 HTTP 错误，不自动移除限制后重试。上游实际计费以其账单为准。

只有 2xx、目标长度、响应声明的模型与请求模型完全相同，而且响应正常结束（或明确因输出 token 上限结束）才采纳；错误、模型不符、无法识别响应模型、重复状态头、401/403/429、重定向、5xx 或不确定超时都停止。仅在成功响应的长度未命中时进行下一次尝试。命中后来源显示 `probe` 并停止；仅保存到选定绑定。观察模式只保存候选，不回灌。

同一出口可能始终返回 312。次数用完会显示“未命中”，不会制造/截断 292，也不会自动切节点、更换账号或无限请求。状态长度只是一种实验性选择规则，不是有效性验证；探测也不能解决 Sub2API 内部账号切换的隔离问题。已有正常生成可能因同会话路由实验受到影响，应先用于已验证的单账号/粘性链路。

```bash
sudo turnstate probe-status
# 从状态输出选择已有 binding id（不含明文密钥）
sudo turnstate probe-start --model gpt-6-astra --binding BINDING_ID --attempts 3 --ack-billable --ack-experimental
sudo turnstate probe-stop
```

关闭处理、改规则、手动刷新/替换、停止服务都会取消未完成探测；不会在服务启动、重启或倒计时结束后自动恢复/重复探测。

转发记录新增“请求 → 响应声明模型”。请求模型是进入扩展时 JSON 中的值，扩展原样转发该正文。响应模型来自有界、只读的 SSE/JSON 元数据检查，缺失时显示未识别，不能用来证明底层运行模型的身份。不会为识别模型缓冲整个响应。

## 控制命令

```bash
sudo turnstate status
sudo turnstate doctor
sudo turnstate start          # 观察模式；不自动重新接管已撤销的 Nginx
sudo turnstate stop           # 原样透传，控制台保持运行
sudo turnstate mode pin --ack-experimental
sudo turnstate disconnect --apply  # 恢复原 Nginx；服务仍运行
sudo turnstate connect --nginx-conf /etc/nginx/conf.d/sub2api.conf --apply
sudo turnstate service-stop --apply  # 先恢复 Nginx，再停止守护进程
sudo turnstate uninstall --apply     # 先恢复路由，再移除 systemd 单元
```

卸载保留数据、初始密码文件（如尚未删除）、备份、CLI wrapper 和版本目录，不递归删除运维文件；保留的 CLI 可用于检查，依赖运行服务的命令不再可用。需要的话再移除专用 npm 包、控制台站点和 wrapper：

```bash
npm uninstall -g --prefix /opt/sub2api-turnstate/npm @babadaren/sub2api-turnstate
# 先确认需要停用控制台，再删除 /etc/nginx/conf.d/turnstate-console.conf，nginx -t 后 reload。
```

不要先 `npm uninstall` 后再考虑路由。`install` 拒绝静默覆盖现有 systemd 单元；升级需先安全撤销 / 停止，再安装新版本，保留配置与状态。

## 可用性与数据安全

- Nginx 配置备份在 `/etc/sub2api-turnstate/nginx.json`；修改前后执行 `nginx -t`。验证失败自动恢复；检测到人工修改时拒绝覆盖。
- Nginx 为扩展设置原 Sub2API 的备用入口。连接被拒绝可回退，但已提交的 POST、不确定的超时、已开始的 SSE/WS **不重放**；不能承诺所有故障零中断。
- HTTP 响应流 / SSE 不缓冲。WebSocket 字节原样转发，只记录握手；不会默认把未知模型握手当作 astra。此版本不能根据后续 WebSocket 帧重写已经发出的握手头。
- 密码 scrypt 哈希、HttpOnly/SameSite/Secure 会话、Origin + CSRF 校验、登录限速。服务运行在独立低权限账号下，管理与转发只监听 loopback。
- runtime/config/rules/state 存于 `/var/lib/sub2api-turnstate`，完整 state 文件权限 0600。状态文件不是加密存储，应当像凭据一样保护，不入 Git。
- 记录不包含 Authorization、Cookie、查询串、提示词、回答或完整 state。日志轮转有上限；可查看最近记录，不提供 token 计费统计。
- 计数及长度分布从本次进程启动开始。HTTP 时间是首响应头耗时，不是首 token。WS 计数是握手次数，不是消息轮数。

## 开发与发布

```bash
npm run check
npm test
npm pack --ignore-scripts
```

测试覆盖多模型不同长度、凭据 / 会话隔离、计时过期、手动刷新、在途响应隔离、持久化、管理员鉴权、SSE、WebSocket、原样透传与真实 Nginx 回滚 / fallback。

仓库提供 GitHub Actions CI 和 Release 打包工作流。默认仅发布 GitHub Release；npm registry 发布需要仓库所有者另行设置发布身份 / OIDC，不包含任何发布 token。
