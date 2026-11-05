from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from datetime import timedelta
from threading import Barrier
from unittest.mock import patch
from uuid import uuid4

from channels.db import database_sync_to_async
from channels.layers import get_channel_layer
from channels.testing import WebsocketCommunicator
from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError
from django.core.management import call_command
from django.db import IntegrityError, close_old_connections, connection, transaction
from django.test import TransactionTestCase, override_settings
from django.utils import timezone
from rest_framework.authtoken.models import Token
from rest_framework.test import APIClient

from config.asgi import application

from .events import CANVAS_PROTOCOL, canvas_group
from .models import Canvas, Pixel, Placement, UserCanvasState
from .services import place_pixel


class CanvasRulesTests(TransactionTestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(username="artist", password="test-only")
        self.canvas = Canvas.objects.create(name="Test", slug="test", width=4, height=4)
        self.client = APIClient()
        self.client.force_authenticate(self.user)
        self.url = f"/api/canvases/{self.canvas.pk}/placements/"

    def payload(self, **changes):
        return {"x": 0, "y": 0, "color": "#FF0000", "request_id": str(uuid4()), **changes}

    def post(self, payload):
        return self.client.post(self.url, payload, format="json")

    def test_persistence_snapshot_and_history(self):
        response = self.post(self.payload(x=3, y=3, color="#ff0000"))
        self.assertEqual(response.status_code, 201)
        self.assertEqual(Pixel.objects.get().color, "#FF0000")
        self.canvas.refresh_from_db()
        self.assertEqual(self.canvas.version, 1)
        self.assertEqual(Placement.objects.get().user, self.user)
        snapshot = self.client.get(f"/api/canvases/{self.canvas.pk}/snapshot/")
        self.assertEqual(snapshot.status_code, 200)
        self.assertEqual(snapshot.data["pixels"], [{"x": 3, "y": 3, "color": "#FF0000"}])
        self.assertEqual(snapshot.data["version"], 1)
        self.assertIsNotNone(snapshot.data["next_allowed_at"])
        history = self.client.get(f"/api/canvases/{self.canvas.pk}/history/")
        self.assertEqual(history.data["count"], 1)

    def test_personal_history_filters_before_pagination(self):
        other = get_user_model().objects.create_user(username="other")
        Placement.objects.bulk_create([
            Placement(
                canvas=self.canvas,
                user=self.user if version <= 51 else other,
                x=0,
                y=0,
                color="#FF0000",
                version=version,
                request_id=uuid4(),
            )
            for version in range(1, 102)
        ])
        url = f"/api/canvases/{self.canvas.pk}/history/"
        recent = self.client.get(url)
        self.assertEqual(
            [row["version"] for row in recent.data["results"]], list(range(101, 51, -1))
        )
        mine = self.client.get(url, {"mine": 1})
        self.assertEqual(mine.status_code, 200)
        self.assertEqual(mine.data["count"], 51)
        self.assertEqual([row["version"] for row in mine.data["results"]], list(range(51, 1, -1)))
        older = self.client.get(url, {"mine": 1, "page": 2})
        self.assertEqual([row["version"] for row in older.data["results"]], [1])

    def test_authentication_required(self):
        self.client.force_authenticate(user=None)
        self.assertEqual(self.post(self.payload()).status_code, 401)
        self.assertEqual(self.client.get("/api/canvases/").status_code, 401)
        self.assertFalse(Pixel.objects.exists())

    def test_real_token_authentication(self):
        self.client.force_authenticate(user=None)
        token = Token.objects.create(user=self.user)
        self.client.credentials(HTTP_AUTHORIZATION=f"Token {token.key}")
        self.assertEqual(self.post(self.payload()).status_code, 201)
        self.client.credentials(HTTP_AUTHORIZATION="Token invalid")
        self.assertEqual(self.post(self.payload(x=1)).status_code, 401)
        self.assertEqual(Placement.objects.count(), 1)

    def test_configuration_has_no_public_write_endpoints(self):
        response = self.client.patch(
            f"/api/canvases/{self.canvas.pk}/", {"width": 1}, format="json"
        )
        self.assertEqual(response.status_code, 405)
        response = self.client.delete(f"/api/canvases/{self.canvas.pk}/")
        self.assertEqual(response.status_code, 405)
        self.canvas.refresh_from_db()
        self.assertEqual(self.canvas.width, 4)

    def test_rejects_invalid_payloads_without_writes(self):
        cases = [
            {"x": -1},
            {"y": -1},
            {"x": 4},
            {"y": 4},
            {"x": 1.5},
            {"x": True},
            {"x": "1"},
            {"x": None},
            {"color": "#123456"},
            {"color": "red"},
            {"color": "#FF0000\n"},
            {"request_id": "invalid"},
            {"user": 100},
            {"version": 999},
            {"next_allowed_at": "2000-01-01"},
        ]
        for changes in cases:
            with self.subTest(changes=changes):
                self.assertEqual(self.post(self.payload(**changes)).status_code, 400)
        self.assertFalse(Pixel.objects.exists())
        self.assertFalse(Placement.objects.exists())
        self.assertFalse(UserCanvasState.objects.exists())
        self.canvas.refresh_from_db()
        self.assertEqual(self.canvas.version, 0)

    def test_missing_canvas(self):
        self.url = "/api/canvases/999999/placements/"
        self.assertEqual(self.post(self.payload()).status_code, 404)

    def test_cooldown_and_expiry(self):
        self.assertEqual(self.post(self.payload()).status_code, 201)
        response = self.post(self.payload(x=1))
        self.assertEqual(response.status_code, 429)
        self.assertGreater(int(response["Retry-After"]), 0)
        self.assertEqual(Placement.objects.count(), 1)
        UserCanvasState.objects.update(next_allowed_at=timezone.now() - timedelta(seconds=1))
        self.assertEqual(self.post(self.payload(x=1)).status_code, 201)

    def test_retry_is_idempotent_and_cannot_change_payload(self):
        payload = self.payload()
        first = self.post(payload)
        retry = self.post(payload)
        self.assertEqual(retry.status_code, 200)
        self.assertEqual(first.data, retry.data)
        self.assertEqual(self.post({**payload, "x": 1}).status_code, 409)
        self.assertEqual(Placement.objects.count(), 1)
        self.canvas.refresh_from_db()
        self.assertEqual(self.canvas.version, 1)

    def test_failed_history_write_rolls_back_everything(self):
        with patch("canvas.services.Placement.objects.create", side_effect=RuntimeError("failure")):
            with self.assertRaises(RuntimeError):
                place_pixel(
                    user=self.user,
                    canvas_id=self.canvas.pk,
                    x=0,
                    y=0,
                    color="#FF0000",
                    request_id=uuid4(),
                )
        self.canvas.refresh_from_db()
        self.assertEqual(self.canvas.version, 0)
        self.assertFalse(Pixel.objects.exists())
        self.assertFalse(UserCanvasState.objects.exists())
        self.assertFalse(Placement.objects.exists())

    def test_database_constraints_and_configuration_validation(self):
        with self.assertRaises(ValidationError):
            Canvas.objects.create(name="Bad", slug="bad", width=0)
        with self.assertRaises(ValidationError):
            Canvas.objects.create(name="Bad", slug="bad", palette=["red"])
        Pixel.objects.create(canvas=self.canvas, x=0, y=0, color="#FFFFFF")
        for values in [
            {"x": 0, "y": 0, "color": "#000000"},
            {"x": -1, "y": 0, "color": "#000000"},
            {"x": 1, "y": 0, "color": "invalid"},
        ]:
            with self.assertRaises(IntegrityError), transaction.atomic():
                Pixel.objects.create(canvas=self.canvas, **values)
        self.assertEqual(Pixel.objects.count(), 1)

    def test_configuration_cannot_invalidate_history(self):
        self.post(self.payload())
        self.canvas.refresh_from_db()
        self.canvas.width = 1
        with self.assertRaises(ValidationError):
            self.canvas.save()

    def test_initial_canvas_command_is_idempotent(self):
        call_command("init_canvas", verbosity=0)
        call_command("init_canvas", verbosity=0)
        self.assertEqual(Canvas.objects.filter(slug="main").count(), 1)

    def race(self, user_ids, request_ids=None):
        self.assertEqual(connection.vendor, "postgresql")
        barrier = Barrier(2)

        def worker(index):
            close_old_connections()
            try:
                user = get_user_model().objects.get(pk=user_ids[index])
                client = APIClient()
                client.force_authenticate(user)
                payload = self.payload(color=["#FF0000", "#0000FF"][index])
                if request_ids:
                    payload.update(request_id=request_ids[index], color="#FF0000")
                barrier.wait(timeout=10)
                response = client.post(self.url, payload, format="json")
                return response.status_code, response.data
            finally:
                close_old_connections()

        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(worker, i) for i in range(2)]
            return [f.result(timeout=15) for f in futures]

    def test_concurrent_requests_cannot_bypass_cooldown(self):
        result = self.race([self.user.pk, self.user.pk])
        self.assertEqual(sorted(code for code, _ in result), [201, 429])
        self.assertEqual(Placement.objects.count(), 1)
        self.assertEqual(Pixel.objects.count(), 1)
        self.canvas.refresh_from_db()
        self.assertEqual(self.canvas.version, 1)

    def test_concurrent_retry_creates_one_placement(self):
        request_id = str(uuid4())
        result = self.race([self.user.pk, self.user.pk], [request_id, request_id])
        self.assertEqual(sorted(code for code, _ in result), [200, 201])
        self.assertEqual(Placement.objects.count(), 1)

    def test_concurrent_users_overwrite_without_duplicate_pixels(self):
        other = get_user_model().objects.create_user(username="other")
        result = self.race([self.user.pk, other.pk])
        self.assertEqual([code for code, _ in result], [201, 201])
        self.assertEqual(Pixel.objects.count(), 1)
        self.assertEqual(Placement.objects.count(), 2)
        latest = Placement.objects.order_by("-version").first()
        self.assertEqual(latest.version, 2)
        self.assertEqual(Pixel.objects.get().color, latest.color)


@override_settings(
    CHANNEL_LAYERS={"default": {"BACKEND": "channels.layers.InMemoryChannelLayer"}},
    ALLOWED_HOSTS=["localhost", "testserver"],
)
class CanvasSocketTests(TransactionTestCase):
    def setUp(self):
        user = get_user_model().objects.create_user(username="artist")
        self.token = Token.objects.create(user=user)
        other = get_user_model().objects.create_user(username="other")
        self.other_token = Token.objects.create(user=other)
        self.canvas = Canvas.objects.create(name="Test", slug="test")

    @asynccontextmanager
    async def connect(self, token):
        socket = WebsocketCommunicator(
            application,
            f"/ws/canvases/{self.canvas.pk}/",
            headers=[(b"origin", b"http://localhost")],
            subprotocols=[CANVAS_PROTOCOL, f"token.{token}"],
        )
        try:
            yield socket, await socket.connect()
        finally:
            await socket.disconnect()

    @database_sync_to_async
    def logout(self):
        client = APIClient()
        client.credentials(HTTP_AUTHORIZATION=f"Token {self.token.key}")
        return client.post("/api/auth/logout/")

    async def test_invalid_token_is_rejected(self):
        async with self.connect("invalid") as (_, result):
            self.assertEqual(result, (False, 4403))

    async def test_logout_disconnects_open_sockets_for_the_same_token(self):
        async with (
            self.connect(self.token.key) as (first, first_result),
            self.connect(self.token.key) as (second, second_result),
            self.connect(self.other_token.key) as (other, other_result),
        ):
            for result in (first_result, second_result, other_result):
                self.assertEqual(result, (True, CANVAS_PROTOCOL))
            self.assertEqual((await self.logout()).status_code, 204)
            for socket in (first, second):
                self.assertEqual(
                    await socket.receive_output(), {"type": "websocket.close", "code": 4403}
                )
            await get_channel_layer().group_send(
                canvas_group(self.canvas.pk),
                {"type": "canvas.placement", "placement": {"version": 1}},
            )
            self.assertEqual(
                await other.receive_json_from(), {"type": "placement", "placement": {"version": 1}}
            )

    async def test_revoked_token_cannot_receive_a_placement_without_logout_event(self):
        async with self.connect(self.token.key) as (socket, result):
            self.assertEqual(result, (True, CANVAS_PROTOCOL))
            await database_sync_to_async(self.token.delete)()
            await get_channel_layer().group_send(
                canvas_group(self.canvas.pk),
                {"type": "canvas.placement", "placement": {"version": 1}},
            )
            self.assertEqual(
                await socket.receive_output(), {"type": "websocket.close", "code": 4403}
            )

    @patch("canvas.consumers.SYNC_INTERVAL_SECONDS", 0.01)
    async def test_heartbeat_disconnects_an_idle_socket_with_a_revoked_token(self):
        async with self.connect(self.token.key) as (socket, result):
            self.assertEqual(result, (True, CANVAS_PROTOCOL))
            await database_sync_to_async(self.token.delete)()
            for _ in range(10):
                event = await socket.receive_output()
                if event["type"] == "websocket.close":
                    break
            self.assertEqual(event, {"type": "websocket.close", "code": 4403})

    @patch("canvas.consumers.SYNC_INTERVAL_SECONDS", 0.01)
    async def test_heartbeat_reports_committed_version_when_broadcast_is_lost(self):
        async with self.connect(self.token.key) as (socket, result):
            self.assertEqual(result, (True, CANVAS_PROTOCOL))
            self.assertEqual(await socket.receive_json_from(), {"type": "version", "version": 0})
            with patch("canvas.services.broadcast_placement"):
                await database_sync_to_async(place_pixel)(
                    user=self.token.user,
                    canvas_id=self.canvas.pk,
                    x=0,
                    y=0,
                    color="#FF0000",
                    request_id=uuid4(),
                )
            for _ in range(10):
                heartbeat = await socket.receive_json_from()
                if heartbeat["version"] == 1:
                    break
            self.assertEqual(heartbeat, {"type": "version", "version": 1})
