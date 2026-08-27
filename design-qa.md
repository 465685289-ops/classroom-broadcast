# 作文学习助手设计对照

## 对照对象

- 视觉真值：`/Users/llin/.codex/generated_images/019ef379-6035-76b0-a752-d91436517946/exec-214da3d0-9aa7-4b0d-82cb-d02f686f30e2.png`
- 实现截图：`/Users/llin/Desktop/classroom-broadcast/previews/xiezuo-desktop.png`
- 合并对照：`/Users/llin/Desktop/classroom-broadcast/previews/xiezuo-design-comparison.png`
- 视口：1600 × 1000，未登录的写作工作台状态。

## Findings

- 无 P0、P1 或 P2 问题。
- [P3] 视觉真值中的左下角静物和右栏书本插画未加入。
  - 位置：侧栏底部、写作小贴士卡片。
  - 证据：对照图左侧包含两处装饰插画，当前实现以留白和文字卡片呈现。
  - 影响：不影响信息层级、工作台操作或访客转登录流程。
  - 后续：如需要更强的插画感，应单独生成与米黄色纸张风格一致的资产，而不是裁切预览图。

## Required Fidelity Surfaces

- 字体与排版：宋体标题、无衬线功能文字、字号层级和紧凑的工作台密度与视觉真值一致。
- 间距与布局节奏：已实现左侧工具栏、中央纸张编辑区、右侧指导栏的三栏结构；中间内容区保留主要写作空间。
- 颜色与视觉令牌：米黄色背景、暖白纸张、深棕文字、橄榄绿激活状态和赭石色操作点均已映射。
- 图像与图标：操作图标使用同一套 Font Awesome 图标库；不使用裁切预览图或 CSS 伪插画替代装饰资产。
- 文案与内容：保留学生可理解的写作提示、隐私提示、7 天体验和学期卡/年卡流程。
- 交互与可访问性：工具切换、登录/注册弹窗、生成、拍照识别、续费入口、关闭弹窗和移动端滚动工具栏均有对应真实操作；输入框有可访问名称。

## Patches Made Since Previous QA Pass

- 将登录前首页改为可直接填写的写作工作台。
- 将生成、OCR、续费设为首次动作后再打开登录；登录成功后继续原动作。
- 接入原有学习会员、支付、OCR、生成接口，未改服务端。

## Follow-up Polish

- 如继续迭代，可补一组纸张质感的静物插画资产。

final result: passed

---

# 教室广播与班级积分整合设计对照（2026-07-14）

## 验收范围

- 教师端：班级开关、学生与座位、加扣分规则、学期、快捷登记、积分榜和完整流水。
- 教室端：安静日常页、加扣分、积分榜、今日流水与筛选。
- 数据与容错：不可变审计流水、冲正撤销、离线队列、幂等重试、历史班级归档。
- 计费边界：包含在教室广播订阅中，不消耗师行 AI 积分。

## Findings

- 无 P0、P1 或 P2 问题。
- 考试成绩导入与数据分析已按产品范围留到第二阶段，不影响本轮日常加扣分闭环。

## Interaction Evidence

- 未开启班级管理的班级仍是纯广播界面，不出现座位、学生或榜单。
- 开启后日常页仅显示小型操作入口；加扣分、榜单和流水 60 秒无操作会自动返回。
- 广播可从积分页面抢占显示，结束后恢复原模式和计时；同时立即停止积分提示音。
- 已验证教室端离线登记、页面重载保留、联网后按原幂等键自动补传，不会重复计分。
- 流水可按学生和加分/扣分方向筛选；撤销以反向流水留痕，不覆盖原记录。
- 有学生、学期或积分历史的班级删除时自动归档，重启后不再出现于活动班级，但积分流水仍完整保留。
- 1280×720 教室流水页无水平溢出，桌面与 1024×768 教室加扣分页均已检查。

## Visual Evidence

- `previews/classroom-points-2026-07-14/01-broadcast-only-idle.png`
- `previews/classroom-points-2026-07-14/02-management-idle.png`
- `previews/classroom-points-2026-07-14/03-score-mode.png`
- `previews/classroom-points-2026-07-14/04-teacher-points.png`
- `previews/classroom-points-2026-07-14/05-ledger-filters.png`
- `previews/classroom-points-2026-07-14/score-1024x768.png`
- `previews/classroom-points-2026-07-14/score-1920x1080.png`

## Automated Verification

- JavaScript 语法检查通过。
- 全平台 143 项自动化测试全部通过，0 失败。
- `git diff --check` 通过。

final result: passed

---

# 数学教师工作台设计验收

## 验收对象

- 桌面工作台：`/Users/llin/Desktop/classroom-broadcast/previews/edulab-teacher-platform-2026-07-13/01-dashboard-desktop.png`
- 桌面生成页：`/Users/llin/Desktop/classroom-broadcast/previews/edulab-teacher-platform-2026-07-13/02-generator-desktop.png`
- 延迟登录：`/Users/llin/Desktop/classroom-broadcast/previews/edulab-teacher-platform-2026-07-13/03-auth-gate-desktop.png`
- 课件库：`/Users/llin/Desktop/classroom-broadcast/previews/edulab-teacher-platform-2026-07-13/04-library-desktop.png`
- 知识点页：`/Users/llin/Desktop/classroom-broadcast/previews/edulab-teacher-platform-2026-07-13/05-knowledge-desktop.png`
- 手机工作台：`/Users/llin/Desktop/classroom-broadcast/previews/edulab-teacher-platform-2026-07-13/06-dashboard-mobile.png`
- 手机生成页：`/Users/llin/Desktop/classroom-broadcast/previews/edulab-teacher-platform-2026-07-13/07-generator-mobile.png`
- 视口：桌面 1440 × 1024，手机 390 × 844；均为未登录真实访客状态。

## Findings

- 无 P0、P1 或 P2 问题。
- [P3] 独立的函数、几何和三维编辑器仍集中在“互动实验室”，暂未拆成多个单独工具。
  - 影响：不阻塞教师从拍题、核对、生成、管理课件到沉淀知识点的主流程。
  - 后续：待真实使用数据表明某类工具高频后，再拆分专用编辑器，避免本轮堆功能。

## Required Fidelity Surfaces

- 信息架构：深色教师侧栏、工作台、拍题生成、互动实验室、课件库、知识点和账户形成完整教师平台。
- 视觉密度：桌面使用双栏生成工作区和高密度数据卡片；手机端切换为单栏与底部导航。
- 颜色与排版：沿用师行米黄色、暖白纸张、墨棕和赭金令牌，标题与功能文字层级清晰。
- 真实数据：积分、课件数、收藏、月度生成、历史记录和充值均读取现有接口；未登录时显示空状态，不伪造统计。
- 生成链路：展示识别题目、深度解答、独立验算、制作课件四阶段，并保留题目核对和教师偏好设置。

## Interaction Evidence

- 已验证访客可完整查看和填写生成表单；点击生成时才弹出登录框。
- 登录弹框出现时加载动画未启动，也没有发出 `/edulab-api/generate` 请求。
- 已验证课件库、知识点页和手机底部导航切换。
- 桌面与手机 `scrollWidth` 均未超过 `innerWidth`，没有页面级横向溢出。
- 已验证 401 与 402 返回会主动清除生成加载状态。

## Patches Made During QA

- 修复 OCR 会话失效后生成面板仍显示加载状态的问题。
- 修复生成接口会话失效或积分不足后加载状态未复位的问题。

final result: passed

---

# 互动数学实验室设计对照

## 对照对象

- 视觉真值：`/Users/llin/.codex/generated_images/019ef8ee-115e-7ce1-bc10-c26e2049a2ef/exec-2641e2b7-237a-498a-9fa4-197d3d9fdbbe.png`
- 桌面实现截图：`/Users/llin/Desktop/classroom-broadcast/previews/edulab-interactive-lab-2026-07-13/04-desktop-full-page.png`
- 移动端实现截图：`/Users/llin/Desktop/classroom-broadcast/previews/edulab-interactive-lab-2026-07-13/02-mobile.png`
- 桌面复核视口：1280 × 720，完整页面高度 986；默认 3 个函数、参数 `a = 1`。
- 全页面证据：视觉真值和桌面实现已在同一次原始分辨率图像检查中并列审阅；浏览器安全策略不允许用 `data:` 页面另制拼图，因此保留两张原始截图作为可追溯证据。

## Findings

- 无 P0、P1 或 P2 问题。
- [P3] 当前画布采用轻量 Canvas 绘制，未复刻视觉稿中的交点浮层标签和公式排版工具条。
  - 位置：中央函数画布、左侧函数卡片。
  - 证据：当前已显示坐标轴、网格、函数曲线、零点和曲线标识，但没有常驻的坐标气泡。
  - 影响：不影响函数录入、参数联动、缩放拖动、保存、分享或课件生成主流程。
  - 后续：可在下一轮增加悬停坐标、极值与交点自动标注。

## Required Fidelity Surfaces

- 字体与排版：标题使用宋体，功能文字使用无衬线字体；层级、密度和视觉目标一致。
- 间距与布局节奏：已实现深色侧栏、函数编辑器、中央画布、课堂步骤和最近实验的完整桌面布局。
- 颜色与视觉令牌：米黄色纸张底、暖白卡片、墨棕侧栏、赭金主按钮、蓝红深蓝函数色均已映射。
- 图像与图标：使用统一 Font Awesome 线性图标，不裁切或拼贴视觉稿。
- 文案与内容：保留“把抽象关系拖出来、画出来、讲明白”的产品定位及 75 积分生成入口。
- 交互与可访问性：函数增删显隐、模板切换、参数联动、平移缩放、全屏、保存、分享、生成和移动端导航均可操作。

## Interaction Evidence

- 已验证参数滑块从 1 调整到 2 后曲线即时重绘。
- 已验证“指数函数”模板和 `exp(a*x)` 表达式解析与绘制。
- 已验证“生成讲解课件”进入现有 `pro.html?from=lab#appCard` 流程，且统一数学导航存在。
- 已检查桌面端和移动端页面宽度，无页面级横向溢出。
- 已检查浏览器控制台，无 error 或 warning。

## Patches Made During QA

- 将移动端函数卡片改为横向滑动条，让函数图像在首屏即可看到。
- 重新建立独立桌面视口并完整截屏，排除从手机尺寸切换后产生的预览画布残留。
- 等待图标字体加载完成后再截图，避免冷启动截图中图标短暂缺失。
- 首次进入自动显示“会动的函数黑板”三步引导，并提供一键载入二次函数示例。
- 普通滚轮恢复为页面滚动，仅在按住 Ctrl/⌘ 时缩放图像，避免画布劫持页面滚动。
- “生成讲解课件”现在会把当前函数与参数带入拍题生成页，不再跳回空白工作台。

## Follow-up Polish

- 后续可增加交点、极值和切线的自动标注，但不作为本轮上线阻塞项。

final result: passed
