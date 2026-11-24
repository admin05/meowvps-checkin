# MeowVPS 每日签到

面向 Arcadia 的 Node.js 定时脚本。运行环境需要 Node.js 18 或更高版本。

## 环境变量

- `MEOWVPS_USERNAME`：MeowVPS 账户用户名
- `MEOWVPS_PASSWORD`：MeowVPS 账户密码
- `BARK`：Bark 推送 key；未设置时签到仍会执行，只跳过通知
- `MEOWVPS_BASE_URL`：可选，默认 `https://meowvps.com`
- `MEOWVPS_LOGIN_PATH`：可选，默认 `/auth/login/local`。升级时可删除旧版的 `/auth/login` 覆盖值
- `MEOWVPS_CHECKIN_PATH`：可选，默认 `/auth/account/checkin`
- `MEOWVPS_TIMEOUT_MS`：可选，单次请求超时毫秒数，默认 `20000`

在 Arcadia 中将前三项配置为环境变量，并设置每天运行一次的计划任务。账户中心使用北京时间显示签到状态，建议把任务安排在北京时间每天 00:05 之后。

```sh
node meowvps_checkin.js
```

登录和签到路径与 MeowVPS 账户中心的前端请求一致。脚本不会保存账户密码或 Bark key。

## 网络排查

请在 Arcadia 的任务日志中查看请求阶段、主机名和底层错误码。`ENOTFOUND`、`EAI_AGAIN` 通常指向容器的 DNS 设置。`ENETUNREACH`、`ETIMEDOUT` 或 `UND_ERR_CONNECT_TIMEOUT` 则需要检查容器到该主机的网络连通性。

登录连接在收到 HTTP 响应前出现 `ECONNRESET` 时，脚本会等待 1 秒并重试一次。如果仍然失败，请在运行 Arcadia 任务的同一个容器里手动执行：

```sh
node meowvps_checkin.js --diagnose
```

诊断模式会访问账户接口，并向登录接口发送一次不含账号密码的请求。通常分别返回 HTTP 200 和 HTTP 401。若两项都出现 `ECONNRESET`，请检查容器的网络出口。若账户探测成功，只有登录探测被重置，请检查网络出口或站点对登录请求的处理。诊断模式只输出到任务日志。
