#!/usr/bin/env node
// 模板静态检查：抓「模板里调用了不存在的方法」这类只在渲染时才炸的错误。
//
// 由来（2026-10-26）：在模板里写了 {{ colLetter(cfg.polCol) }}，而 colLetter 是模块级函数、
// 不是组件方法 —— 单测/逻辑探针全绿，用户点开面板直接白屏。渲染冒烟也没抓住（Vue 会吞异常），
// 所以这里做纯静态识别：模板里出现的函数名，必须在组件里能找到定义。
import fs from 'node:fs';
import path from 'node:path';

const FILE = process.argv[2] || 'src/components/TaskPane.vue';
const src = fs.readFileSync(FILE, 'utf8');

const tplStart = src.indexOf('<template>');
const tplEnd = src.lastIndexOf('</template>');
if (tplStart < 0 || tplEnd < 0) { console.log('✗ 找不到 <template>'); process.exit(1); }
const tpl = src.slice(tplStart, tplEnd);
const script = src.slice(tplEnd);

// 组件里可用的名字：methods / computed / data 返回的键 / props
const defined = new Set();
const addAll = (block, re) => { for (const m of block.matchAll(re)) defined.add(m[1]); };

const methodsBlock = script.slice(script.indexOf('methods: {'));
addAll(methodsBlock, /^\s{4}(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/gm);
addAll(script, /^\s{4}([A-Za-z_$][\w$]*)\s*\(\)\s*\{\s*$/gm);          // computed 简写
const dataBlock = script.slice(script.indexOf('return {'), script.indexOf('computed:'));
addAll(dataBlock, /^\s{6}([A-Za-z_$][\w$]*)\s*:/gm);
addAll(script, /props:\s*\[([^\]]*)\]/g);                                // 粗略，下面再补

// 模块级 const/function 在 Options API 模板里**不可见**，但为了少误报仍单独记一份
const moduleNames = new Set();
for (const m of script.matchAll(/^const\s+([A-Za-z_$][\w$]*)\s*=/gm)) moduleNames.add(m[1]);
for (const m of script.matchAll(/^function\s+([A-Za-z_$][\w$]*)/gm)) moduleNames.add(m[1]);

// 全局/内置，忽略
const GLOBALS = new Set(['Math', 'String', 'Number', 'Boolean', 'JSON', 'Object', 'Array', 'Date', 'parseInt', 'parseFloat', 'isNaN', 'encodeURIComponent', 'decodeURIComponent', 'setTimeout', 'clearTimeout', 'require', 'Boolean', 'if', 'for', 'while', 'return', 'typeof']);

// 只在插值 {{ }} 和 v-*/: 绑定里找「函数调用」
const exprs = [];
for (const m of tpl.matchAll(/\{\{([\s\S]*?)\}\}/g)) exprs.push(m[1]);
for (const m of tpl.matchAll(/\s(?:v-if|v-else-if|v-show|v-for|:[\w-]+|@[\w.-]+)="([^"]*)"/g)) exprs.push(m[1]);

const calls = new Set();
for (const e of exprs) {
  for (const m of e.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) calls.add(m[1]);
}

const bad = [];
for (const name of calls) {
  if (GLOBALS.has(name)) continue;
  if (defined.has(name)) continue;
  if (moduleNames.has(name)) { bad.push([name, '模块级函数/常量，模板里不可见（要么挪进 methods/computed，要么先算好再渲染）']); continue; }
  bad.push([name, '未定义']);
}

if (bad.length) {
  console.log('✗ 模板里用了不存在的名字：');
  for (const [n, why] of bad) console.log(`   - ${n}()  ← ${why}`);
  process.exit(1);
}
console.log(`✅ 模板静态检查通过（检查了 ${calls.size} 个调用、${defined.size} 个组件成员）`);
