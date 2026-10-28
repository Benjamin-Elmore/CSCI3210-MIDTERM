from rest_framework import serializers

from .models import Canvas, Placement


class StrictIntegerField(serializers.IntegerField):
    def to_internal_value(self, data):
        # Reject booleans, numeric strings, and floats instead of converting them.
        if type(data) is not int:
            raise serializers.ValidationError("Use a JSON integer.")
        return super().to_internal_value(data)


class PlacementInputSerializer(serializers.Serializer):
    x = StrictIntegerField(min_value=0)
    y = StrictIntegerField(min_value=0)
    color = serializers.RegexField(r"^#[0-9A-Fa-f]{6}$", trim_whitespace=False)
    request_id = serializers.UUIDField()

    def to_internal_value(self, data):
        # User identity, cooldowns, and versions come from the server, not the payload.
        if isinstance(data, dict) and set(data) - set(self.fields):
            raise serializers.ValidationError(
                {"non_field_errors": ["Unknown fields are not allowed."]}
            )
        return super().to_internal_value(data)

    def validate_color(self, value):
        # Store one consistent spelling even when clients send lowercase hex.
        return value.upper()


class CanvasSerializer(serializers.ModelSerializer):
    class Meta:
        model = Canvas
        fields = ["id", "name", "slug", "width", "height", "palette", "cooldown_seconds", "version"]


class PlacementSerializer(serializers.ModelSerializer):
    class Meta:
        model = Placement
        fields = ["id", "request_id", "x", "y", "color", "version", "created_at"]
