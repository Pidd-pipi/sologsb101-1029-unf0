/**
 * 连戏核对报告 JSON 序列化与校验（共同账版）
 * 报告页用于导出整份核对报告，也是「导入导出备份」的数据校验入口。
 * 风险口径：「待重算」差异是旧基准产物，一律不计入现行风险，避免报告互相打架。
 */
import type { Scene } from '../types/scene'
import type { Element } from '../types/element'
import type { ShootDay } from '../types/shootDay'
import type { Record as ContinuityRecord } from '../types/record'
import type { Conflict } from '../types/conflict'
import type { ContinuityLedger, LedgerDraft, LedgerHistoryEntry, QuarantineItem } from '../types/ledger'
import { SEVERITY_WEIGHT } from './diff'
import {
  DB_NAME,
  DB_SCHEMA_VERSION,
  listConflicts,
  listElements,
  listLedgers,
  listRecords,
  listScenes,
  listShootDays,
  listDrafts,
  listLedgerHistory,
  listQuarantine
} from './db'
import { nowIso } from './uuid'

/** 单个场次的核对小结 */
export interface SceneReportRow {
  sceneId: string
  sceneNo: string
  place: string
  timeOfDay: string
  location: string
  state: string
  withdrawn: boolean
  elementCount: number
  criticalElementCount: number
  openConflictCount: number
  staleConflictCount: number
  resolvedConflictCount: number
  shootDayCount: number
}

/** 连戏核对报告 */
export interface ContinuityReport {
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
  summary: {
    sceneCount: number
    withdrawnSceneCount: number
    ledgerCount: number
    multiSceneLedgerCount: number
    elementCount: number
    recordCount: number
    openConflictCount: number
    staleConflictCount: number
    blockedConflictCount: number
    resolvedConflictCount: number
    draftCount: number
    quarantineCount: number
    /** 现行未解决冲突最多的场次 */
    riskiestSceneNo: string
    rows: SceneReportRow[]
  }
}

type WithRevision = { revision?: number; createdAt?: number; updatedAt?: number }

function stripRevision<T extends WithRevision>(row: T): T {
  const copy = { ...row } as Record<string, unknown>
  delete copy.revision
  delete copy.createdAt
  delete copy.updatedAt
  return copy as T
}

/** 汇总整份连戏核对报告（待重算差异不进现行风险） */
export async function buildReport(): Promise<ContinuityReport> {
  const [scenes, elements, shootDays, records, conflicts, ledgers, ledgerHistory, ledgerDrafts, quarantine] =
    await Promise.all([
      listScenes(),
      listElements(),
      listShootDays(),
      listRecords(),
      listConflicts(),
      listLedgers(),
      listLedgerHistory(),
      listDrafts(),
      listQuarantine()
    ])

  const rows: SceneReportRow[] = scenes.map((scene) => {
    const sceneElements = elements.filter((item) => item.sceneId === scene.id)
    const ledgerIds = new Set(
      ledgers.filter((ledger) => ledger.sceneIds.includes(scene.id)).map((ledger) => ledger.id)
    )
    const sceneConflicts = conflicts.filter(
      (item) =>
        ledgerIds.has(item.ledgerId) || sceneElements.some((element) => element.id === item.elementId)
    )
    return {
      sceneId: scene.id,
      sceneNo: scene.sceneNo,
      place: scene.place,
      timeOfDay: scene.timeOfDay,
      location: scene.location,
      state: scene.withdrawn ? '已撤下' : scene.state,
      withdrawn: scene.withdrawn,
      elementCount: sceneElements.length,
      criticalElementCount: sceneElements.filter((item) => item.critical).length,
      openConflictCount: sceneConflicts.filter((item) => item.state === '待确认' && item.stale === '现行').length,
      staleConflictCount: sceneConflicts.filter((item) => item.stale === '待重算').length,
      resolvedConflictCount: sceneConflicts.filter((item) => item.state === '已解决').length,
      shootDayCount: shootDays.filter((day) => day.sceneIds.includes(scene.id)).length
    }
  })

  const riskiest = [...rows]
    .filter((row) => !row.withdrawn)
    .sort((a, b) => b.openConflictCount - a.openConflictCount || b.criticalElementCount - a.criticalElementCount)[0]

  const current = conflicts.filter((item) => item.stale === '现行')
  const openConflicts = current.filter((item) => item.state === '待确认')

  return {
    name: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: nowIso(),
    scenes: scenes.map(stripRevision),
    elements: elements.map(stripRevision),
    shootDays: shootDays.map(stripRevision),
    records: records.map(stripRevision),
    conflicts: conflicts.map(stripRevision),
    ledgers: ledgers.map(stripRevision),
    ledgerHistory: ledgerHistory.map(({ revision, createdAt, updatedAt, ...rest }) => rest),
    ledgerDrafts: ledgerDrafts.map(({ revision, updatedAt, ...rest }) => rest),
    quarantine,
    summary: {
      sceneCount: scenes.filter((item) => !item.withdrawn).length,
      withdrawnSceneCount: scenes.filter((item) => item.withdrawn).length,
      ledgerCount: ledgers.length,
      multiSceneLedgerCount: ledgers.filter((item) => item.sceneIds.length > 1).length,
      elementCount: elements.length,
      recordCount: records.length,
      openConflictCount: openConflicts.length,
      staleConflictCount: conflicts.filter((item) => item.stale === '待重算').length,
      blockedConflictCount: openConflicts.filter((item) => item.severity === '阻断').length,
      resolvedConflictCount: conflicts.filter((item) => item.state === '已解决').length,
      draftCount: ledgerDrafts.length,
      quarantineCount: quarantine.filter((item) => item.state === '待确认').length,
      riskiestSceneNo: riskiest ? riskiest.sceneNo : '—',
      rows
    }
  }
}

/** 严重程度加权后的现行风险分：待重算差异不参与，防止旧基准抬高风险 */
export function riskScore(conflicts: Conflict[]): number {
  return conflicts
    .filter((item) => item.stale !== '待重算')
    .reduce((sum, item) => sum + SEVERITY_WEIGHT[item.severity], 0)
}

export function serializeReport(report: ContinuityReport): string {
  return JSON.stringify(report, null, 2)
}

/** 校验并解析报告 / 备份 JSON，失败时抛出可读错误 */
export function parseReport(text: string): ContinuityReport {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('不是合法的 JSON 文本')
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('报告根节点必须是对象')
  }
  const candidate = parsed as Partial<ContinuityReport>
  if (typeof candidate.name !== 'string') throw new Error('缺少 name 字段')
  if (typeof candidate.schemaVersion !== 'number') throw new Error('缺少 schemaVersion 字段')
  if (!Array.isArray(candidate.scenes)) throw new Error('scenes 必须是数组')
  if (!Array.isArray(candidate.conflicts)) throw new Error('conflicts 必须是数组')
  return candidate as ContinuityReport
}

/** 触发浏览器下载（纯前端，无需后端） */
export function downloadJson(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}
