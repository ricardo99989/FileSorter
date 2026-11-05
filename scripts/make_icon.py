"""生成 FileSorter 应用图标。

设计取向：深色玻璃底 + 单一几何符号。
高级感通常不来自细节堆叠，而来自「底色够沉、符号够少、留白够大」这三件事，
所以这里刻意不用放大镜这类具象图形，只保留一个抽象的「排序」记号。

构成：
- 轮廓用超椭圆（superellipse）而不是普通圆角矩形。这是 iOS 图标「连续曲率」的关键，
  圆角矩形在 128px 以上会显出生硬的直角过渡。
- 底色是深墨蓝黑渐变，顶部叠加一层蓝紫柔光营造玻璃受光，四周压暗角把视线收进中心。
- 主符号是三条左对齐、长度阶梯递减的圆角横条，直接对应「文件被排好序」。
  三条而不是两条：两条像等号，三条且长度不同才有「依次归档」的语义。
- 32px 以下单独渲染一版：只留两条、加粗、拉大间距。直接缩放大图标在 16px 会糊成
  一块白斑，这是 Windows 任务栏图标最常见的翻车点。
- ICO 手工写入每一个尺寸（PNG 编码条目），保证每个尺寸都是独立渲染而不是插值产物。
"""

import math
import struct
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

SS = 4  # 超采样倍数
ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "build"
OUT_DIR.mkdir(parents=True, exist_ok=True)

# 底色：深墨蓝黑。比纯黑多一点冷调，屏幕上看不会「死黑」，同时白符号反差足够大。
TOP = (33, 37, 53)
BOTTOM = (11, 12, 17)
GLOW = (128, 144, 255)  # 顶部蓝紫柔光，与界面 --accent 同源
VIGNETTE = (6, 7, 10)

BAR_TOP = (255, 255, 255)
BAR_BOTTOM = (204, 214, 244)


def superellipse_mask(size: int, exponent: float = 4.6, inset: int = 0) -> Image.Image:
    """超椭圆遮罩。exponent 越大越接近方形，iOS 图标大约在 4.5~5 之间。"""
    mask = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(mask)
    cx = cy = size / 2
    r = size / 2 - inset
    points = []
    steps = 1440
    for i in range(steps):
        t = 2 * math.pi * i / steps
        ct, st = math.cos(t), math.sin(t)
        x = cx + r * math.copysign(abs(ct) ** (2 / exponent), ct)
        y = cy + r * math.copysign(abs(st) ** (2 / exponent), st)
        points.append((x, y))
    draw.polygon(points, fill=255)
    return mask


def vertical_gradient(size: int, top: tuple, bottom: tuple) -> Image.Image:
    grad = Image.new("RGB", (1, size))
    for y in range(size):
        t = y / max(1, size - 1)
        # smoothstep：中段过渡比线性更自然，不会出现「塑料感」的色带
        t = t * t * (3 - 2 * t)
        grad.putpixel(
            (0, y),
            tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3)),
        )
    return grad.resize((size, size), Image.BILINEAR)


def radial_glow(size: int, center: tuple, radius: float, color: tuple, alpha: int) -> Image.Image:
    """柔光：模糊的实心圆，作为叠加层使用。"""
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    cx, cy = center
    draw.ellipse([cx - radius, cy - radius, cx + radius, cy + radius], fill=(*color, alpha))
    return layer.filter(ImageFilter.GaussianBlur(radius * 0.42))


def build_glyph(size: int, mode: str = "full") -> Image.Image:
    """三条阶梯递减的圆角横条，画在透明层上。

    mode: full 标准版 / small 48px 档 / tiny 32px 及以下（只留两条并加粗）
    """
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))

    tiny = mode == "tiny"
    small = mode in ("small", "tiny")

    # 符号整体占宽：标准 62%，小尺寸再放大一点以保住辨识度。
    # 占比给足才「大气」——缩在中间一小撮会显得怯，撑满又会在任务栏里顶边，62% 是两者的平衡点。
    span = size * (0.72 if tiny else (0.68 if small else 0.62))
    left = (size - span) / 2

    if tiny:
        bar_h = size * 0.125
        widths = [1.00, 0.62]
        gap = size * 0.115
    elif small:
        bar_h = size * 0.105
        widths = [1.00, 0.76, 0.50]
        gap = size * 0.104
    else:
        bar_h = size * 0.088
        widths = [1.00, 0.72, 0.44]
        gap = size * 0.094

    total_h = bar_h * len(widths) + gap * (len(widths) - 1)
    top = (size - total_h) / 2

    # 先把三条合成一个遮罩，再整体上竖直渐变，保证三条颜色连续而不是各自为政
    shape = Image.new("L", (size, size), 0)
    sd = ImageDraw.Draw(shape)
    for index, ratio in enumerate(widths):
        y = top + index * (bar_h + gap)
        sd.rounded_rectangle(
            [left, y, left + span * ratio, y + bar_h],
            radius=bar_h / 2,  # 全圆头，端点在任何尺寸下都是正圆弧
            fill=255,
        )

    # 渐变色条：自上而下由纯白轻微压暗，避免大面积纯白在深色底上「发光过曝」
    ramp = vertical_gradient(size, BAR_TOP, BAR_BOTTOM).convert("RGBA")
    ramp.putalpha(shape)
    layer = Image.alpha_composite(layer, ramp)
    return layer


def render(size: int, mode: str = "full") -> Image.Image:
    """在 size*SS 的画布上绘制，再降采样到目标尺寸。"""
    S = size * SS

    # 1. 底色渐变
    base = vertical_gradient(S, TOP, BOTTOM).convert("RGBA")

    # 2. 顶部柔光 + 底部暗角，塑造受光方向
    base = Image.alpha_composite(base, radial_glow(S, (S * 0.50, S * 0.10), S * 0.46, GLOW, 92))
    vignette = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    vd = ImageDraw.Draw(vignette)
    vd.ellipse([-S * 0.25, S * 0.55, S * 1.25, S * 1.5], fill=(*VIGNETTE, 150))
    base = Image.alpha_composite(base, vignette.filter(ImageFilter.GaussianBlur(S * 0.09)))

    # 3. 斜向高光带，模拟玻璃表面的反光
    sheen = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    sd = ImageDraw.Draw(sheen)
    sd.polygon(
        [(0, 0), (S * 0.68, 0), (S * 0.26, S), (0, S * 0.66)],
        fill=(255, 255, 255, 12),
    )
    base = Image.alpha_composite(base, sheen.filter(ImageFilter.GaussianBlur(S * 0.12)))

    # 4. 符号直接叠加，不加投影：白符号一旦带阴影，会在深底上晕出一圈脏灰
    base = Image.alpha_composite(base, build_glyph(S, mode))

    # 5. 内描边：沿同一条超椭圆路径偏移几像素得到细环，四角不会穿帮
    outer = superellipse_mask(S, exponent=4.6, inset=int(S * 0.03))
    inner = superellipse_mask(S, exponent=4.6, inset=int(S * 0.03) + max(2, int(S * 0.005)))
    ring_mask = ImageChops.subtract(outer, inner)
    rim = Image.new("RGBA", (S, S), (255, 255, 255, 46))
    base = Image.composite(rim, base, ring_mask)

    # 6. 超椭圆裁切（留 3% 呼吸空间，Windows 任务栏里不会顶边）
    out = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    out.paste(base, (0, 0), outer)
    return out.resize((size, size), Image.LANCZOS)


def write_ico(path: Path, images: list[tuple[int, Image.Image]]) -> None:
    """手工写 ICO：每个尺寸放一张 PNG，避免 Pillow 从大图插值出小尺寸。"""
    blobs = []
    for size, image in images:
        tmp = OUT_DIR / f"_tmp_{size}.png"
        image.save(tmp, format="PNG", optimize=True)
        blobs.append((size, tmp.read_bytes()))
        tmp.unlink()

    header = struct.pack("<HHH", 0, 1, len(blobs))
    offset = 6 + 16 * len(blobs)
    entries = bytearray()
    for size, data in blobs:
        entries += struct.pack(
            "<BBBBHHII",
            0 if size >= 256 else size,
            0 if size >= 256 else size,
            0,
            0,
            1,
            32,
            len(data),
            offset,
        )
        offset += len(data)

    with open(path, "wb") as fh:
        fh.write(header)
        fh.write(entries)
        for _, data in blobs:
            fh.write(data)


def mode_for(size: int) -> str:
    if size <= 32:
        return "tiny"
    if size <= 48:
        return "small"
    return "full"


def main() -> None:
    # 每个尺寸独立渲染：小尺寸换成简化符号，而不是把大图缩小
    sizes = [16, 24, 32, 48, 64, 128, 256]
    rendered = {s: render(s, mode_for(s)) for s in sizes}

    write_ico(OUT_DIR / "icon.ico", [(s, rendered[s]) for s in sizes])

    big = render(512, "full")
    big.save(OUT_DIR / "icon.png", optimize=True)
    big.save(OUT_DIR / "icon-1024.png", optimize=True)

    # 界面标题栏用的 128px
    asset = ROOT / "src" / "renderer" / "assets" / "logo.png"
    asset.parent.mkdir(parents=True, exist_ok=True)
    render(128, "full").save(asset, optimize=True)

    # 预览图：深色与浅色背景下各排一行，检查两种任务栏主题下的可辨识度
    for theme, bg in (("dark", (24, 25, 30, 255)), ("light", (238, 240, 245, 255))):
        width = sum(sizes) + 12 * (len(sizes) + 1)
        strip = Image.new("RGBA", (width, 280), bg)
        x = 12
        for s in sizes:
            strip.alpha_composite(rendered[s], (x, 12))
            x += s + 12
        strip.save(OUT_DIR / f"_sizes_{theme}.png")

        tile = Image.new("RGBA", (256, 256), bg)
        tile.alpha_composite(rendered[256], (0, 0))
        tile.save(OUT_DIR / f"_ico_{theme}.png")

    print("icon.ico / icon.png / logo.png 已生成")


if __name__ == "__main__":
    main()
