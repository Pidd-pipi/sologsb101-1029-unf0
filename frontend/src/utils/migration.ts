/**
 * v1 → v2 账面迁移转换。
 * 旧结构里连戏要素按「场次 × 要素」各建档案（elements 表），同一个连戏编号
 * 跨场重复建档时现场改动互不可见。迁移规则：
 * 1. 能识别出连戏编号的旧档案：按编号归并成一条共同账（挂多场、基准取最新），
 *    现场记录改挂共同账，差异跟着转挂；
 * 2. 识别不出编号的旧档案：原档与随附现场记录整体进隔离区待确认，不丢弃；
 * 3. 归并、隔离、处置痕迹全部写成只追加历史。
 * 升级（Dexie upgrade）与导入 v1 备份共用本模块。
 */
import type { Scene } from '../types/scene'
import type { ShootDay } from '../types/shootDay'
import type { ElementCategory } from '../types/element'
import type { Ledger, LedgerResolution } from '../types/ledger'
import type { Record as ContinuityRecord } from '../types/record'
import type { Conflict } from '../types/conflict'
import type { QuarantineItem } from '../types/quarantine'
import type { LedgerHistoryEntry } from '../types/history'
import { ROW_REVISION } from './db'
import { createId, nowIso } from './uuid'

/** v1 旧要素档案（elements 表），可带可选 code */
export interface LegacyElement {
  id: string
  sceneId: string
  category: ElementCategory
  name: string
  initialState: string
  owner: string
  critical: boolean
  code?: string
}

/** v1 现场记录（elementId 挂旧要素） */
export interface LegacyRecord {
  id: string
  shootDayId: string
  elementId: string
  sceneId: string
  takeNo: string
  currentState: string
  photoNote: string
  recordedBy: string
}

/** v1 差异（elementId 挂旧要素） */
export interface LegacyConflict {
  id: string
  elementId: string
  recordIdA: string
  recordIdB: string
  diffDesc: string
  severity: Conflict['severity']
  state: Conflict['state']
  resolvedNote: string
  resolvedAt: string
}

export interface MigrationResult {
  ledgers: Ledger[]
  records: ContinuityRecord[]
  conflicts: Conflict[]
  quarantine: QuarantineItem[]
  history: LedgerHistoryEntry[]
}

/** 从旧档案名称里尝试识别连戏编号，如「LX-017 女主风衣」→「LX-017」 */
export function recognizeCode(name: string): string {
  const matched = name.match(/([A-Za-z]{1,4}[-_—]?\d{1,4})/)
  return matched ? matched[1].replace(/_/g, '-').toUpperCase() : ''
}

function blankLedger(id: string, code: string, first: LegacyElement): Ledger {
  return {
    id,
    code,
    sceneIds: [],
    category: first.category,
    name: first.name.replace(/^[A-Za-z]{1,4}[-_—]?\d{1,4}\s*/, '').trim() || first.name,
    baselineState: first.initialState,
    owner: first.owner,
    critical: false,
    status: '在用',
    resolutions: []
  }
}

export interface MigrateInput {
  scenes: Scene[]
  shootDays: ShootDay[]
  elements: LegacyElement[]
  records: LegacyRecord[]
  conflicts: LegacyConflict[]
}

/**
 * 把 v1 五行模型转换为 v2 共同账模型。纯函数，不触碰数据库，
 * 输出行自带行修订号（revision/createdAt/updatedAt）。
 */
export function migrateV1ToV2(input: MigrateInput): MigrationResult {
  const now = Date.now()
  const iso = nowIso()
  const sceneHint = (sceneId: string): string => {
    const scene = input.scenes.find((item) => item.id === sceneId)
    return scene ? `第 ${scene.sceneNo} 场 · ${scene.location}` : '原场次已不在台账'
  }

  const ledgers: Ledger[] = []
  const elementToLedger = new Map<string, string>()
  const quarantine: QuarantineItem[] = []
  const history: LedgerHistoryEntry[] = []

  // 1. 旧要素按编号分组：显式 code 优先，其次从名称识别
  const groups = new Map<string, LegacyElement[]>()
  const noCode: LegacyElement[] = []
  input.elements.forEach((element) => {
    const code = (element.code ?? '').trim().toUpperCase() || recognizeCode(element.name)
    if (!code) {
      noCode.push(element)
      return
    }
    const list = groups.get(code) ?? []
    list.push(element)
    groups.set(code, list)
  })

  // 2. 有编号：归并为共同账
  Array.from(groups.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .forEach(([code, members]) => {
      const ledgerId = createId('ledger')
      const ledger = blankLedger(ledgerId, code, members[0])
      const mergedSceneIds: string[] = []
      members.forEach((member) => {
        elementToLedger.set(member.id, ledgerId)
        if (!mergedSceneIds.includes(member.sceneId)) mergedSceneIds.push(member.sceneId)
        // 基准取最新：以要素 id 中时间戳不可靠，统一取 initialState 非空的最后一份
        if (member.initialState.trim()) ledger.baselineState = member.initialState
        if (member.critical) ledger.critical = true
        if (!ledger.owner && member.owner) ledger.owner = member.owner
      })
      ledger.sceneIds = mergedSceneIds
      ledgers.push(ledger)
      history.push({
        id: createId('hist'),
        at: iso,
        ledgerId,
        code,
        action: '归并',
        detail: `旧档案 ${members.length} 份按编号 ${code} 归并为一份共同账，关联场次 ${mergedSceneIds.length} 个`,
        snapshot: { mergedElementIds: members.map((item) => item.id), sceneIds: mergedSceneIds }
      })
    })

  // 3. 无编号：整体隔离（含随附现场记录）
  noCode.forEach((element) => {
    const itemId = createId('quar')
    const ownRecords = input.records.filter((record) => record.elementId === element.id)
    quarantine.push({
      id: itemId,
      sourceElementId: element.id,
      category: element.category as ElementCategory,
      name: element.name,
      initialState: element.initialState,
      owner: element.owner,
      critical: element.critical,
      sceneId: element.sceneId,
      sceneHint: sceneHint(element.sceneId),
      suspectedCode: recognizeCode(element.name),
      recordSnapshot: ownRecords.map((record) => ({
        id: record.id,
        shootDayId: record.shootDayId,
        sceneId: record.sceneId,
        takeNo: record.takeNo,
        currentState: record.currentState,
        photoNote: record.photoNote,
        recordedBy: record.recordedBy
      })),
      status: '待确认',
      resolvedNote: '',
      resolvedAt: '',
      resolvedLedgerId: '',
      quarantinedAt: iso
    })
    history.push({
      id: createId('hist'),
      at: iso,
      ledgerId: '',
      code: '（缺编号）',
      action: '隔离',
      detail: `旧档案「${element.name}」缺少连戏编号，连同 ${ownRecords.length} 条现场记录隔离待确认`,
      snapshot: { sourceElementId: element.id, recordIds: ownRecords.map((item) => item.id) }
    })
  })

  // 4. 现场记录转挂
  const records: ContinuityRecord[] = input.records
    .filter((record) => elementToLedger.has(record.elementId))
    .map((record) => ({
      id: record.id,
      shootDayId: record.shootDayId,
      ledgerId: elementToLedger.get(record.elementId) as string,
      sceneId: record.sceneId,
      takeNo: record.takeNo,
      currentState: record.currentState,
      photoNote: record.photoNote,
      recordedBy: record.recordedBy,
      voided: false
    }))

  // 5. 差异转挂；已解决差异把处置痕迹并入共同账 resolutions
  const quarantinedElementIds = new Set(noCode.map((item) => item.id))
  const conflicts: Conflict[] = []
  input.conflicts.forEach((legacy) => {
    const ledgerId = elementToLedger.get(legacy.elementId)
    if (!ledgerId) {
      // 要素进了隔离区：差异不进入现行差异表，转历史留痕
      history.push({
        id: createId('hist'),
        at: iso,
        ledgerId: '',
        code: quarantinedElementIds.has(legacy.elementId) ? '（缺编号）' : '',
        action: '差异归档',
        detail: `旧差异 ${legacy.id}（${legacy.severity}/${legacy.state}）随缺编号档案归档，待隔离确认后重算`,
        snapshot: { legacyConflictId: legacy.id, elementId: legacy.elementId }
      })
      return
    }
    conflicts.push({
      id: legacy.id,
      ledgerId,
      recordIdA: legacy.recordIdA,
      recordIdB: legacy.recordIdB,
      diffDesc: legacy.diffDesc,
      severity: legacy.severity,
      state: legacy.state,
      resolvedNote: legacy.resolvedNote,
      resolvedAt: legacy.resolvedAt,
      stale: false,
      staleReason: '',
      staleAt: ''
    })
    if (legacy.state === '已解决' && legacy.resolvedAt) {
      const ledger = ledgers.find((item) => item.id === ledgerId)
      const resolution: LedgerResolution = {
        conflictId: legacy.id,
        note: legacy.resolvedNote,
        at: legacy.resolvedAt,
        baselineState: ledger?.baselineState ?? ''
      }
      ledger?.resolutions.push(resolution)
    }
  })

  return {
    ledgers: ledgers.map((row) => ({ ...row, revision: ROW_REVISION, createdAt: now, updatedAt: now, version: 1 })),
    records: records.map((row) => ({ ...row, revision: ROW_REVISION, createdAt: now, updatedAt: now, version: 1 })),
    conflicts: conflicts.map((row) => ({ ...row, revision: ROW_REVISION, createdAt: now, updatedAt: now })),
    quarantine,
    history
  }
}
