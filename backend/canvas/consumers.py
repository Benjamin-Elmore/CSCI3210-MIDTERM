import asyncio
import logging
from contextlib import suppress

from channels.db import database_sync_to_async
from channels.generic.websocket import AsyncJsonWebsocketConsumer
from django.db.models import Exists
from rest_framework.authtoken.models import Token

from accounts.events import token_group

from .events import CANVAS_PROTOCOL, canvas_group
from .models import Canvas

logger = logging.getLogger(__name__)
SYNC_INTERVAL_SECONDS = 15


def active_tokens(token):
    return Token.objects.filter(key=token, user__is_active=True)


@database_sync_to_async
def token_is_active(token):
    return active_tokens(token).exists()


@database_sync_to_async
def current_version(token, canvas_id):
    return (
        Canvas.objects.filter(Exists(active_tokens(token)), pk=canvas_id)
        .values_list("version", flat=True)
        .first()
    )


class CanvasConsumer(AsyncJsonWebsocketConsumer):
    heartbeat = None
    closing = False
    subscriptions = ()

    async def connect(self):
        # Browser WebSockets cannot set Authorization. Offer the token as a
        # subprotocol and negotiate only the public protocol name.
        protocols = self.scope["subprotocols"]
        if (
            len(protocols) != 2
            or protocols[0] != CANVAS_PROTOCOL
            or not protocols[1].startswith("token.")
        ):
            await self.close(code=4403)
            return

        self.token = protocols[1][6:]
        self.canvas_id = self.scope["url_route"]["kwargs"]["canvas_id"]
        if await current_version(self.token, self.canvas_id) is None:
            await self.close(code=4403)
            return

        self.subscriptions = (canvas_group(self.canvas_id), token_group(self.token))
        await self.renew_subscriptions()
        # Logout can commit between validation and joining the token group.
        if not await token_is_active(self.token):
            await self.close(code=4403)
            return

        await self.accept(subprotocol=CANVAS_PROTOCOL)
        self.heartbeat = asyncio.create_task(self.send_versions())

    async def disconnect(self, code):
        if self.heartbeat is not None:
            self.heartbeat.cancel()
            with suppress(asyncio.CancelledError):
                await self.heartbeat
        for group in self.subscriptions:
            await self.channel_layer.group_discard(group, self.channel_name)

    async def renew_subscriptions(self):
        for group in self.subscriptions:
            await self.channel_layer.group_add(group, self.channel_name)

    async def close_connection(self, code):
        if not self.closing:
            self.closing = True
            await self.close(code=code)

    async def auth_revoked(self, event):
        await self.close_connection(4403)

    async def send_versions(self):
        try:
            while not self.closing:
                await asyncio.sleep(SYNC_INTERVAL_SECONDS)
                version = await current_version(self.token, self.canvas_id)
                if version is None:
                    await self.close_connection(4403)
                    return
                if not self.closing:
                    # A database watermark lets clients detect a lost final placement.
                    await self.send_json({"type": "version", "version": version})
                    # Channels group memberships expire even if the socket stays open.
                    await self.renew_subscriptions()
        except Exception:
            logger.exception("Canvas WebSocket heartbeat failed")
            await self.close_connection(1011)

    async def canvas_placement(self, event):
        # Redis delivery is best effort. Never rely on the logout event to gate placements.
        if not self.closing and not await token_is_active(self.token):
            await self.close_connection(4403)
        if not self.closing:
            await self.send_json({"type": "placement", "placement": event["placement"]})
