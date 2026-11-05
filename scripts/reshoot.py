"""
重拍 docs/ 下的文档截图。

窗口改成 DWM 亚克力之后，capturePage 拍出来的是一片透明（亚克力是系统画在窗口背后的，
不在页面的绘制树里），所以每一张都必须走 --capture-screen 的系统全屏截图。

主题和显示模式都是持久化的，逐个拍之前要先把 settings.json 摆到目标状态，
否则上一张的 mode/theme 会带到下一张。
"""
import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SETTINGS = os.path.expandvars(r'$APPDATA/filesorter/settings.json')
ELECTRON = os.path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
# 演示目录在工作区上一层，可用 FILE_SORTER_DEMO 覆盖；不写死绝对路径
DEMO = os.environ.get('FILE_SORTER_DEMO',
                      os.path.join(os.path.dirname(ROOT), '_demo_files'))
OUT = os.path.join(ROOT, '_probe', 'shots')
DOCS = os.path.join(ROOT, 'docs')

# (步骤, 输出文件名, 主题, 模式, 裁切框, 目标宽度)
# 裁切框为 None 表示用整屏。sidebar/dock 必须裁：全屏缩下去窗口只剩一小条，
# 缩放比例和别的图不一致，放进文档里会忽大忽小。
#
# 模式通过 --smoke-mode= 显式传给主进程。store 里的 mode 会被上一次冒烟改写，
# 不显式指定就会拍到一小条 dock。
#
# 每张都垫 SMOKE_BACKDROP=1 的合成桌面：亚克力窗口底板是透明的，
# 背后是用户的浏览器还是蓝天草地，截出来完全是两个东西，文档图必须可复现。
SHOTS = [
    ('',             'screenshot-main.png',     'light', 'window',  None,         1400),
    ('grid',         'screenshot-grid.png',     'light', 'window',  None,         1400),
    ('detailfile',   'screenshot-details.png',  'light', 'window',  None,         1400),
    ('dark',         'screenshot-dark.png',     'dark',  'window',  None,         1400),
    ('organize',     'screenshot-organize.png', 'light', 'window',  None,         1400),
    ('settings',     'screenshot-settings.png', 'light', 'window',  None,         1400),
    ('dupes',        'screenshot-dupes.png',    'light', 'window',  None,         1400),
    ('space',        'screenshot-space.png',    'light', 'window',  None,         1400),
    ('history',      'screenshot-history.png',  'light', 'window',  None,         1400),
    ('mode_sidebar', 'screenshot-sidebar.png',  'light', 'sidebar', (0, 0, 700, 1067),   620),
    # dock 挂件只有 460x325 左右，整屏缩到 560 宽会小得看不清；
    # 右下角这块取景框（相对全屏的比例）既保住挂件完整，又留一点桌面当透明参照。
    ('mode_dock',    'screenshot-dock.png',     'light', 'dock',     (0.66, 0.60, 1.0, 1.0), 560),
    ('wheelhover',   'screenshot-wheel.png',    'light', 'window',  None,         1100),
]


def set_prefs(theme, mode):
    with open(SETTINGS, encoding='utf-8') as f:
        d = json.load(f)
    d['theme'] = theme
    d['mode'] = mode
    with open(SETTINGS, 'w', encoding='utf-8') as f:
        json.dump(d, f, ensure_ascii=False, indent=2)


def ime_noise(path):
    """数一下画面里有没有中文输入法候选条的绿色高亮。

    候选条是系统级置顶窗，宿主会话里正好在打字时就会飘到应用上面，
    alwaysOnTop / focus 都压不住。合成桌面现在是纯中性灰，
    所以任何成片的饱和绿都只可能是它 —— 检测到就重拍。
    """
    import warnings
    from PIL import Image
    im = Image.open(path).convert('RGB')
    w, h = im.size
    region = im.crop((int(w * 0.3), int(h * 0.2), w, int(h * 0.9)))
    region = region.resize((max(1, region.width // 4), max(1, region.height // 4)))
    with warnings.catch_warnings():
        warnings.simplefilter('ignore', DeprecationWarning)
        pixels = list(region.getdata())
    return sum(1 for r, g, b in pixels if g > r + 35 and g > b + 35 and g > 110)


def main():
    os.makedirs(OUT, exist_ok=True)
    env = dict(os.environ)
    env['SMOKE_DIR'] = DEMO
    env['SMOKE_BACKDROP'] = '1'
    env.pop('ELECTRON_RUN_AS_NODE', None)
    env.pop('NODE_OPTIONS', None)

    only = sys.argv[1] if len(sys.argv) > 1 else None

    for step, name, theme, mode, box, width in SHOTS:
        if only and only not in name:
            continue
        set_prefs(theme, mode)
        raw = os.path.join(OUT, 'raw-' + name)
        out = os.path.join(DOCS, name)
        args = [ELECTRON, '.', '--smoke', '--smoke-mode=' + mode,
                '--smoke-size=1360x860',
                '--capture-screen', '--capture=' + raw]
        if step:
            args.append('--smoke-step=' + step)

        for attempt in range(3):
            r = subprocess.run(args, cwd=ROOT, env=env, capture_output=True, text=True,
                               timeout=120)
            ok = os.path.exists(raw)
            print(('  ok  ' if ok else ' FAIL ') + name + ('  [' + step + ']' if step else '')
                  + ('  重试 %d' % (attempt + 1) if attempt else ''))
            if not ok:
                print(r.stdout[-800:], r.stderr[-400:])
                break

            # 先裁后缩：顺序反了会先把无关的桌面一起缩小，裁出来还是糊的
            from PIL import Image
            im = Image.open(raw).convert('RGB')
            b = box
            if b:
                # 四个 0~1 的小数 = 相对全屏的取景比例；整数 = 绝对像素
                if all(isinstance(v, float) and 0 < v <= 1 for v in b):
                    w, h = im.size
                    b = (round(b[0] * w), round(b[1] * h),
                         round(b[2] * w), round(b[3] * h))
                im = im.crop(b)
            else:
                # 屏幕最右侧那颗蓝色圆球是宿主的悬浮助手，不是应用的一部分。
                # 整屏截图会把它一起收进来，文档图统一裁掉右侧 7%（桌面留白仍够）。
                im = im.crop((0, 0, round(im.width * 0.93), im.height))
            if im.width > width:
                h = round(im.height * width / im.width)
                im = im.resize((width, h), Image.LANCZOS)
            im.save(out, optimize=True)

            noise = ime_noise(out)
            if noise < 15:
                print('        -> %dx%d' % im.size)
                break
            print('        -> 混入输入法候选条（%d 像素），重拍' % noise)


if __name__ == '__main__':
    main()
