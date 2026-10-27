// 纯函数单测：船司别名 / SOC·COC 干扰词 / 复合单号 / 形态预筛
import { carrierFromSl, splitComposite, cleanNumber, looksLikeNumber, looksLikeDate } from '../src/lib/cellparse.js'

const cases = []
const eq = (name, got, want) => cases.push([name, got === want, `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`])

// ---- 船司别名（爹地表里真实写法）----
eq('HPL COC', carrierFromSl('HPL COC'), 'hapag')
eq('HPL SOC', carrierFromSl('HPL SOC'), 'hapag')
eq('hpl  soc 正本', carrierFromSl('hpl  soc 正本'), 'hapag')
eq('MSK', carrierFromSl('MSK'), 'maersk')
eq('MSK SWB', carrierFromSl('MSK SWB'), 'maersk')
eq('ZIM', carrierFromSl('ZIM'), 'zim')
eq('MSC', carrierFromSl('MSC'), 'msc')
eq('MSC SOC', carrierFromSl('MSC SOC'), 'msc')
eq('地中海', carrierFromSl('地中海'), 'msc')
eq('COSCO SOC', carrierFromSl('COSCO SOC'), 'cosco')
eq('CMA CGM', carrierFromSl('CMA CGM'), 'cma')
eq('OOCL', carrierFromSl('OOCL'), 'oocl')
eq('ONE', carrierFromSl('ONE'), 'one')
eq('HMM', carrierFromSl('HMM'), 'hmm')
eq('EMC', carrierFromSl('EMC'), 'evergreen')
eq('长荣 EMC', carrierFromSl('长荣 EMC'), 'evergreen')
eq('YML', carrierFromSl('YML'), 'yangming')
eq('AKKON', carrierFromSl('AKKON'), 'akkon')
eq('AKK SOC', carrierFromSl('AKK SOC'), 'akkon')
eq('akkon lines 正本', carrierFromSl('akkon lines 正本'), 'akkon')
eq('WHL', carrierFromSl('WHL'), 'wanhai')
eq('万海', carrierFromSl('万海'), 'wanhai')
eq('SLS', carrierFromSl('SLS'), 'sls')
eq('UGL', carrierFromSl('UGL'), 'ugl')
eq('MLH', carrierFromSl('MLH'), 'mlh')
eq('空', carrierFromSl(''), '')
eq('只有条款词 SOC', carrierFromSl('SOC'), '')
eq('随机备注', carrierFromSl('客户自提 已付'), '')

// ---- SOC/COC 不能把船司吃掉 ----
eq('SOC HPL（顺序颠倒）', carrierFromSl('SOC HPL'), 'hapag')
eq('COC/MSK', carrierFromSl('COC/MSK'), 'maersk')

// ---- 复合单号 ----
eq('订舱/提单 复合', splitComposite('11527275/HLCUEUR25220885E7XX'), 'HLCUEUR25220885E7XX')
eq('空格分隔', splitComposite('30225118 HLCUEUR25BA14ED88XX'), 'HLCUEUR25BA14ED88XX')
eq('单一号码', splitComposite('276759780'), '276759780')
eq('单一 HLCU', splitComposite('HLCUEUR25220885E7XX'), 'HLCUEUR25220885E7XX')
eq('带空格', splitComposite(' HLCU EUR25220885E7XX '), 'HLCUEUR25220885E7XX')
eq('空', splitComposite(''), '')

// ---- 清洗与形态 ----
eq('去空格', cleanNumber(' hlc u eur25220885e7xx '), 'HLCUEUR25220885E7XX')
eq('日期排除', looksLikeDate('20261023'), true)
eq('日期不当单号', looksLikeNumber('20261023'), false)
eq('9 位数字', looksLikeNumber('276759780'), true)
eq('HLCU 提单', looksLikeNumber('HLCUEUR25220885E7XX'), true)
eq('ZIM 单', looksLikeNumber('ZIMUSHH31788752'), true)
eq('太短', looksLikeNumber('A1'), false)
eq('带斜杠（应已拆分前不通过）', looksLikeNumber('11527275/HLCUEUR25220885E7XX'), false)

let bad = 0
for (const [n, ok, d] of cases) {
  if (!ok) bad++
  console.log(`${ok ? '✅' : '❌'} ${n}${ok ? '' : '  ' + d}`)
}
console.log(`\n${cases.length - bad}/${cases.length} 通过`)
process.exit(bad ? 1 : 0)
