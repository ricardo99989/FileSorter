"""生成应用图标（build/icon.ico + icon.png）。

设计：莫兰迪蓝灰圆角底 + 白色文件夹 + 三条递进色条，
在小尺寸（16px）下仍能辨识出「归类」这个动作。

用法：python scripts/make_icon.py
依赖：Pillow
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

S = 1024  # 先在大画布上绘制再降采样，边缘更干净
ACCENT = (138, 155, 176, 255)
WHITE = (255, 255, 255, 240)

OUT = Path(__file__).resolve().parent.parent / "build"


def build() -> Image.Image:
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    draw.rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.22), fill=ACCENT)

    # 左上角高光，模拟新拟态的柔和受光（必须模糊，否则会留下硬边）
    highlight = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(highlight).ellipse(
        [-S * 0.25, -S * 0.55, S * 1.15, S * 0.5], fill=(255, 255, 255, 46)
    )
    highlight = highlight.filter(ImageFilter.GaussianBlur(S * 0.09))
    img = Image.alpha_composite(img, highlight)

    draw = ImageDraw.Draw(img)
    fx0, fy0, fx1, fy1 = S * 0.19, S * 0.31, S * 0.81, S * 0.75
    draw.rounded_rectangle(
        [fx0, fy0 - S * 0.055, fx0 + S * 0.32, fy0 + S * 0.03],
        radius=int(S * 0.024),
        fill=WHITE,
    )
    draw.rounded_rectangle([fx0, fy0, fx1, fy1], radius=int(S * 0.06), fill=WHITE)

    # 三条长度递减的色条，暗示「按类型归位」
    for index, width in enumerate((0.34, 0.24, 0.14)):
        y = S * 0.43 + index * S * 0.095
        draw.rounded_rectangle(
            [fx0 + S * 0.07, y, fx0 + S * 0.07 + S * width, y + S * 0.042],
            radius=int(S * 0.021),
            fill=ACCENT,
        )
    return img


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    img = build()
    img.save(OUT / "icon.ico", sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)])
    img.resize((512, 512), Image.LANCZOS).save(OUT / "icon.png")
    print("已生成:", OUT / "icon.ico")


if __name__ == "__main__":
    main()
