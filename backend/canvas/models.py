from django.conf import settings
from django.core.exceptions import ValidationError
from django.core.validators import RegexValidator
from django.db import models
from django.db.models import Q
from django.utils import timezone

from .validators import default_palette, validate_palette

color_validator = RegexValidator(r"^#[0-9A-F]{6}$", "Use an uppercase #RRGGBB color.")


class Canvas(models.Model):
    """Board settings and the version of its latest accepted placement."""

    name = models.CharField(max_length=100)
    slug = models.SlugField(unique=True)
    width = models.PositiveIntegerField(default=100)
    height = models.PositiveIntegerField(default=100)
    palette = models.JSONField(default=default_palette, validators=[validate_palette])
    cooldown_seconds = models.PositiveIntegerField(default=30)
    version = models.PositiveBigIntegerField(default=0, editable=False)

    class Meta:
        constraints = [
            models.CheckConstraint(condition=Q(width__gte=1, width__lte=512), name="canvas_width"),
            models.CheckConstraint(
                condition=Q(height__gte=1, height__lte=512), name="canvas_height"
            ),
            models.CheckConstraint(
                condition=Q(cooldown_seconds__lte=86400), name="canvas_cooldown"
            ),
        ]

    def clean(self):
        # Changing geometry or allowed colors would invalidate existing placement history.
        if self.pk and self.placements.exists():
            previous = Canvas.objects.get(pk=self.pk)
            if any(
                getattr(self, key) != getattr(previous, key)
                for key in ("width", "height", "palette")
            ):
                raise ValidationError(
                    "Geometry and palette cannot change after the first placement."
                )

    def save(self, *args, **kwargs):
        # Django does not normally run model validation when save() is called.
        self.full_clean()
        return super().save(*args, **kwargs)

    def __str__(self):
        return self.name


class Pixel(models.Model):
    """Current color at a painted coordinate; untouched pixels have no row."""

    canvas = models.ForeignKey(Canvas, on_delete=models.CASCADE, related_name="pixels")
    x = models.PositiveIntegerField()
    y = models.PositiveIntegerField()
    color = models.CharField(max_length=7, validators=[color_validator])

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["canvas", "x", "y"], name="pixel_coordinate"),
            models.CheckConstraint(condition=Q(color__regex=r"^#[0-9A-F]{6}$"), name="pixel_color"),
        ]


class Placement(models.Model):
    """History of accepted placements, including the IDs used to recognize retries."""

    canvas = models.ForeignKey(Canvas, on_delete=models.CASCADE, related_name="placements")
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    request_id = models.UUIDField()
    x = models.PositiveIntegerField()
    y = models.PositiveIntegerField()
    color = models.CharField(max_length=7, validators=[color_validator])
    version = models.PositiveBigIntegerField()
    created_at = models.DateTimeField(default=timezone.now, editable=False)

    class Meta:
        ordering = ["-version"]
        constraints = [
            models.UniqueConstraint(fields=["canvas", "version"], name="placement_version"),
            models.UniqueConstraint(
                fields=["canvas", "user", "request_id"], name="placement_retry"
            ),
            models.CheckConstraint(condition=Q(version__gte=1), name="placement_positive_version"),
            models.CheckConstraint(
                condition=Q(color__regex=r"^#[0-9A-F]{6}$"), name="placement_color"
            ),
        ]


class UserCanvasState(models.Model):
    """One server-controlled cooldown per user on each canvas."""

    canvas = models.ForeignKey(Canvas, on_delete=models.CASCADE)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    next_allowed_at = models.DateTimeField(default=timezone.now)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["canvas", "user"], name="user_canvas_cooldown"),
        ]
