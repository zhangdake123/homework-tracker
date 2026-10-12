# 班主任作业追踪（MVP）

小学班主任用的练习册作业追踪工具：持续追踪「每个学生 × 每一项作业」的完成情况，让遗留任务（未收到 / 待订正 / 待交回 / 待批改）始终留在待办看板上，避免漏批。

只做一件事：**减少记录和统计的时间，保证任务不丢失**。不做班级管理、AI、语音、成绩分析、家长通知。

---

## 一、技术栈（零依赖，可直接运行）

| 层 | 选择 | 说明 |
| --- | --- | --- |
| 后端 | Node.js 内置 `node:http` | 无第三方依赖，不需要 `npm install` |
| 数据库 | Node.js 内置 `node:sqlite`（SQLite 文件库） | 数据存在服务器文件里，手机和电脑共享同一份数据 |
| 前端 | 原生 HTML / CSS / JavaScript（响应式） | 手机竖屏优先，电脑端双列看板 |
| 同步 | Server-Sent Events（SSE）+ 15 秒轮询兜底 | 手机改完，电脑端几秒内自动刷新 |

同一份代码支持两种跑法（业务规则完全一致，都通过 `npm test` 验证）：

| 跑法 | 需要什么 | 数据存在哪 | 说明 |
| --- | --- | --- | --- |
| **本机服务器版** | `node server.js` | `data/tracker.db`（SQLite 文件） | 教室电脑或自有云服务器，见第四节方案 A / B |
| **静态托管版** | 只要静态网站托管，**不需要服务器** | 腾讯云开发「文档型数据库」 | 浏览器直连云数据库（匿名登录），见 **[DEPLOY-STATIC.md](DEPLOY-STATIC.md)** |

前提：**Node.js ≥ 22.13**（或 ≥ 23.4；本机实测 v24.15.0）。`node --version` 可以查看。静态托管版只要浏览器，跟 Node 版本无关。

> `node:sqlite` 在 Node 22.5–22.12 里需要加 `--experimental-sqlite` 标志才能用，22.13 起才默认可用；云端部署请锁版本（本仓库已带 `.node-version`，内容为 `24.15.0`）。

### 目录结构

```
server.js                 启动入口（HTTP 服务 + 静态文件 + SSE + 路由分发）
src/db.js                 数据库结构、状态流转规则、历史记录
src/api.js                REST 接口
public/index.html         单页应用结构
public/styles.css         响应式样式
public/app.js             前端逻辑（登记 / 标记 / 看板 / 详情 / 名单 / 同步）
public/store-core.js      业务规则核心（与 src/db.js 等价，静态版共用同一套规则）
public/store-cloudbase.js 静态托管版：浏览器直连腾讯云开发数据库（匿名登录 + 实时推送）
scripts/seed-demo.js      生成演示数据（3 本作业册、3 个课次、38 名虚拟学生）
scripts/build-static-zip.js 生成静态托管上传包（outputs/static-site + zip）
tests/scenarios.test.js   服务器版自动化测试（60 项断言，覆盖全部验收场景）
tests/static-store.test.js 静态版业务规则测试（内存驱动，67 项断言）
tests/cloudbase-driver.test.js 云开发数据库驱动测试（按官方 SDK 行为做假实现，32 项断言）
tests/static-boot.test.js  静态版启动流程测试（假浏览器，20 项断言）
DEPLOY-STATIC.md          静态托管部署指南（不需要服务器的跑法）
render.yaml                Render 蓝图（免费云平台一键部署用，可选）
.node-version              锁定的 Node 版本（云端平台会自动读取）
data/tracker.db           SQLite 数据库文件（首次启动自动创建）
```

---

## 二、如何在本地启动

在项目目录（本目录）打开终端：

```powershell
node server.js
```

启动后终端会打印：

```
 本机（电脑）访问: http://localhost:3000
 手机访问（与电脑同一 Wi-Fi）: http://192.168.x.x:3000
 数据库文件: ...\data\tracker.db
 当前名单人数: 38，任务数: 0
```

换端口：`$env:PORT=3001; node server.js`（PowerShell）。

首次启动会自动建库，并生成 **38 个虚拟学号（01 - 38）**，可以直接测试；也可以先在「名单 / 设置」里改成自己班的人数。

生成演示数据（推荐第一次看效果时执行，**先停止服务再执行**，避免同时写库）：

```powershell
node scripts/seed-demo.js            # 追加演示任务（A册/B册/C册，第3/4/5课）
node scripts/seed-demo.js --reset    # 先清空任务再生成演示数据
```

---

## 三、如何在手机和电脑上访问

> 这一节讲「**本机服务器版**」（电脑当服务器，手机连同一 Wi-Fi）。如果希望**不用电脑常开、不用同一 Wi-Fi**，直接用静态托管版，见第四节**方案 E**（[DEPLOY-STATIC.md](DEPLOY-STATIC.md)）。

1. 电脑（当作服务器）和手机连到**同一个 Wi-Fi**。
2. 电脑上运行 `node server.js`，记下终端打印的“手机访问”地址（形如 `http://192.168.1.23:3000`）。也可以自己查：`ipconfig`，看「IPv4 地址」。
3. 手机浏览器打开这个地址即可。建议“添加到主屏幕”，用起来像 App。
4. 电脑浏览器打开 `http://localhost:3000`，切到「待办看板」并常驻显示。
5. 手机改成某个学生的状态后，电脑端会在几秒内自动更新（顶部“已同步 hh:mm:ss”会变化）。

打不开时的排查：

- Windows 防火墙会拦截第一次监听。首次运行若弹出提示，请勾选「专用网络」并允许。也可以手动放行：
  `New-NetFirewallRule -DisplayName "作业追踪 3000" -Direction Inbound -LocalPort 3000 -Protocol TCP -Action Allow`
- 确认手机和电脑在同一网段（手机不要开流量/VPN）。
- 有些路由器开启了「AP 隔离」，会禁止手机访问电脑，需要在路由器里关闭。

---

## 四、如何部署（两台设备共享同一份数据）

先选路子：**A** 教室电脑常开（最省事，数据最安全）｜**B** 自有云服务器｜**E** 腾讯云静态托管 + 云开发数据库（不用服务器、手机 4G 也能用、数据在云上不会丢）｜**D** Vercel（能跑，但数据会丢，只适合演示）。

如果目标是"**不折腾服务器，手机和电脑随时能用**"，直接用 **方案 E**，完整步骤见 **[DEPLOY-STATIC.md](DEPLOY-STATIC.md)**。

**方案 A：一台电脑常开（最简单，推荐教室使用）**

- 把项目放到教室电脑（或一台常年开机的电脑），开机时运行 `node server.js`，手机连同一 Wi-Fi 访问上面的局域网地址。
- 做成开机自启动（可选）：Win + R 输入 `shell:startup`，放一个快捷方式，目标填
  `powershell -WindowStyle Hidden -Command "cd '项目目录'; node server.js"`。

**方案 B：部署到云服务器（推荐腾讯云；手机在 4G 下也能用，数据存在服务器磁盘上，不会丢）**

项目自带一键部署脚本 `scripts/deploy-linux.sh`，适用于 Ubuntu 22.04+ / Debian 12+，已实测通过。

1. 在腾讯云买一台**轻量应用服务器**（或 CVM），系统选 **Ubuntu 22.04 / 24.04**。
2. 在控制台的**防火墙 / 安全组**里放行你要用的端口（例如 `3000`）。用 `IP:端口` 访问**不需要 ICP 备案**；只有绑域名走 80/443 才需要备案。
3. 用 root 登录服务器，执行：

```bash
curl -fsSL https://raw.githubusercontent.com/zhangdake123/homework-tracker/main/scripts/deploy-linux.sh -o deploy.sh
sudo bash deploy.sh
```

   脚本会自动完成：安装 Node.js 24（22.5–22.12 的 `node:sqlite` 要加 `--experimental-sqlite` 标志，所以脚本统一装 24）→ 拉代码到 `/opt/hw-tracker` → 写 systemd 服务（开机自启、崩溃自动重启）→ 起服务 → 装每天 21:00 的自动备份 → 自检接口。
   如果服务器拉 GitHub 慢，可以先把本项目目录传到服务器，再执行 `sudo bash scripts/deploy-linux.sh`（脚本会自动识别本地代码并复制过去）。
4. 脚本结束会打印 `http://<公网IP>:3000`，手机和电脑都打开它即可，共用同一份数据。
5. 要换端口：改 `/etc/systemd/system/hw-tracker.service` 里的 `Environment=PORT=`，然后 `systemctl daemon-reload && systemctl restart hw-tracker`。
6. 想用域名 + HTTPS：在 3 的基础上加 Nginx/Caddy 反向代理（**SSE 需要 `proxy_buffering off;`**；另外 `app.js` 有 15 秒轮询兜底，SSE 被切断也能同步）。需要账号保护时在反向代理层加 Basic Auth（本 MVP 不含登录模块）。

常用运维命令：

```bash
journalctl -u hw-tracker -f                                    # 实时日志
systemctl restart hw-tracker                                   # 重启服务
cd /opt/hw-tracker && git pull && systemctl restart hw-tracker  # 更新到最新代码
bash scripts/backup-db.sh                                      # 手动备份一次
```

**自动备份**：脚本会写入 `/etc/cron.d/hw-tracker-backup`，每天 21:00 用 SQLite 的 `VACUUM INTO` 热备一份到 `/opt/hw-tracker/data/backups/`，自动保留最近 14 份。恢复方式：停服务后把备份文件复制成 `data/tracker.db`，再启动服务。

**方案 C：已有服务器/内网穿透**：把 `node server.js` 挂在你熟悉的方式（pm2、screen、Docker）后面即可，唯一要求是手机和电脑都能访问同一个地址。

**方案 E：腾讯云静态托管 + 云开发数据库（不需要服务器，已实现，完整步骤见 [DEPLOY-STATIC.md](DEPLOY-STATIC.md)）**

思路：网页是纯静态文件（放「静态网站托管」），数据放云开发「文档型数据库」，浏览器用官方 Web SDK 直连。

1. 云开发控制台做 3 件事：开启**匿名登录** → 建 4 个集合（`ht_students` / `ht_tasks` / `ht_history` / `ht_settings`）权限设为「所有用户可读写」→ 确认网站域名在**安全来源**里（静态托管默认域名默认就在）。
2. `npm run build:static` 生成上传文件。
3. 静态网站托管 → 文件管理 → 上传 `outputs/static-site/` 里的 5 个文件（**不要带着外层文件夹上传**，否则根路径 404）。
4. 打开网址 → 「名单 / 设置」→ 填云开发环境 ID → 连接。手机、电脑各填一次即可（也可以下载 `cloudbase-config.js` 传到网站根目录，之后所有设备都不用再填）。

注意：默认域名 `*.tcloudbaseapp.com` 会先显示平台「访问提示中间页」，点「确定访问」即可；要彻底去掉需要绑定已备案的自定义域名。

**方案 D：部署到 Vercel（本项目已实测部署成功，免费、支持 GitHub 登录）**

线上地址：**`https://homework-tracker-c-s3.vercel.app`**（Vercel 项目名 `homework-tracker`，团队 `c-s3`）。

> ⚠️ 注意：不带后缀的 `homework-tracker.vercel.app` 属于**别人的 Vercel 账号**（打开会是一个无关的 React 页面），不要用那个地址。

1. 仓库里的 `vercel.json` 把 `server.js` 声明为 Node 服务入口 —— 不写就会报 `must specify an "entrypoint" for runtime "node"`：

```json
{
  "services": {
    "homework-tracker": {
      "root": ".",
      "entrypoint": "server.js",
      "buildCommand": "npm install"
    }
  },
  "rewrites": [{ "source": "/(.*)", "destination": { "type": "service", "service": "homework-tracker" } }]
}
```

2. 环境变量（**必须**）：`NODE_VERSION=24`、`DB_PATH=/tmp/tracker.db`。Vercel 函数文件系统只读，只有 `/tmp` 可写；不设 `DB_PATH` 会在启动时报 `EROFS: read-only file system`。
3. 部署：`vercel link --yes` → `vercel env add DB_PATH production` → `vercel deploy --prod`；或在 Vercel 网站 Import Git Repository，之后 `git push` 自动部署。
4. 打开 `https://<项目名>.vercel.app`，手机和电脑共用同一份数据；SSE（`/api/events`）实测能正常建立连接，另有 15 秒轮询兜底。

5. **必须关闭部署保护**，否则域名会返回 Vercel 登录页（手机没登录 Vercel 就打不开）：`vercel project protection disable homework-tracker --sso`。本项目已执行该项。

6. 本项目实测可用的生产域名（三个都指向同一个部署）：`https://homework-tracker-c-s3.vercel.app`（推荐，最短）、`https://mvp-ai-1-a-b-c-2.vercel.app`、`https://homework-tracker-git-main-c-s3.vercel.app`。

⚠️ **致命限制（已实测，务必看）**：Vercel 函数的 `/tmp` 是**临时的，且不跨实例共享**。实测：往 GitHub 推一次代码触发重新部署后，刚创建的作业任务和 40 条状态历史**全部消失**（`tasks=0`、`history=0`，只有学号名单会被重新生成）。因此：

- **Vercel 免费版只能当演示/预览**，不要录入真实作业记录；
- 要长期使用，必须把数据库换成外部持久存储（如 Turso 的 serverless SQLite、Neon 的 Postgres），这需要把 `src/db.js` 改成异步访问（代码改造，不是改配置），或改用方案 A / B。

---

## 五、数据保存在哪里、如何备份

- 数据库文件：`data/tracker.db`（同目录的 `tracker.db-wal`、`tracker.db-shm` 是 SQLite 的日志文件）。
- 通过环境变量换位置：`$env:DB_PATH="D:\hwdata\tracker.db"; node server.js`。
- 备份（**先停止服务**，把三个文件一起复制即可）：

```powershell
Stop-Process -Name node -ErrorAction SilentlyContinue   # 或 Ctrl+C 停止服务
Copy-Item .\data\tracker.db* "D:\backup\hw-$(Get-Date -Format yyyyMMdd-HHmm)\" -Force
```

- 恢复：把备份文件复制回 `data/` 覆盖，再启动服务。
- 也可以用 SQLite 在线备份：`node -e "const{DatabaseSync}=require('node:sqlite');new DatabaseSync('data/tracker.db').exec(\"VACUUM INTO 'data/backup.db'\")"`。
- 部署在服务器上时（方案 B）：脚本已装好每天 21:00 的自动备份，文件在 `/opt/hw-tracker/data/backups/`，也可随时手动执行 `bash scripts/backup-db.sh`。
- 数据全部在服务器上，**不在浏览器 localStorage 里**；手机和电脑只是显示同一份数据，清空浏览器缓存不会丢数据。
- ⚠️ **免费云平台的磁盘是临时的**：实例重启或重新部署会清空 `data/`，所以免费平台只适合试用。要长期保存，请挂持久盘（并设置 `DB_PATH`）、换成自有服务器（方案 B），或直接用教室电脑（方案 A）+ 定期备份。

**静态托管版（方案 E）的数据在哪、怎么备份：**

- 数据存在**腾讯云开发「文档型数据库」**的 4 个集合里：`ht_students`（名单）、`ht_tasks`（任务，每个学生的状态内嵌在任务文档里，一条记录 = 学生 + 这一项作业）、`ht_history`（状态变化历史）、`ht_settings`（班级人数等）。
- 数据在云上，手机和电脑只是显示同一份；清空浏览器缓存不会丢数据（只是环境 ID 要重填一次）。
- 备份：网页 → 「名单 / 设置」→「导出数据备份（JSON）」，会下载一份含名单、任务、历史的完整 JSON，自己存好即可。
- 恢复：静态托管版**暂无一键导入**（见第七节），需要恢复时可在云开发控制台按 JSON 手工重建，或回到本机服务器版用 SQLite 备份恢复。
- ⚠️ 云开发**免费额度**有读/写次数与存储上限。一个班（几十名学生、每天几十次操作）通常远低于免费额度，但建议偶尔在控制台看一眼用量。

---

## 六、状态与业务规则

| 状态 | 含义 | 谁来处理 |
| --- | --- | --- |
| 未收到 | 一开始就没有收到这份作业（不记录原因） | 学生补交 |
| 待订正 | 已批改，需要学生订正 | 学生订正后交回 |
| 待交回 | 退回后学生还没有交回来（含反复退回） | 学生交回 |
| 待批改 | 已经交回，等待老师检查 | 老师 |
| 已完成 | 老师确认通过 | — |

规则实现要点：

- **规则 1**：每条记录 = 学生 + 作业任务 + 当前状态（数据库唯一约束 `assignments(task_id, student_id)`），不是按“整本册”或“整批学生”记录。
- **规则 2**：反复订正不丢。实测链路：待批改 →（退回）待订正 →（交回）待批改 →（再次退回）待交回，任务一直留在看板，直到老师确认通过。
- 退回时系统自动判断：该生这条记录**第一次**被退回 → 待订正；**已经被退回/订正过**再退回 → 待交回。也可以手动指定任意状态。
- **规则 3**：未收到 与 待交回 是两个独立状态，一起显示在看板上，后续动作不同（未收到→等第一次交；待交回→等交回来）。
- **规则 4**：没有任何自动完成逻辑。开启新课次、日期变化、学生交了新作业，都不会把旧任务标记为完成；只有老师点「检查通过 / 标记为已完成」才会关闭。
- **规则 5**：每次状态变化都写入 `history` 表（原状态、新状态、时间、来源），任务详情里可查看，`/api/tasks/:id/history`、`/api/students/:id/history` 可查。
- **规则 6**：不做推送和语音。电脑端只需常驻打开看板，遗留任务会一直显示“已持续 N 天未完成”。

页面与交互：

- 登记页：填 作业册 / 课次 / 作业内容 / 创建日期（默认当天）→ 标题自动组合为「A册·第3课·抄写作业」→ 一键生成全班学号。
  - 作业册 / 课次 / 作业内容 **都是自由输入**（没有预设按钮），你以前输入过的名称会自动变成下拉建议，点一下就能复用。
  - 创建日期默认当天；选好“全班初始状态”后点“创建任务”，自动生成全班学号。
  - 多选学号（可「全选」「清空」），再点状态按钮批量标记；也可开「印章模式」点一下就改一个人。
  - 一键「其余未批改的学生 → 待订正」，对应“其余学生进入待订正”的流程。
- 看板（电脑端主力页）：按作业册分组，遗留越久的越靠前；每张卡片显示标题、创建日期、**已持续 N 天未完成**、各状态人数、每个未完成学生的学号与状态；点学号直接改状态；支持按作业册 / 课次 / 状态筛选，可切换“显示已完成任务 / 显示已归档”。
- 详情页：逐条追踪全班状态，支持勾选批量修改、单条快捷操作（检查通过 / 已交回 / 退回订正 / 未收到）、查看状态历史、归档、删除。
- 每次批量或单条修改后，屏幕下方会弹出提示条并提供「撤销」，撤销同样会写入历史。

---

## 七、已实现 / 未实现

已实现：

- 作业任务创建（作业册、课次、内容全部自由输入 + 历史输入下拉建议，标题自动组合）、全班学号自动生成、班级人数可修改（1-120）。
- 五种状态的全部流转、批量与单条修改、印章模式、一键「其余→待订正」、撤销、归档/恢复/删除。
- 电脑端待办看板（分组、筛选、持续天数、遗留优先）、任务详情、逐生历史记录。
- 手机 / 电脑实时同步（SSE + 轮询兜底）、数据持久化（SQLite）、服务重启后数据保留。
- 响应式适配手机与电脑、按状态颜色区分 + 文字标签（不依赖颜色）。
- **静态托管版**：同一套页面可直接放到静态网站托管，浏览器用腾讯云开发 Web SDK 直连云数据库（匿名登录 + 实时推送），**不需要任何服务器**；页面内可填环境 ID 连接、切换回本机服务器、导出数据备份、下载 `cloudbase-config.js` 让所有设备免手填。
- 演示数据脚本、自动化测试（4 套共 **179 项**断言，详见第八节）。

未实现（按需求刻意不做）：

- 登录/权限、多班级、多老师（部署时可用反向代理 Basic Auth 兜底）。
- 家长通知、消息推送、语音播报、AI 提醒、成绩分析。
- 真实学生信息导入（Excel/CSV 导入）、姓名批量编辑（目前可逐个填写姓名）。
- 状态变化时间线的高级统计报表（数据都在 `history` 表里，将来可以加）。
- 离线可用（PWA 缓存）：断网时页面无法打开。
- Vercel 上的“服务器版”：函数文件系统只读 + 临时 `/tmp`，**重启/重新部署数据必丢**（已实测），只适合演示。要长期云端使用，推荐方案 E（静态托管 + 云开发数据库），或方案 B 自有服务器。
- 静态托管版的**一键导入备份**（可导出 JSON，导入未实现）。
- 静态托管版的账号级权限隔离：目前用匿名登录 + 集合级读写权限，靠网址不外传做基本保护，没有按老师 / 班级隔离的数据。
- 静态托管版**未做真机浏览器实测**（本机浏览器自动化授权被拒 + 手头没有云开发账号）：业务规则与启动流程已用测试覆盖，云端实际表现请按 [DEPLOY-STATIC.md](DEPLOY-STATIC.md) 自己跑一遍确认。
- 云端一键导出/导入整库备份（本地可用第五节的文件复制或 `VACUUM INTO`）。

---

## 八、测试结果

```powershell
npm test          # 一次跑完全部 4 套
```

| 测试套件 | 命令 | 断言 | 实测结果 |
| --- | --- | --- | --- |
| 服务器版（SQLite）业务场景 | `npm run test:server` | 60 | 通过 60，失败 0 |
| 静态版业务规则（内存驱动） | `npm run test:static` | 67 | 通过 67，失败 0 |
| 云开发数据库驱动 | `npm run test:cloudbase` | 32 | 通过 32，失败 0 |
| 静态版启动流程（假浏览器） | `npm run test:boot` | 20 | 通过 20，失败 0 |

合计 **179 项断言，全部通过**。服务器版用临时数据库真实启动 HTTP 服务跑 16 组场景；静态版用内存驱动跑同一套业务规则，并用两个 store 实例模拟“手机改、电脑看”；云开发驱动与启动流程用按官方 SDK 行为写的假实现验证。

下面这组验收场景，**服务器版和静态版跑的是同一套规则**：

| 验收场景 | 结果 |
| --- | --- |
| 第一次批改后，全对学生被排除在待办之外 | 通过（3 人已完成，未完成 35 人，不在待办列表） |
| 未收到作业的学生可以单独追踪 | 通过（07 号为未收到，仍在未完成列表，可按状态筛选命中） |
| 学生反复订正、反复被退回，任务始终不会丢失 | 通过（待批改→待订正→待批改→待交回，历史完整） |
| 学生跨天未交，第二天仍显示原课次任务 | 通过（任务日期为 3 天前，持续天数为 3，重开网页仍在） |
| 新课次开始后，旧课次遗留任务依然存在 | 通过（第3课与第4课并存，旧任务未被覆盖，未自动完成） |
| 交回后状态可从「未收到」或「待交回」更新为「待批改」 | 通过（单条更新与批量更新均验证） |
| 老师确认通过后，任务才进入已完成状态 | 通过（只有显式确认才 done，其他学生不受影响） |
| 手机修改后，电脑端能看到最新状态 | 通过（SSE 收到 change 推送，随后读取到最新状态） |
| 关闭网页再打开后，数据仍然保留 | 通过（杀掉进程重启服务，名单/任务/状态/历史完全一致） |
| 批量操作不会错误地修改其他课次的任务 | 通过（只改目标课次，其他任务计数完全不变） |
| 已完成任务从默认看板隐藏但历史可查 | 通过 |
| 归档不会自动完成学生作业 | 通过（归档后各状态计数不变） |
| 撤销误操作 | 通过（恢复原状态并写入历史） |
| 班级人数修改与按学生查询历史 | 通过 |

---

## 九、接口一览（便于将来扩展）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/bootstrap` | 首屏数据：设置、名单、全部任务（含未完成学生明细） |
| GET | `/api/tasks?book=&lesson=&status=&includeDone=1&includeArchived=1` | 待办看板数据，支持筛选 |
| POST | `/api/tasks` | 创建任务并生成全班学生记录 `{book, lesson, content, taskDate, initialStatus}` |
| GET/PATCH/DELETE | `/api/tasks/:id` | 任务详情 / 修改（含 `status: open|closed` 归档）/ 删除 |
| POST | `/api/tasks/:id/bulk` | 批量改状态 `{scope: selected|all|pending|done|<状态>, studentIds, status, action:'return'}` |
| PATCH | `/api/assignments/:id` | 单条改状态 `{status, note}` |
| POST | `/api/assignments/restore` | 撤销 `{items:[{assignmentId, status}]}` |
| GET | `/api/tasks/:id/history`、`/api/students/:id/history`、`/api/history` | 状态变化历史 |
| GET/POST/PATCH | `/api/students` | 名单查询 / 新增 / 修改（姓名、启停用） |
| POST | `/api/settings/class-size` | 修改班级人数并补齐学号 |
| POST | `/api/admin/reset` | 清空数据（需 `confirm: "RESET"`） |
| GET | `/api/events` | SSE 实时同步推送 |

### 数据库表

- `students(id, student_no, name, active, created_at)`
- `tasks(id, book, lesson, content, title, task_date, status, created_at, closed_at)`
- `assignments(id, task_id, student_id, status, updated_at)` — 唯一键 `(task_id, student_id)`，即“每个学生每项作业一条记录”
- `history(id, assignment_id, task_id, student_id, from_status, to_status, note, changed_at, source)`
- `settings(key, value)` — 班级人数等

---

## 十、常见问题

- **端口被占用**：`$env:PORT=3001; node server.js`。
- **手机打不开**：先确认是同一 Wi-Fi、防火墙已放行、地址用的是电脑的局域网 IP 而不是 `localhost`（`localhost` 在手机上指手机自己）。
- **电脑重启后要重新运行**：按“方案 A”做开机自启，或部署到云服务器。
- **想换到别的电脑**：复制整个项目目录（含 `data/`）即可，数据跟着走。
- **误操作**：屏幕提示条上的「撤销」，或在任务详情里手动改回；所有变化都有历史记录可追溯。
- **部署到免费平台后数据没了**：免费实例磁盘是临时的，重启即清空。处理方式见第四节方案 D 和第五节。
- **云端启动报 `ERR_UNKNOWN_BUILTIN_MODULE: node:sqlite`**：Node 版本低于 22.13，升到 22.13+/23.4+ 即可（本仓库 `.node-version` 已写 24.15.0）。
- **云端线上地址打不开 / 首次访问很慢**：免费实例休眠后需要冷启动，等 30–60 秒再刷新。
- **静态托管上传后打开是 404**：多半是把外层文件夹一起传上去了。解压 `outputs/homework-tracker-static.zip` 后的 5 个文件（`index.html`、`styles.css`、`app.js`、`store-core.js`、`store-cloudbase.js`）必须放在网站**根目录**，根路径要有 `index.html`。
- **静态托管版打开后提示“未连接云开发”**：正常。第一次要在「名单 / 设置」填云开发环境 ID 并点连接（手机、电脑各填一次；或把页面下载的 `cloudbase-config.js` 传到网站根目录，之后所有设备自动连接）。
- **连接报“匿名登录未开启”**：云开发控制台 → 环境 → 登录授权，开启**匿名登录**。
- **连接报集合不存在 / 权限不足**：建好 4 个集合 `ht_students` / `ht_tasks` / `ht_history` / `ht_settings`，安全规则设为 `{"read": true, "write": true}`。
- **连接报安全来源 / CORS**：把当前网站域名加进云开发「安全来源」白名单（静态托管默认域名 `*.tcloudbaseapp.com` 默认已包含）。
- **静态托管默认域名先出现一个中间提示页**：平台加的访问提示页，点「确定访问」即可；要去掉需绑定已备案的自定义域名。