"""Firebase Admin SDK helpers for trusted app-user administration."""
from __future__ import annotations

import json
import logging
import os
from functools import lru_cache
from datetime import datetime, timezone
from typing import Any, Dict

import firebase_admin
from firebase_admin import auth, credentials
from firebase_admin.exceptions import FirebaseError
from fastapi import HTTPException

_BRIDGE_DIR = os.path.dirname(os.path.abspath(__file__))
_REPO_DIR = os.path.dirname(_BRIDGE_DIR)
log = logging.getLogger("bridge.admin")


@lru_cache(maxsize=1)
def _initialize_firebase_admin():
    try:
        return firebase_admin.get_app()
    except ValueError:
        pass

    credentials_json = os.getenv("FIREBASE_ADMIN_CREDENTIALS_JSON")
    credentials_path = os.getenv("FIREBASE_ADMIN_CREDENTIALS")
    if credentials_json:
        try:
            service_account = json.loads(credentials_json)
        except json.JSONDecodeError as exc:
            raise HTTPException(
                status_code=503,
                detail="A configuração JSON do Firebase Admin SDK é inválida.",
            ) from exc
        credential = credentials.Certificate(service_account)
    else:
        if not credentials_path:
            local_path = os.path.join(
                _REPO_DIR, "rw-tips-firebase-adminsdk-fbsvc-83ccc19671.json"
            )
            if os.path.isfile(local_path):
                credentials_path = local_path
        if not credentials_path:
            raise HTTPException(
                status_code=503,
                detail="Configure as credenciais Firebase Admin SDK no servidor.",
            )
        if not os.path.isabs(credentials_path):
            credentials_path = os.path.join(_BRIDGE_DIR, credentials_path)
        if not os.path.isfile(credentials_path):
            raise HTTPException(
                status_code=503,
                detail="O arquivo de credenciais Firebase Admin SDK não foi encontrado no servidor.",
            )
        credential = credentials.Certificate(credentials_path)

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
    configured_email = os.getenv("FIREBASE_ADMIN_EMAIL", "").strip().casefold()
    user_email = str(decoded.get("email", "")).strip().casefold()
    if not configured_email:
        raise HTTPException(
            status_code=503,
            detail="Configure o e-mail administrador no servidor.",
        )
    if not user_email or user_email != configured_email:
        raise HTTPException(status_code=403, detail="Acesso restrito ao administrador.")
    return decoded


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

    expires_at = int(datetime.now(timezone.utc).timestamp()) + days * 86400
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

    return {
        "uid": user.uid,
        "email": user.email,
        "expires_at": datetime.fromtimestamp(expires_at, timezone.utc).isoformat(),
    }
