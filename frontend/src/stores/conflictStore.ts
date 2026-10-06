/**
 * 连戏差异 store：维护差异列表、严重程度/状态筛选与解决状态流转。
 * 重新比对走 recompute：旧差异恢复或归档（痕迹保留在历史与共同账 resolutions）。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { LocationQuery } from 'vue-router'
import type { FilterModel } from '@/types/filter'
import { recomputeConflicts, resolveConflict, reopenConflict, type RecomputeStats } from '@/utils/db'
import { queryToFilters } from '@/utils/query'
import type { DiffCandidate } from '@/hooks/useContinuityDiff'

export const CONFLICT_FILTER_KEYS = ['severities', 'states', 'staleness']

export const useConflictStore = defineStore('conflict', () => {
  const filters = ref<FilterModel>({ keyword: '', severities: [], states: [], staleness: [] })
  /** 最近一次重算结果（生成/恢复/归档数） */
  const lastRecompute = ref<RecomputeStats>({ created: 0, restored: 0, archived: 0 })

  function setFilters(next: FilterModel): void {
    filters.value = next
  }

  function resetFilters(): void {
    filters.value = { keyword: '', severities: [], states: [], staleness: [] }
  }

  function applyQuery(query: LocationQuery): void {
    filters.value = queryToFilters(query, CONFLICT_FILTER_KEYS)
  }

  /** 由比对候选重新生成/恢复/归档差异（只认当前账面） */
  async function regenerate(candidates: DiffCandidate[], ledgerId?: string): Promise<RecomputeStats> {
    const stats = await recomputeConflicts(
      candidates.map((item) => ({
        ledgerId: item.ledgerId,
        recordIdA: item.a.id,
        recordIdB: item.b.id,
        diffDesc: item.desc,
        severity: item.severity
      })),
      ledgerId
    )
    lastRecompute.value = stats
    return stats
  }

  /** 解决差异：写入留痕并回写当前基准；待重算差异禁止处置 */
  async function resolve(id: string, note: string): Promise<void> {
    await resolveConflict(id, note)
  }

  async function reopen(id: string): Promise<void> {
    await reopenConflict(id)
  }

  return { filters, lastRecompute, setFilters, resetFilters, applyQuery, regenerate, resolve, reopen }
})
