/**
 * 连戏差异 store：维护差异列表、严重程度筛选、重算与解决状态流转。
 * 差异按连戏编号（共同账）挂账；撤下场次 / 停用道具 / 记录更新后，
 * db 层已把相关差异置「待重算」，这里的 reconcile() 负责统一重算处置。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { LocationQuery } from 'vue-router'
import type { Conflict } from '@/types/conflict'
import type { FilterModel } from '@/types/filter'
import type { ConflictRow, ReconcileStats } from '@/utils/db'
import {
  putConflict,
  removeConflict,
  reopenConflict,
  reconcileConflicts,
  resolveConflict,
  ROW_REVISION
} from '@/utils/db'
import { createId } from '@/utils/uuid'
import { queryToFilters } from '@/utils/query'

export const CONFLICT_FILTER_KEYS = ['severities', 'states', 'stales']

export const useConflictStore = defineStore('conflict', () => {
  const filters = ref<FilterModel>({ keyword: '', severities: [], states: [], stales: [] })
  const lastReconcile = ref<ReconcileStats | null>(null)

  function setFilters(next: FilterModel): void {
    filters.value = next
  }

  function resetFilters(): void {
    filters.value = { keyword: '', severities: [], states: [], stales: [] }
  }

  function applyQuery(query: LocationQuery): void {
    filters.value = queryToFilters(query, CONFLICT_FILTER_KEYS)
  }

  /** 全量重算：待重算条目刷新 / 自动关闭留痕，现行历史条目不丢 */
  async function reconcile(actor = '差异比对页'): Promise<ReconcileStats> {
    const stats = await reconcileConflicts(actor)
    lastReconcile.value = stats
    return stats
  }

  /** 手工登记一条差异（用于现场口头发现的偏差），按编号挂共同账 */
  async function createManual(
    payload: Omit<Conflict, 'id' | 'resolvedNote' | 'resolvedAt' | 'stale' | 'staleReason'>
  ): Promise<string> {
    const now = Date.now()
    const id = createId('conflict')
    const row: ConflictRow = {
      ...payload,
      id,
      stale: '现行',
      staleReason: '',
      resolvedNote: '',
      resolvedAt: '',
      revision: ROW_REVISION,
      createdAt: now,
      updatedAt: now
    }
    await putConflict(row)
    return id
  }

  /** 解决差异：写入留痕并回写共同账基准 */
  async function resolve(id: string, note: string): Promise<void> {
    await resolveConflict(id, note)
  }

  async function reopen(id: string): Promise<void> {
    await reopenConflict(id)
  }

  async function remove(id: string): Promise<void> {
    await removeConflict(id)
  }

  return { filters, lastReconcile, setFilters, resetFilters, applyQuery, reconcile, createManual, resolve, reopen, remove }
})
