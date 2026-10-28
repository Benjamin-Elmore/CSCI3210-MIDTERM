from django.contrib import admin

from .models import Canvas, Pixel, Placement, UserCanvasState


@admin.register(Canvas)
class CanvasAdmin(admin.ModelAdmin):
    list_display = ["name", "width", "height", "cooldown_seconds", "version"]

    def has_change_permission(self, request, obj=None):
        # Existing configurations are immutable in admin, avoiding races with placements.
        return False

    def has_delete_permission(self, request, obj=None):
        return False


class ReadOnlyGameAdmin(admin.ModelAdmin):
    # All game-state changes must go through the placement service to enforce its rules.
    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False


admin.site.register([Pixel, Placement, UserCanvasState], ReadOnlyGameAdmin)
