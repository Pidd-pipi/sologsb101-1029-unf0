/**
 * 路由表：/scenes、/elements（连戏编号共同账）、/shootdays、/conflicts、/quarantine、/report
 * 页面按路由懒加载，构建时自动分包。
 */
import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'

export const ROUTES = {
  scenes: '/scenes',
  elements: '/elements',
  shootdays: '/shootdays',
  conflicts: '/conflicts',
  quarantine: '/quarantine',
  report: '/report'
} as const

export interface NavItem {
  path: string
  label: string
  icon: string
  hint: string
}

/** 侧边导航配置（与路由一一对应） */
export const NAV_ITEMS: NavItem[] = [
  { path: ROUTES.scenes, label: '剧本场次', icon: '🎬', hint: '场次台账与拍摄顺序' },
  { path: ROUTES.elements, label: '连戏编号', icon: '🔖', hint: '编号共同账 · 一基准挂多场' },
  { path: ROUTES.shootdays, label: '现场记录', icon: '📝', hint: '拍摄日与镜次记录' },
  { path: ROUTES.conflicts, label: '差异比对', icon: '⚠️', hint: '待重算与冲突消解' },
  { path: ROUTES.quarantine, label: '隔离区', icon: '📥', hint: '缺编号档案待确认' },
  { path: ROUTES.report, label: '核对报告', icon: '📋', hint: '报告 / 快照恢复 / 备份' }
]

const routes: RouteRecordRaw[] = [
  { path: '/', redirect: ROUTES.scenes },
  {
    path: ROUTES.scenes,
    name: 'scenes',
    component: () => import('@/pages/SceneList.vue'),
    meta: { title: '剧本场次与拍摄顺序台账' }
  },
  {
    path: ROUTES.elements,
    name: 'elements',
    component: () => import('@/pages/LedgerRegistry.vue'),
    meta: { title: '连戏编号共同账' }
  },
  {
    path: ROUTES.shootdays,
    name: 'shootdays',
    component: () => import('@/pages/ShootDayLog.vue'),
    meta: { title: '现场状态记录' }
  },
  {
    path: ROUTES.conflicts,
    name: 'conflicts',
    component: () => import('@/pages/ConflictBoard.vue'),
    meta: { title: '连戏差异比对与冲突提示' }
  },
  {
    path: ROUTES.quarantine,
    name: 'quarantine',
    component: () => import('@/pages/QuarantineCenter.vue'),
    meta: { title: '缺编号隔离区' }
  },
  {
    path: ROUTES.report,
    name: 'report',
    component: () => import('@/pages/ReportExport.vue'),
    meta: { title: '连戏核对报告与账面恢复' }
  },
  { path: '/:pathMatch(.*)*', redirect: ROUTES.scenes }
]

export const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 })
})

export default router
