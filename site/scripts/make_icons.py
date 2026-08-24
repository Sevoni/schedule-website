# -*- coding: utf-8 -*-
"""Генератор PWA-иконок из дизайна frontend/favicon.svg.

Запуск один раз локально перед деплоем (результат коммитится в frontend/icons/):
    python scripts/make_icons.py

Создаёт:
    frontend/icons/icon-192.png          — any (manifest, apple-touch-icon)
    frontend/icons/icon-512.png          — any
    frontend/icons/icon-maskable-512.png — maskable (полный фон, глиф в safe zone)
"""
import os
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.normpath(os.path.join(HERE, '..', 'frontend', 'icons'))

BG = (15, 17, 23, 255)     # #0f1117 — как в favicon.svg и theme-color
FG = (108, 140, 255, 255)  # #6c8cff


def draw_calendar(d, box, ox=0.0, oy=0.0):
    """Календарь из favicon.svg (viewBox 64x64) в квадрат box×box со смещением."""
    k = box / 64.0

    def X(v):
        return ox + v * k

    def Y(v):
        return oy + v * k

    w = max(1, round(4 * k))
    d.rounded_rectangle([X(14), Y(12), X(50), Y(52)], radius=5 * k, outline=FG, width=w)
    d.line([X(14), Y(26), X(50), Y(26)], fill=FG, width=w)
    for cx in (24, 40):
        x = X(cx)
        d.line([x, Y(7), x, Y(17)], fill=FG, width=w)
        rr = w / 2.0
        for yy in (Y(7), Y(17)):
            d.ellipse([x - rr, yy - rr, x + rr, yy + rr], fill=FG)


def render_any(size):
    """Иконка any: скруглённый тёмный фон на всю площадь + календарь как в SVG."""
    ss = 4  # суперсэмплинг против лесенок
    big = size * ss
    img = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, big - 1, big - 1], radius=round(big * 14 / 64), fill=BG)
    draw_calendar(d, big)
    return img.resize((size, size), Image.LANCZOS)


def render_maskable(size):
    """Maskable: фон заливает весь холст (без скруглений — маску накложит лаунчер),
    глиф уменьшен до безопасной зоны (~66% диаметра)."""
    ss = 4
    big = size * ss
    img = Image.new('RGBA', (big, big), BG)
    d = ImageDraw.Draw(img)
    glyph = round(big * 0.58)
    off = (big - glyph) / 2.0
    draw_calendar(d, glyph, ox=off, oy=off)
    return img.resize((size, size), Image.LANCZOS)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    jobs = [
        ('icon-192.png', render_any(192)),
        ('icon-512.png', render_any(512)),
        ('icon-maskable-512.png', render_maskable(512)),
    ]
    for name, img in jobs:
        path = os.path.join(OUT_DIR, name)
        img.save(path, 'PNG', optimize=True)
        print(f'{path}  {img.size[0]}x{img.size[1]}')


if __name__ == '__main__':
    main()
