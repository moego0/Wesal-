from rest_framework import status, views, viewsets, permissions
from rest_framework.response import Response
from .models import User, Pharmacy
from .serializers import (
    UserSerializer,
    PharmacySerializer,
    LoginSerializer,
    RegisterPharmacistSerializer
)
from .permissions import IsPlatformAdmin, IsPharmacyUser


class LoginView(views.APIView):
    permission_classes = [permissions.AllowAny]

    def post(self, request):
        serializer = LoginSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        return Response(serializer.validated_data, status=status.HTTP_200_OK)


class CurrentUserView(views.APIView):
    permission_classes = [permissions.IsAuthenticated]

    def get(self, request):
        serializer = UserSerializer(request.user)
        return Response(serializer.data)


class PharmacyViewSet(viewsets.ModelViewSet):
    queryset = Pharmacy.objects.all()
    serializer_class = PharmacySerializer

    def get_permissions(self):
        if self.action in ['create', 'destroy']:
            return [IsPlatformAdmin()]
        return [IsPharmacyUser()]

    def get_queryset(self):
        user = self.request.user
        if not user.is_authenticated:
            return Pharmacy.objects.none()
        if user.role == 'admin':
            return Pharmacy.objects.all()
        if user.pharmacy:
            return Pharmacy.objects.filter(id=user.pharmacy.id)
        return Pharmacy.objects.none()


class UserViewSet(viewsets.ModelViewSet):
    serializer_class = UserSerializer
    permission_classes = [IsPharmacyUser]

    def get_queryset(self):
        user = self.request.user
        if not user.is_authenticated:
            return User.objects.none()
        if user.role == 'admin':
            return User.objects.all()
        if user.pharmacy:
            return User.objects.filter(pharmacy=user.pharmacy)
        return User.objects.filter(id=user.id)

    def create(self, request, *args, **kwargs):
        if request.user.role != 'admin' and request.data.get('pharmacy') != str(request.user.pharmacy_id):
            return Response(
                {'detail': 'Cannot create user for another pharmacy.'},
                status=status.HTTP_403_FORBIDDEN
            )
        serializer = RegisterPharmacistSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        user = serializer.save()
        return Response(UserSerializer(user).data, status=status.HTTP_201_CREATED)
