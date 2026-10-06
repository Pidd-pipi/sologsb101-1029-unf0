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
| 状态管理 | Pinia（setup store） | `sceneStore` / `ledgerStore` / `recordStore` / `conflictStore` |
| 路由 | Vue Router 4（history 模式） | nginx 侧配合 `try_files` 做 SPA fallback |
| 本地存储 | Dexie 4（IndexedDB 封装） | 库名 `gbcontinuity-db`，结构 `version(2)` 连戏编号共同账，含 v1→v2 upgrade 迁移、乐观版本号与提交前快照 |
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
| `/scenes` | 剧本场次与拍摄顺序台账 | Scene、Ledger、Conflict | 新建/编辑/**撤场**（编号自动摘挂、记录作废、差异立即待重算）、拖拽调序并自动重编号、按内外景与日/夜筛选、卡片回显编号数与现行/待重算差异数、筛选同步 URL query |
| `/elements` | 连戏编号共同账 | Ledger、Scene、Conflict、History | **一个编号一份当前基准、挂多个场次**；按类别/状态/场次筛选；编辑走存储版本乐观锁，双标签页同编号提交时落后方保留表格草稿并列出双方字段差异，可强制覆盖；停用编号；查看编号完整痕迹 |
| `/shootdays` | 现场状态记录 | ShootDay、Record、Ledger | 建立拍摄日并勾选当日场次、按镜次逐条录入编号当前状态与照片说明，同编号保留历次快照；记录更新/作废后相关差异立即待重算；作废记录折叠留档；记录编辑同样支持乐观锁冲突面板 |
| `/conflicts` | 连戏差异比对与冲突提示 | Conflict、Record、Ledger | **重新比对（待重算恢复/归档/新生成）**、并排展示记录 A / 记录 B、待重算条目高亮沉底且禁止处置、严重程度与解决状态流转、解决后回写编号当前基准并把处置痕迹并入台账（重开/归档不丢痕迹） |
| `/quarantine` | 缺编号隔离区 | Quarantine、Ledger、History | 旧数据里识别不出连戏编号的档案隔离待确认，确认编号后新建或并入共同账（随附记录一并转挂），或标记丢弃；原档与处理痕迹保留 |
| `/report` | 连戏核对报告 / 快照恢复 / 备份 | 全部模型 | 场次核对小结（待重算不计风险）、**提交前快照列表与一键恢复到提交前账面**、只追加历史时间轴、报告 / 整库 JSON 导出与导入（v1 备份自动迁移） |

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
        ├── types/              # scene.ts ledger.ts shootDay.ts record.ts conflict.ts history.ts quarantine.ts checkpoint.ts filter.ts
        ├── stores/             # sceneStore ledgerStore recordStore conflictStore
        ├── components/common/  # ConflictTag.vue FilterBar.vue StatBadge.vue EmptyPanel.vue HistoryTimeline.vue
        ├── hooks/              # useContinuityDiff.ts useIdbTable.ts
        ├── utils/              # diff.ts db.ts migration.ts export.ts seed.ts uuid.ts query.ts
        ├── pages/              # SceneList LedgerRegistry ShootDayLog ConflictBoard QuarantineCenter ReportExport
        ├── styles/main.css
        └── router/index.ts
```

---

## 六、数据存储说明

- **IndexedDB 库名**：`gbcontinuity-db`（Dexie 封装），结构版本号 `version(2)`（v1「每场各档」→ v2「连戏编号共同账」），`upgrade()` 内完成旧库自动迁移。
- **共同账模型**：`ledgers` 连戏编号（编号唯一、一份当前基准 `baselineState`、挂多场 `sceneIds`、在用/停用、带 `version` 乐观锁、内嵌已处置痕迹 `resolutions`）；`records` 现场记录挂 `ledgerId` 并带 `version`，撤场/停用只软作废（`voided`）不删除；`conflicts` 差异带 `stale/staleReason/staleAt` 待重算标记。
- **辅助表**：`history` 只追加历史（归并、隔离、撤场、停用、现场记录、冲突处置、差异待重算/恢复/归档、回滚恢复，永不清理）、`quarantine` 缺编号隔离区、`checkpoints` 提交前账面快照；另有 `scenes`、`shootDays`。
- **乐观并发（两个标签页同提交同一编号）**：共同账与现场记录都带存储版本号，提交时事务内重读版本——一致才落地并 +1；落后一方拿到 `kind: 'conflict'`，页面不关闭弹窗、保留表格草稿，并按字段列出「本页草稿 / 对方已落地 / 我读到的旧值」，可选择「读取对方版本后再改」或「强制覆盖」。
- **待重算联动**：撤下场次（编号摘挂、该场记录作废）、停用编号、现场记录更新/作废、撤除拍摄日，都会在同一事务内把相关待确认差异立即置为待重算；待重算差异不计入报告风险分，且禁止直接处置；重新比对时依据成立的恢复、依据已变的归档（差异从现行表移除但完整写入历史）、新依据生成新条目。
- **写入失败恢复**：每个领域写操作都经 `commitWithCheckpoint` 单事务提交（写库 + 历史 + 快照原子完成，抛错即整体回滚）；提交前涉及行的原样与新增 id 存入 `checkpoints`，报告页可一键恢复到任一提交前账面，恢复本身也留痕。
- **旧数据迁移**：v1 的 `elements` 重复档案按连戏编号（显式编号或从名称识别）归并成一条共同账、多场挂接、记录/差异转挂；识别不出编号的档案连同现场记录整体进隔离区待确认，确认编号后再建档/归并；导入 v1 备份走同一套转换。归并、隔离与处置痕迹全部进历史。
- **首屏自动播种**：`utils/db.ts` 的 `initDatabase()` 在 `scenes` 表为空时调用 `seedDatabase()`，灌入演示数据：跨场共用编号（LX-001 挂 12A/12B）、阻断/轻微待确认差异、已解决差异（含处置痕迹）、缺编号隔离档案；播种幂等。
- **差异算法**：`utils/diff.ts` 对状态文本做归一化（去空白标点、颜色/款式同义归组，如「藏青 / 深蓝」视为同一色），归一后仍有差异才生成条目；关键编号的状态变化判「阻断」，一般状态变化判「需处理」，仅照片说明 / 镜次变化判「轻微」；作废记录与停用编号不参与比对。
- **无后端**：没有 API 服务、没有数据库容器；容器本身无状态，不挂载任何卷。
- **撤场/撤日规则（不做物理级联删除）**：撤下场次只摘挂编号（基准保留）、该场记录作废留档、差异待重算；撤除拍摄日同样把当日记录作废留档；均可从提交前快照恢复。
- **测试**：`frontend/scripts/smoke.ts`（需 `npm i --no-save fake-indexeddb esbuild`，基于 fake-indexeddb）覆盖迁移归并/隔离、OCC 双提交、撤场/停用/记录更新联动、重算恢复归档、处置留痕、快照恢复共 59 项断言；用 esbuild 打包为 ESM 后可直接在 Node 运行：`node_modules/.bin/esbuild scripts/smoke.ts --bundle --platform=node --format=esm --outfile=/tmp/smoke.mjs && node /tmp/smoke.mjs`。
