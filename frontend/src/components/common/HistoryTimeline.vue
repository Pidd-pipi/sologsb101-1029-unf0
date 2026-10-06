<script setup lang="ts">
/**
 * HistoryTimeline：只追加历史的时间轴视图。
 * 可按 ledgerId 过滤单个编号的痕迹；历史永不物理删除。
 */
import { computed, ref } from 'vue'
import { db, type HistoryRow } from '@/utils/db'
import { useIdbTable } from '@/hooks/useIdbTable'

const props = withDefaults(
  defineProps<{
    ledgerId?: string
    /** 只看某类动作 */
    action?: string
    /** 最多显示条数（0 = 全部） */
    limit?: number
  }>(),
  { ledgerId: '', action: '', limit: 0 }
)

const keyword = ref('')

const { rows: history, ready } = useIdbTable<HistoryRow>(() => db.history)

const filtered = computed(() => {
  let list = history.value
  if (props.ledgerId) list = list.filter((item) => item.ledgerId === props.ledgerId)
  if (props.action) list = list.filter((item) => item.action === props.action)
  const kw = keyword.value.trim().toLowerCase()
  if (kw) list = list.filter((item) => `${item.code} ${item.detail} ${item.action}`.toLowerCase().includes(kw))
  return props.limit > 0 ? list.slice(0, props.limit) : list
})

const ACTION_TYPES: Record<string, string> = {
  归并: 'success',
  隔离: 'warning',
  建档: 'primary',
  编辑: 'info',
  更新基准: 'primary',
  现场记录: 'info',
  撤场: 'warning',
  停用: 'info',
  重新启用: 'success',
  冲突处置: 'success',
  差异待重算: 'warning',
  差异生成: 'warning',
  差异归档: 'info',
  差异恢复: 'success',
  回滚恢复: 'danger',
  隔离确认: 'success',
  导入: 'primary'
}
</script>

<template>
  <div class="history-timeline">
    <el-input v-model="keyword" placeholder="搜索痕迹说明 / 编号…" clearable size="small" class="history-search" />
    <el-empty v-if="ready && filtered.length === 0" description="暂无历史痕迹" :image-size="60" />
    <el-timeline v-else>
      <el-timeline-item
        v-for="item in filtered"
        :key="item.id"
        :type="(ACTION_TYPES[item.action] as never) ?? 'primary'"
        :timestamp="`${item.at.slice(0, 19).replace('T', ' ')}${item.code ? ` · ${item.code}` : ''}`"
        placement="top"
      >
        <el-tag size="small" :type="(ACTION_TYPES[item.action] as never) ?? 'info'" effect="plain">{{ item.action }}</el-tag>
        <div class="history-detail">{{ item.detail }}</div>
      </el-timeline-item>
    </el-timeline>
  </div>
</template>

<style scoped>
.history-search {
  margin-bottom: 12px;
}

.history-detail {
  margin-top: 4px;
  font-size: 13px;
  color: #4a5560;
  line-height: 1.6;
}
</style>
