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

    fake_user = SimpleNamespace(
        uid="new-user-id",
        email="new@example.com",
        disabled=False,
        custom_claims={},
        user_metadata=SimpleNamespace(creation_timestamp=None),
    )
    with patch.object(admin_auth, "_initialize_firebase_admin"), \
         patch.object(auth, "create_user", return_value=fake_user), \
         patch.object(auth, "set_custom_user_claims") as set_claims, \
         patch.object(auth, "get_user", side_effect=lambda uid: fake_user):
        def _store_claims(uid, claims):
            fake_user.custom_claims = claims
        set_claims.side_effect = _store_claims
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
    http_request = SimpleNamespace(client=SimpleNamespace(host="127.0.0.1"))
    credentials = HTTPAuthorizationCredentials(scheme="Bearer", credentials="admin-token")
    with patch.object(bridge_main.admin_auth, "require_admin") as require_admin, \
         patch.object(bridge_main.admin_auth, "create_limited_user", return_value=result), \
         patch.object(bridge_main, "check_rate_limit"):
        assert bridge_main.create_admin_user(
            request,
            http_request,
            credentials,
        ) == result
        require_admin.assert_called_once_with("admin-token")

    listed = {"users": [result]}
    updated = {**result, "email": "edited@example.com"}
    renewed = {**result, "expires_at": datetime.now(timezone.utc).isoformat()}
    session = {**result, "session_id": "abc123"}
    with patch.object(bridge_main.admin_auth, "require_admin"), \
         patch.object(bridge_main, "check_rate_limit"), \
         patch.object(bridge_main.admin_auth, "list_limited_users", return_value=listed), \
         patch.object(bridge_main.admin_auth, "update_limited_user", return_value=updated), \
         patch.object(bridge_main.admin_auth, "delete_limited_user", return_value={"uid": "new-user-id", "deleted": True}), \
         patch.object(bridge_main.admin_auth, "renew_limited_user", return_value=renewed), \
         patch.object(bridge_main.admin_auth, "verify_firebase_token", return_value={"uid": "new-user-id"}), \
         patch.object(bridge_main.admin_auth, "start_user_session", return_value=session):
        assert bridge_main.list_admin_users(http_request, credentials) == listed
        assert bridge_main.update_admin_user(
            "new-user-id",
            bridge_main.AdminUserUpdateRequest(email="edited@example.com"),
            http_request,
            credentials,
        )["email"] == "edited@example.com"
        assert bridge_main.delete_admin_user("new-user-id", http_request, credentials)["deleted"] is True
        assert bridge_main.renew_admin_user(
            "new-user-id",
            bridge_main.AdminUserRenewRequest(days=30),
            http_request,
            credentials,
        )
        assert bridge_main.start_auth_session(http_request, credentials)["session_id"] == "abc123"

    admin_record = SimpleNamespace(
        uid="admin-id",
        email="admin@example.com",
        disabled=False,
        custom_claims={},
        user_metadata=SimpleNamespace(creation_timestamp=None),
    )
    member = SimpleNamespace(
        uid="member-id",
        email="member@example.com",
        disabled=False,
        custom_claims={"access_expires_at": int(datetime.now(timezone.utc).timestamp()) + 86400, "session_id": "old"},
        user_metadata=SimpleNamespace(creation_timestamp=None),
    )
    with patch.dict(os.environ, {"FIREBASE_ADMIN_EMAIL": "admin@example.com"}), \
         patch.object(admin_auth, "_initialize_firebase_admin"), \
         patch.object(auth, "get_user", return_value=member), \
         patch.object(auth, "set_custom_user_claims") as set_claims, \
         patch.object(auth, "update_user", return_value=member), \
         patch.object(auth, "delete_user"):
        started = admin_auth.start_user_session("member-id")
        assert started["session_id"]
        assert set_claims.call_args.args[1]["session_id"] == started["session_id"]
        renewed_user = admin_auth.renew_limited_user("member-id", 10)
        assert renewed_user["email"] == "member@example.com"
        updated_user = admin_auth.update_limited_user("member-id", email="member2@example.com")
        assert updated_user["email"] == "member@example.com"
        assert admin_auth.delete_limited_user("member-id")["deleted"] is True

    with patch.dict(os.environ, {"FIREBASE_ADMIN_EMAIL": "admin@example.com"}), \
         patch.object(admin_auth, "_initialize_firebase_admin"), \
         patch.object(auth, "get_user", return_value=admin_record):
        try:
            admin_auth.delete_limited_user("admin-id")
        except HTTPException as error:
            assert error.status_code == 403
        else:
            raise AssertionError("The administrator account must be protected.")

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
