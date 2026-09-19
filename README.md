# Sub2API Turn-State · v0.6.0

单开关的可选入口扩展。登录控制台后只有一个运行开关：**启动 / 关闭**。

```text
客户端 → Nginx → 本扩展 127.0.0.1:17890 → Sub2API 127.0.0.1:18080
                                                     ↓
                                     Sub2API 原有账号 / 出站代理 → 上游
```

不会修改 Sub2API 账号、Docker 网络或出站代理配置。本机转发不使用 HTTP_PROXY/HTTPS_PROXY/ALL_PROXY。

## 开关的含义

**启动**：收到已配置目标模型的完整 HTTP Responses 请求后，检查对应绑定是否已有未过期、模型声明经过核对且长度符合规则的固定值。有则直接使用；没有则保留原请求在有界内存中，只发送简短探测。模型/长度未命中会自动退避重试；命中后固定并发送原请求一次。1 小时固定值在到期前 10 分钟自动更新，更新期间未过期旧值继续使用；新值核对通过后替换。

**关闭**：取消正在进行的探测；仍连接的等待原请求原样放行。新请求直接透传，不解析正文中的模型、不修改请求或响应状态头。控制台和转发服务仍运行。已经在上游执行的请求无法撤回。

自动模式没有共享额度、总尝试次数或总运行时长设置，也没有隐藏的旧额度检查。旧 `probe-budget.json`、`probe-limits.json`、`preflight.json` 不再读取；不会出现旧额度耗尽造成自动停止。

首次匹配请求提供认证与会话标识并建立定时更新计划。之后即使没有新请求，也会在到期前 10 分钟探测；不再要求等待一个新请求触发。无需手动输入 API Key 或增加设置项。仅允许列表内的认证和路由信息在进程内存中驻留，不保存原始正文、不写入磁盘；关闭、规则修改、服务停止时清除。新进程或重新开启后，必须由下一条匹配请求重新提供凭据，已有固定值本身不会泄漏凭据。探测使用 `input: "ping"` / `instructions: "Reply only OK."` / `max_output_tokens: 16`，不会携带原始提示词、工具或附件；上游可能忽略输出限制，探测可能持续计费。

模型未命中（例如 astra 请求返回 luna）或长度未命中均继续，不将错误模型的 292 固定给 astra。只有 HTTP 2xx、精确模型声明、配置长度，以及成功结束或输出 token 上限事件均通过检查时才采用。上述条件是本地兼容判断，不是状态签名验证或底层模型身份的证明。

### 基础网络保护仍然存在

重试间隔自动从 2 秒退避到最多 30 秒；不存在总次数或总时限停止条件。单条网络探测仍使用 15 秒超时，防止挂死的 socket。401/403/429、连接错误、响应失败和服务器错误会让当前原请求得到明确的 503（不发送原始正文），短暂冷却后后续请求可以再试，不做认证/限流绕过。

客户端断开时取消其等待；最后一个同绑定等待者断开后取消首次获取；已经独立建立的定时更新不会因为没有等待请求而取消。客户端、Nginx 或 CDN 本身仍可能有等待超时，这不是本工具的“总探测时间”设置。没有目标响应时，不能保证原请求一定能继续。

最多两个不同绑定同时探测；同绑定并发会合并。最多八个等待原请求，合计保留正文不超过 64 MiB，超载明确报错。资源保护不是次数配额。原始生成不会因失败而被扩展自行重放。

## 控制台

需要管理员登录；保留原账号密码。页面提供总开关、自动进度、当前固定值及刷新倒计时、请求与状态日志。完整状态仅在管理员点击后通过受保护 POST 获取，显示后自动清除；普通日志不记录完整状态。

多模型格式保留在折叠的“模型规则”中：astra 的 292/312 为用户提供的兼容规则，不是所有模型通用规则。已有模型长度、刷新周期、隔离范围原样保留。添加其他模型时可指定目标长度，未配置模型不自动套用 astra。普通使用不需要编辑这些规则。

固定值按 API Key 的 HMAC、模型和配置的会话/轮次隔离。前置扩展无法感知 Sub2API 内部切换上游账号；宽范围 credential 隔离及跨轮复用属于实验性兼容行为。相同 token 的重复响应不会无限延长本地刷新倒计时。

## 安装

需要 Linux、systemd、Nginx 和 Node.js 22+。零第三方运行依赖。旧服务器可独立安装 Node 到 `/opt`，不用替换其他应用的运行时。

使用经过校验的本地 npm 安装包，或从该版本的 GitHub Release 获取同名资产。GitHub Release 安装包不等于已发布到 npm registry：

```sh
npm install -g --prefix /opt/sub2api-turnstate/npm --ignore-scripts \
  ./babadaren-sub2api-turnstate-0.6.0.tgz

sudo node /opt/sub2api-turnstate/npm/lib/node_modules/@babadaren/sub2api-turnstate/bin/turnstate.mjs install \
  --admin-origin https://state.example.com --domain state.example.com \
  --nginx-conf /etc/nginx/conf.d/sub2api.conf --apply

# 使用安装时的 Node 绝对路径，不依赖系统默认 Node
sudo turnstate start
```

新安装初始关闭；`start` 开启自动处理和可能计费的探测。旧安装处于 `pin` 状态时升级为自动开启，旧 `off/observe` 状态保持关闭。升级需先安全撤销入口，等待现有请求结束，再切换独立版本目录；保留旧版本、Nginx 备份、状态和模型规则。`install` 不会静默覆盖现有 systemd 服务。

默认用户名 `admin`。随机初始密码保存在服务器 root 专用文件，不输出到日志：

```sh
sudo cat /etc/sub2api-turnstate/initial-admin-password
```

DNS 未就绪时只提供验证占位页；DNS 与证书就绪后开启控制台 HTTPS：

```sh
sudo turnstate domain-enable --domain state.example.com --apply
```

## 常用命令

```sh
sudo turnstate start        # 自动探测 + 固定
sudo turnstate stop         # 取消探测 + 原样透传
sudo turnstate status       # 状态、版本、已完成请求
sudo turnstate auto-status  # 自动任务及缓存命中
sudo turnstate states      # 模型规则和脱敏固定值
sudo turnstate refresh --model gpt-6-astra  # 失效，下一条请求自动重取
sudo turnstate doctor

sudo turnstate disconnect --apply     # 撤销 Nginx 接管；控制台仍运行
sudo turnstate connect --nginx-conf /etc/nginx/conf.d/sub2api.conf --apply
sudo turnstate service-stop --apply   # 先恢复原路由，再停止进程
sudo turnstate uninstall --apply      # 先恢复路由，再移除 systemd；数据/备份保留
```

请勿直接 npm uninstall 后留下指向已移除服务的 Nginx 配置。完整停用后再卸载 npm 包、停用控制台站点。

旧版 `probe-start/probe-budget/preflight-config` 等独立控制命令已移除；旧管理 API 返回 410，提示使用单一 `/api/automation`，而不是静默维持旧额度。`GET /api/automation` 查询；`POST /api/automation` 接受 `{"enabled":true}` 或 `{"enabled":false}`。管理 API 都需要鉴权，浏览器写操作另需 Origin、JSON Content-Type 和 CSRF 校验。

## 覆盖范围及数据

同时支持 `/responses`、`/v1/responses` 及 `/compact` 的完整 HTTP POST。非目标模型、无法解析、压缩、超出 8 MiB 默认解析上限的正文、WebSocket 握手按原流程透传，不猜测其模型。SSE 响应流不缓冲整份输出；响应诊断读取上限默认 4 MiB。解析并发受限，繁忙请求按原流程透传。

仅监听 loopback。Nginx 的连接失败备用路径保留；扩展不可连接时可回原 sub2api，因此不是所有故障下的强制拦截层。运行中自动流程主动返回的 503 不会被 Nginx 转送备用上游。没有 TLS 中间人、代理切换或系统流量劫持。

配置/状态在 `/var/lib/sub2api-turnstate`，Nginx 回滚记录在 `/etc/sub2api-turnstate`；完整状态文件权限 0600，不加密、不入 Git。日志轮转有上限，排除 Authorization、Cookie、查询参数、正文与完整状态。关闭时仍可记录基础传输状态。内存统计和最近自动任务随进程重启归零；轮转日志保留。

## 开发

```sh
npm run check
npm test
npm pack --ignore-scripts
```

v0.5.0 替换旧的手动任务/额度测试为单开关自动流程测试，保留传输、SSE/WS、鉴权、模型解析、持久化及真实 Nginx 回滚/备用路由测试。详见 `TEST_AUTOMATIC.md`。历史行为和旧报告只适用于各自版本；本版本不再运行旧额度任务引擎。


## 提前更新（v0.6.0）

只有原来的启动/关闭总开关。对于当前 3600 秒生命周期，固定值采集后的第 50 分钟自动开始短探测。对于短周期，提前量为生命周期的三分之一，最长 10 分钟；不会在取得新值后立即再次更新。定时器每秒检查一次，容量繁忙时会延后。

成功条件仍是 HTTP 2xx、精确响应模型、目标长度和响应成功。原值 A 与目标模型/长度未命中时保持不变；得到不同的新值 B 后替换并持久化。从 B 的采集时刻按模型已有 TTL 重新计时。相同 A 不重置过期时间，也不当作一次新命中。

并发保护：每个绑定只进行一个获取/更新任务。旧值未过期时正常请求不等待更新；过期后同绑定请求加入正在进行的更新，不使用过期状态。请求已经以 A 发出时，不在其响应中改用 B；A 对应的迟到响应也不能覆盖 B。即使新请求以 B 发出却又收到上游旧值 A，普通响应也不能覆盖当前未过期且已核对的 B；这类固定值只由独立更新任务轮换。关闭会取消全部定时更新并清除内存认证，不另加次数、总时限或配额。

网络失败保留旧值并退避；上游 Retry-After 会被尊重。认证失败不反复使用被拒的认证信息，等待新的实际请求。更新持续未命中并超过旧值到期时间时，不能保证无间断：旧值不再使用，原请求可能等待、被客户端取消或收到明确错误。

控制台的固定值卡片分别显示到期时间、计划探测时间、正在提前更新、错误后等待以及等待认证信息。停用/重启后不会把磁盘中的固定值误报为已建立主动更新计划；认证信息只在内存，下一条目标请求会自动恢复。

此版本测试包含虚拟时钟、真实定时器及 Linux/Nginx 集成验证；不是线上运行一小时后的验收。详见 TEST_RENEWAL.md。
