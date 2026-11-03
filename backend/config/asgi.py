import os

from channels.routing import ProtocolTypeRouter, URLRouter
from channels.security.websocket import AllowedHostsOriginValidator
from django.core.asgi import get_asgi_application
from django.urls import path

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")
django_application = get_asgi_application()

from canvas.consumers import CanvasConsumer  # noqa: E402

application = ProtocolTypeRouter({
    "http": django_application,
    "websocket": AllowedHostsOriginValidator(URLRouter([
        path("ws/canvases/<int:canvas_id>/", CanvasConsumer.as_asgi()),
    ])),
})
