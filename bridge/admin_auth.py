"""Firebase Admin SDK helpers for trusted app-user administration."""
from __future__ import annotations

import json
import logging
import os
import uuid
from datetime import datetime, timezone
from functools import lru_cache
from typing import Any, Dict, Optional

import firebase_admin
from dotenv import load_dotenv
from fastapi import HTTPException
from firebase_admin import auth, credentials
from firebase_admin.exceptions import FirebaseError

_BRIDGE_DIR = os.path.dirname(os.path.abspath(__file__))
_REPO_DIR = os.path.dirname(_BRIDGE_DIR)
log = logging.getLogger("bridge.admin")

load_dotenv(os.path.join(_BRIDGE_DIR, ".env"))
load_dotenv(os.path.join(_REPO_DIR, ".env"))


def _admin_email() -> str:
    return os.getenv("FIREBASE_ADMIN_EMAIL", "").strip().casefold()


def _is_admin_user(user: Any) -> bool:
    configured = _admin_email()
    email = str(getattr(user, "email", "") or "").strip().casefold()
    return bool(configured and email == configured)


@lru_cache(maxsize=1)
def _initialize_firebase_admin():
    try:
        return firebase_admin.get_app()
    except ValueError:
        pass

    credentials_json = (os.getenv("FIREBASE_ADMIN_CREDENTIALS_JSON") or "").strip()
    credentials_path = (
        os.getenv("FIREBASE_ADMIN_CREDENTIALS")
        or os.getenv("FIREBASE_SERVICE_ACCOUNT_FILE")
        or os.getenv("GOOGLE_APPLICATION_CREDENTIALS")
        or ""
    ).strip()

    if credentials_json:
        try:
            service_account = json.loads(credentials_json)
        except json.JSONDecodeError as exc:
            raise HTTPException(
                status_code=503,
                detail="A configuração JSON do Firebase Admin SDK é inválida.",
            ) from exc
        credential = credentials.Certificate(service_account)
        log.info("Firebase Admin SDK inicializado com FIREBASE_ADMIN_CREDENTIALS_JSON.")
    else:
        candidate_dirs = [
            _BRIDGE_DIR,
            _REPO_DIR,
            os.getcwd(),
            os.path.join(_BRIDGE_DIR, "data"),
            os.path.join(_REPO_DIR, "data"),
            "/app",
            "/app/bridge",
            "/app/bridge/data",
        ]
        found_path = None
        explicit_candidates = [
            credentials_path,
            "rw-tips-firebase-adminsdk-fbsvc-83ccc19671.json",
        ]
        for exp in explicit_candidates:
            if not exp:
                continue
            if os.path.isabs(exp) and os.path.isfile(exp):
                found_path = exp
                break
            for directory in candidate_dirs:
                path = os.path.join(directory, exp)
                if os.path.isfile(path):
                    found_path = path
                    break
            if found_path:
                break

        if not found_path:
            for directory in candidate_dirs:
                if not os.path.isdir(directory):
                    continue
                try:
                    for fname in os.listdir(directory):
                        if fname.endswith(".json") and (
                            fname.startswith("rw-tips-firebase-adminsdk")
                            or "firebase-adminsdk" in fname
                            or "service-account" in fname
                        ):
                            path = os.path.join(directory, fname)
                            if os.path.isfile(path):
                                found_path = path
                                break
                except OSError:
                    pass
                if found_path:
                    break

        if not found_path or not os.path.isfile(found_path):
            raise HTTPException(
                status_code=503,
                detail=(
                    "Configure as credenciais Firebase Admin SDK no servidor. "
                    "Defina FIREBASE_ADMIN_CREDENTIALS_JSON ou coloque o JSON do "
                    "service account na pasta da ponte (bridge/) ou em bridge/data/."
                ),
            )
        log.info("Firebase Admin SDK inicializado com credenciais: %s", found_path)
        credential = credentials.Certificate(found_path)

    project_id = os.getenv("FIREBASE_PROJECT_ID")
    options = {"projectId": project_id} if project_id else None
    return firebase_admin.initialize_app(credential, options=options)


def verify_firebase_token(token: str) -> Dict[str, Any]:
    _initialize_firebase_admin()
    try:
        return auth.verify_id_token(token, check_revoked=True)
    except (auth.InvalidIdTokenError, auth.ExpiredIdTokenError, auth.RevokedIdTokenError) as exc:
        raise HTTPException(status_code=401, detail="Sessão Firebase inválida ou expirada.") from exc
    except auth.UserDisabledError as exc:
        raise HTTPException(status_code=403, detail="Esta conta Firebase está desativada.") from exc
    except FirebaseError as exc:
        raise HTTPException(status_code=503, detail="Não foi possível validar a sessão com o Firebase.") from exc


def require_admin(token: str) -> Dict[str, Any]:
    decoded = verify_firebase_token(token)
    configured_email = _admin_email()
    user_email = str(decoded.get("email", "")).strip().casefold()
    if not configured_email:
        raise HTTPException(
            status_code=503,
            detail="Configure o e-mail administrador no servidor.",
        )
    if not user_email or user_email != configured_email:
        raise HTTPException(status_code=403, detail="Acesso restrito ao administrador.")
    return decoded


def _claims_of(user: Any) -> Dict[str, Any]:
    return dict(user.custom_claims or {})


def _serialize_user(user: Any) -> Dict[str, Any]:
    claims = _claims_of(user)
    expires_at = claims.get("access_expires_at")
    created_ms = getattr(getattr(user, "user_metadata", None), "creation_timestamp", None)
    expires_iso = None
    if expires_at:
        try:
            expires_iso = datetime.fromtimestamp(int(expires_at), timezone.utc).isoformat()
        except (TypeError, ValueError, OSError):
            expires_iso = None
    return {
        "uid": user.uid,
        "email": user.email,
        "disabled": bool(getattr(user, "disabled", False)),
        "is_admin": _is_admin_user(user),
        "expires_at": expires_iso,
        "created_at": datetime.fromtimestamp(created_ms / 1000, timezone.utc).isoformat()
        if isinstance(created_ms, (int, float)) and created_ms > 0
        else None,
    }


def _get_user(uid: str):
    _initialize_firebase_admin()
    try:
        return auth.get_user(uid)
    except auth.UserNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Usuário não encontrado.") from exc
    except FirebaseError as exc:
        raise HTTPException(status_code=502, detail="O Firebase não conseguiu localizar o usuário.") from exc


def _assert_managed_user(user: Any) -> None:
    if _is_admin_user(user):
        raise HTTPException(
            status_code=403,
            detail="A conta administrador não pode ser alterada por esta tela.",
        )


def _merge_claims(uid: str, **updates: Any) -> Dict[str, Any]:
    user = _get_user(uid)
    claims = _claims_of(user)
    for key, value in updates.items():
        if value is None:
            claims.pop(key, None)
        else:
            claims[key] = value
    try:
        auth.set_custom_user_claims(uid, claims)
    except Exception as exc:
        log.error("Failed to update custom claims for %s (%s).", uid, type(exc).__name__)
        raise HTTPException(
            status_code=502,
            detail="Não foi possível atualizar as permissões desta conta.",
        ) from exc
    return claims


def _expiry_from_days(days: int) -> int:
    return int(datetime.now(timezone.utc).timestamp()) + days * 86400


def create_limited_user(email: str, password: str, days: int) -> Dict[str, Any]:
    _initialize_firebase_admin()
    normalized_email = email.strip().casefold()
    try:
        user = auth.create_user(email=normalized_email, password=password)
    except auth.EmailAlreadyExistsError as exc:
        raise HTTPException(status_code=409, detail="Este e-mail já possui uma conta.") from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail="Confira o e-mail e a senha informados.") from exc
    except FirebaseError as exc:
        raise HTTPException(status_code=502, detail="O Firebase não conseguiu criar a conta.") from exc

    expires_at = _expiry_from_days(days)
    try:
        auth.set_custom_user_claims(user.uid, {"access_expires_at": expires_at})
    except Exception as exc:
        try:
            auth.delete_user(user.uid)
        except Exception:
            log.exception(
                "Failed to remove newly created Firebase user after setting expiry claims failed."
            )
        log.error("Failed to set expiry claim for a newly created Firebase user (%s).", type(exc).__name__)
        raise HTTPException(
            status_code=502,
            detail="Não foi possível definir a validade do acesso. A operação foi cancelada; tente novamente.",
        ) from exc

    return _serialize_user(auth.get_user(user.uid))


def list_limited_users() -> Dict[str, Any]:
    _initialize_firebase_admin()
    users = []
    try:
        for user in auth.list_users().iterate_all():
            users.append(_serialize_user(user))
    except FirebaseError as exc:
        raise HTTPException(status_code=502, detail="O Firebase não conseguiu listar os usuários.") from exc
    users.sort(key=lambda item: (not item["is_admin"], (item.get("email") or "").casefold()))
    return {"users": users}


def update_limited_user(uid: str, email: Optional[str] = None, password: Optional[str] = None) -> Dict[str, Any]:
    user = _get_user(uid)
    _assert_managed_user(user)
    updates: Dict[str, Any] = {}
    if email is not None:
        normalized = email.strip().casefold()
        if not normalized:
            raise HTTPException(status_code=422, detail="Informe um e-mail válido.")
        updates["email"] = normalized
    if password is not None:
        if len(password) < 6:
            raise HTTPException(status_code=422, detail="A senha precisa ter pelo menos 6 caracteres.")
        updates["password"] = password
    if not updates:
        raise HTTPException(status_code=422, detail="Informe e-mail e/ou senha para atualizar.")
    try:
        auth.update_user(uid, **updates)
    except auth.EmailAlreadyExistsError as exc:
        raise HTTPException(status_code=409, detail="Este e-mail já possui uma conta.") from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail="Confira o e-mail e a senha informados.") from exc
    except FirebaseError as exc:
        raise HTTPException(status_code=502, detail="O Firebase não conseguiu atualizar a conta.") from exc
    return _serialize_user(auth.get_user(uid))


def delete_limited_user(uid: str) -> Dict[str, Any]:
    user = _get_user(uid)
    _assert_managed_user(user)
    try:
        auth.delete_user(uid)
    except FirebaseError as exc:
        raise HTTPException(status_code=502, detail="O Firebase não conseguiu excluir a conta.") from exc
    return {"uid": uid, "deleted": True}


def renew_limited_user(uid: str, days: int) -> Dict[str, Any]:
    user = _get_user(uid)
    _assert_managed_user(user)
    expires_at = _expiry_from_days(days)
    _merge_claims(uid, access_expires_at=expires_at)
    return _serialize_user(auth.get_user(uid))


def start_user_session(uid: str) -> Dict[str, Any]:
    user = _get_user(uid)
    claims = _claims_of(user)
    if not _is_admin_user(user):
        expires_at = claims.get("access_expires_at")
        try:
            expires_ts = int(expires_at)
        except (TypeError, ValueError):
            expires_ts = 0
        if expires_ts <= int(datetime.now(timezone.utc).timestamp()):
            raise HTTPException(
                status_code=403,
                detail="Este acesso não está ativo. Entre em contato com o administrador.",
            )
    session_id = uuid.uuid4().hex
    _merge_claims(uid, session_id=session_id)
    refreshed = _serialize_user(auth.get_user(uid))
    refreshed["session_id"] = session_id
    return refreshed
