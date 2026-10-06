# 影视场景连戏与道具接续核对台（gbcontinuity）

面向剧组场记与服装道具部门的本地化核对工具：把剧本场次拆成连戏要素清单，按拍摄日逐条记录现场服装、道具、妆发与陈设的实际状态，自动比对同一场景在不同拍摄日之间的差异，提示冲突并跟踪解决，最后生成连戏核对报告。

核心动作：**建场次与拍摄顺序 → 登记连戏要素 → 录现场状态与镜次 → 比对差异 → 消解冲突并导出报告**。

纯前端单页应用（Vue 3 + TypeScript + Element Plus + Vite + Pinia + Vue Router + Dexie），**无后端、无数据库服务、无 API 服务**，全部数据保存在浏览器本地（IndexedDB），刷新或重启浏览器后仍然存在。

---

## 一、Docker 一键启动（推荐）

```bash
# 1. 首次启动先复制环境变量模板
cp .env.example .env

# 2. 构建并启动
docker compose up -d --build
```

启动完成后访问：**http://localhost:22829**

常用命令：

```bash
docker compose ps                 # 查看服务状态（healthy 表示就绪）
docker compose logs -f frontend   # 查看 nginx 日志
docker compose down               # 停止并移除容器
docker compose up -d --build      # 代码改动后重新构建
```

> 端口可在 `.env` 中通过 `FRONTEND_PORT` 修改；容器名固定为 `${COMPOSE_PROJECT_NAME:-gbcontinuity}-frontend`。
> 容器无状态：不连接数据库、不挂载命名卷，数据全部在浏览器本地，迁移设备请使用应用内「导出整库备份 / 导入备份」。

---

## 二、技术栈

| 分类 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | Vue 3（`<script setup>` + Composition API） | 全部页面与组件使用组合式 API |
| 语言 | TypeScript（`strict: true`，无 `any`） | `npm run build` 内含 `vue-tsc --noEmit` 类型检查 |
| UI 组件库 | Element Plus 2.x（含 `@element-plus/icons-vue`） | 表格、卡片、对话框、表单、下拉菜单交互 |
| 构建工具 | Vite 6 | 开发服务器端口 22829 |
| 状态管理 | Pinia（setup store） | `sceneStore` / `elementStore` / `ledgerStore`（共同账）/ `recordStore` / `conflictStore` |
| 路由 | Vue Router 4（history 模式） | nginx 侧配合 `try_files` 做 SPA fallback |
| 本地存储 | Dexie 4（IndexedDB 封装） | 库名 `gbcontinuity-db`，含结构版本号与 upgrade 迁移 |
| 容器化 | Docker 多阶段构建：`node:20-alpine` → `nginx:alpine` | 构建阶段执行类型检查与打包，运行阶段仅托管静态产物 |

---

## 三、本地开发方式

```bash
cd frontend
npm install
npm run dev        # 开发服务器 http://localhost:22829
npm run build      # 类型检查 + 生产构建，产物在 frontend/dist
npm run preview    # 本地预览构建产物（http://localhost:22829）
```

---

## 四、页面与路由

| 路由 | 模块 | 消费模型 | 主要交互 |
| --- | --- | --- | --- |
| `/scenes` | 剧本场次与拍摄顺序台账 | Scene、Conflict | 新建/编辑/**撤下/恢复**、拖拽调序并自动重编号、按内外景与日/夜筛选、卡片回显要素数与现行未解决冲突数、筛选同步 URL query |
| `/elements` | 连戏要素登记 | Element、Scene | 按场次与类别分组、维护**连戏编号**与责任人、关键要素标记、**停用/启用道具**、增删改 |
| `/ledger` | **连戏共同账本** | ContinuityLedger、LedgerHistory、LedgerDraft、Quarantine | **一个编号挂多场、只认一份当前基准（乐观锁版本）**、并发提交落后方保留表格草稿并列出双方不同字段、撤下/停用/记录更新后一键重算、缺编号旧档隔离确认、全量变更历史 |
| `/shootdays` | 现场状态记录 | ShootDay、Record、Element | 建立拍摄日并勾选当日场次、按镜次逐条录入当前状态与照片说明、按编号归账、同编号保留历次快照、差异待重算角标 |
| `/conflicts` | 连戏差异比对与冲突提示 | Conflict、Record、ContinuityLedger | **全量重算（刷新/自动关闭待重算条目并留痕）**、按编号并排展示记录 A / 记录 B、严重程度与解决状态流转、解决后回写共同账基准并留痕 |
| `/report` | 连戏核对报告与结构版本导出 | 全部模型 | 场次核对小结（**待重算不计风险**）、风险分统计、本地库版本查看、报告 / 整库 JSON 导出与导入（旧版备份自动补账） |

---

## 五、目录结构

```
sologsb101-1029/
├── README.md
├── docker-compose.yml
├── .env / .env.example
├── .gitignore
└── frontend/
    ├── Dockerfile              # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf              # try_files SPA fallback + gzip
    ├── .dockerignore
    ├── index.html / vite.config.ts / tsconfig.json / package.json
    ├── public/favicon.svg
    └── src/
        ├── main.ts  App.vue  env.d.ts
        ├── types/              # scene.ts element.ts shootDay.ts record.ts conflict.ts filter.ts
        ├── stores/             # sceneStore elementStore recordStore conflictStore
        ├── components/common/  # ConflictTag.vue FilterBar.vue StatBadge.vue EmptyPanel.vue
        ├── hooks/              # useContinuityDiff.ts useIdbTable.ts
        ├── utils/              # diff.ts db.ts export.ts seed.ts uuid.ts query.ts
        ├── pages/              # SceneList ElementRegistry ShootDayLog ConflictBoard ReportExport
        ├── styles/main.css
        └── router/index.ts
```

---

## 六、数据存储说明

- **IndexedDB 库名**：`gbcontinuity-db`，结构版本 `version(2)`，并带 `upgrade()` 迁移逻辑。v1 旧库打开时自动升级：重复档案按连戏编号（同名同类即同一编号）归并成一份共同账，缺编号的档案整份快照进隔离区待确认，历史不丢。
- **共同账模型（9 张表）**：在原 `scenes` 场次、`elements` 连戏要素、`shootDays` 拍摄日、`records` 现场记录、`conflicts` 连戏差异之上，新增 `ledgers` 连戏共同账、`ledgerHistory` 变更历史、`ledgerDrafts` 并发草稿、`quarantine` 隔离区。每行带 `revision` / `createdAt` / `updatedAt`。
- **一个编号一份基准**：一个连戏编号可挂多个场次，基准（`baseline`）只存在共同账上；场次侧要素跟随同步。共同账带乐观锁 `version`，两个标签页同时提交同一编号时各自按读到的版本落地，**落后一方不覆盖主账**，表格草稿（含双方不同字段）保留在 `ledgerDrafts`，可人工合并覆盖或放弃。
- **待重算联动**：撤下场次（`withdrawn`，不物理删除）、停用道具、现场记录更新后，涉及差异立即置 `stale = 待重算`，报告风险只统计「现行」差异；差异页一键重算时刷新或自动关闭待重算条目并留痕，已处理/历史条目不删除。
- **失败恢复**：共同账写入在单个读写事务内完成，失败整体回滚；同时保存提交前账面快照（主账 + 场次侧要素 + 相关差异），异常后据此恢复到提交前状态。
- **首屏自动播种**：`utils/db.ts` 的 `initDatabase()` 在 `scenes` 表为空时调用 `seedDatabase()`，灌入互相引用的演示数据（含跨两场共用编号的共同账、阻断/轻微差异、一条待重算差异、一份隔离档案）；播种幂等。
- **差异算法**：`utils/diff.ts` 对状态文本做归一化（去掉空白与标点、颜色/款式同义写法归组，如「藏青 / 深蓝」视为同一色），归一后仍有差异才生成条目；关键要素的状态变化判为「阻断」，一般要素的状态变化判为「需处理」，仅照片说明 / 镜次变化判为「轻微」。比对按连戏编号归到同一条时间轴，撤下场次不参与。
- **无后端**：没有 API 服务、没有数据库容器；容器本身无状态。旧版（v1）备份导入后会自动按编号补建共同账。
