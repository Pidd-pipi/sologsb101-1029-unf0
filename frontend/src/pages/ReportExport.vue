<script setup lang="ts">
/** /report 连戏核对报告、提交前快照恢复与整库导入导出 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Download, Upload, RefreshLeft } from '@element-plus/icons-vue'
import FilterBar from '@/components/common/FilterBar.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import ConflictTag from '@/components/common/ConflictTag.vue'
import HistoryTimeline from '@/components/common/HistoryTimeline.vue'
import {
  db,
  countAll,
  exportSnapshot,
  importSnapshot,
  resetDatabase,
  restoreCheckpoint,
  isLegacySnapshot,
  convertLegacySnapshot,
  DB_NAME,
  DB_SCHEMA_VERSION,
  type CheckpointRow,
  type ConflictRow
} from '@/utils/db'
import { useIdbTable } from '@/hooks/useIdbTable'
import { buildReport, downloadJson, parseReport, riskScore, serializeReport, type ContinuityReport } from '@/utils/export'
import type { DatabaseSnapshot } from '@/utils/db'
import type { FilterModel } from '@/types/filter'
import { filtersToQuery } from '@/utils/query'

const route = useRoute()
const router = useRouter()

const { rows: conflicts } = useIdbTable<ConflictRow>(() => db.conflicts)
const { rows: checkpoints, refresh: refreshCheckpoints } = useIdbTable<CheckpointRow>(() => db.checkpoints)
const report = ref<ContinuityReport | null>(null)
const dbCounts = ref<Record<string, number>>({})
const filters = ref<FilterModel>({ keyword: '' })
const preview = ref('')
const activeTab = ref<'report' | 'checkpoints' | 'history'>('report')

const totals = computed(() => {
  const open = conflicts.value.filter((item) => item.state === '待确认' && !item.stale)
  return {
    total: conflicts.value.length,
    open: open.length,
    resolved: conflicts.value.filter((item) => item.state === '已解决').length,
    stale: conflicts.value.filter((item) => item.stale).length,
    blocking: open.filter((item) => item.severity === '阻断').length,
    risk: riskScore(conflicts.value)
  }
})

const rows = computed(() => {
  const list = report.value?.summary.rows ?? []
  const keyword = String(filters.value.keyword ?? '').trim().toLowerCase()
  if (!keyword) return list
  return list.filter((row) =>
    `${row.sceneNo} ${row.location} ${row.place} ${row.timeOfDay}`.toLowerCase().includes(keyword)
  )
})

const restorableCheckpoints = computed(() => checkpoints.value.filter((item) => item.status === '可恢复').slice(0, 15))

const SNAPSHOT_TABLE_LABELS: Record<string, string> = {
  scenes: '场次',
  ledgers: '编号',
  records: '记录',
  conflicts: '差异',
  shootDays: '拍摄日',
  quarantine: '隔离'
}

/** 快照实际触碰过的表及行数 */
function touchedTables(checkpoint: CheckpointRow): Array<{ name: string; label: string; count: number }> {
  return Object.entries(checkpoint.snapshot)
    .map(([name, snap]) => ({ name, label: SNAPSHOT_TABLE_LABELS[name] ?? name, count: snap.put.length + snap.delete.length }))
    .filter((item) => item.count > 0)
}

async function refresh(): Promise<void> {
  report.value = await buildReport()
  dbCounts.value = await countAll()
  preview.value = serializeReport(report.value)
  await refreshCheckpoints()
}

async function exportReport(): Promise<void> {
  const current = await buildReport()
  downloadJson(`连戏核对报告-${current.exportedAt.slice(0, 10)}.json`, serializeReport(current))
  ElMessage.success('连戏核对报告已下载（待重算差异未计入风险）')
}

async function exportLibrary(): Promise<void> {
  const snapshot = await exportSnapshot()
  downloadJson(`gbcontinuity-备份-${snapshot.exportedAt.slice(0, 10)}.json`, JSON.stringify(snapshot, null, 2))
  ElMessage.success('本地库已导出为 JSON（含历史与隔离区）')
}

async function importLibrary(): Promise<void> {
  try {
    const { value } = await ElMessageBox.prompt('粘贴整库 JSON 备份内容后确认导入（将覆盖现有数据）；v1 旧备份会自动按编号归并', '导入备份', {
      inputType: 'textarea',
      confirmButtonText: '确认导入'
    })
    const parsed = parseReport(value) as Record<string, unknown>
    const legacy = isLegacySnapshot(parsed)
    const snapshot: DatabaseSnapshot = legacy
      ? convertLegacySnapshot(parsed)
      : (() => {
          if (!Array.isArray(parsed.ledgers)) throw new Error('缺少 ledgers 数组字段，不是本应用的备份文件')
          return parsed as unknown as DatabaseSnapshot
        })()
    await importSnapshot(snapshot)
    await refresh()
    ElMessage.success(legacy ? 'v1 旧备份已按连戏编号归并导入，缺编号档案已进隔离区' : '备份已导入')
  } catch (error) {
    if (error instanceof Error && error.message) ElMessage.error(`导入失败：${error.message}`)
  }
}

/** 写入失败/反悔：从提交前账面状态恢复 */
async function restore(checkpoint: CheckpointRow): Promise<void> {
  try {
    const { value } = await ElMessageBox.prompt(
      `将把账面恢复到「${checkpoint.label}」提交前的状态，之后的提交会被标记失效。确认恢复？`,
      '账面恢复确认',
      { inputValue: '提交异常，恢复到提交前账面', confirmButtonText: '确认恢复', cancelButtonText: '取消' }
    )
    await restoreCheckpoint(checkpoint.id, value || '手动恢复')
    await refresh()
    ElMessage.success('账面已恢复到提交前状态，恢复动作已记入历史')
  } catch (error) {
    if (error instanceof Error && error.message) ElMessage.error(`恢复失败：${error.message}`)
  }
}

async function resetDemo(): Promise<void> {
  try {
    await ElMessageBox.confirm('将清空本地库并重新灌入演示数据，是否继续？', '重置确认', { type: 'warning' })
  } catch {
    return
  }
  await resetDatabase()
  await refresh()
  ElMessage.success('已重置为演示数据')
}

function formatTime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ')
}

function onFilterChange(next: FilterModel): void {
  filters.value = next
}

onMounted(() => {
  void refresh()
  if (typeof route.query.keyword === 'string') filters.value.keyword = route.query.keyword
  if (route.query.tab === 'checkpoints') activeTab.value = 'checkpoints'
})

watch(filters, (value) => {
  void router.replace({ path: route.path, query: filtersToQuery(value) })
}, { deep: true })
</script>

<template>
  <div class="page">
    <div class="page__head">
      <div>
        <h2 class="page__title">连戏核对报告与账面恢复</h2>
        <p class="page__subtitle">
          本地库 {{ DB_NAME }}（结构版本 v{{ DB_SCHEMA_VERSION }}）· 待重算差异不计入风险分；每次提交都有可恢复快照。
        </p>
      </div>
      <div>
        <el-button :icon="Download" @click="exportLibrary">导出整库备份</el-button>
        <el-button type="primary" :icon="Download" @click="exportReport">导出核对报告</el-button>
      </div>
    </div>

    <div class="badge-row">
      <StatBadge label="现行未解决" :value="totals.open" suffix="条" icon="WarningFilled" tone="danger" />
      <StatBadge label="阻断级" :value="totals.blocking" suffix="条" icon="WarningFilled" tone="warning" />
      <StatBadge label="待重算" :value="totals.stale" suffix="条" icon="RefreshRight" tone="info" />
      <StatBadge label="已解决" :value="totals.resolved" suffix="条" icon="CircleCheck" tone="success" />
      <StatBadge label="现行风险分" :value="totals.risk" suffix="分" icon="TrendCharts" tone="primary" />
    </div>

    <el-tabs v-model="activeTab" class="report-tabs">
      <el-tab-pane label="场次核对小结" name="report">
        <FilterBar
          :model-value="filters"
          keyword-placeholder="搜索场号 / 地点 / 内外景…"
          :show-reset="true"
          @update:model-value="onFilterChange"
          @reset="filters = { keyword: '' }"
        />

        <el-card v-if="report" shadow="never">
          <template #header>
            <div class="card-title">
              <span>场次核对小结</span>
              <span class="muted">
                场次 {{ report.summary.sceneCount }} · 编号 {{ report.summary.ledgerCount }}（停用 {{ report.summary.inactiveLedgerCount }}）·
                有效记录 {{ report.summary.recordCount }}（作废留档 {{ report.summary.voidedRecordCount }}）·
                隔离待确认 {{ report.summary.quarantineCount }} · 风险最高 第 {{ report.summary.riskiestSceneNo }} 场
              </span>
            </div>
          </template>
          <EmptyPanel v-if="rows.length === 0" title="没有匹配的场次" description="调整关键字后重试。" :show-create="false" />
          <el-table v-else :data="rows" border stripe>
            <el-table-column prop="sceneNo" label="场号" width="90" />
            <el-table-column label="内外景 / 时间" width="130">
              <template #default="{ row }">
                <ConflictTag :state="row.state" />
                <div class="muted">{{ row.place }} · {{ row.timeOfDay }}</div>
              </template>
            </el-table-column>
            <el-table-column prop="location" label="地点" min-width="140" />
            <el-table-column prop="ledgerCount" label="编号数" width="80" align="right" />
            <el-table-column prop="criticalLedgerCount" label="关键编号" width="90" align="right" />
            <el-table-column label="现行未解决" width="100" align="right">
              <template #default="{ row }">
                <el-tag :type="row.openConflictCount > 0 ? 'danger' : 'success'" size="small" effect="plain">
                  {{ row.openConflictCount }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="待重算" width="90" align="right">
              <template #default="{ row }">
                <el-tag :type="row.staleConflictCount > 0 ? 'warning' : 'info'" size="small" effect="plain">
                  {{ row.staleConflictCount }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="resolvedConflictCount" label="已解决" width="80" align="right" />
            <el-table-column prop="shootDayCount" label="拍摄日" width="80" align="right" />
          </el-table>
        </el-card>

        <el-row :gutter="16" class="mt-row">
          <el-col :span="12">
            <el-card shadow="never">
              <template #header>
                <div class="card-title"><span>本地结构版本</span><span class="muted">IndexedDB</span></div>
              </template>
              <el-descriptions :column="2" border size="small">
                <el-descriptions-item label="库名">{{ DB_NAME }}</el-descriptions-item>
                <el-descriptions-item label="结构版本">v{{ DB_SCHEMA_VERSION }}（连戏编号共同账）</el-descriptions-item>
                <el-descriptions-item label="场次/编号">{{ dbCounts.scenes ?? 0 }} / {{ dbCounts.ledgers ?? 0 }}</el-descriptions-item>
                <el-descriptions-item label="拍摄日/记录">{{ dbCounts.shootDays ?? 0 }} / {{ dbCounts.records ?? 0 }}</el-descriptions-item>
                <el-descriptions-item label="现行差异/待重算">{{ dbCounts.conflicts ?? 0 }} / {{ totals.stale }}</el-descriptions-item>
                <el-descriptions-item label="历史/隔离">{{ dbCounts.history ?? 0 }} / {{ dbCounts.quarantine ?? 0 }}</el-descriptions-item>
              </el-descriptions>
              <div class="btn-row">
                <el-button :icon="Upload" @click="importLibrary">导入备份（支持 v1）</el-button>
                <el-button type="danger" plain @click="resetDemo">重置演示数据</el-button>
                <el-button @click="refresh">刷新报告</el-button>
              </div>
            </el-card>
          </el-col>
          <el-col :span="12">
            <el-card shadow="never">
              <template #header>
                <div class="card-title"><span>报告 JSON 预览</span><span class="muted">可直接复制</span></div>
              </template>
              <el-input v-model="preview" type="textarea" :rows="12" readonly />
            </el-card>
          </el-col>
        </el-row>
      </el-tab-pane>

      <el-tab-pane :label="`提交前快照恢复（${restorableCheckpoints.length}）`" name="checkpoints">
        <el-card shadow="never">
          <template #header>
            <div class="card-title">
              <span>提交前账面快照</span>
              <span class="muted">写入失败或反悔时可恢复；恢复留痕，快照本身不删除</span>
            </div>
          </template>
          <EmptyPanel
            v-if="restorableCheckpoints.length === 0"
            title="暂无可恢复快照"
            description="每次新建/编辑/撤场/停用/重算等提交前都会自动留存一份账面快照（最近 30 份）。"
            :show-create="false"
          />
          <el-table v-else :data="restorableCheckpoints" border size="small">
            <el-table-column label="提交时间" width="170">
              <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
            </el-table-column>
            <el-table-column prop="label" label="提交动作" min-width="200" />
            <el-table-column label="快照覆盖" min-width="260">
              <template #default="{ row }">
                <el-tag v-for="item in touchedTables(row)" :key="item.name" size="small" effect="plain" class="cp-tag">
                  {{ item.label }} {{ item.count }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="130" fixed="right">
              <template #default="{ row }">
                <el-button link type="warning" size="small" :icon="RefreshLeft" @click="restore(row)">恢复到提交前</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-tab-pane>

      <el-tab-pane label="全部历史痕迹" name="history">
        <el-card shadow="never">
          <template #header>
            <div class="card-title">
              <span>历史台账（只追加，永不删除）</span>
              <span class="muted">归并 / 隔离 / 处置 / 撤场 / 待重算 / 回滚恢复全部在此</span>
            </div>
          </template>
          <HistoryTimeline />
        </el-card>
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<style scoped>
.btn-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}

.mt-row {
  margin-top: 16px;
}

.report-tabs {
  margin-top: 8px;
}

.cp-tag {
  margin: 2px 4px 2px 0;
}
</style>
