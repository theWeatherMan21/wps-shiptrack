#!/usr/bin/env python3
"""读 xlsx 内部结构，检查插件有没有真的把阶段色刷进去。

为什么用这个而不是看截图（11-12）：
  阶段色是写死在 src/lib/milestone.js 的 STAGE_COLOR 里的三个 RGB ——
  在途 CFE3FA / 已到港 D5F0DC / 已还空 E6E6E6。
  xlsx 是 zip，fill 定义在 xl/styles.xml，每格用 s="N" 指向 cellXfs[N].fillId。
  所以「表里有没有这三个色」是个可以机器判定的事实，不需要人肉眼比对。

用法：
  python3 scripts/check-row-fills.py ~/Desktop/工作/波兰2026.xlsx
  python3 scripts/check-row-fills.py <xlsx> --sheet Terramar --out-col R --col P
  python3 scripts/check-row-fills.py <xlsx> --json        # 给脚本消费

判据：
  出现 CFE3FA/D5F0DC/E6E6E6 且落在输出列上 → 插件上色生效
  三个阶段色一个都没有                        → 没上色（旧插件 / 或本次没有 stage>0 的行）

诚实边界：只看填充色，不判断「该不该是这个颜色」—— 那要看 milestone.js 的阶段判定。
"""
import sys, zipfile, re, json, argparse


def load(path, sheet_name=None, sheet_index=None):
    z = zipfile.ZipFile(path)
    wb = z.read('xl/workbook.xml').decode('utf8')
    sheets = re.findall(r'<sheet name="([^"]+)"[^>]*r:id="(rId\d+)"', wb)
    rels = dict(re.findall(r'Id="(rId\d+)"[^>]*Target="([^"]+)"', z.read('xl/_rels/workbook.xml.rels').decode('utf8')))
    if sheet_name:
        rid = next((r for n, r in sheets if n == sheet_name), None)
        if not rid:
            raise SystemExit(f'没有名为 {sheet_name} 的 sheet，现有：{[n for n, _ in sheets]}')
        target = rels[rid]
    else:
        idx = sheet_index if sheet_index is not None else 0
        target = rels[sheets[idx][1]]
    xml = z.read('xl/' + target.lstrip('/').replace('xl/', '', 1)).decode('utf8')

    styles = z.read('xl/styles.xml').decode('utf8')
    xfs = re.findall(r'<xf\b[^>]*?(?:/>|>.*?</xf>)', styles.split('<cellXfs')[1].split('</cellXfs>')[0], re.S)
    fills = re.findall(r'<fill>.*?</fill>', styles, re.S)

    try:
        ss = z.read('xl/sharedStrings.xml').decode('utf8')
        strs = [re.sub(r'<[^>]+>', '', s) for s in re.findall(r'<si>(.*?)</si>', ss, re.S)]
    except KeyError:
        strs = []

    def fill_of(style_idx):
        if style_idx is None or int(style_idx) >= len(xfs):
            return 'NONE'
        m = re.search(r'fillId="(\d+)"', xfs[int(style_idx)])
        fi = int(m.group(1)) if m else 0
        f = fills[fi] if fi < len(fills) else ''
        rgb = re.search(r'rgb="([0-9A-Fa-f]{6,8})"', f)
        if rgb:
            return rgb.group(1)[-6:].upper()
        if 'patternType="none"' in f or not f:
            return 'NONE'
        return 'INDEXED'

    return z, xml, strs, fill_of, [n for n, _ in sheets]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('xlsx')
    ap.add_argument('--sheet')
    ap.add_argument('--sheet-index', type=int)
    ap.add_argument('--out-col', default='R')
    ap.add_argument('--extra-col', default='P', help='一起显示的参考列（船名/航次）')
    ap.add_argument('--json', action='store_true')
    a = ap.parse_args()

    _, xml, strs, fill_of, names = load(a.xlsx, a.sheet, a.sheet_index)
    PLUGIN_COLORS = {'CFE3FA': '在途', 'D5F0DC': '已到港', 'E6E6E6': '已还空'}

    rows = []
    for rm in re.finditer(r'<row r="(\d+)"[^>]*>(.*?)</row>', xml, re.S):
        rn, body = rm.group(1), rm.group(2)
        cells = {}
        # ★ 11-12 修：自闭合的 <c r="A2" s="10"/> 会让 `[^>]*>(.*?)</c>` 从 A2 一路吞到 B2 的 </c>，
        #   整行错位一格 —— 表现是「R 列读出来是空的、填充色全是 NONE」。
        #   必须先判自闭合，再取 innerText。
        for cm in re.finditer(r'<c r="([A-Z]+)(\d+)"((?:[^>"]|"[^"]*")*?)(?:/>|>(.*?)</c>)', body, re.S):
            col, _rn, attrs, inner = cm.groups()
            if inner is None:
                continue                      # 自闭合空单元格（只有格式没有值）
            sm = re.search(r'\bs="(\d+)"', attrs)
            tm = re.search(r'\bt="(\w+)"', attrs)
            sidx = sm.group(1) if sm else None
            t = tm.group(1) if tm else None
            v = re.search(r'<v>(.*?)</v>', inner)
            val = v.group(1) if v else ''
            if t == 's' and val.isdigit() and int(val) < len(strs):
                val = strs[int(val)]
            elif t == 'inlineStr':
                val = re.sub(r'<[^>]+>', '', inner)
            cells[col] = (val, fill_of(sidx))
        out = cells.get(a.out_col, ('', 'NONE'))
        extra = cells.get(a.extra_col, ('', 'NONE'))
        if not out[0] and not extra[0]:
            continue
        rows.append({'row': int(rn), 'out': out[0], 'fill': out[1],
                     'stage': PLUGIN_COLORS.get(out[1], ''), 'extra': extra[0]})

    hit = [r for r in rows if r['fill'] in PLUGIN_COLORS]
    if a.json:
        print(json.dumps({'file': a.xlsx, 'sheets': names, 'plugin_colors_found': len(hit),
                          'rows': rows}, ensure_ascii=False, indent=1))
        return

    print(f'文件: {a.xlsx}')
    print(f'sheet: {a.sheet or names[0]}   输出列: {a.out_col}   参考列: {a.extra_col}\n')
    print(f'{"行":>4} {"填充":<9} {"阶段":<8} {a.extra_col + " 列":<26} {a.out_col} 列')
    print('-' * 92)
    for r in rows:
        print(f'{r["row"]:>4} {r["fill"]:<9} {r["stage"]:<8} {str(r["extra"])[:24]:<26} {str(r["out"])[:34]}')
    print()
    if hit:
        print(f'✅ 插件阶段色命中 {len(hit)} 行 = 上色生效')
        for c, n in PLUGIN_COLORS.items():
            cnt = sum(1 for r in hit if r['fill'] == c)
            if cnt:
                print(f'   {n} {c}: {cnt} 行')
    else:
        print('✗ 三个阶段色一个都没有 = 没上色')
        print('   要么跑的是旧插件，要么本次没有 stage>0 的行（放空箱/进闸/未发货 都是 stage=0）')


if __name__ == '__main__':
    main()
