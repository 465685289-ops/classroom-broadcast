# 班级广播系统更新部署（2026-06-10 第二批：教室大屏改版）

上一批（server.js / db.js 安全加固）已部署完成，本次**只更新两个静态文件**，不改后端、不动数据库、**不需要重启服务**：

- `public/screen.html`（教室大屏视觉改版 + 推广二维码 + 品牌角标）
- `public/qr-site.svg`（新增：二维码图片）

## 1. 备份

```bash
cd $APP_DIR   # 与上次相同的项目目录
cp public/screen.html releases-backup/screen.html.$(date +%Y%m%d-%H%M%S)
```

## 2. 上传 2 个文件

```bash
scp public/screen.html public/qr-site.svg user@SERVER:$APP_DIR/public/
```

## 3. 验证

```bash
# 两个文件都能访问到（期望都是 200）
curl -s -o /dev/null -w "%{http_code}\n" https://notice.yingyuzuowen.asia/screen.html
curl -s -o /dev/null -w "%{http_code}\n" https://notice.yingyuzuowen.asia/qr-site.svg

# 新版页面应包含推广位关键字
curl -s https://notice.yingyuzuowen.asia/screen.html | grep -c "idle-promo"   # 期望 ≥ 1
```

## 4. 回滚（仅当出问题时）

```bash
cd $APP_DIR
cp releases-backup/screen.html.最新时间戳 public/screen.html
```

## 部署后用户侧注意

各教室大屏**刷新一次页面**即可看到新版界面（Ctrl+F5 强制刷新更保险）。绑定状态保存在浏览器本地，刷新不需要重新绑定。
