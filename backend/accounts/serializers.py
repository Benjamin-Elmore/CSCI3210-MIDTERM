from django.contrib.auth import authenticate, get_user_model, password_validation
from django.core.exceptions import ValidationError as DjangoValidationError
from rest_framework import serializers

User = get_user_model()


class UserSerializer(serializers.ModelSerializer):
    class Meta:
        model = User
        fields = ["id", "username"]
        read_only_fields = fields


class RegistrationSerializer(serializers.ModelSerializer):
    password = serializers.CharField(write_only=True, trim_whitespace=False, max_length=128)

    class Meta:
        model = User
        fields = ["username", "password"]

    def validate(self, attrs):
        # Apply Django's configured password rules against the proposed username.
        user = User(username=attrs["username"])
        try:
            password_validation.validate_password(attrs["password"], user=user)
        except DjangoValidationError as error:
            raise serializers.ValidationError({"password": error.messages}) from error
        return attrs

    def create(self, validated_data):
        # create_user hashes the password; never store the submitted value directly.
        return User.objects.create_user(**validated_data)


class LoginSerializer(serializers.Serializer):
    username = serializers.CharField(max_length=150)
    password = serializers.CharField(write_only=True, trim_whitespace=False, max_length=128)

    def validate(self, attrs):
        user = authenticate(request=self.context.get("request"), **attrs)
        if user is None:
            # Use the same response for missing users, wrong passwords and disabled accounts.
            raise serializers.ValidationError("Unable to log in with those credentials.")
        return {"user": user}
