from channels.db import database_sync_to_async
from channels.generic.websocket import AsyncJsonWebsocketConsumer
from rest_framework.authtoken.models import Token

from .events import CANVAS_PROTOCOL, canvas_group
from .models import Canvas


@database_sync_to_async
def can_subscribe(token, canvas_id):
    return (
        Token.objects.filter(key=token, user__is_active=True).exists()
        and Canvas.objects.filter(pk=canvas_id).exists()
    )


class CanvasConsumer(AsyncJsonWebsocketConsumer):
    group = None

    async def connect(self):
        # Browser WebSockets cannot set Authorization. Offer the token as a
        # subprotocol and negotiate only the public protocol name.
        protocols = self.scope["subprotocols"]
        canvas_id = self.scope["url_route"]["kwargs"]["canvas_id"]
        if (
            len(protocols) != 2
            or protocols[0] != CANVAS_PROTOCOL
            or not protocols[1].startswith("token.")
            or not await can_subscribe(protocols[1][6:], canvas_id)
        ):
            await self.close(code=4403)
            return

        group = canvas_group(canvas_id)
        await self.channel_layer.group_add(group, self.channel_name)
        self.group = group
        await self.accept(subprotocol=CANVAS_PROTOCOL)

    async def disconnect(self, code):
        if self.group is not None:
            await self.channel_layer.group_discard(self.group, self.channel_name)

    async def canvas_placement(self, event):
        await self.send_json({"type": "placement", "placement": event["placement"]})
