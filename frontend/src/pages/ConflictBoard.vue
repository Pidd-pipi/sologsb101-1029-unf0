<script setup lang="ts">
/** /conflicts 连戏差异比对：并排展示同一编号两次记录、待重算标记与处置 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Refresh } from '@element-plus/icons-vue'
import ConflictTag from '@/components/common/ConflictTag.vue'
import FilterBar from '@/components/common/FilterBar.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import { db, type ConflictRow, type LedgerRow, type RecordRow, type SceneRow, type ShootDayRow } from '@/utils/db'
import { useIdbTable } from '@/hooks/useIdbTable'
import { useContinuityDiff } from '@/hooks/useContinuityDiff'
import { useConflictStore } from '@/stores/conflictStore'
import { CONFLICT_SEVERITIES, CONFLICT_STATES } from '@/types/conflict'
import { SEVERITY_WEIGHT } from '@/utils/diff'
import type { FilterSelectConfig, FilterModel } from '@/types/filter'
import { filtersToQuery } from '@/utils/query'

const route = useRoute()
const router = useRouter()
const store = useConflictStore()

const { rows: conflicts, ready } = useIdbTable<ConflictRow>(() => db.conflicts, {
  compare: (a, b) => SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity]
})
const { rows: records } = useIdbTable<RecordRow>(() => db.records)
const { rows: ledgers } = useIdbTable<LedgerRow>(() => db.ledgers)
const { rows: scenes } = useIdbTable<SceneRow>(() => db.scenes, { compare: (a, b) => a.shootOrder - b.shootOrder })
const { rows: shootDays } = useIdbTable<ShootDayRow>(() => db.shootDays)

/** 字段级比对结果（已自动排除作废记录与停用编号） */
const diff = useContinuityDiff(records, ledgers, shootDays)

const selects: FilterSelectConfig[] = [
  { key: 'severities', label: '严重程度', options: CONFLICT_SEVERITIES.map((item) => ({ label: item, value: item })) },
  { key: 'states', label: '处理状态', options: CONFLICT_STATES.map((item) => ({ label: item, value: item })) },
  {
    key: 'staleness',
    label: '重算状态',
    options: [
      { label: '现行', value: '现行' },
      { label: '待重算', value: '待重算' }
    ]
  }
]

function recordOf(id: string): RecordRow | null {
  return records.value.find((item) => item.id === id) ?? null
}

function ledgerOf(ledgerId: string): LedgerRow | null {
  return ledgers.value.find((item) => item.id === ledgerId) ?? null
}

function sceneLabelsOf(ledger: LedgerRow | null): string {
  if (!ledger) return '编号已删'
  return ledger.sceneIds.map((id) => `第 ${scenes.value.find((scene) => scene.id === id)?.sceneNo ?? '?'} 场`).join('、')
}

function dayLabelOf(record: RecordRow | null): string {
  if (!record) return '记录已删除/作废'
  return shootDays.value.find((item) => item.id === record.shootDayId)?.date ?? '未知拍摄日'
}

const filtered = computed(() => {
  const keyword = String(store.filters.keyword ?? '').trim().toLowerCase()
  const severities = Array.isArray(store.filters.severities) ? store.filters.severities : []
  const states = Array.isArray(store.filters.states) ? store.filters.states : []
  const staleness = Array.isArray(store.filters.staleness) ? store.filters.staleness : []
  return conflicts.value
    .filter((conflict) => {
      const ledger = ledgerOf(conflict.ledgerId)
      const label = `${ledger ? `${ledger.code} ${ledger.name}` : ''} ${conflict.diffDesc}`.toLowerCase()
      if (keyword && !label.includes(keyword)) return false
      if (severities.length > 0 && !severities.includes(conflict.severity)) return false
      if (states.length > 0 && !states.includes(conflict.state)) return false
      if (staleness.length > 0) {
        if (staleness.includes('现行') && conflict.stale) return false
        if (staleness.includes('待重算') && !conflict.stale) return false
      }
      return true
    })
    .sort((a, b) => {
      // 待重算沉底
      if (a.stale !== b.stale) return a.stale ? 1 : -1
      return SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity]
    })
})

const totals = computed(() => {
  const open = conflicts.value.filter((item) => item.state === '待确认' && !item.stale)
  return {
    total: conflicts.value.length,
    open: open.length,
    resolved: conflicts.value.filter((item) => item.state === '已解决').length,
    blocking: open.filter((item) => item.severity === '阻断').length,
    stale: conflicts.value.filter((item) => item.stale).length,
    pendingCandidates: diff.diffCount.value
  }
})

const reloading = ref(false)

/** 重新比对：旧差异恢复/归档，新差异入库；待重算清零或更新 */
async function regenerate(): Promise<void> {
  reloading.value = true
  try {
    if (diff.candidates.value.length === 0 && conflicts.value.filter((item) => item.stale).length === 0) {
      ElMessage.info('当前没有可比对的内容（每个在用编号至少需要两次有效现场记录）')
      return
    }
    const stats = await store.regenerate(diff.candidates.value)
    ElMessage.success(
      `重算完成：新生成 ${stats.created} 条，恢复 ${stats.restored} 条，归档 ${stats.archived} 条（归档痕迹在编号台账历史中可查）`
    )
  } finally {
    reloading.value = false
  }
}

async function resolve(conflict: ConflictRow): Promise<void> {
  try {
    const { value } = await ElMessageBox.prompt('请填写处理说明，确认后会把编号当前基准回写为最新现场状态', '消解冲突', {
      inputValue: '已按现场实际状态统一并留痕',
      confirmButtonText: '确认解决',
      cancelButtonText: '取消'
    })
    await store.resolve(conflict.id, value)
    ElMessage.success('冲突已解决，基准已回写，处置痕迹已并入编号台账')
  } catch (error) {
    if (error instanceof Error && error.message) ElMessage.error(error.message)
  }
}

async function reopen(conflict: ConflictRow): Promise<void> {
  await store.reopen(conflict.id)
  ElMessage.success('已重新打开为待确认（原处置痕迹保留）')
}

function onFilterChange(next: FilterModel): void {
  store.setFilters(next)
}

function tableRowClass({ row }: { row: ConflictRow }): string {
  return row.stale ? 'row-stale' : ''
}

onMounted(() => {
  store.applyQuery(route.query)
})

watch(
  () => store.filters,
  (value) => {
    void router.replace({ path: route.path, query: filtersToQuery(value) })
  },
  { deep: true }
)
</script>

<template>
  <div class="page">
    <div class="page__head">
      <div>
        <h2 class="page__title">连戏差异比对与冲突提示</h2>
        <p class="page__subtitle">同一连戏编号取最近两次有效现场记录比对；撤场/停用/记录更新后差异自动转「待重算」，重算前不计入报告风险。</p>
      </div>
      <el-button type="primary" :icon="Refresh" :loading="reloading" @click="regenerate">重新比对（重算待重算）</el-button>
    </div>

    <div class="badge-row">
      <StatBadge label="现行待确认" :value="totals.open" suffix="条" icon="WarningFilled" tone="danger" />
      <StatBadge label="阻断级" :value="totals.blocking" suffix="条" icon="WarningFilled" tone="warning" />
      <StatBadge label="已解决" :value="totals.resolved" suffix="条" icon="CircleCheck" tone="success" />
      <StatBadge label="待重算" :value="totals.stale" suffix="条" icon="RefreshRight" tone="info" />
      <StatBadge label="全部条目" :value="totals.total" suffix="条" icon="Files" tone="primary" />
      <StatBadge label="可比对候选" :value="totals.pendingCandidates" suffix="条" icon="DataLine" tone="info" />
    </div>

    <FilterBar
      :model-value="store.filters"
      :selects="selects"
      keyword-placeholder="搜索编号 / 差异描述…"
      @update:model-value="onFilterChange"
      @reset="store.resetFilters()"
    />

    <EmptyPanel
      v-if="ready && filtered.length === 0"
      title="还没有差异条目"
      description="先在现场记录页为同一连戏编号留下至少两次有效记录，然后点「重新比对」。"
      :show-create="false"
    />

    <el-table v-else :data="filtered" border stripe row-key="id" :row-class-name="tableRowClass">
      <el-table-column label="连戏编号" min-width="180">
        <template #default="{ row }">
          <div>
            <strong>{{ ledgerOf(row.ledgerId)?.code ?? '编号已删' }}</strong>
            · {{ ledgerOf(row.ledgerId)?.name ?? '—' }}
          </div>
          <div class="muted">{{ ledgerOf(row.ledgerId)?.category ?? '—' }} · {{ ledgerOf(row.ledgerId)?.critical ? '关键编号' : '一般编号' }}</div>
          <div class="muted">{{ sceneLabelsOf(ledgerOf(row.ledgerId)) }}</div>
        </template>
      </el-table-column>
      <el-table-column label="记录 A（较早）" min-width="190">
        <template #default="{ row }">
          <div class="muted">{{ dayLabelOf(recordOf(row.recordIdA)) }} · 镜次 {{ recordOf(row.recordIdA)?.takeNo ?? '—' }}</div>
          <div :class="{ 'void-text': recordOf(row.recordIdA)?.voided }">
            {{ recordOf(row.recordIdA)?.currentState ?? '记录已删除' }}
          </div>
        </template>
      </el-table-column>
      <el-table-column label="记录 B（较晚）" min-width="190">
        <template #default="{ row }">
          <div class="muted">{{ dayLabelOf(recordOf(row.recordIdB)) }} · 镜次 {{ recordOf(row.recordIdB)?.takeNo ?? '—' }}</div>
          <div :class="{ 'void-text': recordOf(row.recordIdB)?.voided }">
            {{ recordOf(row.recordIdB)?.currentState ?? '记录已删除' }}
          </div>
        </template>
      </el-table-column>
      <el-table-column label="差异 / 重算状态" min-width="240">
        <template #default="{ row }">
          <div>{{ row.diffDesc }}</div>
          <el-alert
            v-if="row.stale"
            type="warning"
            :closable="false"
            show-icon
            class="stale-alert"
            :title="`待重算：${row.staleReason || '账面已变更'}`"
            :description="row.staleAt ? row.staleAt.slice(0, 19).replace('T', ' ') : ''"
          />
        </template>
      </el-table-column>
      <el-table-column label="严重 / 状态" width="160">
        <template #default="{ row }">
          <ConflictTag :severity="row.stale ? undefined : row.severity" :state="row.state" />
          <el-tag v-if="row.stale" size="small" type="warning" effect="dark" round>待重算</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="解决留痕" min-width="170">
        <template #default="{ row }">
          <template v-if="row.state === '已解决'">
            <div>{{ row.resolvedNote }}</div>
            <div class="muted">{{ row.resolvedAt ? row.resolvedAt.slice(0, 19).replace('T', ' ') : '' }}</div>
          </template>
          <span v-else class="muted">—</span>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="150" fixed="right">
        <template #default="{ row }">
          <el-button v-if="row.state === '待确认' && !row.stale" link type="success" size="small" @click="resolve(row)">解决</el-button>
          <el-button v-else-if="row.state === '已解决'" link type="warning" size="small" @click="reopen(row)">重开</el-button>
          <el-tag v-else-if="row.stale" size="small" type="info" effect="plain">重算后处理</el-tag>
        </template>
      </el-table-column>
    </el-table>
  </div>
</template>

<style scoped>
.stale-alert {
  margin-top: 6px;
  padding: 4px 8px;
}

.void-text {
  text-decoration: line-through;
  color: #9aa5ad;
}

:deep(.row-stale) {
  background-color: #fdf6ec !important;
}
</style>
