from django.db import transaction
from django.shortcuts import get_object_or_404
from django.utils import timezone
from rest_framework import status, viewsets
from rest_framework.decorators import action
from rest_framework.pagination import PageNumberPagination
from rest_framework.response import Response

from .models import Canvas, UserCanvasState
from .serializers import CanvasSerializer, PlacementInputSerializer, PlacementSerializer
from .services import place_pixel


class HistoryPagination(PageNumberPagination):
    page_size = 50


class CanvasViewSet(viewsets.ReadOnlyModelViewSet):
    # Settings cannot be edited through the API; placements use the dedicated action.
    queryset = Canvas.objects.order_by("id")
    serializer_class = CanvasSerializer

    @action(detail=True, methods=["get"])
    def snapshot(self, request, pk=None):
        # Match the placement lock: metadata/version and pixels describe the same instant.
        with transaction.atomic():
            canvas = get_object_or_404(Canvas.objects.select_for_update(), pk=pk)
            data = dict(CanvasSerializer(canvas).data)
            data["pixels"] = list(canvas.pixels.order_by("y", "x").values("x", "y", "color"))
            # The client fills coordinates missing from the sparse pixel list with white.
            data["background_color"] = "#FFFFFF"
            state = UserCanvasState.objects.filter(canvas=canvas, user=request.user).first()
            data["next_allowed_at"] = state.next_allowed_at if state else None
            # Let the client display cooldowns without relying on its own clock being correct.
            data["server_time"] = timezone.now()
        return Response(data)

    @action(detail=True, methods=["post"])
    def placements(self, request, pk=None):
        # Validate the payload here; the service handles board rules and database writes.
        payload = PlacementInputSerializer(data=request.data)
        payload.is_valid(raise_exception=True)
        placement, created = place_pixel(
            user=request.user,
            canvas_id=pk,
            **payload.validated_data,
        )
        return Response(
            PlacementSerializer(placement).data,
            # New placements return 201; successful retries return the existing result as 200.
            status=status.HTTP_201_CREATED if created else status.HTTP_200_OK,
        )

    @action(detail=True, methods=["get"])
    def history(self, request, pk=None):
        canvas = self.get_object()
        paginator = HistoryPagination()
        # Limit each response instead of loading the entire placement history.
        rows = paginator.paginate_queryset(canvas.placements.all(), request)
        return paginator.get_paginated_response(PlacementSerializer(rows, many=True).data)
