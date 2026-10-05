"""Verify Firebase-backed administrator authorization and account expiry claims."""
from __future__ import annotations

import os
import sys
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import HTTPException

_HERE = os.path.dirname(os.path.abspath(__file__))
_BRIDGE = os.path.dirname(os.path.dirname(_HERE))
if _BRIDGE not in sys.path:
    sys.path.insert(0, _BRIDGE)

import admin_auth  # noqa: E402
import main as bridge_main  # noqa: E402
from firebase_admin import auth  # noqa: E402
from fastapi.security import HTTPAuthorizationCredentials  # noqa: E402


def main() -> int:
    admin_token = {"email": "admin@example.com", "uid": "admin-id"}
    with patch.dict(os.environ, {"FIREBASE_ADMIN_EMAIL": "admin@example.com"}):
        with patch.object(admin_auth, "_initialize_firebase_admin"), \
             patch.object(auth, "verify_id_token", return_value=admin_token):
            assert admin_auth.require_admin("verified-id-token") == admin_token
            with patch.object(auth, "verify_id_token", return_value={"email": "other@example.com"}):
                try:
                    admin_auth.require_admin("non-admin-token")
                except HTTPException as error:
                    assert error.status_code == 403
                else:
                    raise AssertionError("Non-admin Firebase users must be rejected.")

    fake_user = SimpleNamespace(uid="new-user-id", email="new@example.com")
    with patch.object(admin_auth, "_initialize_firebase_admin"), \
         patch.object(auth, "create_user", return_value=fake_user), \
         patch.object(auth, "set_custom_user_claims") as set_claims:
        result = admin_auth.create_limited_user(" New@Example.com ", "test-password", 7)

    expiry = datetime.fromisoformat(result["expires_at"])
    assert result["email"] == "new@example.com"
    assert (expiry - datetime.now(timezone.utc)).total_seconds() <= 7 * 86400
    assert set_claims.call_args.args[0] == fake_user.uid
    assert set_claims.call_args.args[1]["access_expires_at"] == int(expiry.timestamp())

    request = bridge_main.AdminUserRequest(
        email="new@example.com",
        password="test-password",
        days=7,
    )
    with patch.object(bridge_main.admin_auth, "require_admin") as require_admin, \
         patch.object(bridge_main.admin_auth, "create_limited_user", return_value=result):
        assert bridge_main.create_admin_user(
            request,
            HTTPAuthorizationCredentials(scheme="Bearer", credentials="admin-token"),
        ) == result
        require_admin.assert_called_once_with("admin-token")

    with patch.dict(os.environ, {"FIREBASE_ADMIN_EMAIL": ""}):
        with patch.object(admin_auth, "_initialize_firebase_admin"), \
             patch.object(auth, "verify_id_token", return_value=admin_token):
            try:
                admin_auth.require_admin("verified-id-token")
            except HTTPException as error:
                assert error.status_code == 503
            else:
                raise AssertionError("Admin access must fail closed without an allowlisted email.")

    print("OK: admin allowlist, denial of non-admins, and account expiry claims.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
