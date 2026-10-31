from django.db import IntegrityError, transaction
from rest_framework import status
from rest_framework.authtoken.models import Token
from rest_framework.exceptions import ValidationError
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from .serializers import LoginSerializer, RegistrationSerializer, UserSerializer


def credentials(user, token):
    return {"user": UserSerializer(user).data, "token": token.key}


class RegisterView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]

    def post(self, request):
        serializer = RegistrationSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        try:
            # Account and token creation must either both succeed or both roll back.
            with transaction.atomic():
                user = serializer.save()
                token = Token.objects.create(user=user)
        except IntegrityError as error:
            # A concurrent registration can claim the username after validation.
            raise ValidationError({"username": ["This username is already taken."]}) from error
        return Response(credentials(user, token), status=status.HTTP_201_CREATED)


class LoginView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]

    def post(self, request):
        serializer = LoginSerializer(data=request.data, context={"request": request})
        serializer.is_valid(raise_exception=True)
        user = serializer.validated_data["user"]
        # DRF supplies one token per account. Repeated logins reuse it until logout.
        token, _ = Token.objects.get_or_create(user=user)
        return Response(credentials(user, token))


class LogoutView(APIView):
    def post(self, request):
        # Deleting the token revokes it for every client using this account's token.
        request.auth.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


class CurrentUserView(APIView):
    def get(self, request):
        return Response(UserSerializer(request.user).data)
