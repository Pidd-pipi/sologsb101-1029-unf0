/**
 * 连戏共同账 store：
 * - 一个连戏编号挂多场，只认一份当前基准（乐观锁 version）
 * - 两个标签页并发提交：各自按读到的版本落地，落后一方保留表格草稿并列出不同字段
 * - 草稿可人工「合并覆盖 / 放弃」
 * - 缺编号旧档案隔离待确认
 * - 撤下场次 / 停用道具 / 记录更新后，相关差异立即待重算（db 层完成，这里驱动页面刷新）
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { ElMessage } from 'element-plus'
import type { ContinuityLedger } from '@/types/ledger'
import {
  commitLedger,
  confirmQuarantine,
  discardDraft,
  forceCommitDraft,
  listDrafts,
  listLedgerHistory,
  listLedgers,
  listQuarantine,
  reconcileConflicts,
  restoreScene as restoreSceneRow,
  withdrawScene as withdrawSceneRow,
  type LedgerCommitOutcome,
  type LedgerDraftRow,
  type LedgerHistoryRow,
  type LedgerRow,
  type QuarantineRow,
  type ReconcileStats
} from '@/utils/db'
import { diffLedgerFields, type LedgerFieldDifference } from '@/utils/ledgerMerge'

/** 并发提交返回给页面的结果：落后时附带双方不同字段 */
export interface LedgerSubmitResult {
  outcome: 'created' | 'updated' | 'conflict'
  ledger: LedgerRow
  differingFields?: LedgerFieldDifference[]
  draft?: LedgerDraftRow
}

export const useLedgerStore = defineStore('ledger', () => {
  const ledgers = ref<LedgerRow[]>([])
  const drafts = ref<LedgerDraftRow[]>([])
  const history = ref<LedgerHistoryRow[]>([])
  const quarantine = ref<QuarantineRow[]>([])
  const ready = ref(false)
  /** 当前打开历史抽屉的共同账 */
  const activeLedgerId = ref<string | null>(null)
  /** 最近一次重算结果 */
  const lastReconcile = ref<ReconcileStats | null>(null)

  async function refresh(): Promise<void> {
    const [ledgerRows, draftRows, historyRows, quarantineRows] = await Promise.all([
      listLedgers(),
      listDrafts(),
      listLedgerHistory(),
      listQuarantine()
    ])
    ledgers.value = ledgerRows
    drafts.value = draftRows
    history.value = historyRows
    quarantine.value = quarantineRows
    ready.value = true
  }

  function getById(id: string): LedgerRow | undefined {
    return ledgers.value.find((item) => item.id === id)
  }

  function getByCode(code: string): LedgerRow | undefined {
    return ledgers.value.find((item) => item.code === code.trim())
  }

  /**
   * 提交共同账（带乐观版本号）。
   * 成功直接落地；版本落后时不覆盖主账，表格草稿已保留，返回双方不同字段供页面展示。
   * 写入失败时 db 层已按提交前账面快照恢复，这里把异常继续抛给页面提示。
   */
  async function submit(params: {
    id?: string
    data: Omit<ContinuityLedger, 'id' | 'version'>
    expectedVersion: number
    actor?: string
  }): Promise<LedgerSubmitResult> {
    const result: LedgerCommitOutcome = await commitLedger({
      id: params.id,
      data: params.data,
      expectedVersion: params.expectedVersion,
      actor: params.actor ?? '当前标签页'
    })
    await refresh()
    if (result.outcome === 'conflict') {
      const differingFields = diffLedgerFields(result.draft.payload, result.ledger)
      return { outcome: 'conflict', ledger: result.ledger, differingFields, draft: result.draft }
    }
    return { outcome: result.outcome, ledger: result.ledger }
  }

  /** 落后标签页人工确认：用草稿强制覆盖当前账面 */
  async function mergeDraft(draftId: string, actor = '当前标签页'): Promise<void> {
    await forceCommitDraft(draftId, actor)
    await refresh()
  }

  /** 放弃草稿（主账不动，留痕） */
  async function dropDraft(draftId: string, actor = '当前标签页'): Promise<void> {
    await discardDraft(draftId, actor)
    await refresh()
  }

  /** 确认隔离档案：指定连戏编号并归账 */
  async function resolveQuarantine(
    quarantineId: string,
    params: { code: string; name: string; actor?: string }
  ): Promise<void> {
    await confirmQuarantine(quarantineId, { code: params.code, name: params.name, actor: params.actor ?? '当前标签页' })
    await refresh()
  }

  /** 全量重算：待重算差异刷新 / 自动关闭留痕 */
  async function reconcile(actor = '当前标签页'): Promise<ReconcileStats> {
    const stats = await reconcileConflicts(actor)
    lastReconcile.value = stats
    await refresh()
    return stats
  }

  /** 撤下场次：相关差异立即待重算，历史保留 */
  async function withdrawScene(sceneId: string, actor = '当前标签页'): Promise<void> {
    await withdrawSceneRow(sceneId, actor)
    await refresh()
  }

  /** 恢复撤下的场次 */
  async function restoreScene(sceneId: string, actor = '当前标签页'): Promise<void> {
    await restoreSceneRow(sceneId, actor)
    await refresh()
  }

  function historyOf(ledgerId: string): LedgerHistoryRow[] {
    return history.value.filter((item) => item.ledgerId === ledgerId)
  }

  function selectLedger(id: string | null): void {
    activeLedgerId.value = id
  }

  return {
    ledgers,
    drafts,
    history,
    quarantine,
    ready,
    activeLedgerId,
    lastReconcile,
    refresh,
    getById,
    getByCode,
    submit,
    mergeDraft,
    dropDraft,
    resolveQuarantine,
    reconcile,
    withdrawScene,
    restoreScene,
    historyOf,
    selectLedger,
    notifyConflict: (msg: string) => ElMessage.warning(msg)
  }
})
