/**
 * 连戏核对报告 JSON 序列化与校验
 * 报告页用于导出整份核对报告，也是「导入导出备份」的数据校验入口。
 * 风险口径：待重算（stale）差异不进风险分，避免撤场/停用/记录更新后报告打架。
 */
import type { Scene } from '../types/scene'
import type { Ledger } from '../types/ledger'
import type { ShootDay } from '../types/shootDay'
import type { Record as ContinuityRecord } from '../types/record'
import type { Conflict } from '../types/conflict'
import type { LedgerHistoryEntry } from '../types/history'
import type { QuarantineItem } from '../types/quarantine'
import { SEVERITY_WEIGHT } from './diff'
import {
  DB_NAME,
  DB_SCHEMA_VERSION,
  listConflicts,
  listLedgers,
  listRecords,
  listScenes,
  listShootDays,
  listQuarantine,
  listHistory
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
  ledgerCount: number
  criticalLedgerCount: number
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
  ledgers: Ledger[]
  shootDays: ShootDay[]
  records: ContinuityRecord[]
  conflicts: Conflict[]
  quarantine: QuarantineItem[]
  history: LedgerHistoryEntry[]
  summary: {
    sceneCount: number
    ledgerCount: number
    inactiveLedgerCount: number
    recordCount: number
    voidedRecordCount: number
    openConflictCount: number
    staleConflictCount: number
    blockedConflictCount: number
    resolvedConflictCount: number
    quarantineCount: number
    /** 未解决现行冲突最多的场次 */
    riskiestSceneNo: string
    rows: SceneReportRow[]
  }
}

function stripRevision<T>(row: T): T {
  const copy = { ...(row as Record<string, unknown>) }
  delete copy.revision
  delete copy.createdAt
  delete copy.updatedAt
  return copy as T
}

/** 汇总整份连戏核对报告 */
export async function buildReport(): Promise<ContinuityReport> {
  const [scenes, ledgers, shootDays, records, conflicts, quarantine, history] = await Promise.all([
    listScenes(),
    listLedgers(),
    listShootDays(),
    listRecords(),
    listConflicts(),
    listQuarantine(),
    listHistory()
  ])

  const rows: SceneReportRow[] = scenes.map((scene) => {
    const sceneLedgers = ledgers.filter((item) => item.sceneIds.includes(scene.id))
    const ledgerIds = new Set(sceneLedgers.map((item) => item.id))
    const sceneConflicts = conflicts.filter((item) => ledgerIds.has(item.ledgerId))
    return {
      sceneId: scene.id,
      sceneNo: scene.sceneNo,
      place: scene.place,
      timeOfDay: scene.timeOfDay,
      location: scene.location,
      state: scene.state,
      ledgerCount: sceneLedgers.length,
      criticalLedgerCount: sceneLedgers.filter((item) => item.critical).length,
      openConflictCount: sceneConflicts.filter((item) => item.state === '待确认' && !item.stale).length,
      staleConflictCount: sceneConflicts.filter((item) => item.stale).length,
      resolvedConflictCount: sceneConflicts.filter((item) => item.state === '已解决').length,
      shootDayCount: shootDays.filter((day) => day.sceneIds.includes(scene.id)).length
    }
  })

  const riskiest = [...rows].sort(
    (a, b) => b.openConflictCount - a.openConflictCount || b.criticalLedgerCount - a.criticalLedgerCount
  )[0]

  const openConflicts = conflicts.filter((item) => item.state === '待确认' && !item.stale)

  return {
    name: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: nowIso(),
    scenes: scenes.map(stripRevision),
    ledgers: ledgers.map(stripRevision) as unknown as Ledger[],
    shootDays: shootDays.map(stripRevision),
    records: records.map(stripRevision) as unknown as ContinuityRecord[],
    conflicts: conflicts.map(stripRevision) as unknown as Conflict[],
    quarantine,
    history,
    summary: {
      sceneCount: scenes.length,
      ledgerCount: ledgers.length,
      inactiveLedgerCount: ledgers.filter((item) => item.status === '停用').length,
      recordCount: records.filter((item) => !item.voided).length,
      voidedRecordCount: records.filter((item) => item.voided).length,
      openConflictCount: openConflicts.length,
      staleConflictCount: conflicts.filter((item) => item.stale).length,
      blockedConflictCount: openConflicts.filter((item) => item.severity === '阻断').length,
      resolvedConflictCount: conflicts.filter((item) => item.state === '已解决').length,
      quarantineCount: quarantine.filter((item) => item.status === '待确认').length,
      riskiestSceneNo: riskiest ? riskiest.sceneNo : '—',
      rows
    }
  }
}

/** 严重程度加权后的风险分：仅统计现行（非待重算）未解决差异 */
export function riskScore(conflicts: Pick<Conflict, 'severity' | 'state' | 'stale'>[]): number {
  return conflicts
    .filter((item) => item.state === '待确认' && !item.stale)
    .reduce((sum, item) => sum + SEVERITY_WEIGHT[item.severity], 0)
}

export function serializeReport(report: ContinuityReport): string {
  return JSON.stringify(report, null, 2)
}

/** 校验并解析报告 / 备份 JSON，失败时抛出可读错误 */
export function parseReport(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('不是合法的 JSON 文本')
  }
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
