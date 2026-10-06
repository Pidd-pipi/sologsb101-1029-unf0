<script setup lang="ts">
/** /conflicts 连戏差异比对与冲突提示：按连戏编号并排展示两次记录、重算与解决状态 */
import { computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Refresh } from '@element-plus/icons-vue'
import ConflictTag from '@/components/common/ConflictTag.vue'
import FilterBar from '@/components/common/FilterBar.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import { db, type ConflictRow, type ElementRow, type RecordRow, type SceneRow, type ShootDayRow, type LedgerRow } from '@/utils/db'
import { useIdbTable } from '@/hooks/useIdbTable'
import { useContinuityDiff } from '@/hooks/useContinuityDiff'
import { useConflictStore } from '@/stores/conflictStore'
import { CONFLICT_SEVERITIES, CONFLICT_STATES, CONFLICT_STALE_STATES } from '@/types/conflict'
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
const { rows: elements } = useIdbTable<ElementRow>(() => db.elements)
const { rows: scenes } = useIdbTable<SceneRow>(() => db.scenes, { compare: (a, b) => a.shootOrder - b.shootOrder })
const { rows: shootDays } = useIdbTable<ShootDayRow>(() => db.shootDays)
const { rows: ledgers } = useIdbTable<LedgerRow>(() => db.ledgers)

/** 按连戏编号（共同账）的字段级比对结果 */
const diff = useContinuityDiff(records, elements, shootDays, ledgers, scenes)

const selects: FilterSelectConfig[] = [
  { key: 'severities', label: '严重程度', options: CONFLICT_SEVERITIES.map((item) => ({ label: item, value: item })) },
  { key: 'states', label: '处理状态', options: CONFLICT_STATES.map((item) => ({ label: item, value: item })) },
  { key: 'stales', label: '重算状态', options: CONFLICT_STALE_STATES.map((item) => ({ label: item, value: item })) }
]

function recordOf(id: string): RecordRow | null {
  return records.value.find((item) => item.id === id) ?? null
}

function ledgerOf(conflict: ConflictRow): LedgerRow | null {
  return ledgers.value.find((item) => item.id === conflict.ledgerId) ?? null
}

function elementOf(elementId: string): ElementRow | null {
  return elements.value.find((item) => item.id === elementId) ?? null
}

function sceneLabelOf(conflict: ConflictRow): string {
  const ids = ledgerOf(conflict)?.sceneIds ?? [elementOf(conflict.elementId)?.sceneId ?? '']
  const labels = ids
    .map((sceneId) => scenes.value.find((item) => item.id === sceneId))
    .filter((scene): scene is SceneRow => Boolean(scene))
    .map((scene) => `第 ${scene.sceneNo} 场`)
  return labels.length > 0 ? labels.join('、') : '场次已撤下或删除'
}

function dayLabelOf(record: RecordRow | null): string {
  if (!record) return '记录已删除'
  return shootDays.value.find((item) => item.id === record.shootDayId)?.date ?? '未知拍摄日'
}

const filtered = computed(() => {
  const keyword = String(store.filters.keyword ?? '').trim().toLowerCase()
  const severities = Array.isArray(store.filters.severities) ? store.filters.severities : []
  const states = Array.isArray(store.filters.states) ? store.filters.states : []
  const stales = Array.isArray(store.filters.stales) ? store.filters.stales : []
  return conflicts.value
    .filter((conflict) => {
      const ledger = ledgerOf(conflict)
      const label = `${ledger ? ledger.name : ''} ${conflict.continuityNo} ${conflict.diffDesc}`.toLowerCase()
      if (keyword && !label.includes(keyword)) return false
      if (severities.length > 0 && !severities.includes(conflict.severity)) return false
      if (states.length > 0 && !states.includes(conflict.state)) return false
      if (stales.length > 0 && !stales.includes(conflict.stale)) return false
      return true
    })
    .sort((a, b) => SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity])
})

const totals = computed(() => {
  const open = conflicts.value.filter((item) => item.state === '待确认')
  const stale = conflicts.value.filter((item) => item.stale === '待重算')
  return {
    total: conflicts.value.length,
    open: open.length,
    resolved: conflicts.value.filter((item) => item.state === '已解决').length,
    blocking: open.filter((item) => item.severity === '阻断' && item.stale === '现行').length,
    staleCount: stale.length,
    pendingCandidates: diff.diffCount.value
  }
})

/** 重新比对（全量重算）：待重算差异立即刷新或自动关闭留痕 */
async function regenerate(): Promise<void> {
  const stats = await store.reconcile()
  const touched = stats.created + stats.updated + stats.closed
  if (touched === 0 && diff.candidates.value.length === 0) {
    ElMessage.info('当前没有可重算的差异（每个编号至少需要两次现场记录）')
    return
  }
  ElMessage.success(`重算完成：新增 ${stats.created} 条、刷新 ${stats.updated} 条、自动关闭 ${stats.closed} 条`)
}

async function resolve(conflict: ConflictRow): Promise<void> {
  try {
    const { value } = await ElMessageBox.prompt('请填写处理说明，确认后会把当前基准回写为最新现场状态', '消解冲突', {
      inputValue: '已按现场实际状态统一并留痕',
      confirmButtonText: '确认解决',
      cancelButtonText: '取消'
    })
    await store.resolve(conflict.id, value)
    ElMessage.success('冲突已解决并回写共同账基准')
  } catch (error) {
    if (error instanceof Error && error.message) ElMessage.error(error.message)
  }
}

async function reopen(conflict: ConflictRow): Promise<void> {
  await store.reopen(conflict.id)
  ElMessage.success('已重新打开为待确认（解决留痕保留）')
}

async function remove(conflict: ConflictRow): Promise<void> {
  try {
    await ElMessageBox.confirm('删除该差异条目不改变现场记录，是否继续？', '删除确认', { type: 'warning' })
  } catch {
    return
  }
  await store.remove(conflict.id)
  ElMessage.success('差异条目已删除')
}

function onFilterChange(next: FilterModel): void {
  store.setFilters(next)
}

function conflictRowClass({ row }: { row: ConflictRow }): string {
  return row.stale === '待重算' ? 'row-stale' : ''
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
        <p class="page__subtitle">同一要素取最近两次现场记录做字段级比对（状态文本会做颜色/款式同义归一）。</p>
      </div>
      <el-button type="primary" :icon="Refresh" @click="regenerate">重新比对生成差异</el-button>
    </div>

    <div class="badge-row">
      <StatBadge label="差异条目" :value="totals.total" suffix="条" icon="Files" tone="primary" />
      <StatBadge label="待确认" :value="totals.open" suffix="条" icon="WarningFilled" tone="danger" />
      <StatBadge label="已解决" :value="totals.resolved" suffix="条" icon="Grid" tone="success" />
      <StatBadge label="现行阻断" :value="totals.blocking" suffix="条" icon="WarningFilled" tone="warning" />
      <StatBadge label="待重算" :value="totals.staleCount" suffix="条" icon="RefreshRight" tone="info" />
      <StatBadge label="可比对编号" :value="totals.pendingCandidates" suffix="个" icon="DataLine" tone="info" />
    </div>

    <FilterBar
      :model-value="store.filters"
      :selects="selects"
      keyword-placeholder="搜索要素 / 差异描述…"
      @update:model-value="onFilterChange"
      @reset="store.resetFilters()"
    />

    <EmptyPanel
      v-if="ready && filtered.length === 0"
      title="还没有差异条目"
      description="先在现场记录页为同一要素留下至少两次记录，然后点「重新比对生成差异」。"
      :show-create="false"
    />

    <el-table
      v-else
      :data="filtered"
      border
      stripe
      row-key="id"
      :row-class-name="conflictRowClass"
    >
      <el-table-column label="连戏编号" width="120">
        <template #default="{ row }">
          <strong>{{ row.continuityNo || '未编号' }}</strong>
          <div class="muted">{{ ledgerOf(row)?.name ?? '共同账已删除' }}</div>
        </template>
      </el-table-column>
      <el-table-column label="关联场次" min-width="150">
        <template #default="{ row }">
          {{ sceneLabelOf(row) }}
          <div class="muted">{{ ledgerOf(row)?.category ?? elementOf(row.elementId)?.category ?? '—' }} · {{ ledgerOf(row)?.critical || elementOf(row.elementId)?.critical ? '关键' : '一般' }}</div>
        </template>
      </el-table-column>
      <el-table-column label="记录 A（较早）" min-width="190">
        <template #default="{ row }">
          <div class="muted">{{ dayLabelOf(recordOf(row.recordIdA)) }} · 镜次 {{ recordOf(row.recordIdA)?.takeNo ?? '—' }}</div>
          <div>{{ recordOf(row.recordIdA)?.currentState ?? '记录已删除' }}</div>
        </template>
      </el-table-column>
      <el-table-column label="记录 B（较晚）" min-width="190">
        <template #default="{ row }">
          <div class="muted">{{ dayLabelOf(recordOf(row.recordIdB)) }} · 镜次 {{ recordOf(row.recordIdB)?.takeNo ?? '—' }}</div>
          <div>{{ recordOf(row.recordIdB)?.currentState ?? '记录已删除' }}</div>
        </template>
      </el-table-column>
      <el-table-column prop="diffDesc" label="差异描述" min-width="240" />
      <el-table-column label="严重 / 状态 / 重算" width="190">
        <template #default="{ row }">
          <ConflictTag :severity="row.severity" :state="row.state" />
          <div class="stale-line">
            <el-tag v-if="row.stale === '待重算'" type="warning" size="small" effect="dark" round>待重算 · {{ row.staleReason }}</el-tag>
            <el-tag v-else type="success" size="small" effect="plain" round>现行</el-tag>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="解决留痕" min-width="180">
        <template #default="{ row }">
          <template v-if="row.state === '已解决'">
            <div>{{ row.resolvedNote }}</div>
            <div class="muted">{{ row.resolvedAt ? row.resolvedAt.slice(0, 19).replace('T', ' ') : '' }}</div>
          </template>
          <span v-else class="muted">—</span>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="180" fixed="right">
        <template #default="{ row }">
          <el-button v-if="row.state === '待确认'" link type="success" size="small" :disabled="row.stale === '待重算'" @click="resolve(row)">解决</el-button>
          <el-button v-else link type="warning" size="small" @click="reopen(row)">重开</el-button>
          <el-button link type="danger" size="small" @click="remove(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>
  </div>
</template>

<style scoped>
.stale-line {
  margin-top: 4px;
}

:deep(.row-stale) {
  background-color: #fdf6ec !important;
}
</style>
