from django.test import SimpleTestCase, override_settings


@override_settings(CORS_ALLOWED_ORIGINS=["https://benjamin-elmore.github.io"])
class CrossOriginTests(SimpleTestCase):
    def test_preflight_allows_the_pages_origin_and_authorization(self):
        response = self.client.options(
            "/api/health/",
            HTTP_ORIGIN="https://benjamin-elmore.github.io",
            HTTP_ACCESS_CONTROL_REQUEST_METHOD="POST",
            HTTP_ACCESS_CONTROL_REQUEST_HEADERS="authorization,content-type",
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response["access-control-allow-origin"], "https://benjamin-elmore.github.io"
        )
        self.assertIn("authorization", response["access-control-allow-headers"])

    def test_disallowed_origin_does_not_receive_cors_access(self):
        response = self.client.get("/api/health/", HTTP_ORIGIN="https://example.com")
        self.assertNotIn("access-control-allow-origin", response)

    def test_retry_after_is_exposed_to_the_pages_origin(self):
        response = self.client.get(
            "/api/health/", HTTP_ORIGIN="https://benjamin-elmore.github.io"
        )
        self.assertIn("retry-after", response["access-control-expose-headers"].lower())
