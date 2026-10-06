/**
 * 现场记录 store：维护拍摄日、现场记录与当前拍摄日上下文。
 * 记录更新走乐观版本检测；删除=软作废（历史不丢），差异立即待重算。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { LocationQuery } from 'vue-router'
import type { ShootDay } from '@/types/shootDay'
import type { FilterModel } from '@/types/filter'
import {
  db,
  saveShootDay,
  saveRecord,
  voidRecord,
  removeShootDay,
  isSaveConflict,
  ROW_REVISION,
  type SaveOutcome,
  type RecordRow,
  type SaveConflictResult,
  type FieldConcurrencyConflict
} from '@/utils/db'
import { createId } from '@/utils/uuid'
import { queryToFilters } from '@/utils/query'
import type { Record as ContinuityRecord } from '@/types/record'

export const RECORD_FILTER_KEYS = ['sceneIds', 'takes']

export const useRecordStore = defineStore('record', () => {
  const filters = ref<FilterModel>({ keyword: '', sceneIds: [], takes: [] })
  /** 当前选中的拍摄日（现场记录页上下文） */
  const currentShootDayId = ref<string | null>(null)
  /** 最近一次记录并发冲突 */
  const conflict = ref<SaveConflictResult | null>(null)
  const lastCheckpointId = ref<string | null>(null)

  function setFilters(next: FilterModel): void {
    filters.value = next
  }

  function resetFilters(): void {
    filters.value = { keyword: '', sceneIds: [], takes: [] }
  }

  function applyQuery(query: LocationQuery): void {
    filters.value = queryToFilters(query, RECORD_FILTER_KEYS)
    if (typeof query.shootDayId === 'string' && query.shootDayId.length > 0) {
      currentShootDayId.value = query.shootDayId
    }
  }

  function selectShootDay(id: string | null): void {
    currentShootDayId.value = id
  }

  function clearConflict(): void {
    conflict.value = null
  }

  async function createShootDay(payload: Omit<ShootDay, 'id'>): Promise<string> {
    if (!payload.date) throw new Error('请选择拍摄日期')
    if (payload.sceneIds.length === 0) throw new Error('请至少选择一个当日场次')
    const id = createId('shootday')
    const now = Date.now()
    await saveShootDay({ ...payload, id, revision: ROW_REVISION, createdAt: now, updatedAt: now })
    currentShootDayId.value = id
    return id
  }

  async function updateShootDay(id: string, patch: Partial<ShootDay>): Promise<void> {
    const existing = await db.shootDays.get(id)
    if (!existing) throw new Error('拍摄日不存在')
    await saveShootDay({ ...existing, ...patch, id })
  }

  async function deleteShootDay(id: string): Promise<void> {
    await removeShootDay(id)
    if (currentShootDayId.value === id) currentShootDayId.value = null
  }

  async function saveEntry(input: {
    id?: string
    fields: Omit<ContinuityRecord, 'id' | 'voided'>
    expectedVersion?: number
    baseFields?: Partial<ContinuityRecord>
    force?: boolean
  }): Promise<SaveOutcome<RecordRow>> {
    const outcome = await saveRecord(input)
    if (isSaveConflict(outcome)) {
      conflict.value = outcome
    } else {
      conflict.value = null
      lastCheckpointId.value = outcome.checkpointId
    }
    return outcome
  }

  /** 删除=作废保留（历史快照不物理删除） */
  async function deleteRecord(id: string): Promise<void> {
    await voidRecord(id, '现场删除该记录')
  }

  function conflictFields(): FieldConcurrencyConflict[] {
    return conflict.value?.fields ?? []
  }

  return {
    filters,
    currentShootDayId,
    conflict,
    lastCheckpointId,
    setFilters,
    resetFilters,
    applyQuery,
    selectShootDay,
    clearConflict,
    createShootDay,
    updateShootDay,
    deleteShootDay,
    saveEntry,
    deleteRecord,
    conflictFields
  }
})
