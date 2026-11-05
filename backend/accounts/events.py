from hashlib import sha256

from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer


def token_group(token):
    return f"auth.token.{sha256(token.encode()).hexdigest()}"


def broadcast_revocation(token):
    async_to_sync(get_channel_layer().group_send)(
        token_group(token), {"type": "auth.revoked"}
    )
