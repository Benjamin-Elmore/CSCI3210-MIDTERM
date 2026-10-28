from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Barrier
from unittest.mock import patch
from uuid import uuid4

from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError
from django.core.management import call_command
from django.db import IntegrityError, close_old_connections, connection, transaction
from django.test import TransactionTestCase
from django.utils import timezone
from rest_framework.authtoken.models import Token
from rest_framework.test import APIClient

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
