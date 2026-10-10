import jwt
from datetime import datetime, timedelta
from django.conf import settings
from rest_framework import authentication, exceptions
from .models import User


def generate_jwt_token(user):
    payload = {
        'user_id': str(user.id),
        'email': user.email,
        'role': user.role,
        'pharmacy_id': str(user.pharmacy.id) if user.pharmacy else None,
        'exp': datetime.utcnow() + timedelta(hours=getattr(settings, 'JWT_EXPIRATION_HOURS', 24)),
        'iat': datetime.utcnow(),
    }
    return jwt.encode(payload, settings.JWT_SECRET_KEY, algorithm='HS256')


class JWTAuthentication(authentication.BaseAuthentication):
    def authenticate(self, request):
        auth_header = request.headers.get('Authorization')
        if not auth_header:
            return None

        parts = auth_header.split()
        if len(parts) != 2 or parts[0].lower() != 'bearer':
            return None

        token = parts[1]
        try:
            payload = jwt.decode(token, settings.JWT_SECRET_KEY, algorithms=['HS256'])
        except jwt.ExpiredSignatureError:
            raise exceptions.AuthenticationFailed('Authentication token has expired')
        except jwt.InvalidTokenError:
            raise exceptions.AuthenticationFailed('Invalid authentication token')

        user_id = payload.get('user_id')
        try:
            user = User.objects.select_related('pharmacy').get(id=user_id)
        except User.DoesNotExist:
            raise exceptions.AuthenticationFailed('User associated with token does not exist')

        if not user.is_active:
            raise exceptions.AuthenticationFailed('User account is deactivated')

        return (user, token)
