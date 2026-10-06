/**
 * IndexedDB 持久化层（Dexie 封装）—— 连戏共同账版本
 *
 * 库名 gbcontinuity-db，结构版本 v2：
 * - ledgers 连戏共同账：一个连戏编号挂多场，只认一份当前基准（version 乐观锁）
 * - ledgerHistory 共同账变更历史（不可物理删除）
 * - ledgerDrafts 并发提交落后一方的表格草稿（列出双方不同字段）
 * - quarantine 缺编号旧档案的隔离区（待确认）
 * - scenes / elements / shootDays / records / conflicts 原有五表，全部按编号归账
 *
 * 关键规则：
 * - v1 旧库升级时，重复档案按连戏编号（同名同类别即同编号）归并，缺编号的隔离待确认
 * - 场次撤下 / 道具停用 / 现场记录更新后，涉及差异立即置「待重算」，报告风险同步剔除
 * - 共同账写入在单个 rw 事务内完成，失败自动回滚；并另存提交前账面快照供显式恢复
 */
import Dexie, { type Table } from 'dexie'
import { toRaw } from 'vue'
import type { Scene } from '../types/scene'
import type { Element } from '../types/element'
import type { ShootDay } from '../types/shootDay'
import type { Record as ContinuityRecord } from '../types/record'
import type { Conflict } from '../types/conflict'
import type {
  ContinuityLedger,
  LedgerDraft,
  LedgerHistoryEntry,
  QuarantineItem
} from '../types/ledger'
import { nowIso } from './uuid'
import { createId } from './uuid'
import { describeDiffs, diffRecords, severityOf } from './diff'
import { seedDatabase } from './seed'

/** 数据库名 */
export const DB_NAME = 'gbcontinuity-db'

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 2

/** 行结构修订号 */
export const ROW_REVISION = 2

/** 带时间戳与修订号的持久化实体 */
export interface Revisioned {
  revision: number
  createdAt: number
  updatedAt: number
}

export type SceneRow = Scene & Revisioned
export type ElementRow = Element & Revisioned
export type ShootDayRow = ShootDay & Revisioned
export type RecordRow = ContinuityRecord & Revisioned
export type ConflictRow = Conflict & Revisioned
export type LedgerRow = ContinuityLedger & Revisioned
export type LedgerHistoryRow = LedgerHistoryEntry & Revisioned
export type LedgerDraftRow = LedgerDraft & { revision: number; updatedAt: number }
export type QuarantineRow = QuarantineItem

/**
 * 深度剥掉 Vue 响应式代理（Proxy），得到可被 IndexedDB 结构化克隆的普通对象。
 * 页面里 `v-model` 绑定的数组字段（如 `ShootDay.sceneIds`）是 Vue 的 Proxy 数组，
 * 直接交给 Dexie 会抛 `DataCloneError: [object Object] could not be cloned`，
 * 表现为“保存按钮点了没反应、列表不增加、刷新后丢失”。所有写库入口都必须先过这一层。
 */
export function toPlainRow<T>(value: T): T {
  const raw = toRaw(value) as unknown
  if (Array.isArray(raw)) return raw.map((item) => toPlainRow(item)) as unknown as T
  if (raw !== null && typeof raw === 'object') {
    const proto = Object.getPrototypeOf(raw)
    // 只深拷贝普通对象/数组，Date、Map 等结构化克隆本身支持的对象原样返回
    if (proto === Object.prototype || proto === null) {
      const plain: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(raw)) plain[key] = toPlainRow(item)
      return plain as T
    }
  }
  return raw as T
}

class GbContinuityDatabase extends Dexie {
  scenes!: Table<SceneRow, string>
  elements!: Table<ElementRow, string>
  shootDays!: Table<ShootDayRow, string>
  records!: Table<RecordRow, string>
  conflicts!: Table<ConflictRow, string>
  ledgers!: Table<LedgerRow, string>
  ledgerHistory!: Table<LedgerHistoryRow, string>
  ledgerDrafts!: Table<LedgerDraftRow, string>
  quarantine!: Table<QuarantineRow, string>

  constructor() {
    super(DB_NAME)

    // v1（保留给旧库识别）：五张表
    this.version(1).stores({
      scenes: 'id, sceneNo, place, timeOfDay, shootOrder, state, updatedAt',
      elements: 'id, sceneId, category, name, owner, critical, updatedAt',
      shootDays: 'id, date, director, scripty, updatedAt',
      records: 'id, shootDayId, elementId, sceneId, takeNo, updatedAt',
      conflicts: 'id, elementId, recordIdA, recordIdB, severity, state, updatedAt'
    })

    // v2：共同账四表 + 老表补编号 / 状态 / 待重算索引
    this.version(2)
      .stores({
        scenes: 'id, sceneNo, place, timeOfDay, shootOrder, state, withdrawn, updatedAt',
        elements: 'id, sceneId, ledgerId, continuityNo, category, name, owner, critical, status, updatedAt',
        shootDays: 'id, date, director, scripty, updatedAt',
        records: 'id, shootDayId, elementId, ledgerId, continuityNo, sceneId, takeNo, updatedAt',
        conflicts: 'id, ledgerId, continuityNo, elementId, recordIdA, recordIdB, severity, state, stale, updatedAt',
        ledgers: 'id, code, category, name, owner, critical, status, version, updatedAt',
        ledgerHistory: 'id, ledgerId, code, action, at',
        ledgerDrafts: 'id, ledgerId, code, createdAt',
        quarantine: 'id, sourceElementId, state, createdAt'
      })
      .upgrade(async () => {
        // upgrade 回调自带事务，直接用 db 表访问
        await migrateV1ToV2()
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

/* ========================================================================== */
/* v1 → v2 迁移：旧重复档案按编号归并，缺编号的隔离待确认                          */
/* ========================================================================== */

/** 旧档案识别键：同名同类即视为同一个连戏编号（编号跨场次沿用的旧建档方式） */
function legacyGroupKey(element: { name?: string; category?: string }): string {
  const name = String(element.name ?? '').trim().replace(/\s+/g, '')
  const category = String(element.category ?? '').trim()
  return `${category}::${name}`
}

/**
 * 升级迁移（也被旧备份导入复用）：
 * 1. 缺名称（= 缺编号）的要素档案整份快照进隔离区，不并账、不丢弃
 * 2. 同名同类的重复档案归并成一份共同账，要素回填 ledgerId / continuityNo
 * 3. 现场记录、差异按要素映射回填编号与重算字段
 */
export async function migrateV1ToV2(): Promise<void> {
  const oldElements = (await db.elements.toArray()) as ElementRow[]
  const oldScenes = (await db.scenes.toArray()) as SceneRow[]

  // 场次补 withdrawn
  for (const scene of oldScenes) {
    if (typeof scene.withdrawn !== 'boolean') scene.withdrawn = false
  }
  await db.scenes.bulkPut(oldScenes)

  const groups = new Map<string, ElementRow[]>()
  const orphan: ElementRow[] = []
  oldElements.forEach((element) => {
    if (!String(element.name ?? '').trim()) {
      orphan.push(element)
      return
    }
    const key = legacyGroupKey(element)
    const list = groups.get(key) ?? []
    list.push(element)
    groups.set(key, list)
  })

  const now = Date.now()
  const elementLedgerMap = new Map<string, string>()
  const elementCodeMap = new Map<string, string>()
  const ledgerRows: LedgerRow[] = []
  const historyRows: LedgerHistoryRow[] = []
  const quarantineRows: QuarantineRow[] = []
  let seq = 0

  groups.forEach((members) => {
    seq += 1
    const code = `LX-${String(seq).padStart(3, '0')}`
    const first = members[0]
    const ledgerId = `lg-${seq}`
    const sceneIds = Array.from(new Set(members.map((item) => item.sceneId).filter(Boolean)))
    const owner = members.map((item) => item.owner).find((item) => item && item.trim()) ?? first.owner
    const ledger: LedgerRow = {
      id: ledgerId,
      code,
      category: first.category,
      name: first.name.trim(),
      sceneIds,
      baseline: { state: first.initialState, photoNote: '' },
      owner,
      critical: members.some((item) => item.critical),
      status: '在用',
      version: 1,
      revision: ROW_REVISION,
      createdAt: now,
      updatedAt: now
    }
    ledgerRows.push(ledger)
    members.forEach((item) => {
      elementLedgerMap.set(item.id, ledgerId)
      elementCodeMap.set(item.id, code)
    })
    historyRows.push({
      id: createId('lgh'),
      ledgerId,
      code,
      action: '旧档归并',
      detail:
        members.length > 1
          ? `旧库中 ${members.length} 份重复档案（${members.map((m) => m.id).join('、')}）按编号 ${code} 归并为一份共同账`
          : `旧档案按编号 ${code} 归入共同账`,
      actor: '系统迁移',
      before: null,
      after: { code, sceneIds },
      at: nowIso(),
      revision: ROW_REVISION,
      createdAt: now,
      updatedAt: now
    })
  })

  // 缺编号档案：整份快照隔离，从主要素表移出，待人工确认
  for (const element of orphan) {
    quarantineRows.push({
      id: createId('qt'),
      sourceElementId: element.id,
      snapshot: { ...toPlainRow(element) },
      state: '待确认',
      reason: '旧档案缺少连戏编号（名称为空），已隔离待人工确认',
      createdAt: now,
      updatedAt: now
    })
  }

  // 回填要素
  const migratedElements: ElementRow[] = []
  oldElements.forEach((element) => {
    const ledgerId = elementLedgerMap.get(element.id)
    if (!ledgerId) return // 缺编号的已隔离，移出主表
    migratedElements.push({
      ...element,
      ledgerId,
      continuityNo: elementCodeMap.get(element.id) ?? '',
      status: '在用',
      updatedAt: now
    })
  })

  // 回填现场记录
  const oldRecords = (await db.records.toArray()) as RecordRow[]
  const migratedRecords: RecordRow[] = oldRecords.map((record) => ({
    ...record,
    ledgerId: elementLedgerMap.get(record.elementId) ?? record.ledgerId ?? '',
    continuityNo: elementCodeMap.get(record.elementId) ?? record.continuityNo ?? '',
    updatedAt: now
  }))

  // 回填差异；隔离档案涉及的差异置待重算（旧档归并）
  const oldConflicts = (await db.conflicts.toArray()) as ConflictRow[]
  const migratedConflicts: ConflictRow[] = oldConflicts.map((conflict) => {
    const ledgerId = elementLedgerMap.get(conflict.elementId)
    const quarantined = !ledgerId
    return {
      ...conflict,
      ledgerId: ledgerId ?? conflict.ledgerId ?? '',
      continuityNo: elementCodeMap.get(conflict.elementId) ?? conflict.continuityNo ?? '',
      stale: quarantined ? '待重算' : '现行',
      staleReason: quarantined ? '旧档归并' : '',
      updatedAt: now
    }
  })

  await db.scenes.bulkPut(oldScenes.map((s) => ({ ...s, withdrawn: s.withdrawn ?? false })))
  await db.elements.clear()
  await db.elements.bulkPut(migratedElements)
  await db.records.clear()
  await db.records.bulkPut(migratedRecords)
  await db.conflicts.clear()
  await db.conflicts.bulkPut(migratedConflicts)
  await db.ledgers.bulkPut(ledgerRows)
  await db.ledgerHistory.bulkPut(historyRows)
  await db.quarantine.bulkPut(quarantineRows)
}

/* ========================================================================== */
/* 通用小工具                                                                   */
/* ========================================================================== */

function stamp<T>(row: T): T & Revisioned {
  const now = Date.now()
  return { ...row, revision: ROW_REVISION, createdAt: now, updatedAt: now }
}

async function addHistory(
  ledgerId: string,
  code: string,
  action: string,
  detail: string,
  actor: string,
  before: Partial<ContinuityLedger> | null,
  after: Partial<ContinuityLedger> | null
): Promise<void> {
  const now = Date.now()
  await db.ledgerHistory.put(
    toPlainRow({
      id: createId('lgh'),
      ledgerId,
      code,
      action,
      detail,
      actor: actor || '未署名',
      before,
      after,
      at: nowIso(),
      revision: ROW_REVISION,
      createdAt: now,
      updatedAt: now
    })
  )
}

/** 把命中的差异置为待重算（场次撤下 / 道具停用 / 记录更新 / 基准变更） */
async function markConflictsStale(
  predicate: (conflict: ConflictRow) => boolean,
  reason: string
): Promise<number> {
  let count = 0
  await db.conflicts.toCollection().modify((conflict) => {
    if (conflict.stale === '待重算' || !predicate(conflict)) return
    conflict.stale = '待重算'
    conflict.staleReason = reason
    conflict.updatedAt = Date.now()
    count += 1
  })
  return count
}

/* ------------------------------ 场次 ------------------------------ */

export async function listScenes(): Promise<SceneRow[]> {
  const rows = await db.scenes.toArray()
  return rows.sort((a, b) => a.shootOrder - b.shootOrder)
}

export async function putScene(row: SceneRow): Promise<void> {
  await db.scenes.put(toPlainRow({ ...row, withdrawn: row.withdrawn ?? false }))
}

export async function updateScene(id: string, patch: Partial<Scene>): Promise<void> {
  await db.scenes.update(id, toPlainRow({ ...patch, updatedAt: Date.now() }) as never)
}

/** 拖拽调序后按新顺序批量写回 shootOrder（从 1 开始自动重编号）；撤下的场次不占顺序号 */
export async function reorderScenes(orderedIds: string[]): Promise<void> {
  await db.transaction('rw', db.scenes, async () => {
    for (let index = 0; index < orderedIds.length; index += 1) {
      await db.scenes.update(orderedIds[index], { shootOrder: index + 1, updatedAt: Date.now() } as never)
    }
  })
}

/** 下一个可用拍摄顺序号 */
export async function nextShootOrder(): Promise<number> {
  const rows = await db.scenes.toArray()
  return rows.reduce((max, row) => Math.max(max, row.shootOrder), 0) + 1
}

/**
 * 撤下场次：不做物理删除。
 * 场次标记 withdrawn、退出拍摄日清单，要素 / 记录 / 差异全部保留，
 * 涉及差异立即转待重算（原因：场次撤下），各关联共同账留痕。
 */
export async function withdrawScene(id: string, actor = '现场'): Promise<void> {
  await db.transaction(
    'rw',
    [db.scenes, db.shootDays, db.elements, db.records, db.conflicts, db.ledgers, db.ledgerHistory],
    async () => {
      const scene = await db.scenes.get(id)
      if (!scene || scene.withdrawn) return
      const now = Date.now()
      await db.scenes.update(id, { withdrawn: true, updatedAt: now } as never)
      await db.shootDays.toCollection().modify((day) => {
        if (day.sceneIds.includes(id)) {
          day.sceneIds = day.sceneIds.filter((sceneId) => sceneId !== id)
          day.updatedAt = now
        }
      })
      const elementIds = new Set((await db.elements.where('sceneId').equals(id).toArray()).map((item) => item.id))
      const recordIds = new Set((await db.records.where('sceneId').equals(id).toArray()).map((r) => r.id))
      await markConflictsStale(
        (conflict) =>
          elementIds.has(conflict.elementId) || recordIds.has(conflict.recordIdA) || recordIds.has(conflict.recordIdB),
        '场次撤下'
      )
      const ledgers = await db.ledgers.toArray()
      for (const ledger of ledgers.filter((item) => item.sceneIds.includes(id))) {
        await addHistory(
          ledger.id,
          ledger.code,
          '撤下场次',
          `第 ${scene.sceneNo} 场撤下，相关差异转为待重算，历史记录保留`,
          actor,
          { sceneIds: ledger.sceneIds },
          null
        )
      }
    }
  )
}

/** 恢复撤下的场次：重新进入排程，相关差异仍需重新比对确认 */
export async function restoreScene(id: string, actor = '现场'): Promise<void> {
  await db.transaction('rw', [db.scenes, db.elements, db.conflicts, db.ledgers, db.ledgerHistory], async () => {
    const scene = await db.scenes.get(id)
    if (!scene || !scene.withdrawn) return
    const now = Date.now()
    await db.scenes.update(id, { withdrawn: false, updatedAt: now } as never)
    const elementIds = (await db.elements.where('sceneId').equals(id).toArray()).map((item) => item.id)
    await markConflictsStale((conflict) => elementIds.includes(conflict.elementId), '场次撤下')
    const ledgers = await db.ledgers.filter((item) => item.sceneIds.includes(id)).toArray()
    for (const ledger of ledgers) {
      await addHistory(ledger.id, ledger.code, '场次恢复', `第 ${scene.sceneNo} 场恢复排程，差异需重新比对`, actor, null, null)
    }
  })
}

/** 彻底删除场次（仅对撤下后的误建场次）：级联删除并在共同账留痕 */
export async function purgeScene(id: string, actor = '现场'): Promise<void> {
  await db.transaction(
    'rw',
    [db.scenes, db.elements, db.records, db.conflicts, db.shootDays, db.ledgers, db.ledgerHistory],
    async () => {
      const scene = await db.scenes.get(id)
      const elements = await db.elements.where('sceneId').equals(id).toArray()
      const elementIds = elements.map((item) => item.id)
      const records = await db.records.where('sceneId').equals(id).toArray()
      const recordIds = new Set(records.map((item) => item.id))
      const ledgers = await db.ledgers.toArray()
      for (const ledger of ledgers.filter((item) => item.sceneIds.includes(id))) {
        await addHistory(
          ledger.id,
          ledger.code,
          '场次删除',
          `第 ${scene?.sceneNo ?? '?'} 场被彻底删除，其要素与现场记录一并移除`,
          actor,
          { sceneIds: ledger.sceneIds },
          { sceneIds: ledger.sceneIds.filter((sceneId) => sceneId !== id) }
        )
        await db.ledgers.update(ledger.id, {
          sceneIds: ledger.sceneIds.filter((sceneId) => sceneId !== id),
          updatedAt: Date.now()
        } as never)
      }
      if (elementIds.length > 0) await db.conflicts.where('elementId').anyOf(elementIds).delete()
      await db.conflicts.filter((item) => recordIds.has(item.recordIdA) || recordIds.has(item.recordIdB)).delete()
      await db.records.where('sceneId').equals(id).delete()
      await db.elements.where('sceneId').equals(id).delete()
      await db.shootDays.toCollection().modify((day) => {
        if (day.sceneIds.includes(id)) day.sceneIds = day.sceneIds.filter((sceneId) => sceneId !== id)
      })
      await db.scenes.delete(id)
    }
  )
}

/* ---------------------------- 连戏要素 ---------------------------- */

export async function listElements(): Promise<ElementRow[]> {
  const rows = await db.elements.toArray()
  return rows.sort((a, b) => a.category.localeCompare(b.category, 'zh-Hans-CN') || a.name.localeCompare(b.name, 'zh-Hans-CN'))
}

export async function putElement(row: ElementRow): Promise<void> {
  await db.elements.put(toPlainRow(row))
}

/**
 * 更新要素（场次侧落点）。名称 / 责任人 / 关键标记 / 基准状态同步回共同账，
 * 保证“一个编号只认一份当前基准”；基准变化时相关差异立即待重算。
 */
export async function updateElement(id: string, patch: Partial<Element>, actor = '现场'): Promise<void> {
  await db.transaction('rw', [db.elements, db.ledgers, db.ledgerHistory, db.conflicts], async () => {
    const current = await db.elements.get(id)
    if (!current) return
    const now = Date.now()
    await db.elements.update(id, toPlainRow({ ...patch, updatedAt: now }) as never)
    if (!current.ledgerId) return
    const ledger = await db.ledgers.get(current.ledgerId)
    if (!ledger) return
    const ledgerPatch: Partial<ContinuityLedger> = {}
    if (patch.name && patch.name !== ledger.name) ledgerPatch.name = patch.name
    if (patch.owner !== undefined && patch.owner !== ledger.owner) ledgerPatch.owner = patch.owner
    if (patch.critical !== undefined && patch.critical !== ledger.critical) ledgerPatch.critical = patch.critical
    if (patch.initialState && patch.initialState !== ledger.baseline.state) {
      ledgerPatch.baseline = { ...ledger.baseline, state: patch.initialState }
    }
    if (patch.sceneId && !ledger.sceneIds.includes(patch.sceneId)) {
      ledgerPatch.sceneIds = [...ledger.sceneIds, patch.sceneId]
    }
    if (Object.keys(ledgerPatch).length > 0) {
      await db.ledgers.update(ledger.id, { ...ledgerPatch, version: ledger.version + 1, updatedAt: now } as never)
      await addHistory(
        ledger.id,
        ledger.code,
        '基准变更',
        `场次侧修改同步到共同账：${Object.keys(ledgerPatch).join('、')}`,
        actor,
        { name: ledger.name, owner: ledger.owner, baseline: ledger.baseline },
        ledgerPatch
      )
      if (ledgerPatch.baseline) await markConflictsStale((c) => c.ledgerId === ledger.id, '基准变更')
    }
  })
}

/** 停用 / 启用道具：停用后涉及差异立即待重算（原因：道具停用），历史保留 */
export async function setElementStatus(id: string, status: Element['status'], actor = '现场'): Promise<void> {
  await db.transaction('rw', [db.elements, db.ledgers, db.ledgerHistory, db.conflicts], async () => {
    const element = await db.elements.get(id)
    if (!element) return
    const now = Date.now()
    await db.elements.update(id, { status, updatedAt: now } as never)
    await markConflictsStale((conflict) => conflict.elementId === id, status === '停用' ? '道具停用' : '道具停用')
    if (element.ledgerId) {
      const ledger = await db.ledgers.get(element.ledgerId)
      if (ledger) {
        const nextStatus = status === '停用' ? '停用' : '在用'
        await db.ledgers.update(ledger.id, { status: nextStatus, updatedAt: now } as never)
        await addHistory(
          ledger.id,
          ledger.code,
          status === '停用' ? '停用' : '重新启用',
          status === '停用' ? '道具停用，相关差异转为待重算，历史记录保留' : '道具重新启用',
          actor,
          { status: ledger.status },
          { status: nextStatus }
        )
      }
    }
  })
}

export async function removeElement(id: string): Promise<void> {
  await db.transaction('rw', [db.elements, db.records, db.conflicts], async () => {
    await db.conflicts.where('elementId').equals(id).delete()
    await db.records.where('elementId').equals(id).delete()
    await db.elements.delete(id)
  })
}

/* ------------------------------ 拍摄日 ------------------------------ */

export async function listShootDays(): Promise<ShootDayRow[]> {
  const rows = await db.shootDays.toArray()
  return rows
    .filter((day) => day.sceneIds.length > 0)
    .sort((a, b) => b.date.localeCompare(a.date))
}

export async function putShootDay(row: ShootDayRow): Promise<void> {
  await db.shootDays.put(toPlainRow(row))
}

export async function updateShootDay(id: string, patch: Partial<ShootDay>): Promise<void> {
  await db.shootDays.update(id, toPlainRow({ ...patch, updatedAt: Date.now() }) as never)
}

/** 删除拍摄日：当日记录移除，涉及差异不删除而是转待重算（现场记录更新） */
export async function removeShootDay(id: string): Promise<void> {
  await db.transaction('rw', [db.shootDays, db.records, db.conflicts], async () => {
    const records = await db.records.where('shootDayId').equals(id).toArray()
    const recordIds = new Set(records.map((item) => item.id))
    if (recordIds.size > 0) {
      await markConflictsStale((item) => recordIds.has(item.recordIdA) || recordIds.has(item.recordIdB), '现场记录更新')
    }
    await db.records.where('shootDayId').equals(id).delete()
    await db.shootDays.delete(id)
  })
}

/* ---------------------------- 现场记录 ---------------------------- */

export async function listRecords(): Promise<RecordRow[]> {
  const rows = await db.records.toArray()
  return rows.sort((a, b) => a.takeNo.localeCompare(b.takeNo, 'zh-Hans-CN'))
}

/** 写入现场记录：自动带出要素所属共同账编号 */
export async function putRecord(row: RecordRow): Promise<void> {
  const element = await db.elements.get(row.elementId)
  const next: RecordRow = {
    ...toPlainRow(row),
    ledgerId: element?.ledgerId ?? row.ledgerId ?? '',
    continuityNo: element?.continuityNo ?? row.continuityNo ?? ''
  }
  await db.records.put(next)
}

/** 新建现场记录：同编号差异不受影响（形成新快照），返回归档行 */
export async function createRecordRow(row: RecordRow): Promise<RecordRow> {
  await putRecord(row)
  return (await db.records.get(row.id))!
}

/** 更新现场记录：涉及它的差异立即转待重算（现场记录更新），已解决的也回到待确认 */
export async function updateRecord(id: string, patch: Partial<ContinuityRecord>): Promise<void> {
  await db.transaction('rw', [db.records, db.conflicts, db.ledgers, db.ledgerHistory], async () => {
    const current = await db.records.get(id)
    if (!current) return
    const now = Date.now()
    await db.records.update(id, toPlainRow({ ...patch, updatedAt: now }) as never)
    let reopened = 0
    await db.conflicts.toCollection().modify((conflict) => {
      if (conflict.recordIdA !== id && conflict.recordIdB !== id) return
      if (conflict.stale !== '待重算') {
        conflict.stale = '待重算'
        conflict.staleReason = '现场记录更新'
        conflict.updatedAt = now
        reopened += 1
      }
      if (conflict.state === '已解决') {
        conflict.state = '待确认'
        conflict.updatedAt = now
      }
    })
    if (reopened > 0 && current.ledgerId) {
      const ledger = await db.ledgers.get(current.ledgerId)
      if (ledger) {
        await addHistory(
          ledger.id,
          ledger.code,
          '差异处置',
          `现场记录 ${current.takeNo} 更新，${reopened} 条差异回到待重算`,
          patch.recordedBy || '现场',
          null,
          null
        )
      }
    }
  })
}

/** 删除现场记录：差异不直接删，转待重算 */
export async function removeRecord(id: string): Promise<void> {
  await db.transaction('rw', [db.records, db.conflicts], async () => {
    await markConflictsStale((item) => item.recordIdA === id || item.recordIdB === id, '现场记录更新')
    await db.records.delete(id)
  })
}

/* ---------------------------- 连戏差异 ---------------------------- */

export async function listConflicts(): Promise<ConflictRow[]> {
  return db.conflicts.toArray()
}

export async function putConflict(row: ConflictRow): Promise<void> {
  await db.conflicts.put(toPlainRow(row))
}

/** 解决差异：写入解决留痕、回写要素初始状态，并把条目标记回现行；共同账留痕 */
export async function resolveConflict(id: string, resolvedNote: string, actor = '现场'): Promise<void> {
  await db.transaction('rw', [db.conflicts, db.records, db.elements, db.ledgers, db.ledgerHistory], async () => {
    const conflict = await db.conflicts.get(id)
    if (!conflict) throw new Error('差异条目不存在')
    const latest = await db.records.get(conflict.recordIdB)
    await db.conflicts.update(id, {
      state: '已解决',
      resolvedNote,
      resolvedAt: nowIso(),
      stale: '现行',
      staleReason: '',
      updatedAt: Date.now()
    } as never)
    if (latest) {
      await db.elements.update(conflict.elementId, {
        initialState: latest.currentState,
        updatedAt: Date.now()
      } as never)
      if (conflict.ledgerId) {
        const ledger = await db.ledgers.get(conflict.ledgerId)
        if (ledger) {
          await db.ledgers.update(conflict.ledgerId, {
            baseline: { ...ledger.baseline, state: latest.currentState },
            version: ledger.version + 1,
            updatedAt: Date.now()
          } as never)
          await addHistory(ledger.id, ledger.code, '差异处置', `差异解决并回写基准：${resolvedNote}`, actor, null, null)
        }
      }
    }
  })
}

/** 重新打开差异（误判回退）：保留解决留痕文本与时间 */
export async function reopenConflict(id: string): Promise<void> {
  await db.conflicts.update(id, { state: '待确认', updatedAt: Date.now() } as never)
}

export async function removeConflict(id: string): Promise<void> {
  await db.conflicts.delete(id)
}

/**
 * 全量重算（差异页「重新比对」）：
 * - 每个在用共同账取时间轴最近两次现场记录做字段级比对
 * - 命中待重算条目：刷新描述/严重程度并回到现行；无差异则自动关闭并留痕
 * - 待重算但已无法复现（场次撤下 / 道具停用 / 记录不足）：自动关闭并留痕
 * - 现行的历史条目一律保留，不删除
 */
export interface ReconcileStats {
  created: number
  updated: number
  closed: number
}

export async function reconcileConflicts(actor = '现场'): Promise<ReconcileStats> {
  const stats: ReconcileStats = { created: 0, updated: 0, closed: 0 }
  await db.transaction(
    'rw',
    [db.ledgers, db.records, db.conflicts, db.scenes, db.elements, db.shootDays, db.ledgerHistory],
    async () => {
      const [ledgers, records, conflicts, scenes, elements, shootDays] = await Promise.all([
        db.ledgers.toArray(),
        db.records.toArray(),
        db.conflicts.toArray(),
        db.scenes.toArray(),
        db.elements.toArray(),
        db.shootDays.toArray()
      ])
      const withdrawnScenes = new Set(scenes.filter((s) => s.withdrawn).map((s) => s.id))
      const dateOf = (record: RecordRow): string =>
        shootDays.find((day) => day.id === record.shootDayId)?.date ?? ''

      const staleByLedger = new Map<string, ConflictRow[]>()
      conflicts.forEach((conflict) => {
        if (conflict.stale !== '待重算') return
        const list = staleByLedger.get(conflict.ledgerId) ?? []
        list.push(conflict)
        staleByLedger.set(conflict.ledgerId, list)
      })

      for (const ledger of ledgers) {
        const usable = records
          .filter(
            (record) =>
              record.ledgerId === ledger.id &&
              !withdrawnScenes.has(record.sceneId) &&
              ledger.status === '在用'
          )
          .sort(
            (a, b) => dateOf(a).localeCompare(dateOf(b)) || a.takeNo.localeCompare(b.takeNo, 'zh-Hans-CN')
          )

        const pending = staleByLedger.get(ledger.id) ?? []

        if (usable.length < 2) {
          for (const conflict of pending) {
            await db.conflicts.update(conflict.id, {
              state: '已解决',
              stale: '现行',
              staleReason: '',
              resolvedNote: `重算时已无法复现（${conflict.staleReason || '依据不足'}），系统自动关闭，历史保留`,
              resolvedAt: nowIso(),
              updatedAt: Date.now()
            } as never)
            stats.closed += 1
          }
          continue
        }

        const a = usable[usable.length - 2]
        const b = usable[usable.length - 1]
        const critical = elements.some((item) => item.ledgerId === ledger.id && item.critical) || ledger.critical
        const diffs = diffRecords(a, b)
        const severity = severityOf(diffs, critical)
        const matched = pending.find(
          (conflict) =>
            (conflict.recordIdA === a.id && conflict.recordIdB === b.id) ||
            (conflict.recordIdA === b.id && conflict.recordIdB === a.id)
        )
        // 同记录对的现行条目（说明此前已比对过，未待重算则不重复生成）
        const currentPair = conflicts.find(
          (conflict) =>
            conflict.stale === '现行' &&
            ((conflict.recordIdA === a.id && conflict.recordIdB === b.id) ||
              (conflict.recordIdA === b.id && conflict.recordIdB === a.id))
        )

        if (matched) {
          if (!severity) {
            await db.conflicts.update(matched.id, {
              state: '已解决',
              stale: '现行',
              staleReason: '',
              resolvedNote: `重算后无差异（原原因：${matched.staleReason || '—'}），系统自动关闭`,
              resolvedAt: nowIso(),
              updatedAt: Date.now()
            } as never)
            stats.closed += 1
          } else {
            await db.conflicts.update(matched.id, {
              recordIdA: a.id,
              recordIdB: b.id,
              elementId: b.elementId,
              continuityNo: ledger.code,
              diffDesc: describeDiffs(diffs),
              severity,
              state: '待确认',
              stale: '现行',
              staleReason: '',
              updatedAt: Date.now()
            } as never)
            stats.updated += 1
          }
        } else if (severity && !currentPair) {
          // 没有待重算条目命中、但也没有现行条目覆盖最新记录对：补生成（含新出现的差异）
          const now = Date.now()
          await db.conflicts.put(
            toPlainRow({
              id: createId('conflict'),
              ledgerId: ledger.id,
              continuityNo: ledger.code,
              elementId: b.elementId,
              recordIdA: a.id,
              recordIdB: b.id,
              diffDesc: describeDiffs(diffs),
              severity,
              state: '待确认',
              stale: '现行',
              staleReason: '',
              resolvedNote: '',
              resolvedAt: '',
              revision: ROW_REVISION,
              createdAt: now,
              updatedAt: now
            })
          )
          stats.created += 1
        }

        // 其余待重算条目（旧记录对已被新快照取代等）：自动关闭留痕
        for (const conflict of pending) {
          if (conflict.id === matched?.id) continue
          await db.conflicts.update(conflict.id, {
            state: '已解决',
            stale: '现行',
            staleReason: '',
            resolvedNote: `重算后最新比对已更新，本条按「${conflict.staleReason || '待重算'}」自动关闭，历史保留`,
            resolvedAt: nowIso(),
            updatedAt: Date.now()
          } as never)
          stats.closed += 1
        }
      }

      // 已删除共同账的孤儿待重算条目：同样自动关闭留痕
      const ledgerIds = new Set(ledgers.map((item) => item.id))
      const orphans = conflicts.filter((item) => item.stale === '待重算' && !ledgerIds.has(item.ledgerId))
      for (const conflict of orphans) {
        await db.conflicts.update(conflict.id, {
          state: '已解决',
          stale: '现行',
          resolvedNote: '共同账已不存在，重算时自动关闭，历史保留',
          resolvedAt: nowIso(),
          updatedAt: Date.now()
        } as never)
        stats.closed += 1
      }

      if (stats.created + stats.updated + stats.closed > 0) {
        await addHistory('—', '—', '差异处置', `全量重算：新增 ${stats.created}、刷新 ${stats.updated}、自动关闭 ${stats.closed}`, actor, null, null)
      }
    }
  )
  return stats
}

/* ========================================================================== */
/* 连戏共同账：乐观并发提交、表格草稿、隔离确认、提交前快照恢复                    */
/* ========================================================================== */

export async function listLedgers(): Promise<LedgerRow[]> {
  const rows = await db.ledgers.toArray()
  return rows.sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'))
}

export async function listLedgerHistory(ledgerId?: string): Promise<LedgerHistoryRow[]> {
  const rows = ledgerId ? await db.ledgerHistory.where('ledgerId').equals(ledgerId).toArray() : await db.ledgerHistory.toArray()
  return rows.sort((a, b) => (a.at < b.at ? 1 : -1))
}

export async function listDrafts(): Promise<LedgerDraftRow[]> {
  const rows = await db.ledgerDrafts.toArray()
  return rows.sort((a, b) => b.createdAt - a.createdAt)
}

export async function listQuarantine(): Promise<QuarantineRow[]> {
  const rows = await db.quarantine.toArray()
  return rows.sort((a, b) => b.createdAt - a.createdAt)
}

/** 提交前账面快照：写入失败时据此恢复到提交前状态 */
export interface LedgerCommitSnapshot {
  ledger: LedgerRow | null
  linkedElements: ElementRow[]
  conflicts: Array<{ id: string; before: ConflictRow | null }>
}

export interface CommitLedgerInput {
  /** 编辑既有账时传入；新建留空 */
  id?: string
  data: Omit<ContinuityLedger, 'id' | 'version'>
  /** 打开编辑时读到的版本；新建传 0 */
  expectedVersion: number
  actor: string
}

export type LedgerCommitOutcome =
  | { outcome: 'created' | 'updated'; ledger: LedgerRow; snapshot: LedgerCommitSnapshot }
  | { outcome: 'conflict'; ledger: LedgerRow; draft: LedgerDraftRow; snapshot: LedgerCommitSnapshot }

async function takeCommitSnapshot(ledgerId: string | undefined): Promise<LedgerCommitSnapshot> {
  const ledger = ledgerId ? (await db.ledgers.get(ledgerId)) ?? null : null
  const linkedElements = ledger ? await db.elements.where('ledgerId').equals(ledger.id).toArray() : []
  const linkedConflicts = ledger ? await db.conflicts.where('ledgerId').equals(ledger.id).toArray() : []
  return {
    ledger,
    linkedElements,
    conflicts: linkedConflicts.map((item) => ({ id: item.id, before: item }))
  }
}

/** 从提交前快照恢复账面（事务失败后的兜底恢复） */
export async function restoreCommitSnapshot(snapshot: LedgerCommitSnapshot): Promise<void> {
  await db.transaction(
    'rw',
    [db.ledgers, db.elements, db.conflicts, db.ledgerHistory, db.ledgerDrafts],
    async () => {
      if (snapshot.ledger) await db.ledgers.put(snapshot.ledger)
      for (const element of snapshot.linkedElements) await db.elements.put(element)
      for (const item of snapshot.conflicts) {
        if (item.before) await db.conflicts.put(item.before)
      }
    }
  )
}

/**
 * 提交共同账（乐观并发）：
 * - 版本一致：落地，version+1，场次侧要素与基准同步，基准变化时差异待重算
 * - 版本落后：不覆盖主账，保留表格草稿并列出双方不同字段
 * 整个过程在单事务内；若写入抛错，事务回滚 + 按提交前快照恢复。
 */
export async function commitLedger(input: CommitLedgerInput): Promise<LedgerCommitOutcome> {
  const { data, expectedVersion, actor } = input
  const code = data.code.trim()
  if (!code) throw new Error('连戏编号不能为空')

  // 动态引入字段比对，避免循环依赖顾虑（ledgerMerge 只依赖类型）
  const { diffLedgerFields } = await import('./ledgerMerge')

  // 先在事务外确定目标（id 优先，其次按编号）
  const byId = input.id ? await db.ledgers.get(input.id) : undefined
  const byCode = await db.ledgers.where('code').equals(code).first()
  const existing = byId ?? byCode ?? null

  const snapshot = await takeCommitSnapshot(existing?.id)

  try {
    if (existing && existing.version !== expectedVersion) {
      // 落后一方：主账不动，草稿落地
      const now = Date.now()
      const differences = diffLedgerFields(data, existing)
      const draft: LedgerDraftRow = toPlainRow({
        id: createId('lgd'),
        ledgerId: existing.id,
        code,
        baseVersion: expectedVersion,
        currentVersion: existing.version,
        payload: { ...data },
        differingFields: differences.map((item) => item.field),
        currentSnapshot: {
          code: existing.code,
          category: existing.category,
          name: existing.name,
          sceneIds: [...existing.sceneIds],
          baseline: { ...existing.baseline },
          owner: existing.owner,
          critical: existing.critical,
          status: existing.status
        },
        actor: actor || '未署名',
        createdAt: now,
        updatedAt: now,
        revision: ROW_REVISION
      })
      await db.transaction('rw', [db.ledgerDrafts, db.ledgerHistory], async () => {
        await db.ledgerDrafts.put(draft)
        await addHistory(
          existing.id,
          code,
          '并发草稿保留',
          `版本 ${expectedVersion} 落后于已落地版本 ${existing.version}，表格草稿保留；差异字段：${
            differences.map((item) => item.label).join('、') || '无'
          }`,
          actor,
          null,
          null
        )
      })
      return { outcome: 'conflict', ledger: existing, draft, snapshot }
    }

    const now = Date.now()

    if (!existing) {
      const ledger: LedgerRow = toPlainRow({
        id: createId('lg'),
        ...data,
        code,
        sceneIds: Array.from(new Set(data.sceneIds)),
        version: 1,
        revision: ROW_REVISION,
        createdAt: now,
        updatedAt: now
      })
      await db.transaction(
        'rw',
        [db.ledgers, db.ledgerHistory, db.elements, db.conflicts],
        async () => {
          await db.ledgers.put(ledger)
          // 新挂接的场次若还没有落点要素，自动补一条（只认基准，初始状态即基准）
          for (const sceneId of ledger.sceneIds) {
            const has = await db.elements.filter((e) => e.ledgerId === ledger.id && e.sceneId === sceneId).first()
            if (!has) {
              await db.elements.put(
                stamp({
                  id: createId('element'),
                  sceneId,
                  category: ledger.category as Element['category'],
                  name: ledger.name,
                  initialState: ledger.baseline.state,
                  owner: ledger.owner,
                  critical: ledger.critical,
                  ledgerId: ledger.id,
                  continuityNo: ledger.code,
                  status: ledger.status === '停用' ? '停用' : '在用'
                })
              )
            }
          }
          await addHistory(ledger.id, code, '创建', `建立共同账，编号 ${code}，挂接 ${ledger.sceneIds.length} 个场次`, actor, null, {
            code,
            sceneIds: ledger.sceneIds,
            baseline: ledger.baseline
          })
        }
      )
      return { outcome: 'created', ledger, snapshot }
    }

    // 版本一致：更新主账
    const before: Partial<ContinuityLedger> = {
      code: existing.code,
      category: existing.category,
      name: existing.name,
      sceneIds: [...existing.sceneIds],
      baseline: { ...existing.baseline },
      owner: existing.owner,
      critical: existing.critical,
      status: existing.status
    }
    const baselineChanged =
      data.baseline.state !== existing.baseline.state || data.baseline.photoNote !== existing.baseline.photoNote
    const next: LedgerRow = toPlainRow({
      ...existing,
      ...data,
      code,
      sceneIds: Array.from(new Set(data.sceneIds)),
      version: existing.version + 1,
      revision: ROW_REVISION,
      updatedAt: now
    })

    await db.transaction(
      'rw',
      [db.ledgers, db.ledgerHistory, db.elements, db.records, db.conflicts],
      async () => {
        await db.ledgers.put(next)

        // 场次侧要素同步：新挂场次补落点，已有要素跟随名称 / 责任人 / 关键 / 状态 / 基准
        for (const sceneId of next.sceneIds) {
          const linked = await db.elements.filter((e) => e.ledgerId === next.id && e.sceneId === sceneId).first()
          if (!linked) {
            await db.elements.put(
              stamp({
                id: createId('element'),
                sceneId,
                category: next.category as Element['category'],
                name: next.name,
                initialState: next.baseline.state,
                owner: next.owner,
                critical: next.critical,
                ledgerId: next.id,
                continuityNo: next.code,
                status: next.status === '停用' ? '停用' : '在用'
              })
            )
          }
        }
        await db.elements.where('ledgerId').equals(next.id).modify((element) => {
          element.name = next.name
          element.owner = next.owner
          element.critical = next.critical
          element.status = next.status === '停用' ? '停用' : '在用'
          element.initialState = next.baseline.state
          element.updatedAt = now
        })

        const removedScenes = before.sceneIds!.filter((sceneId) => !next.sceneIds.includes(sceneId))
        const addedScenes = next.sceneIds.filter((sceneId) => !before.sceneIds!.includes(sceneId))
        const action =
          next.status === '停用' && existing.status === '在用'
            ? '停用'
            : next.status === '在用' && existing.status === '停用'
              ? '重新启用'
              : removedScenes.length > 0 || addedScenes.length > 0
                ? '挂接场次'
                : '更新基准'
        const detailParts: string[] = []
        if (addedScenes.length) detailParts.push(`挂接场次 ${addedScenes.length} 个`)
        if (removedScenes.length) detailParts.push(`移除场次 ${removedScenes.length} 个`)
        if (baselineChanged) detailParts.push('当前基准已更新')
        if (action === '停用') detailParts.push('道具停用，相关差异转待重算')
        await addHistory(
          next.id,
          code,
          action,
          detailParts.length ? detailParts.join('；') : '共同账字段更新',
          actor,
          before,
          {
            name: next.name,
            sceneIds: next.sceneIds,
            baseline: next.baseline,
            owner: next.owner,
            critical: next.critical,
            status: next.status
          }
        )

        if (baselineChanged || next.status === '停用') {
          await markConflictsStale(
            (conflict) => conflict.ledgerId === next.id,
            next.status === '停用' ? '道具停用' : '基准变更'
          )
        }
      }
    )

    return { outcome: 'updated', ledger: next, snapshot }
  } catch (error) {
    // 写入失败：按提交前账面状态恢复，再把错误交回调用方提示
    await restoreCommitSnapshot(snapshot).catch(() => undefined)
    throw error
  }
}

/** 落后一方确认后，以草稿强制覆盖落地（版本按当前存储版本对齐） */
export async function forceCommitDraft(draftId: string, actor = '现场'): Promise<void> {
  await db.transaction('rw', [db.ledgerDrafts, db.ledgers, db.ledgerHistory], async () => {
    const draft = await db.ledgerDrafts.get(draftId)
    if (!draft) return
    const current = await db.ledgers.get(draft.ledgerId)
    if (!current) throw new Error('共同账不存在，无法合并草稿')
    const now = Date.now()
    const next: LedgerRow = toPlainRow({
      ...current,
      ...draft.payload,
      code: current.code,
      sceneIds: Array.from(new Set(draft.payload.sceneIds ?? current.sceneIds)),
      version: current.version + 1,
      updatedAt: now
    })
    await db.ledgers.put(next)
    await db.ledgerDrafts.delete(draftId)
    await addHistory(
      current.id,
      current.code,
      '合并草稿',
      `落后标签页的表格草稿已人工确认覆盖（基于版本 ${draft.baseVersion} → ${current.version}）`,
      actor,
      null,
      { baseline: next.baseline, sceneIds: next.sceneIds }
    )
  })
}

/** 放弃表格草稿（草稿删除，主账不动；留痕） */
export async function discardDraft(draftId: string, actor = '现场'): Promise<void> {
  const draft = await db.ledgerDrafts.get(draftId)
  if (!draft) return
  await db.transaction('rw', [db.ledgerDrafts, db.ledgerHistory], async () => {
    await db.ledgerDrafts.delete(draftId)
    await addHistory(draft.ledgerId, draft.code, '放弃草稿', `版本 ${draft.baseVersion} 的并发草稿被放弃`, actor, null, null)
  })
}

/**
 * 隔离区确认：给缺编号旧档案指定连戏编号。
 * 编号已存在则并入该账（挂接其场次），不存在则新建共同账；
 * 原档案的现场记录与差异重新挂接，差异转待重算（旧档归并）。
 */
export async function confirmQuarantine(
  quarantineId: string,
  params: { code: string; name: string; actor: string }
): Promise<void> {
  await db.transaction(
    'rw',
    [db.quarantine, db.ledgers, db.elements, db.records, db.conflicts, db.ledgerHistory],
    async () => {
      const item = await db.quarantine.get(quarantineId)
      if (!item || item.state === '已确认') throw new Error('隔离档案不存在或已确认')
      const code = params.code.trim()
      if (!code) throw new Error('请填写连戏编号')
      const snapshot = item.snapshot as Partial<Element>
      const now = Date.now()
      const elementId = createId('element')

      let ledger = await db.ledgers.where('code').equals(code).first()
      if (ledger) {
        if (snapshot.sceneId && !ledger.sceneIds.includes(snapshot.sceneId)) {
          await db.ledgers.update(ledger.id, { sceneIds: [...ledger.sceneIds, snapshot.sceneId], updatedAt: now } as never)
        }
      } else {
        const ledgerId = createId('lg')
        ledger = stamp({
          id: ledgerId,
          code,
          category: (snapshot.category as string) || '道具',
          name: params.name.trim() || (snapshot.name as string) || code,
          sceneIds: snapshot.sceneId ? [snapshot.sceneId] : [],
          baseline: { state: String(snapshot.initialState ?? ''), photoNote: '' },
          owner: String(snapshot.owner ?? ''),
          critical: Boolean(snapshot.critical),
          status: '在用',
          version: 1
        })
        await db.ledgers.put(ledger)
      }
      await db.elements.put(
        stamp({
          id: elementId,
          sceneId: String(snapshot.sceneId ?? ''),
          category: (snapshot.category as Element['category']) || '道具',
          name: ledger.name,
          initialState: ledger.baseline.state,
          owner: ledger.owner,
          critical: ledger.critical,
          ledgerId: ledger.id,
          continuityNo: ledger.code,
          status: '在用'
        })
      )

      // 旧记录重新挂接
      await db.records.where('elementId').equals(item.sourceElementId).modify((record) => {
        record.elementId = elementId
        record.ledgerId = ledger!.id
        record.continuityNo = ledger!.code
        record.updatedAt = now
      })
      await db.conflicts.toCollection().modify((conflict) => {
        if (conflict.elementId === item.sourceElementId) {
          conflict.elementId = elementId
          conflict.ledgerId = ledger!.id
          conflict.continuityNo = ledger!.code
          conflict.stale = '待重算'
          conflict.staleReason = '旧档归并'
          conflict.updatedAt = now
        }
      })

      await db.quarantine.update(quarantineId, { state: '已确认', updatedAt: now } as never)
      await addHistory(
        ledger.id,
        code,
        '隔离确认',
        `隔离档案 ${item.sourceElementId} 确认编号 ${code} 并归账，相关差异转待重算`,
        params.actor,
        null,
        { code, sceneIds: ledger.sceneIds }
      )
    }
  )
}

/* --------------------------- 整库导入导出 --------------------------- */

export interface DatabaseSnapshot {
  name: string
  schemaVersion: number
  exportedAt: string
  scenes: Scene[]
  elements: Element[]
  shootDays: ShootDay[]
  records: ContinuityRecord[]
  conflicts: Conflict[]
  ledgers: ContinuityLedger[]
  ledgerHistory: LedgerHistoryEntry[]
  ledgerDrafts: LedgerDraft[]
  quarantine: QuarantineItem[]
}

function stripRow<T extends Revisioned>(row: T): Omit<T, keyof Revisioned> {
  const copy = { ...row } as Record<string, unknown>
  delete copy.revision
  delete copy.createdAt
  delete copy.updatedAt
  return copy as Omit<T, keyof Revisioned>
}

export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [scenes, elements, shootDays, records, conflicts, ledgers, ledgerHistory, ledgerDrafts, quarantine] =
    await Promise.all([
      db.scenes.toArray(),
      db.elements.toArray(),
      db.shootDays.toArray(),
      db.records.toArray(),
      db.conflicts.toArray(),
      db.ledgers.toArray(),
      db.ledgerHistory.toArray(),
      db.ledgerDrafts.toArray(),
      db.quarantine.toArray()
    ])
  return {
    name: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: nowIso(),
    scenes: scenes.map(stripRow),
    elements: elements.map(stripRow),
    shootDays: shootDays.map(stripRow),
    records: records.map(stripRow),
    conflicts: conflicts.map(stripRow),
    ledgers: ledgers.map(stripRow),
    ledgerHistory: ledgerHistory.map(({ revision, createdAt, updatedAt, ...rest }) => rest),
    ledgerDrafts: ledgerDrafts.map(({ revision, updatedAt, ...rest }) => rest),
    quarantine
  }
}

export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  await db.transaction(
    'rw',
      [
        db.scenes,
        db.elements,
        db.shootDays,
        db.records,
        db.conflicts,
        db.ledgers,
        db.ledgerHistory,
        db.ledgerDrafts,
        db.quarantine
      ],
    async () => {
      await Promise.all([
        db.scenes.clear(),
        db.elements.clear(),
        db.shootDays.clear(),
        db.records.clear(),
        db.conflicts.clear(),
        db.ledgers.clear(),
        db.ledgerHistory.clear(),
        db.ledgerDrafts.clear(),
        db.quarantine.clear()
      ])
      await db.scenes.bulkPut(snapshot.scenes.map((row) => stamp({ ...row, withdrawn: row.withdrawn ?? false })))
      await db.elements.bulkPut(
        snapshot.elements.map((row) =>
          stamp({ ...row, ledgerId: row.ledgerId ?? '', continuityNo: row.continuityNo ?? '', status: row.status ?? '在用' })
        )
      )
      await db.shootDays.bulkPut(snapshot.shootDays.map(stamp))
      await db.records.bulkPut(
        snapshot.records.map((row) => stamp({ ...row, ledgerId: row.ledgerId ?? '', continuityNo: row.continuityNo ?? '' }))
      )
      await db.conflicts.bulkPut(
        snapshot.conflicts.map((row) =>
          stamp({
            ...row,
            ledgerId: row.ledgerId ?? '',
            continuityNo: row.continuityNo ?? '',
            stale: row.stale ?? '现行',
            staleReason: row.staleReason ?? ''
          })
        )
      )
      await db.ledgers.bulkPut((snapshot.ledgers ?? []).map((row) => stamp({ ...row, version: row.version ?? 1 })))
      await db.ledgerHistory.bulkPut(
        (snapshot.ledgerHistory ?? []).map((row) => ({ ...row, revision: ROW_REVISION, createdAt: Date.now(), updatedAt: Date.now() }))
      )
      await db.ledgerDrafts.bulkPut(
        (snapshot.ledgerDrafts ?? []).map((row) => ({ ...row, revision: ROW_REVISION, updatedAt: row.createdAt }))
      )
      await db.quarantine.bulkPut(snapshot.quarantine ?? [])

      // 兼容旧版备份（无共同账）：导入后按旧档归并规则补账
      if ((snapshot.ledgers ?? []).length === 0 && snapshot.elements.length > 0) {
        await migrateV1ToV2()
      }
    }
  )
}

/** 清空全部数据并重新灌入演示数据 */
export async function resetDatabase(): Promise<void> {
  await db.transaction(
    'rw',
    [db.scenes, db.elements, db.shootDays, db.records, db.conflicts, db.ledgers, db.ledgerHistory, db.ledgerDrafts, db.quarantine],
    async () => {
      await Promise.all([
        db.scenes.clear(),
        db.elements.clear(),
        db.shootDays.clear(),
        db.records.clear(),
        db.conflicts.clear(),
        db.ledgers.clear(),
        db.ledgerHistory.clear(),
        db.ledgerDrafts.clear(),
        db.quarantine.clear()
      ])
    }
  )
  await seedDatabase()
}

/** 各表行数统计 */
export async function countAll(): Promise<Record<string, number>> {
  const [scenes, elements, shootDays, records, conflicts, ledgers, drafts, quarantine] = await Promise.all([
    db.scenes.count(),
    db.elements.count(),
    db.shootDays.count(),
    db.records.count(),
    db.conflicts.count(),
    db.ledgers.count(),
    db.ledgerDrafts.count(),
    db.quarantine.where('state').equals('待确认').count()
  ])
  return { scenes, elements, shootDays, records, conflicts, ledgers, drafts, quarantine }
}
