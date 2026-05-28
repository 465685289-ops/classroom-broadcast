# 班级广播通知系统

老师在手机端发布通知，教室大屏实时显示并可语音播报。适合班主任、任课老师协作发送班级通知。

## 功能

- 老师端注册登录、班级管理、班级协作邀请
- 教室端绑定班级、实时接收通知、语音播报
- 班级告示栏，适合发布作业和值日等静默通知
- 消息中心，接收教室回复和班级邀请
- 云狗微信支付年费开通
- JSON 文件本地存储，适合轻量部署

## 技术栈

- Node.js
- Express
- Socket.IO
- 原生 HTML/CSS/JavaScript
- JSON 文件存储

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
```

## 部署提示

如果用 systemd 部署，建议把 `ADMIN_PASS`、`YUNGOU_MCH_ID`、`YUNGOU_PAY_KEY` 等放到 systemd 环境变量或服务器本地配置文件中，不要写进仓库。
