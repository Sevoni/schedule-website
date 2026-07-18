#!/usr/bin/env python3
"""Генерация секретного кода владельца (OWNER_CODE) для campus-schedule.

OWNER_CODE — секрет, который даёт права owner в Worker'е (создание и
отзыв ссылок-приглашений). Устанавливается через:

    npx wrangler secret put OWNER_CODE

Этот скрипт генерирует криптографически стойкий случайный код и выводит
команду для его установки, либо (опционально) сам пишет в .dev.vars для
локального запуска `wrangler dev`.

Примеры:
    python generate_owner_code.py                 # вывести код и команду
    python generate_owner_code.py --length 32     # длина (по умолчанию 24)
    python generate_owner_code.py --write-dev     # записать в .dev.vars
    python generate_owner_code.py --write-dev --dev-vars .dev.vars
"""

import argparse
import os
import secrets
import string
import sys

# Допустимые символы: буквы (без Ambiguous — O/0, l/1 убраны), цифры, спецсимволы.
# Используем алфавит, который легко копировать и вводить вручную.
_ALPHABET = string.ascii_letters + string.digits + "-_"
# Убираем визуально похожие символы, чтобы код было легче вводить вручную.
_DISAMBIGUATE = str.maketrans("", "", "O0l1I")


def generate_owner_code(length: int = 24, disambiguate: bool = True) -> str:
    """Генерирует URL-safe криптостойкий код заданной длины."""
    alphabet = _ALPHABET
    if disambiguate:
        alphabet = alphabet.translate(_DISAMBIGUATE)
    if length < 8:
        raise ValueError("Длина кода должна быть не меньше 8")
    return "".join(secrets.choice(alphabet) for _ in range(length))


def write_dev_vars(path: str, code: str) -> None:
    """Дописывает/обновляет OWNER_CODE в .dev.vars (для wrangler dev)."""
    lines = []
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            lines = f.read().splitlines()

    # Удаляем существующую строку OWNER_CODE=, если есть.
    lines = [ln for ln in lines if not ln.startswith("OWNER_CODE=")]
    lines.append(f"OWNER_CODE={code}")

    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")


def main() -> int:
    parser = argparse.ArgumentParser(description="Генерация OWNER_CODE")
    parser.add_argument("--length", type=int, default=24, help="Длина кода (по умолчанию 24)")
    parser.add_argument(
        "--write-dev",
        action="store_true",
        help="Записать код в .dev.vars (для локального wrangler dev)",
    )
    parser.add_argument(
        "--dev-vars",
        default=".dev.vars",
        help="Путь к .dev.vars (по умолчанию ./.dev.vars)",
    )
    parser.add_argument(
        "--no-disambiguate",
        action="store_true",
        help="Не убирать похожие символы (O/0, l/1, I)",
    )
    args = parser.parse_args()

    try:
        code = generate_owner_code(args.length, disambiguate=not args.no_disambiguate)
    except ValueError as e:
        print(f"Ошибка: {e}", file=sys.stderr)
        return 1

    print("OWNER_CODE:", code)
    print()
    print("Установить в Cloudflare (интерактивно):")
    print(f"  npx wrangler secret put OWNER_CODE")
    print(f"  # затем ввести: {code}")
    print()

    if args.write_dev:
        write_dev_vars(args.dev_vars, code)
        print(f"Записано в {args.dev_vars} (OWNER_CODE={code})")

    return 0


if __name__ == "__main__":
    sys.exit(main())
