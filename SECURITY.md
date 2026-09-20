# Security

Use HTTPS for public administration. Keep both application listeners on loopback.
The dashboard Nginx configuration must erase `X-Turnstate-Control` from inbound requests.
Protect `/var/lib/sub2api-turnstate` and `/etc/sub2api-turnstate`; never commit runtime files.

Passwords are scrypt hashes. State blobs are stored as sensitive plaintext with mode 0600,
not encrypted at rest. Audit records contain fingerprints/lengths, never full state or credentials.
Full state reveal and manual pin require an authenticated POST and CSRF token (or a root-owned
local control token). Delete the initial password recovery file after saving it securely.

Length matching is not validity verification. Scope isolation uses a salted HMAC of the
client credential, model, and optional session/turn. It does not identify the account chosen
inside Sub2API. Pinning must be explicitly enabled and may cause routing errors on pooled accounts.
Fresh installations start disabled. Existing pin-mode installs migrate to automatic mode.
Unknown models do not inherit astra's length. Automatic probing can keep incurring costs
while a connected target request waits; there is no hourly quota or total retry limit in v0.5.
The authenticated start/stop control is authorization for that automatic processing.
Pacing, bounded in-memory waiters, individual socket timeouts and explicit auth/rate-limit
errors remain. In v0.6, renewal credentials can remain in bounded process memory as described below; they are never persisted to disk or exposed in snapshots.

TLS/DNS setup never exposes login in plaintext while waiting for a certificate. Avoid broad
proxy retries: an already accepted generation must not be replayed to the backup server.


## v0.6.0 proactive renewal
Allowlisted authentication and routing identifiers are retained only in bounded process memory (at most 128 binding slots) after a qualified binding is seen. This enables unattended renewal even with no new foreground request. These values never enter logs, status snapshots, files or a release package. Stop, shutdown, configuration change and slot eviction clear their references; immutable JavaScript strings cannot be guaranteed cryptographically zeroized. On restart the operator must send a normal target request to re-arm the plan. Renewal probes may be billed while the switch remains enabled. Identical old states never extend the configured expiry. In v0.7.0, model equality is intentionally not enforced; a different response model can qualify by length plus successful completion, but is never claimed to prove requested-model identity.


## v0.7.0 acceptance
The administrator requested length-only model selection. Any response model, including luna or a missing model name, can qualify if successful completion and a single safe target-length header are present. This policy is NOT a model authenticity guarantee. Actual response model values remain visible; there is no response-body model rewriting and no sharing across requested-model bindings. Per-model disable/delete uses authenticated CSRF-protected POST and clears only that model's pins and memory-held routing identity.


## v0.8.0 model-wide cache and editable TTL
New rules default to 3600 seconds and model-wide sharing; old persisted rules retain their scope unless the operator explicitly migrates them. In model scope, the salted binding hash contains only the requested model, not tenant/credential/session identity. This intentionally removes those state-isolation boundaries and is not suitable for unrelated upstream accounts or untrusted multi-tenancy. Original requests always retain their own credentials and Sub2API performs authorization. Cross-account compatibility remains unverified. Credential/session/turn scopes are still available.
Only successful probes or completed original responses can supply model-wide renewal credentials. Anonymous calls cannot create model bindings; failed credentials do not replace remembered renewal credentials or revoke a state acquired by another credential merely because of HTTP 401/403. The normal unknown-error preservation policy remains. No routing credential is printed or stored on disk. A TTL-only edit reuses the source acquisition timestamp, and explicit scope widening never extends the prior expiry. TTL is a local operator limit, not verified upstream validity.

## Proxy pool v0.9.0
代理节点密码不是模型上游认证。直接通过节点请求上游时，不能把客户端的 sub2api API Key 当作上游 OAuth。当前集成不自动导出或读取 sub2api 数据库里的账户凭据：在控制台“独立探测上游连接”中，管理员需显式填写真实上游 token、Codex 的 ChatGPT Account ID，以及允许触发的本机 API Key。仅该绑定调用方可触发独立收费探测，其他调用方使用原 sub2api 路径。支持固定的 chatgpt.com Codex OAuth 或 api.openai.com Responses API 目标，不开放任意目的 URL。

**尚未配置上游认证时，节点可导入维护和进行非模型连接检查，但不能开启节点自动探测。** 页面明确显示缺少连接条件，不会声称已走节点却仍偷偷走原出口。上游凭据不由此工具自动刷新，过期后必须更新。使用独立 token 的探测不会进入 sub2api 的用量账本，但仍可能被上游计费。

轮询按一个自动任务遍历所有启用节点一次，从持久化的 nextId 开始；每尝试一个节点，起点前移。成功后下次获取从后一个节点开始，末尾回到第一。节点全部未命中则该任务剩余尝试使用原 sub2api 链路，不在同一任务无限重复扫描节点。连接失败、代理 407、长度未命中可尝试下一节点；上游 401/403/429、流式失败等停止本轮，不通过换节点规避拒绝。重试间隔沿用自动模式，无新增总次数/总时长/额度设置。

关闭节点池取消正在使用节点的短探测并丢弃迟到结果，后续探测回原 sub2api；现有固定值不会被强制清空。总开关关闭也取消节点工作。固定值和自动记录标记其取得来源（节点或 sub2api）。**普通请求始终走原 sub2api 出口，所以跨出口固定值兼容性属于未验证的实验，不保证同地区节点就能获得 292、也不保证节点取得的值适用于正式链路。** 现有按长度采纳及模型共享策略不变。

节点密码与显式上游 token 通过 AES-256-GCM 保存至 `proxy-pool.enc.json`，文件权限 0600；密钥从现有控制密钥派生。允许调用的本机 API Key 只保存 HMAC。页面与普通日志不返回密码/token/原始 API Key。不要更换控制密钥后丢弃旧备份；无法解密时节点池关闭，普通路径不受影响。此加密减少意外泄漏，不防御能够同时读取控制配置的主机管理员。

代理连接禁止本机/私网 IPv4，公网域名在连接前解析检查并固定所选地址。上游 TLS 校验不关闭；不解密第三方流量，不导出上游证书或私钥。HTTP/SOCKS5 的代理认证本身不加密，HTTPS CONNECT 可保护第一跳；上游模型请求始终在独立 TLS 内发送。

测试见 `TEST_PROXY_POOL.md`。这是可配置的独立探测能力；未提供上游认证时，不把仅验证代理连接写成模型探测成功。
