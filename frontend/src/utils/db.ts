/**
 * IndexedDB 持久化层（Dexie 封装）——连戏编号共同账结构（v2）
 *
 * 表：
 * - ledgers     连戏编号共同账：一个编号一份当前基准、挂多个场次，带 version 乐观锁
 * - records      现场记录：挂 ledgerId，带 version；撤场/停用只软作废（voided）
 * - conflicts    连戏差异：stale=待重算，撤场/停用/记录更新立即置位
 * - history      只追加历史（归并、隔离、处置、回滚等全部痕迹，永不清理）
 * - quarantine   缺编号旧档案的隔离区
 * - checkpoints  提交前账面快照，写入失败/反悔时恢复
 * - scenes / shootDays 沿用
 *
 * 所有领域写操作都走 commitWithCheckpoint：单事务内完成写库 + 历史 + 快照，
 * 失败整体回滚（IndexedDB 原子事务），事后可用 restoreCheckpoint 恢复账面。
 */
import Dexie, { type Table } from 'dexie'
import { toRaw } from 'vue'
import type { Scene } from '../types/scene'
import type { ShootDay } from '../types/shootDay'
import type { Ledger, LedgerFields, LedgerResolution } from '../types/ledger'
import type { Record as ContinuityRecord } from '../types/record'
import type { Conflict, ConflictSeverity } from '../types/conflict'
import type { LedgerHistoryEntry } from '../types/history'
import type { QuarantineItem } from '../types/quarantine'
import type { Checkpoint, CheckpointSnapshot, CheckpointTableSnapshot } from '../types/checkpoint'
import { nowIso, createId } from './uuid'
import { seedDatabase } from './seed'
import { migrateV1ToV2, type LegacyConflict, type LegacyElement, type LegacyRecord } from './migration'

/** 数据库名 */
export const DB_NAME = 'gbcontinuity-db'

/** 当前数据结构版本号（v1：每场各档 → v2：连戏编号共同账） */
export const DB_SCHEMA_VERSION = 2

/** 行结构修订号 */
export const ROW_REVISION = 2

/** 带时间戳与修订号的持久化实体 */
export interface Revisioned {
  revision: number
  createdAt: number
  updatedAt: number
}

/** 带存储版本号（乐观锁）的实体：共同账与现场记录支持双标签页并发检测 */
export interface Versioned {
  /** 存储版本：每次落地 +1；提交时必须与读到的版本一致，否则返回冲突 */
  version: number
}

export type SceneRow = Scene & Revisioned
export type ShootDayRow = ShootDay & Revisioned
export type LedgerRow = Ledger & Revisioned & Versioned
export type RecordRow = ContinuityRecord & Revisioned & Versioned
export type ConflictRow = Conflict & Revisioned
export type HistoryRow = LedgerHistoryEntry
export type QuarantineRow = QuarantineItem
export type CheckpointRow = Checkpoint

/**
 * 深度剥掉 Vue 响应式代理，得到可被 IndexedDB 结构化克隆的普通对象。
 */
export function toPlainRow<T>(value: T): T {
  const raw = toRaw(value) as unknown
  if (Array.isArray(raw)) return raw.map((item) => toPlainRow(item)) as unknown as T
  if (raw !== null && typeof raw === 'object') {
    const proto = Object.getPrototypeOf(raw)
    if (proto === Object.prototype || proto === null) {
      const plain: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(raw)) plain[key] = toPlainRow(item)
      return plain as T
    }
  }
  return raw as T
}

/* ============================ 乐观并发（OCC）结果 ============================ */

/** 两个标签页基于不同存储版本提交时，单字段的双方取值对照 */
export interface FieldConcurrencyConflict {
  field: string
  label: string
  /** 落后方读到的基准值（其编辑所依据的版本） */
  base: unknown
  /** 先落地一方已写入的现值 */
  current: unknown
  /** 落后方本次想写入的值（表格草稿保留在页面上，不入库） */
  theirs: unknown
}

export interface SaveConflictResult {
  kind: 'conflict'
  id: string
  code: string
  expectedVersion: number
  storedVersion: number
  fields: FieldConcurrencyConflict[]
}

export interface SaveSuccessResult<T> {
  kind: 'success'
  id: string
  version: number
  checkpointId: string | null
  value: T
}

export type SaveOutcome<T> = SaveSuccessResult<T> | SaveConflictResult

export function isSaveConflict<T>(outcome: SaveOutcome<T>): outcome is SaveConflictResult {
  return outcome.kind === 'conflict'
}

/* ================================ 数据库 ================================ */

class GbContinuityDatabase extends Dexie {
  scenes!: Table<SceneRow, string>
  ledgers!: Table<LedgerRow, string>
  records!: Table<RecordRow, string>
  conflicts!: Table<ConflictRow, string>
  shootDays!: Table<ShootDayRow, string>
  history!: Table<HistoryRow, string>
  quarantine!: Table<QuarantineRow, string>
  checkpoints!: Table<CheckpointRow, string>

  constructor() {
    super(DB_NAME)

    // v1（历史结构，保留以便老库升级）：场次/要素/拍摄日/记录/差异
    this.version(1).stores({
      scenes: 'id, sceneNo, place, timeOfDay, shootOrder, state, updatedAt',
      elements: 'id, sceneId, category, name, owner, critical, updatedAt',
      shootDays: 'id, date, director, scripty, updatedAt',
      records: 'id, shootDayId, elementId, sceneId, takeNo, updatedAt',
      conflicts: 'id, elementId, recordIdA, recordIdB, severity, state, updatedAt'
    })

    // v2：连戏编号共同账。elements 表删除（数据先在 upgrade 中迁移走）
    this.version(2)
      .stores({
        scenes: 'id, sceneNo, place, timeOfDay, shootOrder, state, updatedAt',
        ledgers: 'id, code, status, category, updatedAt',
        records: 'id, shootDayId, ledgerId, sceneId, takeNo, voided, updatedAt',
        conflicts: 'id, ledgerId, recordIdA, recordIdB, severity, state, stale, updatedAt',
        shootDays: 'id, date, director, scripty, updatedAt',
        history: 'id, ledgerId, code, action, at',
        quarantine: 'id, status, sourceElementId',
        checkpoints: 'id, status, createdAt',
        elements: null
      })
      .upgrade(async (tx) => {
        const oldScenes = (await tx.table('scenes').toArray()) as Array<SceneRow & Partial<Revisioned>>
        const oldShootDays = (await tx.table('shootDays').toArray()) as Array<ShootDayRow & Partial<Revisioned>>
        const oldElements = (await tx.table('elements').toArray()) as LegacyElement[]
        const oldRecords = (await tx.table('records').toArray()) as LegacyRecord[]
        const oldConflicts = (await tx.table('conflicts').toArray()) as LegacyConflict[]

        const stamp = <T extends object>(row: T): T & Revisioned => {
          const withMeta = row as T & Partial<Revisioned>
          const now = Date.now()
          return {
            ...withMeta,
            revision: typeof withMeta.revision === 'number' ? withMeta.revision : ROW_REVISION,
            createdAt: typeof withMeta.createdAt === 'number' ? withMeta.createdAt : now,
            updatedAt: typeof withMeta.updatedAt === 'number' ? withMeta.updatedAt : now
          }
        }

        const migrated = migrateV1ToV2({
          scenes: oldScenes,
          shootDays: oldShootDays,
          elements: oldElements,
          records: oldRecords,
          conflicts: oldConflicts
        })

        await tx.table('scenes').bulkPut(oldScenes.map(stamp))
        await tx.table('shootDays').bulkPut(oldShootDays.map(stamp))
        if (migrated.ledgers.length > 0) await tx.table('ledgers').bulkPut(toPlainRow(migrated.ledgers))
        if (migrated.records.length > 0) await tx.table('records').bulkPut(toPlainRow(migrated.records))
        if (migrated.conflicts.length > 0) await tx.table('conflicts').bulkPut(toPlainRow(migrated.conflicts))
        if (migrated.quarantine.length > 0) await tx.table('quarantine').bulkPut(toPlainRow(migrated.quarantine))
        if (migrated.history.length > 0) await tx.table('history').bulkPut(toPlainRow(migrated.history))
        // elements 表由 Dexie 在升级收尾时按声明删除
      })
  }
}

export const db = new GbContinuityDatabase()

/** 打开数据库：首次使用时灌入演示数据（幂等：表非空不播） */
export async function initDatabase(): Promise<void> {
  await db.open()
  if ((await db.scenes.count()) === 0) {
    await seedDatabase()
  }
}

/* ========================== 提交引擎（checkpoint） ========================== */

type CommitTableName = 'scenes' | 'ledgers' | 'records' | 'conflicts' | 'shootDays' | 'quarantine'

const COMMIT_TABLES: CommitTableName[] = ['scenes', 'ledgers', 'records', 'conflicts', 'shootDays', 'quarantine']

function emptyTableSnapshot(): CheckpointTableSnapshot {
  return { put: [], delete: [] }
}

/**
 * 提交上下文：领域逻辑通过它写库。
 * - 第一次触碰某 id 时记下提交前原样（恢复时写回）；
 * - 事务内新建的 id 单独记账（恢复时删除）；
 * - 历史通过 log() 缓冲，随事务原子写入。
 * 暴露的 Table 仅用于读，写一律走 putRow/updateRow/removeRow。
 */
export interface CommitContext {
  readonly scenes: Table<SceneRow, string>
  readonly ledgers: Table<LedgerRow, string>
  readonly records: Table<RecordRow, string>
  readonly conflicts: Table<ConflictRow, string>
  readonly shootDays: Table<ShootDayRow, string>
  readonly quarantine: Table<QuarantineRow, string>
  putRow: <T extends { id: string }>(name: CommitTableName, row: T) => Promise<void>
  updateRow: (name: CommitTableName, id: string, patch: Record<string, unknown>) => Promise<void>
  removeRow: (name: CommitTableName, id: string) => Promise<void>
  log: (entry: Omit<LedgerHistoryEntry, 'id' | 'at'> & { at?: string }) => void
}

class CommitScope implements CommitContext {
  readonly scenes = db.scenes
  readonly ledgers = db.ledgers
  readonly records = db.records
  readonly conflicts = db.conflicts
  readonly shootDays = db.shootDays
  readonly quarantine = db.quarantine

  readonly snapshot: CheckpointSnapshot = {
    scenes: emptyTableSnapshot(),
    ledgers: emptyTableSnapshot(),
    records: emptyTableSnapshot(),
    conflicts: emptyTableSnapshot(),
    shootDays: emptyTableSnapshot(),
    quarantine: emptyTableSnapshot()
  }

  private readonly seen = new Map<CommitTableName, Set<string>>()
  private readonly history: HistoryRow[] = []
  private mutated = false
  checkpointId: string | null = null

  private tableOf(name: CommitTableName): Table {
    return db[name]
  }

  /** 触碰某行：提交前已存在则原样入快照，新建则记入 delete 清单 */
  private async touch(name: CommitTableName, id: string): Promise<void> {
    let set = this.seen.get(name)
    if (!set) {
      set = new Set<string>()
      this.seen.set(name, set)
    }
    if (set.has(id)) return
    set.add(id)
    const before = await this.tableOf(name).get(id)
    const snap = this.snapshot[name]
    if (before) snap.put.push(before as unknown as Record<string, unknown>)
    else snap.delete.push(id)
  }

  async putRow<T extends { id: string }>(name: CommitTableName, row: T): Promise<void> {
    await this.touch(name, row.id)
    this.mutated = true
    await this.tableOf(name).put(toPlainRow(row))
  }

  async updateRow(name: CommitTableName, id: string, patch: Record<string, unknown>): Promise<void> {
    await this.touch(name, id)
    this.mutated = true
    await this.tableOf(name).update(id, toPlainRow(patch))
  }

  async removeRow(name: CommitTableName, id: string): Promise<void> {
    await this.touch(name, id)
    this.mutated = true
    await this.tableOf(name).delete(id)
  }

  log(entry: Omit<LedgerHistoryEntry, 'id' | 'at'> & { at?: string }): void {
    this.history.push({ ...entry, id: createId('hist'), at: entry.at ?? nowIso() })
  }

  async finish(label: string): Promise<string | null> {
    if (!this.mutated) return null
    const checkpoint: CheckpointRow = {
      id: createId('cp'),
      createdAt: Date.now(),
      label,
      status: '可恢复',
      snapshot: this.snapshot,
      restoredAt: '',
      restoreNote: ''
    }
    await db.checkpoints.put(toPlainRow(checkpoint))
    if (this.history.length > 0) await db.history.bulkPut(toPlainRow(this.history))
    // 只保留最近 30 份快照（历史本身永不清理）
    const all = await db.checkpoints.orderBy('createdAt').reverse().toArray()
    const stale = all.slice(30)
    if (stale.length > 0) await db.checkpoints.bulkDelete(stale.map((item) => item.id))
    this.checkpointId = checkpoint.id
    return checkpoint.id
  }
}

/**
 * 在单事务里执行一次账面提交：写库、历史、checkpoint 原子完成；
 * worker 内抛错则整体回滚（自动恢复到提交前）。
 * worker 返回 kind='conflict' 时不产生任何写入（版本检测均发生在首条写操作之前）。
 */
export async function commitWithCheckpoint<T>(
  label: string,
  worker: (ctx: CommitContext) => Promise<T>
): Promise<{ result: T; checkpointId: string | null }> {
  const scope = new CommitScope()
  const txTables: Table[] = COMMIT_TABLES.map((name) => db[name] as Table)
  txTables.push(db.checkpoints, db.history)
  const result = await db.transaction('rw', txTables, async () => {
    const output = await worker(scope)
    if (output && typeof output === 'object' && (output as { kind?: string }).kind === 'conflict') {
      return output
    }
    await scope.finish(label)
    return output
  })
  return { result, checkpointId: scope.checkpointId }
}

/**
 * 从 checkpoint 恢复到提交前账面：原行写回、提交内新增行删除。
 * 恢复动作本身也留历史；恢复后该快照标记「已恢复」，其后的快照标记「已失效」。
 */
export async function restoreCheckpoint(id: string, note: string): Promise<void> {
  const txTables: Table[] = COMMIT_TABLES.map((name) => db[name] as Table)
  txTables.push(db.checkpoints, db.history)
  await db.transaction('rw', txTables, async () => {
    const checkpoint = await db.checkpoints.get(id)
    if (!checkpoint) throw new Error('快照不存在或已被清理')
    if (checkpoint.status !== '可恢复') throw new Error('该快照已不可恢复')

    for (const name of COMMIT_TABLES) {
      const table = db[name] as Table
      const snap = checkpoint.snapshot[name]
      if (snap.put.length > 0) await table.bulkPut(toPlainRow(snap.put) as never)
      if (snap.delete.length > 0) await table.bulkDelete(snap.delete)
    }

    const iso = nowIso()
    await db.checkpoints.update(id, { status: '已恢复', restoredAt: iso, restoreNote: note } as never)
    // 之后的快照若再恢复会产生账面错乱，统一标记失效
    const newer = await db.checkpoints.where('createdAt').above(checkpoint.createdAt).toArray()
    await Promise.all(newer.map((item) => db.checkpoints.update(item.id, { status: '已失效' } as never)))

    const codeById = new Map<string, string>()
    checkpoint.snapshot.ledgers.put.forEach((row) => {
      if (row.id && row.code) codeById.set(String(row.id), String(row.code))
    })
    const ledgerIds = Array.from(codeById.keys())
    const historyRows: HistoryRow[] = (ledgerIds.length > 0 ? ledgerIds : ['']).map((ledgerId) => ({
      id: createId('hist'),
      at: iso,
      ledgerId,
      code: codeById.get(ledgerId) ?? '',
      action: '回滚恢复',
      detail: `按提交前快照恢复账面：${checkpoint.label}${note ? `（${note}）` : ''}`,
      snapshot: { checkpointId: checkpoint.id }
    }))
    await db.history.bulkPut(historyRows)
  })
}

/* ========================== 共同账字段差异（OCC） ========================== */

const LEDGER_FIELD_LABELS: Record<keyof LedgerFields, string> = {
  code: '连戏编号',
  sceneIds: '关联场次',
  category: '类别',
  name: '名称',
  baselineState: '当前基准',
  owner: '责任人',
  critical: '关键要素',
  status: '状态'
}

const RECORD_FIELD_LABELS: Record<string, string> = {
  takeNo: '镜次',
  currentState: '当前状态',
  photoNote: '照片说明',
  recordedBy: '记录人',
  sceneId: '场次'
}

function collectFieldDiffs<K extends string>(
  keys: readonly K[],
  labels: Record<K, string>,
  stored: Record<string, unknown>,
  draft: Record<string, unknown>,
  base: Record<string, unknown>
): FieldConcurrencyConflict[] {
  const fields: FieldConcurrencyConflict[] = []
  keys.forEach((field) => {
    const current = stored[field]
    const theirs = draft[field]
    if (JSON.stringify(current ?? null) !== JSON.stringify(theirs ?? null)) {
      fields.push({ field, label: labels[field], base: base[field] ?? '', current: current ?? '', theirs: theirs ?? '' })
    }
  })
  return fields
}

/** 对照落后方草稿与已落地版本，列出双方不同的共同账字段 */
export function diffLedgerVersions(
  stored: Partial<LedgerFields>,
  draft: Partial<LedgerFields>,
  base: Partial<LedgerFields>
): FieldConcurrencyConflict[] {
  return collectFieldDiffs(Object.keys(LEDGER_FIELD_LABELS) as Array<keyof LedgerFields>, LEDGER_FIELD_LABELS, stored, draft, base)
}

function diffRecordVersions(
  stored: Partial<ContinuityRecord>,
  draft: Partial<ContinuityRecord>,
  base: Partial<ContinuityRecord>
): FieldConcurrencyConflict[] {
  return collectFieldDiffs(Object.keys(RECORD_FIELD_LABELS), RECORD_FIELD_LABELS, stored, draft, base)
}

/* ============================== 读操作 ============================== */

export async function listScenes(): Promise<SceneRow[]> {
  const rows = await db.scenes.toArray()
  return rows.sort((a, b) => a.shootOrder - b.shootOrder)
}

export async function listShootDays(): Promise<ShootDayRow[]> {
  const rows = await db.shootDays.toArray()
  return rows.sort((a, b) => b.date.localeCompare(a.date))
}

export async function listLedgers(): Promise<LedgerRow[]> {
  return db.ledgers.toArray()
}

export async function listRecords(): Promise<RecordRow[]> {
  return db.records.toArray()
}

export async function listConflicts(): Promise<ConflictRow[]> {
  return db.conflicts.toArray()
}

export async function listHistory(): Promise<HistoryRow[]> {
  const rows = await db.history.toArray()
  return rows.sort((a, b) => b.at.localeCompare(a.at))
}

export async function listQuarantine(): Promise<QuarantineRow[]> {
  const rows = await db.quarantine.toArray()
  return rows.sort((a, b) => b.quarantinedAt.localeCompare(a.quarantinedAt))
}

export async function listCheckpoints(): Promise<CheckpointRow[]> {
  return db.checkpoints.orderBy('createdAt').reverse().toArray()
}

/** 下一个可用拍摄顺序号 */
export async function nextShootOrder(): Promise<number> {
  const rows = await db.scenes.toArray()
  return rows.reduce((max, row) => Math.max(max, row.shootOrder), 0) + 1
}

/* ======================== 共同账：建/改（OCC） ======================== */

export interface SaveLedgerInput {
  id?: string
  fields: LedgerFields
  /** 编辑时页面读到的存储版本；与库中不一致则返回冲突（不覆盖先落地方） */
  expectedVersion?: number
  /** 编辑打开时的字段快照，用于冲突时列出双方字段 */
  baseFields?: Partial<LedgerFields>
  /** 冲突后用户选择「仍以本页为准覆盖」 */
  force?: boolean
}

/**
 * 保存共同账（新建/编辑）。
 * 两个标签页同时提交同一编号：各自按读到的存储版本落地，落后方拿到
 * kind='conflict'，页面保留草稿并据 fields 列出双方不同字段。
 * 撤场（sceneIds 减少）与停用（status→停用）立即把相关差异置待重算。
 */
export async function saveLedger(input: SaveLedgerInput): Promise<SaveOutcome<LedgerRow>> {
  const outcome = await commitWithCheckpoint(
    input.id ? `更新共同账 ${input.fields.code}` : `新建共同账 ${input.fields.code}`,
    async (ctx) => {
      const fields: LedgerFields = {
        ...input.fields,
        code: input.fields.code.trim(),
        sceneIds: [...new Set(input.fields.sceneIds)]
      }
      if (!fields.code) throw new Error('请填写连戏编号')
      if (fields.sceneIds.length === 0) throw new Error('请至少关联一个场次')

      const normalized = fields.code.toUpperCase()
      const duplicate = (await ctx.ledgers.toArray()).find(
        (item) => item.code.trim().toUpperCase() === normalized && item.id !== input.id
      )
      if (duplicate) {
        return {
          kind: 'conflict' as const,
          id: duplicate.id,
          code: duplicate.code,
          expectedVersion: input.expectedVersion ?? 0,
          storedVersion: duplicate.version,
          fields: diffLedgerVersions(duplicate, fields, input.baseFields ?? {})
        }
      }

      const now = Date.now()

      if (!input.id) {
        const row: LedgerRow = {
          ...fields,
          id: createId('ledger'),
          resolutions: [],
          revision: ROW_REVISION,
          version: 1,
          createdAt: now,
          updatedAt: now
        }
        await ctx.putRow('ledgers', row)
        ctx.log({ ledgerId: row.id, code: row.code, action: '建档', detail: `建立连戏编号 ${row.code}，关联 ${row.sceneIds.length} 个场次` })
        return { kind: 'success' as const, id: row.id, version: 1, value: row }
      }

      const existing = await ctx.ledgers.get(input.id)
      if (!existing) throw new Error('共同账条目不存在或已被删除')
      if (!input.force && typeof input.expectedVersion === 'number' && existing.version !== input.expectedVersion) {
        return {
          kind: 'conflict' as const,
          id: existing.id,
          code: existing.code,
          expectedVersion: input.expectedVersion,
          storedVersion: existing.version,
          fields: diffLedgerVersions(existing, fields, input.baseFields ?? existing)
        }
      }

      const row: LedgerRow = {
        ...existing,
        ...fields,
        id: existing.id,
        resolutions: existing.resolutions,
        revision: ROW_REVISION,
        version: existing.version + 1,
        createdAt: existing.createdAt,
        updatedAt: now
      }
      await ctx.putRow('ledgers', row)

      // 撤场：从关联场次中撤下的场次，其现场记录软作废，相关差异待重算
      const detachedScenes = existing.sceneIds.filter((sceneId) => !fields.sceneIds.includes(sceneId))
      if (detachedScenes.length > 0) {
        const records = await ctx.records.where('ledgerId').equals(existing.id).toArray()
        const affectedRecordIds = new Set<string>()
        await Promise.all(
          records
            .filter((record) => !record.voided && detachedScenes.includes(record.sceneId))
            .map(async (record) => {
              affectedRecordIds.add(record.id)
              await ctx.updateRow('records', record.id, { sceneId: '', voided: true, updatedAt: now } as never)
            })
        )
        await markConflictsStale(
          ctx,
          existing.id,
          row.code,
          `场次撤出编号 ${row.code}`,
          (conflict) =>
            !conflict.stale &&
            conflict.state === '待确认' &&
            (affectedRecordIds.has(conflict.recordIdA) || affectedRecordIds.has(conflict.recordIdB))
        )
        detachedScenes.forEach((sceneId) => {
          ctx.log({
            ledgerId: existing.id,
            code: row.code,
            action: '撤场',
            detail: `编号 ${row.code} 撤下关联场次 ${sceneId}，该场历史记录保留但置为作废，相关差异转待重算`
          })
        })
      }

      // 停用：全部待确认差异立即待重算
      if (existing.status === '在用' && fields.status === '停用') {
        await markConflictsStale(ctx, existing.id, row.code, `编号 ${row.code} 已停用`, (conflict) => !conflict.stale && conflict.state === '待确认')
        ctx.log({ ledgerId: existing.id, code: row.code, action: '停用', detail: `编号 ${row.code} 停用，相关差异转待重算，新差异不再生成` })
      } else if (existing.status === '停用' && fields.status === '在用') {
        ctx.log({ ledgerId: existing.id, code: row.code, action: '重新启用', detail: `编号 ${row.code} 重新启用` })
      }

      if (existing.baselineState !== fields.baselineState) {
        ctx.log({
          ledgerId: existing.id,
          code: row.code,
          action: '更新基准',
          detail: `当前基准更新：「${existing.baselineState || '空'}」→「${fields.baselineState}」`
        })
      } else if (detachedScenes.length === 0 && fields.status === existing.status) {
        ctx.log({ ledgerId: existing.id, code: row.code, action: '编辑', detail: `编号 ${row.code} 账面字段已更新（版本 v${row.version}）` })
      }

      return { kind: 'success' as const, id: row.id, version: row.version, value: row }
    }
  )
  return { ...outcome.result, checkpointId: outcome.checkpointId } as SaveOutcome<LedgerRow>
}

/** 差异批量置待重算（同事务） */
async function markConflictsStale(
  ctx: CommitContext,
  ledgerId: string,
  code: string,
  reason: string,
  predicate: (conflict: ConflictRow) => boolean
): Promise<number> {
  const rows = await ctx.conflicts.where('ledgerId').equals(ledgerId).toArray()
  const iso = nowIso()
  let count = 0
  await Promise.all(
    rows
      .filter(predicate)
      .map(async (conflict) => {
        count += 1
        await ctx.updateRow('conflicts', conflict.id, {
          stale: true,
          staleReason: reason,
          staleAt: iso,
          updatedAt: Date.now()
        } as never)
        ctx.log({
          ledgerId,
          code,
          action: '差异待重算',
          detail: `差异 ${conflict.id} 转待重算：${reason}`,
          snapshot: { conflictId: conflict.id }
        })
      })
  )
  return count
}

/* ======================= 现场记录：建/改（OCC） ======================= */

export interface SaveRecordInput {
  id?: string
  fields: Omit<ContinuityRecord, 'id' | 'voided'>
  expectedVersion?: number
  baseFields?: Partial<ContinuityRecord>
  force?: boolean
}

/**
 * 保存现场记录。记录更新后该编号全部待确认差异立即转待重算；
 * 双标签页同改一条记录时按版本号检测，落后方保留草稿。
 */
export async function saveRecord(input: SaveRecordInput): Promise<SaveOutcome<RecordRow>> {
  const outcome = await commitWithCheckpoint(
    input.id ? `更新现场记录 ${input.fields.takeNo}` : `录入现场记录 ${input.fields.takeNo}`,
    async (ctx) => {
      const fields = { ...input.fields }
      if (!fields.shootDayId) throw new Error('请先选择拍摄日')
      if (!fields.ledgerId) throw new Error('请选择连戏编号')
      if (!fields.currentState.trim()) throw new Error('请填写当前状态')
      const ledger = await ctx.ledgers.get(fields.ledgerId)
      if (!ledger) throw new Error('连戏编号不存在')
      if (ledger.status === '停用') throw new Error(`编号 ${ledger.code} 已停用，不能再录入记录`)
      if (!fields.sceneId) fields.sceneId = ledger.sceneIds[0] ?? ''

      const now = Date.now()

      if (!input.id) {
        const row: RecordRow = {
          ...fields,
          id: createId('record'),
          voided: false,
          revision: ROW_REVISION,
          version: 1,
          createdAt: now,
          updatedAt: now
        }
        await ctx.putRow('records', row)
        ctx.log({
          ledgerId: ledger.id,
          code: ledger.code,
          action: '现场记录',
          detail: `${fields.takeNo || '未填镜次'} 录入现场记录：「${fields.currentState}」`
        })
        return { kind: 'success' as const, id: row.id, version: 1, value: row }
      }

      const existing = await ctx.records.get(input.id)
      if (!existing) throw new Error('现场记录不存在或已被删除')
      if (!input.force && typeof input.expectedVersion === 'number' && existing.version !== input.expectedVersion) {
        return {
          kind: 'conflict' as const,
          id: existing.id,
          code: ledger.code,
          expectedVersion: input.expectedVersion,
          storedVersion: existing.version,
          fields: diffRecordVersions(existing, fields, input.baseFields ?? existing)
        }
      }

      const row: RecordRow = {
        ...existing,
        ...fields,
        id: existing.id,
        voided: existing.voided,
        revision: ROW_REVISION,
        version: existing.version + 1,
        createdAt: existing.createdAt,
        updatedAt: now
      }
      await ctx.putRow('records', row)

      await markConflictsStale(ctx, ledger.id, ledger.code, `现场记录 ${row.takeNo} 已更新`, (conflict) => !conflict.stale && conflict.state === '待确认')
      ctx.log({
        ledgerId: ledger.id,
        code: ledger.code,
        action: '现场记录',
        detail: `${row.takeNo} 现场记录更新（版本 v${row.version}），相关差异转待重算`
      })
      return { kind: 'success' as const, id: row.id, version: row.version, value: row }
    }
  )
  return { ...outcome.result, checkpointId: outcome.checkpointId } as SaveOutcome<RecordRow>
}

/**
 * 作废现场记录（撤场/停用/删除都不物理删除，历史快照保留）。
 * 涉及它的差异立即转待重算。
 */
export async function voidRecord(id: string, reason: string): Promise<void> {
  await commitWithCheckpoint(`作废现场记录 ${id}`, async (ctx) => {
    const record = await ctx.records.get(id)
    if (!record || record.voided) return
    await ctx.updateRow('records', id, { voided: true, updatedAt: Date.now() } as never)
    const ledger = await ctx.ledgers.get(record.ledgerId)
    await markConflictsStale(
      ctx,
      record.ledgerId,
      ledger?.code ?? '',
      reason || `现场记录 ${record.takeNo} 已作废`,
      (conflict) => !conflict.stale && conflict.state === '待确认' && (conflict.recordIdA === id || conflict.recordIdB === id)
    )
    ctx.log({
      ledgerId: record.ledgerId,
      code: ledger?.code ?? '',
      action: '现场记录',
      detail: `${record.takeNo} 现场记录作废（保留历史）：${reason || '—'}`
    })
  })
}

/* ============================== 拍摄日 ============================== */

export async function saveShootDay(row: ShootDayRow): Promise<void> {
  await commitWithCheckpoint(`保存拍摄日 ${row.date}`, async (ctx) => {
    const existing = await ctx.shootDays.get(row.id)
    await ctx.putRow('shootDays', toPlainRow({ ...row, updatedAt: Date.now() }))
    if (!existing) {
      ctx.log({ ledgerId: '', code: '', action: '建档', detail: `建立拍摄日 ${row.date}，关联 ${row.sceneIds.length} 个场次` })
    }
  })
}

/** 删除拍摄日：当日记录软作废，相关差异转待重算（记录与痕迹不物理删除） */
export async function removeShootDay(id: string): Promise<void> {
  await commitWithCheckpoint('删除拍摄日', async (ctx) => {
    const day = await ctx.shootDays.get(id)
    if (!day) return
    const records = await ctx.records.where('shootDayId').equals(id).toArray()
    await Promise.all(
      records
        .filter((record) => !record.voided)
        .map(async (record) => {
          await ctx.updateRow('records', record.id, { voided: true, updatedAt: Date.now() } as never)
          await markConflictsStale(
            ctx,
            record.ledgerId,
            (await ctx.ledgers.get(record.ledgerId))?.code ?? '',
            `拍摄日 ${day.date} 已撤`,
            (conflict) =>
              !conflict.stale &&
              conflict.state === '待确认' &&
              (conflict.recordIdA === record.id || conflict.recordIdB === record.id)
          )
        })
    )
    await ctx.removeRow('shootDays', id)
    ctx.log({
      ledgerId: '',
      code: '',
      action: '现场记录',
      detail: `拍摄日 ${day.date} 撤除，${records.length} 条现场记录作废保留，相关差异转待重算`
    })
  })
}

/* ========================== 差异：重算 / 处置 ========================== */

export interface RecomputeStats {
  created: number
  restored: number
  archived: number
}

/**
 * 重新比对（ledgerId 可空=全量）。
 * - 待重算（stale）差异：与最新比对一致的「恢复」，不一致/失去依据的归档（历史留痕，不删除）；
 * - 现行差异若最新比对已不支持（记录作废、编号停用等）也归档；
 * - 新出现的比对结果落为新的「待确认」差异；
 * - 已解决差异的处置痕迹保存在共同账 resolutions 中，归档不影响已处理痕迹。
 */
export async function recomputeConflicts(
  candidates: Array<{
    ledgerId: string
    recordIdA: string
    recordIdB: string
    diffDesc: string
    severity: ConflictSeverity
  }>,
  ledgerId?: string
): Promise<RecomputeStats> {
  const stats: RecomputeStats = { created: 0, restored: 0, archived: 0 }
  await commitWithCheckpoint('重新比对差异', async (ctx) => {
    const ledgers = await ctx.ledgers.toArray()
    const activeLedgers = new Set(ledgers.filter((item) => item.status === '在用').map((item) => item.id))
    const codeOf = new Map(ledgers.map((item) => [item.id, item.code]))
    const scoped = candidates.filter(
      (item) => (ledgerId ? item.ledgerId === ledgerId : true) && activeLedgers.has(item.ledgerId)
    )
    const keyOf = (item: { ledgerId: string; recordIdA: string; recordIdB: string }): string =>
      `${item.ledgerId}|${item.recordIdA}|${item.recordIdB}`
    const candidateByKey = new Map(scoped.map((item) => [keyOf(item), item]))

    const existing = await ctx.conflicts.toArray()
    const scopedExisting = existing.filter((item) => (ledgerId ? item.ledgerId === ledgerId : true))

    // 1. 旧差异：对得上最新比对则恢复/保留，对不上则归档
    await Promise.all(
      scopedExisting.map(async (conflict) => {
        const candidate = candidateByKey.get(keyOf(conflict))
        const recordA = await ctx.records.get(conflict.recordIdA)
        const recordB = await ctx.records.get(conflict.recordIdB)
        const ledger = await ctx.ledgers.get(conflict.ledgerId)
        const stillActive = ledger?.status === '在用'
        const stillHasBasis = recordA && recordB && !recordA.voided && !recordB.voided && stillActive

        if (candidate) {
          if (conflict.stale && conflict.state === '待确认') {
            await ctx.updateRow('conflicts', conflict.id, {
              stale: false,
              staleReason: '',
              staleAt: '',
              severity: candidate.severity,
              diffDesc: candidate.diffDesc,
              updatedAt: Date.now()
            } as never)
            stats.restored += 1
            ctx.log({
              ledgerId: conflict.ledgerId,
              code: codeOf.get(conflict.ledgerId) ?? '',
              action: '差异恢复',
              detail: `差异 ${conflict.id} 重新比对后依据成立，恢复为现行差异`
            })
          }
          candidateByKey.delete(keyOf(conflict))
          return
        }

        const shouldArchive = conflict.stale || (conflict.state === '待确认' && !stillHasBasis)
        if (shouldArchive) {
          await ctx.removeRow('conflicts', conflict.id)
          stats.archived += 1
          ctx.log({
            ledgerId: conflict.ledgerId,
            code: codeOf.get(conflict.ledgerId) ?? '',
            action: '差异归档',
            detail: `差异 ${conflict.id} 重新比对后${conflict.stale ? `依据已变（${conflict.staleReason || '待重算'}）` : '失去依据'}，归档留痕`,
            snapshot: { conflict }
          })
        }
      })
    )

    // 2. 新比对结果落库
    const now = Date.now()
    await Promise.all(
      Array.from(candidateByKey.values()).map(async (candidate) => {
        const row: ConflictRow = {
          id: createId('conflict'),
          ledgerId: candidate.ledgerId,
          recordIdA: candidate.recordIdA,
          recordIdB: candidate.recordIdB,
          diffDesc: candidate.diffDesc,
          severity: candidate.severity,
          state: '待确认',
          resolvedNote: '',
          resolvedAt: '',
          stale: false,
          staleReason: '',
          staleAt: '',
          revision: ROW_REVISION,
          createdAt: now,
          updatedAt: now
        }
        await ctx.putRow('conflicts', row)
        stats.created += 1
        ctx.log({
          ledgerId: candidate.ledgerId,
          code: codeOf.get(candidate.ledgerId) ?? '',
          action: '差异生成',
          detail: `重新比对生成新差异：${candidate.diffDesc}`
        })
      })
    )
  })
  return stats
}

/** 解决差异：留痕进共同账 resolutions（已处理痕迹不随重算丢失），并回写当前基准 */
export async function resolveConflict(id: string, resolvedNote: string): Promise<void> {
  await commitWithCheckpoint(`处置差异 ${id}`, async (ctx) => {
    const conflict = await ctx.conflicts.get(id)
    if (!conflict) throw new Error('差异条目不存在')
    if (conflict.stale) throw new Error('该差异已标记待重算，请重新比对后再处置')
    const ledger = await ctx.ledgers.get(conflict.ledgerId)
    if (!ledger) throw new Error('连戏编号共同账不存在')
    const latest = await ctx.records.get(conflict.recordIdB)
    const iso = nowIso()
    const baselineState = latest && !latest.voided ? latest.currentState : ledger.baselineState

    const resolution: LedgerResolution = { conflictId: id, note: resolvedNote, at: iso, baselineState }
    await ctx.putRow('ledgers', {
      ...ledger,
      baselineState,
      resolutions: [...ledger.resolutions, resolution],
      version: ledger.version + 1,
      updatedAt: Date.now()
    })
    await ctx.updateRow('conflicts', id, {
      state: '已解决',
      resolvedNote,
      resolvedAt: iso,
      updatedAt: Date.now()
    } as never)
    ctx.log({
      ledgerId: ledger.id,
      code: ledger.code,
      action: '冲突处置',
      detail: `差异已解决：${resolvedNote}；当前基准回写为「${baselineState}」`
    })
  })
}

/** 重开差异（误判回退）；已处理痕迹保留在共同账 resolutions 中不抹除 */
export async function reopenConflict(id: string): Promise<void> {
  await commitWithCheckpoint(`重开差异 ${id}`, async (ctx) => {
    const conflict = await ctx.conflicts.get(id)
    if (!conflict) return
    await ctx.updateRow('conflicts', id, {
      state: '待确认',
      resolvedNote: '',
      resolvedAt: '',
      updatedAt: Date.now()
    } as never)
    const ledger = await ctx.ledgers.get(conflict.ledgerId)
    ctx.log({
      ledgerId: conflict.ledgerId,
      code: ledger?.code ?? '',
      action: '差异待重算',
      detail: `差异 ${id} 重新打开为待确认（已处理留痕保留在编号台账中）`
    })
  })
}

/* ============================== 场次撤场 ============================== */

/**
 * 撤下场次（删除场次）：
 * - 共同账只摘挂（sceneIds 移除），条目与基准保留；
 * - 该场现场记录软作废、相关差异立即待重算；
 * - 拍摄日清单同步摘除；场次行删除。全部痕迹进历史。
 */
export async function removeScene(id: string): Promise<void> {
  await commitWithCheckpoint('撤下场次', async (ctx) => {
    const scene = await ctx.scenes.get(id)
    if (!scene) return
    const ledgers = await ctx.ledgers.toArray()
    const affected = ledgers.filter((ledger) => ledger.sceneIds.includes(id))
    await Promise.all(
      affected.map(async (ledger) => {
        const nextSceneIds = ledger.sceneIds.filter((sceneId) => sceneId !== id)
        await ctx.updateRow('ledgers', ledger.id, { sceneIds: nextSceneIds, updatedAt: Date.now() } as never)
        ctx.log({
          ledgerId: ledger.id,
          code: ledger.code,
          action: '撤场',
          detail: `第 ${scene.sceneNo} 场撤除，编号 ${ledger.code} 摘挂保留（仍关联 ${nextSceneIds.length} 场）`
        })
      })
    )

    const records = await ctx.records.where('sceneId').equals(id).toArray()
    const affectedLedgerIds = new Set(records.map((record) => record.ledgerId).concat(affected.map((item) => item.id)))
    await Promise.all(
      records
        .filter((record) => !record.voided)
        .map((record) => ctx.updateRow('records', record.id, { sceneId: '', voided: true, updatedAt: Date.now() } as never))
    )
    await Promise.all(
      Array.from(affectedLedgerIds).map((ledgerId) =>
        markConflictsStale(ctx, ledgerId, ledgers.find((item) => item.id === ledgerId)?.code ?? '', `第 ${scene.sceneNo} 场已撤`, (conflict) => !conflict.stale && conflict.state === '待确认')
      )
    )

    const days = await ctx.shootDays.toArray()
    await Promise.all(
      days
        .filter((day) => day.sceneIds.includes(id))
        .map((day) =>
          ctx.updateRow('shootDays', day.id, {
            sceneIds: day.sceneIds.filter((sceneId) => sceneId !== id),
            updatedAt: Date.now()
          } as never)
        )
    )
    await ctx.removeRow('scenes', id)
  })
}

/* ========================== 场次基础写操作 ========================== */

export async function saveScene(row: SceneRow): Promise<void> {
  await commitWithCheckpoint(row.sceneNo ? `保存场次 ${row.sceneNo}` : '保存场次', async (ctx) => {
    const existing = await ctx.scenes.get(row.id)
    await ctx.putRow('scenes', toPlainRow({ ...row, updatedAt: Date.now() }))
    if (!existing) ctx.log({ ledgerId: '', code: '', action: '建档', detail: `新建场次 ${row.sceneNo}（${row.location}）` })
  })
}

export async function updateSceneRow(id: string, patch: Partial<Scene>): Promise<void> {
  const existing = await db.scenes.get(id)
  await commitWithCheckpoint(`更新场次 ${existing?.sceneNo ?? id}`, async (ctx) => {
    await ctx.updateRow('scenes', id, { ...patch, updatedAt: Date.now() } as never)
  })
}

/** 拖拽调序后按新顺序批量写回 shootOrder（从 1 开始自动重编号） */
export async function reorderScenes(orderedIds: string[]): Promise<void> {
  await commitWithCheckpoint('调整拍摄顺序', async (ctx) => {
    for (let index = 0; index < orderedIds.length; index += 1) {
      await ctx.updateRow('scenes', orderedIds[index], { shootOrder: index + 1, updatedAt: Date.now() } as never)
    }
  })
}

/* ============================== 隔离区 ============================== */

/**
 * 确认隔离条目：指定编号与场次，把旧档案并入（或新建）共同账；
 * 随附现场记录转挂。历史与隔离记录保留并标记已归并。
 */
export async function resolveQuarantine(
  quarantineId: string,
  payload: { code: string; sceneIds: string[]; note?: string }
): Promise<string> {
  let ledgerId = ''
  await commitWithCheckpoint(`确认隔离档案 → ${payload.code}`, async (ctx) => {
    const quar = await ctx.quarantine.get(quarantineId)
    if (!quar || quar.status !== '待确认') throw new Error('隔离条目不可处理')
    const code = payload.code.trim()
    if (!code) throw new Error('请确认连戏编号')
    const sceneIds = [...new Set(payload.sceneIds.length > 0 ? payload.sceneIds : quar.sceneId ? [quar.sceneId] : [])]
    if (sceneIds.length === 0) throw new Error('请至少关联一个场次')

    const now = Date.now()
    let ledger = (await ctx.ledgers.toArray()).find((row) => row.code.trim().toUpperCase() === code.toUpperCase())
    if (!ledger) {
      ledger = {
        id: createId('ledger'),
        code,
        sceneIds,
        category: quar.category,
        name: quar.name,
        baselineState: quar.initialState,
        owner: quar.owner,
        critical: quar.critical,
        status: '在用',
        resolutions: [],
        revision: ROW_REVISION,
        version: 1,
        createdAt: now,
        updatedAt: now
      }
      await ctx.putRow('ledgers', ledger)
      ctx.log({ ledgerId: ledger.id, code, action: '建档', detail: `隔离档案「${quar.name}」确认编号 ${code} 后建档` })
    } else {
      const mergedSceneIds = [...new Set([...ledger.sceneIds, ...sceneIds])]
      ledger = {
        ...ledger,
        sceneIds: mergedSceneIds,
        critical: ledger.critical || quar.critical,
        owner: ledger.owner || quar.owner,
        version: ledger.version + 1,
        updatedAt: now
      }
      await ctx.putRow('ledgers', ledger)
      ctx.log({ ledgerId: ledger.id, code, action: '归并', detail: `隔离档案「${quar.name}」确认后并入既有编号 ${code}，随附 ${quar.recordSnapshot.length} 条记录转挂` })
    }
    ledgerId = ledger.id

    await Promise.all(
      quar.recordSnapshot.map(async (snap, index) => {
        const row: RecordRow = {
          id: snap.id || createId('record'),
          shootDayId: snap.shootDayId,
          ledgerId: ledger!.id,
          sceneId: snap.sceneId,
          takeNo: snap.takeNo,
          currentState: snap.currentState,
          photoNote: snap.photoNote,
          recordedBy: snap.recordedBy,
          voided: false,
          revision: ROW_REVISION,
          version: 1,
          createdAt: now + index,
          updatedAt: now + index
        }
        await ctx.putRow('records', row)
      })
    )

    await ctx.updateRow('quarantine', quarantineId, {
      status: '已归并',
      resolvedAt: nowIso(),
      resolvedNote: payload.note ?? `归并到编号 ${code}`,
      resolvedLedgerId: ledger.id
    } as never)
    ctx.log({
      ledgerId: ledger.id,
      code,
      action: '隔离确认',
      detail: `隔离档案「${quar.name}」已确认，${quar.recordSnapshot.length} 条历史记录随档转挂`
    })
  })
  return ledgerId
}

/** 丢弃隔离条目：确认无需建账，条目不删除，标记「已丢弃」留痕 */
export async function discardQuarantine(quarantineId: string, note: string): Promise<void> {
  await commitWithCheckpoint('丢弃隔离档案', async (ctx) => {
    const quar = await ctx.quarantine.get(quarantineId)
    if (!quar || quar.status !== '待确认') return
    await ctx.updateRow('quarantine', quarantineId, { status: '已丢弃', resolvedAt: nowIso(), resolvedNote: note } as never)
    ctx.log({
      ledgerId: '',
      code: '（缺编号）',
      action: '隔离确认',
      detail: `隔离档案「${quar.name}」标记为已丢弃：${note || '—'}（原档保留可查）`
    })
  })
}

/* ============================ 整库导入导出 ============================ */

export interface DatabaseSnapshot {
  name: string
  schemaVersion: number
  exportedAt: string
  scenes: Scene[]
  ledgers: Ledger[]
  shootDays: ShootDay[]
  records: ContinuityRecord[]
  conflicts: Conflict[]
  history: LedgerHistoryEntry[]
  quarantine: QuarantineItem[]
}

function stripMeta<T>(row: T): T {
  const copy = { ...(row as Record<string, unknown>) }
  delete copy.revision
  delete copy.createdAt
  delete copy.updatedAt
  return copy as T
}

export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [scenes, ledgers, shootDays, records, conflicts, history, quarantine] = await Promise.all([
    db.scenes.toArray(),
    db.ledgers.toArray(),
    db.shootDays.toArray(),
    db.records.toArray(),
    db.conflicts.toArray(),
    db.history.toArray(),
    db.quarantine.toArray()
  ])
  return {
    name: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: nowIso(),
    scenes: scenes.map(stripMeta),
    ledgers: ledgers.map(stripMeta) as unknown as Ledger[],
    shootDays: shootDays.map(stripMeta),
    records: records.map(stripMeta) as unknown as ContinuityRecord[],
    conflicts: conflicts.map(stripMeta) as unknown as Conflict[],
    history,
    quarantine
  }
}

function stampRow<T extends object>(row: T, versioned: boolean): T & Revisioned & Partial<Versioned> {
  const now = Date.now()
  const source = row as T & Partial<Revisioned & Versioned>
  const stamped: T & Revisioned & Partial<Versioned> = {
    ...source,
    revision: typeof source.revision === 'number' ? source.revision : ROW_REVISION,
    createdAt: typeof source.createdAt === 'number' ? source.createdAt : now,
    updatedAt: typeof source.updatedAt === 'number' ? source.updatedAt : now
  }
  if (versioned) stamped.version = typeof source.version === 'number' ? source.version : 1
  return stamped
}

/** v1 备份（含 elements/elementId）转 v2 行 */
export function convertLegacySnapshot(raw: Record<string, unknown>): DatabaseSnapshot {
  const migrated = migrateV1ToV2({
    scenes: (raw.scenes as Scene[]) ?? [],
    shootDays: (raw.shootDays as ShootDay[]) ?? [],
    elements: (raw.elements as LegacyElement[]) ?? [],
    records: ((raw.records as Array<Partial<LegacyRecord>>) ?? []).map((item) => ({
      id: String(item.id ?? ''),
      shootDayId: String(item.shootDayId ?? ''),
      elementId: String(item.elementId ?? ''),
      sceneId: String(item.sceneId ?? ''),
      takeNo: String(item.takeNo ?? ''),
      currentState: String(item.currentState ?? ''),
      photoNote: String(item.photoNote ?? ''),
      recordedBy: String(item.recordedBy ?? '')
    })),
    conflicts: ((raw.conflicts as Array<Partial<LegacyConflict>>) ?? []).map((item) => ({
      id: String(item.id ?? ''),
      elementId: String(item.elementId ?? ''),
      recordIdA: String(item.recordIdA ?? ''),
      recordIdB: String(item.recordIdB ?? ''),
      diffDesc: String(item.diffDesc ?? ''),
      severity: (item.severity as Conflict['severity']) ?? '轻微',
      state: (item.state as Conflict['state']) ?? '待确认',
      resolvedNote: String(item.resolvedNote ?? ''),
      resolvedAt: String(item.resolvedAt ?? '')
    }))
  })
  return {
    name: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: nowIso(),
    scenes: (raw.scenes as Scene[]) ?? [],
    ledgers: migrated.ledgers,
    shootDays: (raw.shootDays as ShootDay[]) ?? [],
    records: migrated.records,
    conflicts: migrated.conflicts,
    history: migrated.history,
    quarantine: migrated.quarantine
  }
}

/** 识别备份 JSON 是 v1（有 elements）还是 v2（返回普通布尔，不收窄类型） */
export function isLegacySnapshot(raw: unknown): boolean {
  return typeof raw === 'object' && raw !== null && Array.isArray((raw as { elements?: unknown }).elements)
}

export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  const txTables: Table[] = [db.scenes, db.ledgers, db.shootDays, db.records, db.conflicts, db.history, db.quarantine, db.checkpoints]
  await db.transaction('rw', txTables, async () => {
      await Promise.all([
        db.scenes.clear(),
        db.ledgers.clear(),
        db.shootDays.clear(),
        db.records.clear(),
        db.conflicts.clear(),
        db.history.clear(),
        db.quarantine.clear(),
        db.checkpoints.clear()
      ])
      const importHistory: HistoryRow = {
        id: createId('hist'),
        at: nowIso(),
        ledgerId: '',
        code: '',
        action: '导入',
        detail: `导入整库备份（${snapshot.ledgers.length} 个编号 / ${snapshot.records.length} 条记录）`,
        snapshot: { schemaVersion: snapshot.schemaVersion }
      }
      await db.scenes.bulkPut((snapshot.scenes as SceneRow[]).map((row) => stampRow(row, false) as SceneRow))
      await db.ledgers.bulkPut(
        (snapshot.ledgers as LedgerRow[]).map((row) => ({
          ...stampRow(row, true),
          resolutions: Array.isArray(row.resolutions) ? row.resolutions : [],
          status: row.status ?? '在用'
        }))
      )
      await db.shootDays.bulkPut((snapshot.shootDays as ShootDayRow[]).map((row) => stampRow(row, false) as ShootDayRow))
      await db.records.bulkPut(
        (snapshot.records as RecordRow[]).map((row) => ({
          ...stampRow(row, true),
          voided: Boolean(row.voided)
        }))
      )
      await db.conflicts.bulkPut(
        (snapshot.conflicts as ConflictRow[]).map((row) => ({
          ...stampRow(row, false),
          stale: Boolean(row.stale),
          staleReason: row.staleReason ?? '',
          staleAt: row.staleAt ?? ''
        }))
      )
      await db.quarantine.bulkPut(toPlainRow(snapshot.quarantine ?? []))
      await db.history.bulkPut(toPlainRow([...(snapshot.history ?? []), importHistory]))
    }
  )
}

/** 清空全部数据并重新灌入演示数据 */
export async function resetDatabase(): Promise<void> {
  const txTables: Table[] = [db.scenes, db.ledgers, db.shootDays, db.records, db.conflicts, db.history, db.quarantine, db.checkpoints]
  await db.transaction('rw', txTables, async () => {
      await Promise.all([
        db.scenes.clear(),
        db.ledgers.clear(),
        db.shootDays.clear(),
        db.records.clear(),
        db.conflicts.clear(),
        db.history.clear(),
        db.quarantine.clear(),
        db.checkpoints.clear()
      ])
    }
  )
  await seedDatabase()
}

/** 各表行数统计 */
export async function countAll(): Promise<Record<string, number>> {
  const [scenes, ledgers, shootDays, records, conflicts, history, quarantine] = await Promise.all([
    db.scenes.count(),
    db.ledgers.count(),
    db.shootDays.count(),
    db.records.count(),
    db.conflicts.count(),
    db.history.count(),
    db.quarantine.count()
  ])
  return { scenes, ledgers, shootDays, records, conflicts, history, quarantine }
}
