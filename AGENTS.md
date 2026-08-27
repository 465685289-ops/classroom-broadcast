# AGENTS.md —— 给在本仓库工作的 AI 助手（Codex / Claude 等）

## 项目一句话

师行教学工具平台：班级广播（付费主力）+ 期末评语 + 中英作文批改 + 思想圆桌 + 数学课件，
单机 Express + Socket.IO + SQLite，nginx 反代三个域名，systemd 部署在阿里云。

## 2026-08-27 大重构后的架构（必读）

`server.js` 已从 5750 行拆分，README「代码结构」章节有完整地图。核心约定：

- **平台配置常量**全部在 `platform-config.js`；优先级：真实环境变量 > secrets.env 注入 env > JSON 配置 > 默认值
- **共享运行态**（内存 store、socket.io 实例）只经 `state.js` 容器访问，模块间禁止互相 require 回环
- **新路由域**照抄样板：参考 `comment-routes.js` 或 `roundtable-routes.js`——
  导出 `installXxxRoutes(app)`，server.js 启动时集中调用；帮助函数放同文件内即可
- AI 调用/提示词统一进 `ai-engines.js`；金额与套餐解析进 `payment-engine.js`；
  支付回调验签后走 `markPaymentPaid` 入账编排，不要绕开
- 加依赖前先看根目录已有的 `shixing-points.js` / `unified-referrals.js` 是否已覆盖

## 硬规矩

1. **源码守卫测试**：`tests/` 里有约 9 处测试直接读源文件文本做正则断言
   （如 platform-shell 要求 server.js 里存在 `function shixingHost(` 声明、
   unified-referral-hooks 切片检查 markPaymentPaid 调用点、english-page 检查支付端点归属）。
   **移动实现时必须同步修改守卫的目标文件**，否则测试假红。守卫符号清单备份见仓库外的开发档案。
2. 跑测试用 `npm test`（已固定串行并发）。已知偶发：unified-referral-api 的验证码邮件竞态，重跑即过，不算回归。
3. 任何密钥（yungou_pay_key / SMTP_PASS / DEEPSEEK_API_KEY / ADMIN_PASS）**绝不入库**。
   本机私有密钥在 `~/.config/classroom-broadcast/secrets.env`，服务器走 systemd 环境变量。
4. 提交信息风格沿用现有 history：`feat:/fix:/refactor(S?):/docs:/test:/chore:` 中文描述。

## 部署（与一般 git 项目不同！）

- 生产是**文件式部署**：scp 文件到 `root@notice.yingyuzuowen.asia:/home/admin/classroom-broadcast/`
  （应用属主 admin），然后 `systemctl restart classroom-broadcast`。**不是 git pull**。
- 上线前必须：本地 `npm test` 绿 → 与服务器现行版本 diff 热修 → 备份到服务器
  `releases-backup/<日期>/` → 上传 → 重启 → curl 三域名健康检查。
- 平台相关：主站 notice.yingyuzuowen.asia ✅；xiezuo ✅；
  english 子域 nginx vhost 未安装（存量问题），english 功能经主域 english.html 使用，属正常。
- systemd unit `/etc/systemd/system/classroom-broadcast.service` 内含 ADMIN_PASS 环境变量（勿提交改动到公网可读处）。

## 当前功能状态快照（2026-08）

班级广播有真实付费用户（¥9.9 半年）；六产品共用师行积分体系与首充奖励；
省级课题"AI赋能青年教师德育"立项中。详见 README 与 docs/plans/ 设计文档序列。
