import logging

from django.conf import settings
from django.db import connection
from redis import Redis
from rest_framework.decorators import api_view, authentication_classes, permission_classes
from rest_framework.response import Response

logger = logging.getLogger(__name__)


# Health probes must work before a user has signed in.
@api_view(["GET"])
@authentication_classes([])
@permission_classes([])
def health(request):
    """Process liveness only; dependencies are checked by readiness."""
    return Response({"status": "ok", "service": "pixel-canvas-api"})


@api_view(["GET"])
@authentication_classes([])
@permission_classes([])
def readiness(request):
    """Return 503 when either required service cannot be reached."""
    checks = {"database": "unavailable", "redis": "unavailable"}
    try:
        with connection.cursor() as cursor:
            cursor.execute("SELECT 1")
            checks["database"] = "ok"
    except Exception:
        # Log details server-side; the public response contains no connection credentials.
        logger.exception("Database readiness check failed")
    try:
        with Redis.from_url(
            settings.REDIS_URL, socket_connect_timeout=2, socket_timeout=2
        ) as client:
            client.ping()
            checks["redis"] = "ok"
    except Exception:
        logger.exception("Redis readiness check failed")
    # Check both dependencies independently so a failure does not hide the other's status.
    ready = all(value == "ok" for value in checks.values())
    return Response(
        {"status": "ready" if ready else "unavailable", "checks": checks},
        status=200 if ready else 503,
    )
