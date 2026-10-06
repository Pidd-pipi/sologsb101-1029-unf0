/**
 * 连戏编号共同账 store：维护编号台账（一号一基准、挂多场）、筛选条件，
 * 以及乐观并发提交（saveLedger）的草稿/冲突状态。
 * 冲突时页面不关闭编辑弹窗、保留表格草稿，据返回字段列出双方差异。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { LocationQuery } from 'vue-router'
import type { LedgerFields } from '@/types/ledger'
import type { FilterModel } from '@/types/filter'
import {
  saveLedger,
  isSaveConflict,
  type SaveOutcome,
  type LedgerRow,
  type SaveConflictResult,
  type FieldConcurrencyConflict
} from '@/utils/db'
import { queryToFilters } from '@/utils/query'

export const LEDGER_FILTER_KEYS = ['categories', 'sceneIds', 'statuses']

export const useLedgerStore = defineStore('ledger', () => {
  const filters = ref<FilterModel>({ keyword: '', categories: [], sceneIds: [], statuses: [] })
  const selectedLedgerId = ref<string | null>(null)

  /** 最近一次并发冲突（落后方）：页面据此保留草稿并展示双方字段差异 */
  const conflict = ref<SaveConflictResult | null>(null)
  /** 最近一次成功提交对应的快照 id（写入失败恢复入口使用） */
  const lastCheckpointId = ref<string | null>(null)

  function setFilters(next: FilterModel): void {
    filters.value = next
  }

  function resetFilters(): void {
    filters.value = { keyword: '', categories: [], sceneIds: [], statuses: [] }
  }

  function applyQuery(query: LocationQuery): void {
    filters.value = queryToFilters(query, LEDGER_FILTER_KEYS)
  }

  function select(id: string | null): void {
    selectedLedgerId.value = id
  }

  function clearConflict(): void {
    conflict.value = null
  }

  /**
   * 提交共同账。expectedVersion/baseFields 来自打开编辑时读到的存储版本；
   * 返回冲突结果时不抛错，由页面保留草稿并提示字段差异。
   */
  async function save(input: {
    id?: string
    fields: LedgerFields
    expectedVersion?: number
    baseFields?: LedgerFields
    force?: boolean
  }): Promise<SaveOutcome<LedgerRow>> {
    const outcome = await saveLedger(input)
    if (isSaveConflict(outcome)) {
      conflict.value = outcome
    } else {
      conflict.value = null
      lastCheckpointId.value = outcome.checkpointId
      selectedLedgerId.value = outcome.value.id
    }
    return outcome
  }

  /** 冲突字段（供页面直接 v-for） */
  function conflictFields(): FieldConcurrencyConflict[] {
    return conflict.value?.fields ?? []
  }

  return {
    filters,
    selectedLedgerId,
    conflict,
    lastCheckpointId,
    setFilters,
    resetFilters,
    applyQuery,
    select,
    clearConflict,
    save,
    conflictFields
  }
})
