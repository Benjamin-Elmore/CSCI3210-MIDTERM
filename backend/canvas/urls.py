from rest_framework.routers import DefaultRouter

from .views import CanvasViewSet

router = DefaultRouter()
router.register("canvases", CanvasViewSet)
urlpatterns = router.urls
