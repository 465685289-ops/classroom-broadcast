# 班级广播通知系统

老师在手机端发布通知，教室大屏实时显示并可语音播报。适合班主任、任课老师协作发送班级通知。

## 功能

- 老师端注册登录、班级管理、班级协作邀请
- 作为师行全产品的唯一主账号库：新用户必须使用邮箱验证码注册，邮箱即账号；存量用户仍可用旧用户名登录，并可仅凭已绑定邮箱找回密码
- 教室端绑定班级、实时接收通知、语音播报
- 班级告示栏，适合发布作业和值日等静默通知
- 消息中心，接收教室回复和班级邀请
- 云狗微信支付年费开通
- 师行共享积分的余额、充值、流水与工作台服务端扣分接口
- SQLite 本地数据库存储，启动时可从旧 `data.json` 自动迁移

教师工作台可以继续呈现自己的注册、登录和找回密码页面，但所有验证码、密码校验和密码存储都通过服务端适配层回到本项目的主账号库，不建立第二套密码。

## 技术栈

- Node.js
- Express
- Socket.IO
- 原生 HTML/CSS/JavaScript
- SQLite 文件数据库

## 本地运行

```bash
npm install
npm start
```

默认访问：

- 首页：http://localhost:3000/
- 老师端：http://localhost:3000/teacher.html
- 教室端：http://localhost:3000/screen.html
- 管理后台：http://localhost:3000/admin.html

## 配置

敏感配置不要提交到 GitHub。可参考 `.env.example` 或 `payment-config.example.json` 配置：

```bash
cp payment-config.example.json payment-config.json
```

生产环境建议使用环境变量：

```bash
ADMIN_PASS=your_admin_password
PUBLIC_BASE_URL=https://your-domain.example
YUNGOU_MCH_ID=your_mch_id
YUNGOU_PAY_KEY=your_pay_key
YEARLY_PLAN_PRICE=9.90
WORKBENCH_POINTS_SECRET=replace-with-a-random-service-secret
```

`WORKBENCH_POINTS_SECRET` 只能配置在广播服务与教师工作台两个服务端，不能进入浏览器代码。广播会员管理教室广播时长，师行积分用于 AI 类功能，两者独立计费。

### 腾讯云精品语音

班级大屏通过服务端调用腾讯云“基础语音合成”接口，默认使用精品音色“智瑜”（VoiceType `101001`）。腾讯云密钥只能放在服务端，不能写进 `public/` 下的网页：

```bash
TENCENT_TTS_SECRET_ID=your_tencent_secret_id
TENCENT_TTS_SECRET_KEY=your_tencent_secret_key
TENCENT_TTS_REGION=ap-guangzhou
TENCENT_TTS_VOICE_TYPE=101001
```

本机可把真实值写入 `~/.config/classroom-broadcast/secrets.env`；生产服务器使用同名 systemd 环境变量。未配置或腾讯云临时失败时，大屏会自动使用浏览器本地中文语音，不影响通知展示。

## 部署提示

如果用 systemd 部署，建议把 `ADMIN_PASS`、`YUNGOU_MCH_ID`、`YUNGOU_PAY_KEY` 等放到 systemd 环境变量或服务器本地配置文件中，不要写进仓库。

## 数据迁移与备份

系统现在使用 `broadcast.db` 保存用户、班级、通知、告示、消息和支付记录。首次启动时，如果发现旧版 `data.json` 且 SQLite 数据库为空，会自动：

1. 将 `data.json` 复制到 `backups/`
2. 把旧数据导入 `broadcast.db`
3. 后续读写改用 SQLite

`broadcast.db`、`backups/`、`data.json` 都属于服务器运行数据，不要提交到 GitHub。

## 代码结构（2026-08 重构后）

```
server.js               应用引导：express/socket.io 装配、注册登录、账户资料、
                        支付入口、广播核心路由（班级/通知/大屏/积分）、管理后台、页面服务
platform-config.js      全部环境变量/JSON 配置常量（env > secrets.env > JSON > 默认值）
state.js                运行态容器（内存 store 与 socket.io 实例的共享引用）
auth-core.js            验证码/密码散列(scrypt)/令牌/会员套餐状态 + safeEqual
http-utils.js           子域识别 / Cookie 签名 / 访客分析埋点 / 邀请归因
mail-center.js          SMTP 传输器、管理员通知、注册与重置邮件
messaging-referrals.js  站内消息 / 各产品邀请返奖引擎
payment-engine.js       云狗网关客户端 / 套餐解析 / 回调验签 / 入账编排 markPaymentPaid
ai-engines.js           评语(DeepSeek)、作文(Qwen·MiniMax)、学习助手：提示词与归一化
middleware.js           userAuth/adminAuth/screen 会话等中间件；installAdminSessionRoutes
*-routes.js             路由域模块（installer 模式，server.js 启动时集中 install）：
                        comment-routes / learning-routes / english-routes /
                        referral-routes / essay-routes / roundtable-routes / tts-routes
tencent-tts.js          腾讯云精品语音 SDK 适配、参数约束与 MP3 解码
```

约定：
- 模块经 `state` 容器访问共享运行态；互相之间只允许单向 require，禁止回环。
- 本机私有密钥放 `~/.config/classroom-broadcast/secrets.env`（KEY=VALUE，服务器同名环境变量优先）。
- 部分测试为源码守卫（直接读源文件做正则断言），迁移实现时需同步守卫目标文件。
