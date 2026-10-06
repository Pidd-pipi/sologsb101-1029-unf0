/**
 * 共同账并发提交工具：
 * 两个标签页同时提交同一编号时，各自按读到的存储版本落地；
 * 落后一方不落主账，保留表格草稿，并列出双方不同的字段。
 */
import type { ContinuityLedger } from '@/types/ledger'
import { LEDGER_FIELD_LABELS } from '@/types/ledger'

/** 取点路径字段值（支持 baseline.state 这类嵌套路径） */
export function getPathValue(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc !== null && typeof acc === 'object') return (acc as Record<string, unknown>)[key]
    return undefined
  }, obj)
}

/** 共同账参与比对的字段口径 */
export const LEDGER_COMPARE_FIELDS: string[] = [
  'code',
  'category',
  'name',
  'sceneIds',
  'baseline.state',
  'baseline.photoNote',
  'owner',
  'critical',
  'status'
]

function comparable(value: unknown): string {
  if (Array.isArray(value)) return [...value].map(String).sort().join('')
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

/** 两个账面对象在指定字段上是否不同 */
export function isFieldDifferent(a: unknown, b: unknown, field: string): boolean {
  return comparable(getPathValue(a, field)) !== comparable(getPathValue(b, field))
}

/** 列出落后方草稿与先落地账面之间不同的字段（中文标签 + 路径） */
export interface LedgerFieldDifference {
  field: string
  label: string
  /** 落后方草稿里的值 */
  draft: unknown
  /** 已落地（当前存储）里的值 */
  current: unknown
}

export function diffLedgerFields(
  draft: Partial<ContinuityLedger>,
  current: Partial<ContinuityLedger>,
  fields: string[] = LEDGER_COMPARE_FIELDS
): LedgerFieldDifference[] {
  return fields
    .filter((field) => isFieldDifferent(draft, current, field))
    .map((field) => ({
      field,
      label: LEDGER_FIELD_LABELS[field] ?? field,
      draft: getPathValue(draft, field),
      current: getPathValue(current, field)
    }))
}

/** 把字段值格式化成可展示文本 */
export function formatFieldValue(value: unknown): string {
  if (value === undefined || value === null || value === '') return '（空）'
  if (Array.isArray(value)) return value.length > 0 ? value.map(String).join('、') : '（空）'
  if (typeof value === 'boolean') return value ? '是' : '否'
  return String(value)
}
