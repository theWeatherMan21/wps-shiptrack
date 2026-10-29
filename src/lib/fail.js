// 失败归类：把各船司千奇百怪的原话，收敛成 5 类，面板才能给出一眼能懂的汇总。
// 原则：分类只用来「帮用户决定要不要动手」，原始文案仍然保留在行里。
const RULES = [
  { kind: 'expired',  label: '已过期',   re: /保留.{0,6}(个月|天|年)|仅保留|只保留|expired|too old/i },
  { kind: 'blocked',  label: '站点拦截', re: /被拦|改版|非 JSON|DataDome|Cloudflare|cf_clearance|验证码|滑块|两个入口都不可用|无查询表单/i },
  { kind: 'format',   label: '号码格式', re: /格式不符|位数|应为\s*\d+\s*位|格式错误/i },
  { kind: 'network',  label: '网络',     re: /ECONN|ERR_|XHR|网络|超时|timeout|Target page|browser has been closed|桥没连上/i },
  { kind: 'notfound', label: '官网查无', re: /查无此号|查无此单|无数据|未找到|not found|No tracking data|不存在|no record/i },
  { kind: 'notwired', label: '未接入',   re: /暂未接入|未接入追踪|请手工查/i },
]

/** @returns {{kind:string,label:string}} */
export function classifyFail(text) {
  const t = String(text || '')
  for (const r of RULES) if (r.re.test(t)) return { kind: r.kind, label: r.label }
  return { kind: 'other', label: '其他' }
}

/** 一次刷新后的汇总文案：成功 88 · 已过期 5 · 站点拦截 2 */
export function summarize(items) {
  const ok = items.filter((x) => x.state === 'ok' && !/查无|无数据|未找到|未返回|没有数据/.test(String(x.text || ''))).length
  const counts = new Map()
  for (const it of items) {
    if (it.state !== 'error' && !/查无|无数据|未找到|未返回|没有数据/.test(String(it.text || ''))) continue
    const { label } = classifyFail(`${it.failReason || ''} ${it.text || ''}`)
    counts.set(label, (counts.get(label) || 0) + 1)
  }
  const parts = [`成功 ${ok}`]
  for (const [k, v] of [...counts.entries()].sort((a, b) => b[1] - a[1])) parts.push(`${k} ${v}`)
  return parts.join(' · ')
}
