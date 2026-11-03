from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer

from .serializers import PlacementSerializer

CANVAS_PROTOCOL = "pixel-canvas.v1"


def canvas_group(canvas_id):
    return f"canvas.{canvas_id}"


def broadcast_placement(placement):
    async_to_sync(get_channel_layer().group_send)(
        canvas_group(placement.canvas_id),
        {"type": "canvas.placement", "placement": dict(PlacementSerializer(placement).data)},
    )
