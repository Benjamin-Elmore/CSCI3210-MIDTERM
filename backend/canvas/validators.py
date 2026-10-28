import re

from django.core.exceptions import ValidationError


def default_palette():
    # A function gives each new canvas its own list rather than a shared mutable default.
    return [
        "#FFFFFF",
        "#000000",
        "#808080",
        "#C0C0C0",
        "#FF0000",
        "#800000",
        "#FFFF00",
        "#808000",
        "#00FF00",
        "#008000",
        "#00FFFF",
        "#008080",
        "#0000FF",
        "#000080",
        "#FF00FF",
        "#800080",
    ]


def validate_palette(value):
    # Keep palettes nonempty, bounded, and free of duplicate or malformed colors.
    if (
        not isinstance(value, list)
        or not 1 <= len(value) <= 256
        or any(not isinstance(c, str) or not re.fullmatch(r"#[0-9A-F]{6}", c) for c in value)
        or len(set(value)) != len(value)
    ):
        raise ValidationError("Use 1–256 unique uppercase #RRGGBB colors.")
