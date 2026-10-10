from rest_framework import permissions


class IsPharmacyUser(permissions.BasePermission):
    """
    Ensures the user is authenticated and belongs to a pharmacy or is a platform admin.
    """
    def has_permission(self, request, view):
        if not request.user or not request.user.is_authenticated:
            return False
        return bool(request.user.role == 'admin' or request.user.pharmacy is not None)

    def has_object_permission(self, request, view, obj):
        if not request.user or not request.user.is_authenticated:
            return False
        if request.user.role == 'admin':
            return True
        if hasattr(obj, 'pharmacy'):
            return obj.pharmacy == request.user.pharmacy
        if hasattr(obj, 'patient') and hasattr(obj.patient, 'pharmacy'):
            return obj.patient.pharmacy == request.user.pharmacy
        return False


class IsPlatformAdmin(permissions.BasePermission):
    """
    Allows access only to platform administrators.
    """
    def has_permission(self, request, view):
        return bool(request.user and request.user.is_authenticated and request.user.role == 'admin')
