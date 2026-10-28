import math
from datetime import timedelta

from django.db import transaction
from django.shortcuts import get_object_or_404
from django.utils import timezone
from rest_framework.exceptions import APIException, Throttled, ValidationError

from .models import Canvas, Pixel, Placement, UserCanvasState


class RetryConflict(APIException):
    status_code = 409
    default_detail = "This request_id was already used for a different placement."


@transaction.atomic
def place_pixel(*, user, canvas_id, x, y, color, request_id):
    """Save all placement changes together, or roll them all back on failure."""
    # Every placement locks the canvas first, providing one consistent lock order
    # and a monotonic version even when different users overwrite the same pixel.
    canvas = get_object_or_404(Canvas.objects.select_for_update(), pk=canvas_id)
    existing = Placement.objects.filter(canvas=canvas, user=user, request_id=request_id).first()
    if existing:
        # Return the original result for a retry without consuming another cooldown.
        if (existing.x, existing.y, existing.color) != (x, y, color):
            raise RetryConflict()
        return existing, False

    # Coordinates start at zero; width and height themselves are outside the board.
    if not 0 <= x < canvas.width or not 0 <= y < canvas.height:
        raise ValidationError({"coordinates": "Pixel is outside the canvas."})
    if color not in canvas.palette:
        raise ValidationError({"color": "Color is not in the canvas palette."})

    state, _ = UserCanvasState.objects.get_or_create(canvas=canvas, user=user)
    state = UserCanvasState.objects.select_for_update().get(pk=state.pk)
    now = timezone.now()  # Evaluate after acquiring locks, never trust the client's timer.
    if state.next_allowed_at > now:
        raise Throttled(wait=math.ceil((state.next_allowed_at - now).total_seconds()))

    canvas.version += 1
    # Only the version changes here; configuration is validated separately by Canvas.save.
    Canvas.objects.filter(pk=canvas.pk).update(version=canvas.version)
    # Repainting replaces the current color but preserves both placements in history.
    Pixel.objects.update_or_create(canvas=canvas, x=x, y=y, defaults={"color": color})
    placement = Placement.objects.create(
        canvas=canvas,
        user=user,
        request_id=request_id,
        x=x,
        y=y,
        color=color,
        version=canvas.version,
        created_at=now,
    )
    state.next_allowed_at = now + timedelta(seconds=canvas.cooldown_seconds)
    state.save(update_fields=["next_allowed_at"])
    # Broadcasting and cache invalidation will be added with live synchronization.
    return placement, True
