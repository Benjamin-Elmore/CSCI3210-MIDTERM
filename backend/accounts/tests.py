from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.db import IntegrityError
from rest_framework.authtoken.models import Token
from rest_framework.test import APITestCase

User = get_user_model()


class AccountTests(APITestCase):
    password = "Paint!cobalt-5829"

    def register(self, **changes):
        return self.client.post(
            "/api/auth/register/",
            {"username": "artist", "password": self.password, **changes},
            format="json",
        )

    def login(self, **changes):
        return self.client.post(
            "/api/auth/login/",
            {"username": "artist", "password": self.password, **changes},
            format="json",
        )

    def authorize(self, token):
        self.client.credentials(HTTP_AUTHORIZATION=f"Token {token}")

    def test_register_hashes_password_and_returns_usable_token(self):
        response = self.register(is_staff=True, is_superuser=True)
        self.assertEqual(response.status_code, 201)
        user = User.objects.get(username="artist")
        self.assertTrue(user.check_password(self.password))
        self.assertNotEqual(user.password, self.password)
        self.assertFalse(user.is_staff)
        self.assertFalse(user.is_superuser)
        self.assertEqual(set(response.data), {"user", "token"})
        self.assertEqual(response.data["user"], {"id": user.pk, "username": "artist"})
        self.assertEqual(Token.objects.get(user=user).key, response.data["token"])
        self.authorize(response.data["token"])
        self.assertEqual(self.client.get("/api/auth/me/").data, response.data["user"])
        self.assertEqual(self.client.get("/api/canvases/").status_code, 200)

    def test_invalid_registration_creates_no_account_or_token(self):
        cases = [
            {"username": ""},
            {"username": "invalid name"},
            {"password": "short"},
            {"password": "password"},
            {"password": "194720395822"},
            {"password": "artist"},
            {"password": "x" * 129},
        ]
        for changes in cases:
            with self.subTest(changes=changes):
                self.assertEqual(self.register(**changes).status_code, 400)
        for data in [{}, {"username": "artist"}, {"password": self.password}]:
            self.assertEqual(self.client.post("/api/auth/register/", data).status_code, 400)
        self.assertFalse(User.objects.exists())
        self.assertFalse(Token.objects.exists())

    def test_duplicate_username_is_rejected(self):
        self.assertEqual(self.register().status_code, 201)
        response = self.register()
        self.assertEqual(response.status_code, 400)
        self.assertIn("username", response.data)
        self.assertEqual(User.objects.count(), 1)

    def test_registration_rolls_back_when_token_creation_fails(self):
        with patch("accounts.views.Token.objects.create", side_effect=RuntimeError("failure")):
            with self.assertRaises(RuntimeError):
                self.register()
        self.assertFalse(User.objects.exists())

    def test_registration_race_returns_validation_error(self):
        with patch("accounts.serializers.User.objects.create_user", side_effect=IntegrityError):
            response = self.register()
        self.assertEqual(response.status_code, 400)
        self.assertIn("username", response.data)
        self.assertFalse(Token.objects.exists())

    def test_login_reuses_token_and_logout_revokes_it(self):
        registered = self.register()
        token = registered.data["token"]
        logged_in = self.login()
        self.assertEqual(logged_in.status_code, 200)
        self.assertEqual(logged_in.data, registered.data)
        self.authorize(token)
        self.assertEqual(self.client.post("/api/auth/logout/").status_code, 204)
        self.assertFalse(Token.objects.exists())
        self.assertEqual(self.client.get("/api/auth/me/").status_code, 401)
        self.assertEqual(self.client.get("/api/canvases/").status_code, 401)
        self.assertEqual(self.client.post("/api/auth/logout/").status_code, 401)
        # Public login ignores the stale token and issues a fresh one after logout.
        logged_in = self.login()
        self.assertEqual(logged_in.status_code, 200)
        self.assertNotEqual(logged_in.data["token"], token)
        self.authorize(logged_in.data["token"])
        self.assertEqual(self.client.get("/api/auth/me/").status_code, 200)

    def test_invalid_credentials_and_inactive_user_share_error(self):
        missing = self.login()
        self.register()
        wrong = self.login(password="incorrect")
        User.objects.update(is_active=False)
        inactive = self.login()
        for response in [missing, wrong, inactive]:
            self.assertEqual(response.status_code, 400)
            self.assertEqual(response.data, missing.data)
        self.authorize(Token.objects.get().key)
        self.assertEqual(self.client.get("/api/auth/me/").status_code, 401)

    def test_protected_endpoints_reject_missing_or_invalid_tokens(self):
        for token in [None, "invalid"]:
            if token:
                self.authorize(token)
            self.assertEqual(self.client.get("/api/auth/me/").status_code, 401)
            self.assertEqual(self.client.post("/api/auth/logout/").status_code, 401)

    def test_logout_does_not_revoke_other_users_token(self):
        first = self.register()
        other = self.register(username="other")
        self.authorize(first.data["token"])
        self.client.post("/api/auth/logout/")
        self.authorize(other.data["token"])
        self.assertEqual(self.client.get("/api/auth/me/").status_code, 200)

    def test_password_whitespace_is_preserved(self):
        password = f" {self.password} "
        self.assertEqual(self.register(password=password).status_code, 201)
        self.assertEqual(self.login(password=password).status_code, 200)
        self.assertEqual(self.login().status_code, 400)
