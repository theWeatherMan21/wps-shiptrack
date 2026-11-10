// 只做 SFC 编译语法检查（不产出、不起 dev server）
import { readFileSync } from 'node:fs'
import { parse, compileTemplate, compileScript } from '@vue/compiler-sfc'

const file = new URL('../src/components/TaskPane.vue', import.meta.url).pathname
const src = readFileSync(file, 'utf8')
const { descriptor, errors } = parse(src, { filename: file })
if (errors.length) { console.error('PARSE_FAIL', errors.map((e) => e.message)); process.exit(1) }
let bad = 0
try {
  const s = compileScript(descriptor, { id: 'x' })
  console.log('SCRIPT_OK', s.content.length, 'chars')
} catch (e) { bad++; console.error('SCRIPT_FAIL', e.message) }
if (descriptor.template) {
  const t = compileTemplate({ source: descriptor.template.content, filename: file, id: 'x' })
  if (t.errors && t.errors.length) { bad++; console.error('TEMPLATE_FAIL', t.errors.map(String)) }
  else console.log('TEMPLATE_OK')
}
process.exit(bad ? 1 : 0)
