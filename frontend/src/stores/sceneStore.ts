/**
 * 场次 store：维护场次列表、拍摄顺序与筛选条件。
 * 撤下场次不做物理删除（退出排程、差异待重算、历史保留）；
 * 只有撤下后的误建场次才允许「彻底删除」。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { LocationQuery } from 'vue-router'
import type { Scene } from '@/types/scene'
import type { FilterModel } from '@/types/filter'
import {
  nextShootOrder,
  purgeScene,
  putScene,
  restoreScene as restoreSceneRow,
  reorderScenes,
  updateScene as updateSceneRow,
  withdrawScene as withdrawSceneRow,
  ROW_REVISION
} from '@/utils/db'
import { createId } from '@/utils/uuid'
import { queryToFilters } from '@/utils/query'

export const SCENE_FILTER_KEYS = ['places', 'times']

export const useSceneStore = defineStore('scene', () => {
  const filters = ref<FilterModel>({ keyword: '', places: [], times: [] })
  const selectedSceneId = ref<string | null>(null)

  function setFilters(next: FilterModel): void {
    filters.value = next
  }

  function resetFilters(): void {
    filters.value = { keyword: '', places: [], times: [] }
  }

  function applyQuery(query: LocationQuery): void {
    filters.value = queryToFilters(query, SCENE_FILTER_KEYS)
  }

  function select(id: string | null): void {
    selectedSceneId.value = id
  }

  async function createScene(payload: Omit<Scene, 'id' | 'shootOrder'>): Promise<string> {
    const now = Date.now()
    const id = createId('scene')
    const shootOrder = await nextShootOrder()
    await putScene({ ...payload, id, shootOrder, withdrawn: false, revision: ROW_REVISION, createdAt: now, updatedAt: now })
    selectedSceneId.value = id
    return id
  }

  async function updateScene(id: string, patch: Partial<Scene>): Promise<void> {
    await updateSceneRow(id, patch)
  }

  /** 撤下场次：历史保留，相关差异转待重算 */
  async function withdrawScene(id: string, actor = '现场'): Promise<void> {
    await withdrawSceneRow(id, actor)
  }

  /** 恢复撤下的场次 */
  async function restoreScene(id: string, actor = '现场'): Promise<void> {
    await restoreSceneRow(id, actor)
  }

  /** 彻底删除（仅限撤下后的误建场次） */
  async function purgeSceneById(id: string, actor = '现场'): Promise<void> {
    await purgeScene(id, actor)
    if (selectedSceneId.value === id) selectedSceneId.value = null
  }

  /** 拖拽 / 上下移后按新顺序批量重编号 */
  async function move(list: Scene[], from: number, to: number): Promise<void> {
    if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return
    const next = [...list]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    await reorderScenes(next.map((item) => item.id))
  }

  return {
    filters,
    selectedSceneId,
    setFilters,
    resetFilters,
    applyQuery,
    select,
    createScene,
    updateScene,
    withdrawScene,
    restoreScene,
    purgeSceneById,
    move
  }
})
